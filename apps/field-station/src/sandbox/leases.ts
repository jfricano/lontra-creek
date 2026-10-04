/**
 * The field station's sandbox slot pool: the same lease coordinator model as the
 * Lab's (lab/leases.ts, Lab contract §4) with the sandbox's own queue and timings
 * (LC11-ADR-04 defaults), and one per-client-address cap shared with the Lab
 * (places.ts). It is the only thing that grants or ends a sandbox lease; requests
 * never name a slot. Each lease carries a study: reset starts a new one on the same
 * slot, and results for an older study are discarded.
 */
import { randomUUID } from 'node:crypto';
import { isErrorCode, isPlainObject, streamError, type Json, type StreamError } from 'streamotter/contracts';
import { AddressCap } from '../places.ts';
import type { SessionClaims } from '../sessions.ts';
import type { SandboxConnection, SandboxEndReason, SandboxErrorCode, SandboxLease, SandboxOperation, SandboxReproDownload, SandboxRuntime, SandboxServiceStatus, SandboxStatus, SlotId, WorkbenchDiscovery } from './contract.ts';
import { CONFIG_BODY_BYTES, HOST_CONTRACT, SANDBOX_OPERATIONS, SandboxFault } from './operations.ts';

/** The sandbox service's private API (service.ts); throws only when it cannot be reached. */
export interface SandboxClient { request(path: string, method?: string, body?: unknown): Promise<{ status: number; body: unknown }>; }
export interface SandboxTimings {
  leaseMs: number; claimMs: number; idleMs: number; queueIdleMs: number; endedMs: number; queueMax: number; opsPerSecond: number;
  pollMs: number; failMs: number; resetDeadlineMs: number; retryMs: number;
}
/** LC11-ADR-04 defaults; the queue idle limit and the poll, failure, and reset timings are the Lab's. */
export const SANDBOX_DEFAULTS: SandboxTimings = { leaseMs: 600_000, claimMs: 30_000, idleMs: 60_000, queueIdleMs: 90_000, endedMs: 60_000, queueMax: 30, opsPerSecond: 2, pollMs: 5000, failMs: 15_000, resetDeadlineMs: 60_000, retryMs: 30_000 };
interface Lease { id: string; studyId: string; slot: SlotId; granted: number; expires: number; claimed: boolean; resetting: boolean; resetAt: number; ops: number[]; runtime: SandboxRuntime; }
interface Place { session: SessionClaims; address: string; joined: number; heartbeat: number; lease?: Lease; }
interface Slot { state: SandboxStatus['slots'][number]['state']; resetAt: number; retryAt: number; }
const iso = (n: number): string => new Date(n).toISOString();
const CODES: readonly SandboxErrorCode[] = ['invalid-request', 'field-not-editable', 'candidate-too-large', 'no-session', 'origin-not-allowed', 'operation-not-allowed', 'no-lease', 'stale-study', 'too-many-requests', 'too-many-places', 'queue-full', 'sandbox-unavailable', 'slot-unavailable'];

