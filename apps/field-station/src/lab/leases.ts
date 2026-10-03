import { randomUUID } from 'node:crypto';
import type { SessionClaims } from '../sessions.ts';
import type { BenchId, BenchStatus, LabAction, LabActionResult, LabEndReason, LabFeedPage, LabLease, LabStatus, LabToken } from './contract.ts';
import { LabError, MAX_LEASE_MS } from './errors.ts';
export interface BenchClient { call<T>(bench: BenchId, path: string, method?: string, body?: unknown): Promise<T>; }
/** The publisher gate (studies.ts): opened when a lease is granted on a study, closed before any reset is asked for. */
export interface StudyGate { open(bench: BenchId, studyId: string): void; close(bench: BenchId, studyId: string): Promise<unknown>; }
interface Place { session: SessionClaims; address: string; joined: number; heartbeat: number; lease?: { id: string; bench: BenchId; granted: number; expires: number; claimed: boolean; nextAction: number }; }
interface Slot { state: LabStatus['benches'][number]['state']; status?: BenchStatus; resetAt: number; retryAt: number; lastSeen: number; nextPoll: number; }
const iso = (n: number): string => new Date(n).toISOString();
/** All state transitions are serialized, including remote calls: concurrent joins cannot double-book. */
export class LeasePool {
  readonly #client: BenchClient;
  readonly #slots = new Map<BenchId, Slot>();
  readonly #places = new Map<string, Place>();
  readonly #ended = new Map<string, Extract<LabLease, { status: 'ended' }>>();
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #queueMax: number;
  readonly #origin: string;
  readonly #studies: StudyGate | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(options: { client: BenchClient; benches: BenchId[]; gatewayOrigin: string; now?: () => number; leaseMs?: number; queueMax?: number; studies?: StudyGate }) {
    this.#client = options.client; this.#studies = options.studies; this.#now = options.now ?? Date.now; this.#leaseMs = options.leaseMs ?? MAX_LEASE_MS; this.#queueMax = options.queueMax ?? 50; this.#origin = options.gatewayOrigin;
    if (this.#leaseMs > MAX_LEASE_MS) throw new RangeError(`A lease can last at most ${MAX_LEASE_MS / 1000} seconds; benches refuse longer ones.`);
    for (const bench of options.benches) this.#slots.set(bench, { state: 'unavailable', resetAt: 0, retryAt: 0, lastSeen: this.#now(), nextPoll: 0 });
  }
  get enabled(): boolean { return this.#slots.size > 0; }
  run<T>(operation: () => Promise<T>): Promise<T> { const next = this.#tail.then(operation); this.#tail = next.catch(() => undefined); return next; }
  async initialize(): Promise<void> { await this.run(async () => { for (const bench of this.#slots.keys()) await this.#reset(bench); }); }
  async #reset(bench: BenchId): Promise<void> {
    const slot = this.#slots.get(bench)!; slot.state = 'resetting'; slot.resetAt = this.#now(); slot.nextPoll = 0;
    // Shut the publisher gate on the bench's study before the bench is asked to discard it (LC11-ADR-02 step 3).
    const study = slot.status?.study?.studyId;
    if (study) await this.#studies?.close(bench, study).catch(() => undefined);
    try { await this.#client.call(bench, '/bench/v1/reset', 'POST', { leaseId: null }); }
    catch { slot.state = 'unavailable'; slot.retryAt = this.#now() + 30_000; }
  }
  async #end(place: Place, reason: LabEndReason): Promise<void> {
    this.#places.delete(place.session.subject);
    this.#ended.set(place.session.subject, { status: 'ended', now: iso(this.#now()), reason, endedAt: iso(this.#now()), bench: place.lease?.bench ?? null });
    if (place.lease) await this.#reset(place.lease.bench);
  }
  async sweep(): Promise<void> {
    const now = this.#now();
    for (const [subject, ended] of this.#ended) if (now - Date.parse(ended.endedAt) >= 60_000) this.#ended.delete(subject);
    for (const place of this.#places.values()) {
      const lease = place.lease;
      const reason = now >= place.session.exp ? 'session-ended' : lease && now >= lease.expires ? 'expired' : lease && !lease.claimed && now - lease.granted >= 30_000 ? 'unclaimed' : now - place.heartbeat >= (lease ? 30_000 : 90_000) ? 'idle' : null;
      if (reason) await this.#end(place, reason);
    }
    for (const [bench, slot] of this.#slots) {
      if (slot.state === 'unavailable') { if (now >= slot.retryAt) await this.#reset(bench); else continue; }
      if (now < slot.nextPoll) continue;
      slot.nextPoll = now + 5000;
      try {
        const status = await this.#client.call<BenchStatus>(bench, '/bench/v1/status');
        slot.status = status; slot.lastSeen = now;
        const place = [...this.#places.values()].find(p => p.lease?.bench === bench);
        if (place && (status.state !== 'leased' || status.lease?.leaseId !== place.lease!.id)) { await this.#end(place, 'bench-failed'); continue; }
        // Only a clean-lease-eligible bench is granted (LC11-ADR-02). A leased bench whose source is held stays leased.
        // A ready bench that isn't eligible (its last cleanup didn't finish) is reset again on the usual schedule.
        if (!place && status.state === 'ready') { if (status.readiness?.cleanLease === true) slot.state = 'ready'; else { slot.state = 'unavailable'; slot.retryAt = now + 30_000; } }
        else if (status.state === 'failed' || slot.state === 'resetting' && now - slot.resetAt >= 60_000) { slot.state = 'unavailable'; slot.retryAt = now + 30_000; }
      } catch { if (now - slot.lastSeen < 15_000) continue; const place = [...this.#places.values()].find(p => p.lease?.bench === bench); if (place) await this.#end(place, 'bench-failed'); slot.state = 'unavailable'; slot.retryAt = now + 30_000; }
    }
    for (const [bench, slot] of this.#slots) {
      if (slot.state !== 'ready') continue;
      const place = [...this.#places.values()].find(p => !p.lease);
      if (!place) break;
      const lease = { id: randomUUID(), bench, granted: now, expires: Math.min(now + this.#leaseMs, place.session.exp), claimed: false, nextAction: now };
      try {
        slot.status = await this.#client.call<BenchStatus>(bench, '/bench/v1/lease', 'PUT', { leaseId: lease.id, expiresAt: iso(lease.expires) }); place.lease = lease; slot.state = 'leased';
        // The leased study is now open for scenario publication. A bench that names no study gets none.
        if (slot.status.study) { try { this.#studies?.open(bench, slot.status.study.studyId); } catch { /* a closed study stays closed: publication is refused */ } }
      }
      catch { slot.state = 'unavailable'; slot.retryAt = now + 30_000; }
    }
  }
  heartbeat(session: SessionClaims): void { const place = this.#places.get(session.subject); if (place && this.#now() - place.heartbeat < (place.lease ? 30_000 : 90_000)) place.heartbeat = this.#now(); }
  status(): LabStatus {
    const leases = [...this.#places.values()].flatMap(p => p.lease ? [p.lease] : []);
    return { enabled: this.enabled, now: iso(this.#now()), benches: [...this.#slots].map(([bench, slot]) => ({ bench, state: slot.state })), queueLength: [...this.#places.values()].filter(p => !p.lease).length, nextFreeAt: [...this.#slots.values()].some(s => s.state === 'ready') || !leases.length ? null : iso(Math.min(...leases.map(l => l.expires))) };
  }
  view(session: SessionClaims): LabLease {
    const now = iso(this.#now()); const place = this.#places.get(session.subject);
    if (!place) return { ...(this.#ended.get(session.subject) ?? { status: 'none' }), now };
    const lease = place.lease;
    if (!lease) { const queue = [...this.#places.values()].filter(p => !p.lease); return { status: 'queued', now, position: queue.indexOf(place) + 1, queueLength: queue.length, joinedAt: iso(place.joined), nextFreeAt: this.status().nextFreeAt, sessionExpiresAt: iso(place.session.exp) }; }
    return { status: lease.claimed ? 'active' : 'ready', now, leaseId: lease.id, bench: lease.bench, grantedAt: iso(lease.granted), expiresAt: iso(lease.expires), claimBy: lease.claimed ? null : iso(lease.granted + 30_000), nextActionAt: iso(lease.nextAction), benchState: this.#slots.get(lease.bench)!.status!.scenario };
  }
  async join(session: SessionClaims, address: string): Promise<LabLease> {
    if (this.#places.has(session.subject)) return this.view(session);
    if (!this.enabled || [...this.#slots.values()].every(s => s.state === 'unavailable')) throw new LabError('lab-unavailable', 503);
    if ([...this.#places.values()].filter(p => p.address === address).length >= 2) throw new LabError('too-many-places', 429);
    if ([...this.#places.values()].filter(p => !p.lease).length >= this.#queueMax) throw new LabError('queue-full', 503);
    this.#ended.delete(session.subject); this.#places.set(session.subject, { session, address, joined: this.#now(), heartbeat: this.#now() }); await this.sweep(); return this.view(session);
  }
  async leave(session: SessionClaims): Promise<LabLease> { const place = this.#places.get(session.subject); if (place) await this.#end(place, place.lease ? 'returned' : 'left'); await this.sweep(); return this.view(session); }
  #lease(session: SessionClaims, active = false): NonNullable<Place['lease']> { const lease = this.#places.get(session.subject)?.lease; if (!lease || active && !lease.claimed) throw new LabError('no-lease', 409); return lease; }
  async #call<T>(session: SessionClaims, path: string, body?: unknown): Promise<T> { const lease = this.#lease(session); try { return await this.#client.call<T>(lease.bench, path, body === undefined ? 'GET' : 'POST', body); } catch (error) { if (error instanceof LabError && error.status < 500) throw error; await this.#end(this.#places.get(session.subject)!, 'bench-failed'); throw new LabError('bench-unavailable', 503); } }
  async token(session: SessionClaims): Promise<LabToken> { const lease = this.#lease(session); const token = await this.#call<{ token: string; expiresAt: string }>(session, '/bench/v1/tokens', { leaseId: lease.id }); lease.claimed = true; return { ...token, bench: lease.bench, gatewayOrigin: this.#origin, gatewayPath: `/lab/${lease.bench}/socket.io` }; }
  async action(session: SessionClaims, action: LabAction): Promise<LabActionResult> { const lease = this.#lease(session, true); if (this.#now() < lease.nextAction) throw new LabError('too-many-actions', 429); const result = await this.#call<{ at: string; scenario: BenchStatus['scenario'] }>(session, '/bench/v1/actions', { leaseId: lease.id, action }); lease.nextAction = this.#now() + 1000; this.#slots.get(lease.bench)!.status!.scenario = result.scenario; return { action, at: result.at, nextActionAt: iso(lease.nextAction), benchState: result.scenario }; }
  async feed(session: SessionClaims, after?: string): Promise<LabFeedPage> { const lease = this.#lease(session, true); return this.#call(session, `/bench/v1/feed?leaseId=${encodeURIComponent(lease.id)}&after=${encodeURIComponent(after ?? '')}`); }
}
/**
 * A bench's error answer as the field station's. The bench's own code passes through
 * where its status allows it, so a bench's `no-lease` reaches the visitor as `no-lease`
 * rather than `not-applicable`. Any other answer is the bench failing: 503
 * bench-unavailable, which ends the lease.
 */
export function benchError(status: number, code: unknown): LabError {
  if (status === 409) return new LabError(code === 'no-lease' ? 'no-lease' : 'not-applicable', 409);
  if (status === 429) return new LabError('too-many-actions', 429);
  if (status === 400) return new LabError('invalid-request', 400);
  return new LabError('bench-unavailable', 503);
}
export function configuredLab(env: NodeJS.ProcessEnv, gatewayOrigin: string, studies?: StudyGate): { pool: LeasePool; tokens: string[] } {
  const urls = (env['LAB_BENCH_API_URLS'] ?? '').split(',').filter(Boolean).map(value => new URL(value).origin);
  if (urls.length > 3) throw new Error('At most three Lab benches are supported.');
  const tokens = urls.map((_, i) => { const token = env[`LAB_BENCH_${i + 1}_SERVICE_TOKEN`]; if (!token || token.length < 32) throw new Error('Each Lab service token needs 32 characters.'); return token; });
  const positive = (key: string, fallback: number): number => { const n = Number(env[key] ?? fallback); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a positive integer.`); return n; };
  const client: BenchClient = { async call<T>(bench: BenchId, path: string, method = 'GET', body?: unknown): Promise<T> { const response = await fetch(`${urls[bench - 1]}${path}`, { method, headers: { authorization: `Bearer ${tokens[bench - 1]}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) }); if (!response.ok) throw benchError(response.status, (await response.json().catch(() => ({})) as { code?: unknown }).code); return await response.json() as T; } };
  const leaseSeconds = positive('LAB_LEASE_SECONDS', MAX_LEASE_MS / 1000);
  if (leaseSeconds * 1000 > MAX_LEASE_MS) throw new Error(`LAB_LEASE_SECONDS must be at most ${MAX_LEASE_MS / 1000}: each bench refuses longer leases.`);
  return { pool: new LeasePool({ client, benches: urls.map((_, i) => i + 1 as BenchId), gatewayOrigin, leaseMs: leaseSeconds * 1000, queueMax: positive('LAB_QUEUE_MAX', 50), ...(studies ? { studies } : {}) }), tokens };
}
