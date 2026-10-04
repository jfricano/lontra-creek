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
import { CONFIG_BODY_BYTES, HOST_CONTRACT, invalid, SANDBOX_OPERATIONS, SandboxFault } from './operations.ts';

/** The sandbox service's private API (service.ts); throws a SandboxFault for a request it cannot encode, and otherwise only when the service cannot be reached. */
export interface SandboxClient { request(path: string, method?: string, body?: unknown): Promise<{ status: number; body: unknown }>; }
export interface SandboxTimings {
  leaseMs: number; claimMs: number; idleMs: number; queueIdleMs: number; endedMs: number; queueMax: number; opsPerSecond: number; opsBurst: number;
  pollMs: number; failMs: number; resetDeadlineMs: number; retryMs: number;
}
/** LC11-ADR-04 defaults; the queue idle limit and the poll, failure, and reset timings are the Lab's. */
export const SANDBOX_DEFAULTS: SandboxTimings = { leaseMs: 600_000, claimMs: 30_000, idleMs: 60_000, queueIdleMs: 90_000, endedMs: 60_000, queueMax: 30, opsPerSecond: 2, opsBurst: 8, pollMs: 5000, failMs: 15_000, resetDeadlineMs: 60_000, retryMs: 30_000 };
/**
 * How long the field station waits for the sandbox service. A status poll or lifecycle
 * call, which the service answers at once, waits 3 s, so a hung service delays no visitor
 * request and the 15 s outage rule still applies. A slot operation or a reproduction
 * bundle waits 15 s: longer than the service's own wait for the slot (seam.ts,
 * CALL_TIMEOUT_MS), so a slow slot call comes back as the slot's TIMEOUT and keeps the
 * lease; only no answer at all ends it.
 */
export const SANDBOX_CALL_TIMEOUT_MS = 3000;
export const SANDBOX_OPS_TIMEOUT_MS = 15_000;
/** How often the field station sweeps the pool: the service poll interval while a slot or study resets. A sweep polls only when the poll is due. */
export const SANDBOX_SWEEP_MS = 1000;
interface Lease { id: string; studyId: string; slot: SlotId; granted: number; expires: number; claimed: boolean; resetting: boolean; resetAt: number; ops: { tokens: number; at: number }; runtime: SandboxRuntime; }
/** `offer` is a lease the service has been asked to grant and has not yet answered; until it does, the place is still in line. */
interface Place { session: SessionClaims; address: string; joined: number; heartbeat: number; lease?: Lease; offer?: { lease: Lease; done: Promise<void> }; }
/** `version` counts the calls that change the slot, `busy` those in flight: a status poll is applied to a slot only if neither moved since it was sent. */
interface Slot { state: SandboxStatus['slots'][number]['state']; resetAt: number; retryAt: number; version: number; busy: number; }
const iso = (n: number): string => new Date(n).toISOString();
const CODES: readonly SandboxErrorCode[] = ['invalid-request', 'field-not-editable', 'candidate-too-large', 'no-session', 'origin-not-allowed', 'operation-not-allowed', 'no-lease', 'stale-study', 'too-many-requests', 'too-many-places', 'queue-full', 'sandbox-unavailable', 'slot-unavailable'];

/**
 * Every state transition is synchronous, and nothing waits on the sandbox service while
 * holding anything: a sweep starts the calls it needs (returns, at most one status poll,
 * grants) and applies each answer when it arrives, checked against the state as it is
 * then. A visitor's request waits only for its own call, so a hung service never makes
 * one request wait for another's.
 */