/** All state transitions are serialized, including remote calls; operations hold the lock only before and after the slot answers. */
export class SandboxPool {
  readonly #client: SandboxClient;
  readonly #slots = new Map<SlotId, Slot>();
  readonly #places = new Map<string, Place>();
  readonly #ended = new Map<string, Extract<SandboxLease, { status: 'ended' }>>();
  readonly #now: () => number;
  readonly #origin: string;
  readonly #cap: AddressCap;
  readonly #t: SandboxTimings;
  #service: SandboxServiceStatus | null = null;
  #bootId: string | null = null;
  #lastSeen: number;
  #nextPoll = 0;
  #initialized = false;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(options: { client: SandboxClient; slots: SlotId[]; gatewayOrigin: string; cap?: AddressCap; now?: () => number; timings?: Partial<SandboxTimings> }) {
    this.#client = options.client; this.#now = options.now ?? Date.now; this.#origin = options.gatewayOrigin; this.#t = { ...SANDBOX_DEFAULTS, ...options.timings };
    this.#cap = options.cap ?? new AddressCap(); this.#cap.register(this); this.#lastSeen = this.#now();
    for (const slot of options.slots) this.#slots.set(slot, { state: 'unavailable', resetAt: 0, retryAt: 0 });
  }
  run<T>(operation: () => Promise<T>): Promise<T> { const next = this.#tail.then(operation); this.#tail = next.catch(() => undefined); return next; }
  placesFor(address: string): number { let n = 0; for (const place of this.#places.values()) if (place.address === address) n++; return n; }
  /** Every slot is returned before anything is granted, which also ends whatever an earlier field station left behind. Until then the pool is unavailable. */
  async initialize(): Promise<void> { await this.run(async () => { for (const slot of this.#slots.keys()) await this.#return(slot, null); this.#initialized = true; }); }

  async #return(slot: SlotId, leaseId: string | null): Promise<void> {
    const s = this.#slots.get(slot)!; s.state = 'resetting'; s.resetAt = this.#now(); this.#nextPoll = 0;
    try { const r = await this.#client.request(`/sandbox/v1/slots/${slot}/return`, 'POST', { leaseId }); if (r.status >= 300) throw new Error('refused'); }
    catch { s.state = 'unavailable'; s.retryAt = this.#now() + this.#t.retryMs; }
  }
  async #end(place: Place, reason: SandboxEndReason): Promise<void> {
    this.#places.delete(place.session.subject);
    this.#ended.set(place.session.subject, { status: 'ended', now: iso(this.#now()), reason, endedAt: iso(this.#now()) });
    if (place.lease) await this.#return(place.lease.slot, place.lease.id);
  }
  #holder(slot: SlotId): Place | undefined { for (const place of this.#places.values()) if (place.lease?.slot === slot) return place; return undefined; }

  async sweep(): Promise<void> {
    if (!this.#initialized) return;
    const now = this.#now(); const t = this.#t;
    for (const [subject, ended] of this.#ended) if (now - Date.parse(ended.endedAt) >= t.endedMs) this.#ended.delete(subject);
    for (const place of [...this.#places.values()]) {
      const lease = place.lease;
      const reason = now >= place.session.exp ? 'session-ended' : lease && now >= lease.expires ? 'expired' : lease && !lease.claimed && now - lease.granted >= t.claimMs ? 'unclaimed'
        : now - place.heartbeat >= (lease ? t.idleMs : t.queueIdleMs) ? 'idle' : lease?.resetting && now - lease.resetAt >= t.resetDeadlineMs ? 'slot-failed' : null;
      if (reason) await this.#end(place, reason);
    }
    for (const [slot, s] of this.#slots) if (s.state === 'unavailable' && this.#service?.availability === 'available' && now >= s.retryAt && !this.#holder(slot)) await this.#return(slot, null);
    const busy = [...this.#places.values()].some(p => p.lease?.resetting) || [...this.#slots.values()].some(s => s.state === 'resetting');
    if (now >= this.#nextPoll) {
      this.#nextPoll = now + (busy ? 1000 : t.pollMs);
      let status: SandboxServiceStatus | null = null;
      try { const r = await this.#client.request('/sandbox/v1/status'); if (r.status === 200 && isPlainObject(r.body)) status = r.body as unknown as SandboxServiceStatus; } catch { /* below */ }
      if (status) await this.#reconcile(status, now);
      else if (now - this.#lastSeen >= t.failMs) {
        this.#service = null;
        for (const place of [...this.#places.values()]) if (place.lease) await this.#end(place, 'slot-failed');
        for (const s of this.#slots.values()) { s.state = 'unavailable'; s.retryAt = now + t.retryMs; }
      }
    }
    if (this.#service?.availability !== 'available') return;
    for (const [slot, s] of this.#slots) {
      if (s.state !== 'ready') continue;
      const place = [...this.#places.values()].find(p => !p.lease);
      if (!place) break;
      const lease: Lease = { id: randomUUID(), studyId: randomUUID(), slot, granted: now, expires: Math.min(now + t.leaseMs, place.session.exp), claimed: false, resetting: false, resetAt: 0, ops: [], runtime: this.#service.runtime! };
      try { const r = await this.#client.request(`/sandbox/v1/slots/${slot}/lease`, 'PUT', { leaseId: lease.id, studyId: lease.studyId, expiresAt: iso(lease.expires) }); if (r.status !== 200) throw new Error('refused'); place.lease = lease; s.state = 'leased'; }
      catch { s.state = 'unavailable'; s.retryAt = now + t.retryMs; }
    }
  }
  async #reconcile(status: SandboxServiceStatus, now: number): Promise<void> {
    const restarted = this.#bootId !== null && status.bootId !== this.#bootId;
    this.#service = status; this.#bootId = status.bootId; this.#lastSeen = now;
    for (const [slot, s] of this.#slots) {
      const remote = status.slots.find(r => r.slot === slot); const place = this.#holder(slot); const lease = place?.lease;
      if (place && lease) {
        if (!remote || remote.state === 'failed' || remote.lease?.leaseId !== lease.id) { await this.#end(place, restarted ? 'sandbox-restarted' : 'slot-failed'); continue; }
        if (lease.resetting && remote.state === 'leased' && remote.lease.studyId === lease.studyId) lease.resetting = false;
        continue;
      }
      if (!remote || remote.state === 'failed') { if (s.state !== 'unavailable') { s.state = 'unavailable'; s.retryAt = now + this.#t.retryMs; } continue; }
      if (remote.state === 'ready' && s.state !== 'unavailable') s.state = 'ready';
      else if (remote.state === 'leased' || remote.lease) await this.#return(slot, null);
      else if (s.state === 'resetting' && now - s.resetAt >= this.#t.resetDeadlineMs) { s.state = 'unavailable'; s.retryAt = now + this.#t.retryMs; }
      else if (remote.state === 'ready' && s.state === 'unavailable' && now >= s.retryAt) s.state = 'ready';
    }
  }

  /** Polls the service on the next sweep, whatever the poll interval. */
  refresh(): void { this.#nextPoll = 0; }
  heartbeat(session: SessionClaims): void { const place = this.#places.get(session.subject); if (place && this.#now() - place.heartbeat < (place.lease ? this.#t.idleMs : this.#t.queueIdleMs)) place.heartbeat = this.#now(); }
  status(): SandboxStatus {
    const now = iso(this.#now()); const service = this.#service;
    const leases = [...this.#places.values()].flatMap(p => p.lease ? [p.lease] : []);
    const slots = [...this.#slots].map(([slot, s]) => ({ slot, state: s.state }));
    const reason = !service ? 'service-unavailable' : service.availability !== 'available' ? service.reason ?? 'service-unavailable' : slots.every(s => s.state === 'unavailable') ? 'all-slots-unavailable' : null;
    return { now, availability: reason ? 'unavailable' : 'available', ...(reason ? { reason } : {}), runtime: service?.runtime ?? null, slots, queueLength: [...this.#places.values()].filter(p => !p.lease).length,
      nextFreeAt: slots.some(s => s.state === 'ready') || !leases.length ? null : iso(Math.min(...leases.map(l => l.expires))) };
  }
  discovery(): WorkbenchDiscovery {
    const service = this.#service;
    return { hostContract: HOST_CONTRACT, operations: ['workbench', ...service?.availability === 'available' ? SANDBOX_OPERATIONS.filter(op => service.operations.includes(op)) : []], limits: { maxRequestBytes: CONFIG_BODY_BYTES } };
  }
  view(session: SessionClaims): SandboxLease {
    const now = iso(this.#now()); const place = this.#places.get(session.subject);
    if (!place) return { ...(this.#ended.get(session.subject) ?? { status: 'none' }), now };
    const lease = place.lease;
    if (!lease) { const queue = [...this.#places.values()].filter(p => !p.lease); return { status: 'queued', now, position: queue.indexOf(place) + 1, queueLength: queue.length, joinedAt: iso(place.joined), nextFreeAt: this.status().nextFreeAt, sessionExpiresAt: iso(place.session.exp) }; }
    return { status: lease.resetting ? 'resetting' : lease.claimed ? 'active' : 'ready', now, leaseId: lease.id, studyId: lease.studyId, slot: lease.slot, grantedAt: iso(lease.granted), expiresAt: iso(lease.expires), claimBy: lease.claimed ? null : iso(lease.granted + this.#t.claimMs), runtime: lease.runtime };
  }
  /** Explicit allocation: the only way a session gets a place or a slot. Idempotent. */
  async join(session: SessionClaims, address: string): Promise<SandboxLease> {
    if (this.#places.has(session.subject)) return this.view(session);
    if (this.status().availability !== 'available') throw new SandboxFault('sandbox-unavailable');
    if (this.#cap.full(address)) throw new SandboxFault('too-many-places');
    if ([...this.#places.values()].filter(p => !p.lease).length >= this.#t.queueMax) throw new SandboxFault('queue-full');
    this.#ended.delete(session.subject); this.#places.set(session.subject, { session, address, joined: this.#now(), heartbeat: this.#now() }); await this.sweep(); return this.view(session);
  }
  async leave(session: SessionClaims): Promise<SandboxLease> { const place = this.#places.get(session.subject); if (place) await this.#end(place, place.lease ? 'returned' : 'left'); await this.sweep(); return this.view(session); }
  #lease(session: SessionClaims, active = false): Lease {
    const lease = this.#places.get(session.subject)?.lease;
    if (!lease || active && (!lease.claimed || lease.resetting)) throw new SandboxFault('no-lease');
    return lease;
  }
  /**
   * A slot call for this session's lease and study; an unreachable or failing slot ends
   * the lease. A failure after the lease has moved on to another study (a reset) or
   * ended is the old study's, so it ends nothing: null, and the caller answers `stale-study`.
   */
  async #call(session: SessionClaims, lease: Lease, studyId: string, path: string, body: unknown): Promise<{ status: number; body: unknown } | null> {
    let response: { status: number; body: unknown } | null = null;
    try { response = await this.#client.request(`/sandbox/v1/slots/${lease.slot}/${path}`, 'POST', body); } catch { /* below */ }
    // 5xx answers the slot gave on purpose (a native SOURCE_UNAVAILABLE, a withheld download) pass through; only an unreachable or failed slot ends the lease.
    const answer = response?.body; const error = isPlainObject(answer) && isPlainObject(answer['error']) ? answer['error'] : null;
    const details = error && isPlainObject(error['details']) ? error['details'] : null;
    if (response && isPlainObject(answer) && (response.status < 500 || answer['code'] !== 'slot-unavailable' && details?.['code'] !== 'slot-unavailable' && (error !== null || answer['code'] !== undefined))) return response;
    const place = this.#places.get(session.subject);
    if (place?.lease !== lease || lease.studyId !== studyId) return null;
    await this.#end(place, 'slot-failed');
    throw new SandboxFault('slot-unavailable');
  }
  async claim(session: SessionClaims): Promise<SandboxConnection> {
    const lease = this.#lease(session); const r = await this.#call(session, lease, lease.studyId, 'claim', { leaseId: lease.id, studyId: lease.studyId });
    if (r?.status !== 200) throw fault(r?.body);
    lease.claimed = true;
    return { leaseId: lease.id, studyId: lease.studyId, expiresAt: iso(lease.expires), gatewayOrigin: this.#origin, gatewayPath: `/sandbox/${lease.slot}/socket.io` };
  }
  /** Discards the study (candidate, runtime state, traces, previews) and starts a new studyId on the same slot and lease. */
  async reset(session: SessionClaims): Promise<SandboxLease> {
    const lease = this.#lease(session);
    if (lease.resetting) return this.view(session);
    const studyId = randomUUID(); lease.studyId = studyId; lease.resetting = true; lease.resetAt = this.#now(); this.#nextPoll = 0;
    const r = await this.#call(session, lease, studyId, 'reset', { leaseId: lease.id, studyId });
    if (!r || r.status >= 300) { const place = this.#places.get(session.subject); if (place?.lease === lease) await this.#end(place, 'slot-failed'); throw new SandboxFault('slot-unavailable'); }
    return this.view(session);
  }
  #throttle(lease: Lease): void {
    const now = this.#now(); lease.ops = lease.ops.filter(at => now - at < 1000);
    if (lease.ops.length >= this.#t.opsPerSecond) throw new SandboxFault('too-many-requests'); lease.ops.push(now);
  }
  /**
   * One allowlisted operation on the session's own slot, in its current study. Call
   * outside `run`: the lock is held to check the lease and again to check the answer,
   * never while the slot works, and an answer for a study that has since been reset
   * or ended is discarded.
   */
  async operate(session: SessionClaims, op: SandboxOperation, input: unknown): Promise<unknown> {
    const ticket = await this.run(async () => { await this.sweep(); this.heartbeat(session); const lease = this.#lease(session, true); this.#throttle(lease); return { lease, studyId: lease.studyId }; });
    const r = await this.#call(session, ticket.lease, ticket.studyId, 'ops', { leaseId: ticket.lease.id, studyId: ticket.studyId, op, input });
    return this.run(async () => {
      const current = this.#places.get(session.subject)?.lease;
      if (!r || current !== ticket.lease || current.studyId !== ticket.studyId) throw new SandboxFault('stale-study', undefined, op === 'traces' ? { wbCode: 'TRACE_CURSOR_EXPIRED', wbStatus: 410 } : {});
      const body = r.body as { ok?: unknown; data?: unknown; error?: unknown };
      if (r.status === 200 && isPlainObject(body) && body.ok === true) return body.data;
      throw new WorkbenchFailure(r.status, isPlainObject(body) ? body.error : undefined);
    });
  }
  async repro(session: SessionClaims): Promise<SandboxReproDownload> {
    const ticket = await this.run(async () => { await this.sweep(); this.heartbeat(session); const lease = this.#lease(session, true); this.#throttle(lease); return { lease, studyId: lease.studyId }; });
    const r = await this.#call(session, ticket.lease, ticket.studyId, 'repro', { leaseId: ticket.lease.id, studyId: ticket.studyId });
    return this.run(async () => {
      const current = this.#places.get(session.subject)?.lease;
      if (!r || current !== ticket.lease || current.studyId !== ticket.studyId) throw new SandboxFault('stale-study');
      if (r.status !== 200) throw fault(r.body);
      return r.body as SandboxReproDownload;
    });
  }
}

/** The slot's own refusal, as a lifecycle error. */
function fault(body: unknown): SandboxFault {
  const code = isPlainObject(body) && CODES.includes(body['code'] as SandboxErrorCode) ? body['code'] as SandboxErrorCode : 'slot-unavailable';
  return new SandboxFault(code, isPlainObject(body) && typeof body['error'] === 'string' ? body['error'].slice(0, 300) : undefined);
}
/** A WHC-1 error from the slot, rebuilt from its public fields only. */
export class WorkbenchFailure extends Error {
  readonly status: number;
  readonly error: StreamError;
  constructor(status: number, raw: unknown) {
    super('Workbench operation failed.'); this.status = status >= 400 && status < 600 ? status : 502;
    const e = isPlainObject(raw) ? raw : {}; const details = isPlainObject(e['details']) && JSON.stringify(e['details']).length <= 16_384 ? e['details'] as Record<string, Json> : undefined;
    this.error = streamError(isErrorCode(e['code']) ? e['code'] : 'INTERNAL', { message: typeof e['message'] === 'string' ? e['message'].slice(0, 300) : 'The sandbox could not answer.', ...(typeof e['retryable'] === 'boolean' ? { retryable: e['retryable'] } : {}), ...(details ? { details } : {}) });
  }
}

export function configuredSandbox(env: NodeJS.ProcessEnv, gatewayOrigin: string, cap?: AddressCap): SandboxPool | undefined {
  const url = env['SANDBOX_API_URL'];
  if (!url) return undefined;
  const origin = new URL(url).origin; const token = env['SANDBOX_SERVICE_TOKEN'];
  if (!token || token.length < 32) throw new Error('SANDBOX_SERVICE_TOKEN needs 32 characters.');
  const positive = (key: string, fallback: number): number => { const n = Number(env[key] ?? fallback); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a positive integer.`); return n; };
  const count = positive('SANDBOX_SLOTS', 3); if (count > 3) throw new Error('At most three sandbox slots are supported.');
  const client: SandboxClient = {
    async request(path, method = 'GET', body) {
      const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json() as unknown };
    }
  };
  return new SandboxPool({ client, slots: Array.from({ length: count }, (_, i) => i + 1 as SlotId), gatewayOrigin, ...(cap ? { cap } : {}), timings: { leaseMs: positive('SANDBOX_LEASE_SECONDS', 600) * 1000, queueMax: positive('SANDBOX_QUEUE_MAX', 30) } });
}