export class SandboxPool {
  readonly #client: SandboxClient;
  readonly #slots = new Map<SlotId, Slot>();
  readonly #places = new Map<string, Place>();
  readonly #ended = new Map<string, Extract<SandboxLease, { status: 'ended' }>>();
  readonly #now: () => number;
  readonly #origin: string;
  readonly #cap: AddressCap;
  readonly #t: SandboxTimings;
  readonly #pending = new Set<Promise<void>>();
  #service: SandboxServiceStatus | null = null;
  #bootId: string | null = null;
  #lastSeen: number;
  #nextPoll = 0;
  #polling = false;
  #initialized = false;
  constructor(options: { client: SandboxClient; slots: SlotId[]; gatewayOrigin: string; cap?: AddressCap; now?: () => number; timings?: Partial<SandboxTimings> }) {
    this.#client = options.client; this.#now = options.now ?? Date.now; this.#origin = options.gatewayOrigin; this.#t = { ...SANDBOX_DEFAULTS, ...options.timings };
    this.#cap = options.cap ?? new AddressCap(); this.#cap.register(this); this.#lastSeen = this.#now();
    for (const slot of options.slots) this.#slots.set(slot, { state: 'unavailable', resetAt: 0, retryAt: 0, version: 0, busy: 0 });
  }
  placesFor(address: string): number { let n = 0; for (const place of this.#places.values()) if (place.address === address) n++; return n; }
  /** Every slot is returned before anything is granted, which also ends whatever an earlier field station left behind. Until then the pool is unavailable. */
  async initialize(): Promise<void> { await Promise.all([...this.#slots.keys()].map(slot => this.#return(slot, null))); this.#initialized = true; }
  /** Settles once no call to the service is in flight (tests and shutdown). */
  async settled(): Promise<void> { while (this.#pending.size) await Promise.all([...this.#pending]); }

  /** One call to the service about a slot, counted while in flight; `apply` runs on its answer (null when there was none). */
  #slotCall(slot: Slot, path: string, method: string, body: unknown, apply: (response: { status: number; body: unknown } | null) => void): Promise<void> {
    slot.version++; slot.busy++;
    const work = this.#client.request(path, method, body).catch(() => null).then(response => { slot.busy--; apply(response); });
    this.#pending.add(work); void work.finally(() => this.#pending.delete(work));
    return work;
  }
  #return(slot: SlotId, leaseId: string | null): Promise<void> {
    const s = this.#slots.get(slot)!; s.state = 'resetting'; s.resetAt = this.#now(); this.#nextPoll = 0;
    const version = s.version + 1;
    return this.#slotCall(s, `/sandbox/v1/slots/${slot}/return`, 'POST', { leaseId }, r => {
      if ((r === null || r.status >= 300) && s.version === version) { s.state = 'unavailable'; s.retryAt = this.#now() + this.#t.retryMs; }
    });
  }
  #end(place: Place, reason: SandboxEndReason): void {
    this.#places.delete(place.session.subject);
    this.#ended.set(place.session.subject, { status: 'ended', now: iso(this.#now()), reason, endedAt: iso(this.#now()) });
    // An offer still unanswered is returned when its answer arrives (#grant).
    if (place.lease) void this.#return(place.lease.slot, place.lease.id);
  }
  #holder(slot: SlotId): Place | undefined { for (const place of this.#places.values()) if (place.lease?.slot === slot || place.offer?.lease.slot === slot) return place; return undefined; }

  /** Ends what is due, retries failed slots, polls the service when due (one poll at a time), and offers free slots to the line. Never waits. */
  sweep(): void {
    if (!this.#initialized) return;
    const now = this.#now(); const t = this.#t;
    for (const [subject, ended] of this.#ended) if (now - Date.parse(ended.endedAt) >= t.endedMs) this.#ended.delete(subject);
    for (const place of [...this.#places.values()]) {
      const lease = place.lease;
      const reason = now >= place.session.exp ? 'session-ended' : lease && now >= lease.expires ? 'expired' : lease && !lease.claimed && now - lease.granted >= t.claimMs ? 'unclaimed'
        : now - place.heartbeat >= (lease ? t.idleMs : t.queueIdleMs) ? 'idle' : lease?.resetting && now - lease.resetAt >= t.resetDeadlineMs ? 'slot-failed' : null;
      if (reason) this.#end(place, reason);
    }
    for (const [slot, s] of this.#slots) if (s.state === 'unavailable' && this.#service?.availability === 'available' && now >= s.retryAt && !this.#holder(slot)) void this.#return(slot, null);
    if (now >= this.#nextPoll && !this.#polling) this.#poll(now);
    this.#grant(now);
  }
  #poll(now: number): void {
    const busy = [...this.#places.values()].some(p => p.lease?.resetting) || [...this.#slots.values()].some(s => s.state === 'resetting');
    this.#nextPoll = now + (busy ? SANDBOX_SWEEP_MS : this.#t.pollMs); this.#polling = true;
    const sent = new Map([...this.#slots].map(([slot, s]) => [slot, s.busy ? -1 : s.version]));
    const work = this.#client.request('/sandbox/v1/status').catch(() => null).then(r => {
      this.#polling = false; const at = this.#now();
      if (r?.status === 200 && isPlainObject(r.body)) this.#reconcile(r.body as unknown as SandboxServiceStatus, at, sent);
      else if (at - this.#lastSeen >= this.#t.failMs) {
        this.#service = null;
        for (const place of [...this.#places.values()]) if (place.lease) this.#end(place, 'slot-failed');
        for (const s of this.#slots.values()) { s.state = 'unavailable'; s.retryAt = at + this.#t.retryMs; }
      }
      this.#grant(at);
    });
    this.#pending.add(work); void work.finally(() => this.#pending.delete(work));
  }
  /** Applies a status answer, except to a slot whose state the field station changed after the poll was sent. */
  #reconcile(status: SandboxServiceStatus, now: number, sent: ReadonlyMap<SlotId, number>): void {
    const restarted = this.#bootId !== null && status.bootId !== this.#bootId;
    this.#service = status; this.#bootId = status.bootId; this.#lastSeen = now;
    for (const [slot, s] of this.#slots) {
      if (sent.get(slot) !== s.version) continue;
      const remote = status.slots.find(r => r.slot === slot); const place = this.#holder(slot); const lease = place?.lease;
      if (place && lease) {
        if (!remote || remote.state === 'failed' || remote.lease?.leaseId !== lease.id) { this.#end(place, restarted ? 'sandbox-restarted' : 'slot-failed'); continue; }
        if (lease.resetting && remote.state === 'leased' && remote.lease.studyId === lease.studyId) lease.resetting = false;
        continue;
      }
      if (place) continue;
      if (!remote || remote.state === 'failed') { if (s.state !== 'unavailable') { s.state = 'unavailable'; s.retryAt = now + this.#t.retryMs; } continue; }
      if (remote.state === 'ready' && s.state !== 'unavailable') s.state = 'ready';
      else if (remote.state === 'leased' || remote.lease) void this.#return(slot, null);
      else if (s.state === 'resetting' && now - s.resetAt >= this.#t.resetDeadlineMs) { s.state = 'unavailable'; s.retryAt = now + this.#t.retryMs; }
      else if (remote.state === 'ready' && s.state === 'unavailable' && now >= s.retryAt) s.state = 'ready';
    }
  }
  /** Offers each ready slot to the head of the line. The place holds the lease once the service has granted it; a grant for a place that has gone meanwhile is returned. */
  #grant(now: number): void {
    const service = this.#service;
    if (service?.availability !== 'available') return;
    for (const [slot, s] of this.#slots) {
      if (s.state !== 'ready') continue;
      const place = [...this.#places.values()].find(p => !p.lease && !p.offer);
      if (!place) break;
      const lease: Lease = { id: randomUUID(), studyId: randomUUID(), slot, granted: now, expires: Math.min(now + this.#t.leaseMs, place.session.exp), claimed: false, resetting: false, resetAt: 0, ops: { tokens: this.#t.opsBurst, at: now }, runtime: service.runtime! };
      s.state = 'leased';
      const done = this.#slotCall(s, `/sandbox/v1/slots/${slot}/lease`, 'PUT', { leaseId: lease.id, studyId: lease.studyId, expiresAt: iso(lease.expires) }, r => {
        if (place.offer?.lease === lease) delete place.offer;
        if (r?.status !== 200) { s.state = 'unavailable'; s.retryAt = this.#now() + this.#t.retryMs; return; }
        if (this.#places.get(place.session.subject) === place) place.lease = lease; else void this.#return(slot, lease.id);
      });
      place.offer = { lease, done };
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
    let place = this.#places.get(session.subject);
    if (!place) {
      if (this.status().availability !== 'available') throw new SandboxFault('sandbox-unavailable');
      if (this.#cap.full(address)) throw new SandboxFault('too-many-places');
      if ([...this.#places.values()].filter(p => !p.lease).length >= this.#t.queueMax) throw new SandboxFault('queue-full');
      this.#ended.delete(session.subject); place = { session, address, joined: this.#now(), heartbeat: this.#now() }; this.#places.set(session.subject, place); this.sweep();
    }
    // A slot offered to this place: answer once the service has granted it (or not), so a free slot is `ready` at once.
    await place.offer?.done;
    return this.view(session);
  }
  async leave(session: SessionClaims): Promise<SandboxLease> { const place = this.#places.get(session.subject); if (place) this.#end(place, place.lease ? 'returned' : 'left'); this.sweep(); return this.view(session); }
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
    // A request the field station itself cannot send (SandboxFault) is refused as such; it says nothing about the slot.
    try { response = await this.#client.request(`/sandbox/v1/slots/${lease.slot}/${path}`, 'POST', body); } catch (error) { if (error instanceof SandboxFault) throw error; }
    // 5xx answers the slot gave on purpose (a native SOURCE_UNAVAILABLE, a withheld download) pass through; only an unreachable or failed slot ends the lease.
    const answer = response?.body; const error = isPlainObject(answer) && isPlainObject(answer['error']) ? answer['error'] : null;
    const details = error && isPlainObject(error['details']) ? error['details'] : null;
    if (response && isPlainObject(answer) && (response.status < 500 || answer['code'] !== 'slot-unavailable' && details?.['code'] !== 'slot-unavailable' && (error !== null || answer['code'] !== undefined))) return response;
    const place = this.#places.get(session.subject);
    if (place?.lease !== lease || lease.studyId !== studyId) return null;
    this.#end(place, 'slot-failed');
    throw new SandboxFault('slot-unavailable');
  }
  async claim(session: SessionClaims): Promise<SandboxConnection> {
    const lease = this.#lease(session); const r = await this.#call(session, lease, lease.studyId, 'claim', { leaseId: lease.id, studyId: lease.studyId });
    // The lease may have ended, or its study been reset, while the slot answered.
    if (this.#places.get(session.subject)?.lease !== lease) throw new SandboxFault('no-lease');
    if (!r) throw new SandboxFault('stale-study');
    if (r.status !== 200) throw fault(r.body);
    lease.claimed = true;
    return { leaseId: lease.id, studyId: lease.studyId, expiresAt: iso(lease.expires), gatewayOrigin: this.#origin, gatewayPath: `/sandbox/${lease.slot}/socket.io` };
  }
  /** Discards the study (candidate, runtime state, traces, previews) and starts a new studyId on the same slot and lease. */
  async reset(session: SessionClaims): Promise<SandboxLease> {
    const lease = this.#lease(session);
    if (lease.resetting) return this.view(session);
    const studyId = randomUUID(); lease.studyId = studyId; lease.resetting = true; lease.resetAt = this.#now(); this.#nextPoll = 0;
    const r = await this.#call(session, lease, studyId, 'reset', { leaseId: lease.id, studyId });
    if (!r || r.status >= 300) { const place = this.#places.get(session.subject); if (place?.lease === lease && lease.studyId === studyId) this.#end(place, 'slot-failed'); throw new SandboxFault('slot-unavailable'); }
    return this.view(session);
  }
  /** A token bucket: the published workbench sends several reads at once when it mounts, so a burst is allowed and the rate holds over time. */
  #throttle(lease: Lease): void {
    const now = this.#now(); const ops = lease.ops;
    ops.tokens = Math.min(this.#t.opsBurst, ops.tokens + ((now - ops.at) / 1000) * this.#t.opsPerSecond); ops.at = now;
    if (ops.tokens < 1) throw new SandboxFault('too-many-requests'); ops.tokens -= 1;
  }
  /** The session's active lease and current study for one slot call, after a sweep and a heartbeat, within the operation budget. */
  #ticket(session: SessionClaims): { lease: Lease; studyId: string } {
    this.sweep(); this.heartbeat(session); const lease = this.#lease(session, true); this.#throttle(lease); return { lease, studyId: lease.studyId };
  }
  /** One allowlisted operation on the session's own slot, in its current study. An answer for a study that has since been reset or ended is discarded. */
  async operate(session: SessionClaims, op: SandboxOperation, input: unknown): Promise<unknown> {
    const ticket = this.#ticket(session);
    const r = await this.#call(session, ticket.lease, ticket.studyId, 'ops', { leaseId: ticket.lease.id, studyId: ticket.studyId, op, input });
    const current = this.#places.get(session.subject)?.lease;
    if (!r || current !== ticket.lease || current.studyId !== ticket.studyId) throw new SandboxFault('stale-study', undefined, op === 'traces' ? { wbCode: 'TRACE_CURSOR_EXPIRED', wbStatus: 410 } : {});
    const body = r.body as { ok?: unknown; data?: unknown; error?: unknown };
    if (r.status === 200 && isPlainObject(body) && body.ok === true) return body.data;
    throw new WorkbenchFailure(r.status, isPlainObject(body) ? body.error : undefined);
  }
  async repro(session: SessionClaims): Promise<SandboxReproDownload> {
    const ticket = this.#ticket(session);
    const r = await this.#call(session, ticket.lease, ticket.studyId, 'repro', { leaseId: ticket.lease.id, studyId: ticket.studyId });
    const current = this.#places.get(session.subject)?.lease;
    if (!r || current !== ticket.lease || current.studyId !== ticket.studyId) throw new SandboxFault('stale-study');
    if (r.status !== 200) throw fault(r.body);
    return r.body as SandboxReproDownload;
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
    const e = isPlainObject(raw) ? raw : {}; const details = bounded(e['details']);
    this.error = streamError(isErrorCode(e['code']) ? e['code'] : 'INTERNAL', { message: typeof e['message'] === 'string' ? e['message'].slice(0, 300) : 'The sandbox could not answer.', ...(typeof e['retryable'] === 'boolean' ? { retryable: e['retryable'] } : {}), ...(details ? { details } : {}) });
  }
}

const DETAILS_BYTES = 16_384;
/** The slot's error details, at most 16 KB: a long `issues` list is cut and flagged (`issuesTruncated`), and `code` is always kept. */
function bounded(raw: unknown): Record<string, Json> | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (JSON.stringify(raw).length <= DETAILS_BYTES) return raw as Record<string, Json>;
  const code = typeof raw['code'] === 'string' ? { code: raw['code'].slice(0, 64) } : {};
  if (!Array.isArray(raw['issues'])) return 'code' in code ? code : undefined;
  const issues: Json[] = []; let size = 256;
  for (const issue of raw['issues'] as Json[]) { size += JSON.stringify(issue).length + 1; if (size > DETAILS_BYTES) break; issues.push(issue); }
  return { ...code, issues, issuesTruncated: true };
}

export function configuredSandbox(env: NodeJS.ProcessEnv, gatewayOrigin: string, cap?: AddressCap): SandboxPool | undefined {
  const url = env['SANDBOX_API_URL'];
  if (!url) return undefined;
  const origin = new URL(url).origin; const token = env['SANDBOX_SERVICE_TOKEN'];
  if (!token || token.length < 32) throw new Error('SANDBOX_SERVICE_TOKEN needs 32 characters.');
  const positive = (key: string, fallback: number): number => { const n = Number(env[key] ?? fallback); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a positive integer.`); return n; };
  const count = positive('SANDBOX_SLOTS', 3); if (count > 3) throw new Error('At most three sandbox slots are supported.');
  return new SandboxPool({ client: sandboxClient(origin, token), slots: Array.from({ length: count }, (_, i) => i + 1 as SlotId), gatewayOrigin, ...(cap ? { cap } : {}), timings: { leaseMs: positive('SANDBOX_LEASE_SECONDS', 600) * 1000, queueMax: positive('SANDBOX_QUEUE_MAX', 30) } });
}

/** The HTTP client for the sandbox service's private API at `origin`, with the service token. */
export function sandboxClient(origin: string, token: string): SandboxClient {
  return {
    async request(path, method = 'GET', body) {
      let payload: string | undefined;
      try { payload = body === undefined ? undefined : JSON.stringify(body); } catch { throw invalid('The request could not be encoded.'); }
      const timeout = /\/(?:ops|repro)$/.test(path) ? SANDBOX_OPS_TIMEOUT_MS : SANDBOX_CALL_TIMEOUT_MS;
      const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(timeout) });
      return { status: response.status, body: await response.json() as unknown };
    }
  };
}
