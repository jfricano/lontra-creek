import { randomUUID } from 'node:crypto';
import type { SessionClaims } from '../sessions.ts';
import type { BenchFailureProfile, BenchId, BenchStatus, LabAction, LabActionResult, LabEndReason, LabFeedPage, LabLease, LabStatus, LabToken } from './contract.ts';
import { BenchNotFound, LabError, MAX_LEASE_MS } from './errors.ts';
import { AddressCap } from '../places.ts';
import type { CapabilityOptions } from './capabilities.ts';
import { FAILURE_PROFILES } from './bench.ts';
import { LabIntents, type IntentLease, type IntentPool } from './intents.ts';
import type { LabStudies, ScenarioSink } from './studies.ts';
export interface BenchClient { call<T>(bench: BenchId, path: string, method?: string, body?: unknown): Promise<T>; }
/** The publisher gate (studies.ts): opened when a lease is granted on a study, closed before any reset is asked for. `current` is the study it holds open. */
export interface StudyGate { open(bench: BenchId, studyId: string): void; close(bench: BenchId, studyId: string): Promise<unknown>; current(bench: BenchId): string | null; }
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
  readonly #cap: AddressCap;
  readonly #studies: StudyGate | undefined;
  /** LAB_FAILURE_HANDLING: a bench is granted only when it reports this profile (and, unless `off`, a durable journal). */
  readonly #profile: BenchFailureProfile;
  /** What the capability summary reports for this deployment (section 12.3). */
  readonly capabilityOptions: CapabilityOptions;
  /** The source-failures intents (intents.ts); configuredLab attaches them. */
  intents: LabIntents | undefined;
  readonly #ending: ((subject: string, leaseId: string) => void)[] = [];
  #tail: Promise<unknown> = Promise.resolve();
  /** Set once initialize() has reset every bench. The API listens first, and nothing is granted or polled before then. */
  #initialized = false;
  constructor(options: { client: BenchClient; benches: BenchId[]; gatewayOrigin: string; now?: () => number; leaseMs?: number; queueMax?: number; cap?: AddressCap; studies?: StudyGate; capabilities?: CapabilityOptions }) {
    this.#client = options.client; this.#studies = options.studies; this.capabilityOptions = options.capabilities ?? { profile: 'off', localExercises: false }; this.#profile = this.capabilityOptions.profile; this.#now = options.now ?? Date.now; this.#leaseMs = options.leaseMs ?? MAX_LEASE_MS; this.#queueMax = options.queueMax ?? 50; this.#origin = options.gatewayOrigin;
    if (this.#leaseMs > MAX_LEASE_MS) throw new RangeError(`A lease can last at most ${MAX_LEASE_MS / 1000} seconds; benches refuse longer ones.`);
    this.#cap = options.cap ?? new AddressCap(); this.#cap.register(this);
    for (const bench of options.benches) this.#slots.set(bench, { state: 'unavailable', resetAt: 0, retryAt: 0, lastSeen: this.#now(), nextPoll: 0 });
  }
  /** Places (leases and places in line) this client address holds here; the cap counts every pool. */
  placesFor(address: string): number { return [...this.#places.values()].filter(p => p.address === address).length; }
  get enabled(): boolean { return this.#slots.size > 0; }
  run<T>(operation: () => Promise<T>): Promise<T> { const next = this.#tail.then(operation); this.#tail = next.catch(() => undefined); return next; }
  async initialize(): Promise<void> { await this.run(async () => { for (const bench of this.#slots.keys()) await this.#reset(bench); this.#initialized = true; }); }
  async #reset(bench: BenchId): Promise<void> {
    const slot = this.#slots.get(bench)!; slot.state = 'resetting'; slot.resetAt = this.#now(); slot.nextPoll = 0;
    // Shut the publisher gate on the study the field station opened, before the bench is asked to discard it (LC11-ADR-02
    // step 3). Never one named only by a polled status: that may be a study the bench is still provisioning.
    const study = this.#studies?.current(bench);
    if (study) await this.#studies!.close(bench, study).catch(() => undefined);
    try { await this.#client.call(bench, '/bench/v1/reset', 'POST', { leaseId: null }); }
    catch { slot.state = 'unavailable'; slot.retryAt = this.#now() + 30_000; }
  }
  /** Called when a lease ends, before its bench is reset: intents cancel its unfinished operations. */
  onEnd(listener: (subject: string, leaseId: string) => void): void { this.#ending.push(listener); }
  /** A bench is eligible only with the deployment's failure-handling profile: an older bench reports none, which is `off`. */
  #eligible(status: BenchStatus): boolean {
    const failures = status.failures ?? { profile: 'off', durable: false, handlerBuildId: null };
    return status.readiness?.cleanLease === true && failures.profile === this.#profile && (this.#profile === 'off' || failures.durable);
  }
  async #end(place: Place, reason: LabEndReason): Promise<void> {
    this.#places.delete(place.session.subject);
    if (place.lease) for (const listener of this.#ending) listener(place.session.subject, place.lease.id);
    this.#ended.set(place.session.subject, { status: 'ended', now: iso(this.#now()), reason, endedAt: iso(this.#now()), bench: place.lease?.bench ?? null });
    if (place.lease) await this.#reset(place.lease.bench);
  }
  async sweep(): Promise<void> {
    if (!this.#initialized) return;
    const now = this.#now();
    for (const [subject, ended] of this.#ended) if (now - Date.parse(ended.endedAt) >= 60_000) this.#ended.delete(subject);
    for (const place of this.#places.values()) {
      const lease = place.lease;
      const reason = now >= place.session.exp ? 'session-ended' : lease && now >= lease.expires ? 'expired' : lease && !lease.claimed && now - lease.granted >= 30_000 ? 'unclaimed' : now - place.heartbeat >= (lease ? 30_000 : 90_000) ? 'idle' : null;
      if (reason) await this.#end(place, reason);
    }
    for (const [bench, slot] of this.#slots) {
      if (slot.state === 'unavailable') {
        if (now < slot.retryAt) continue;
        // A slow reset may have finished since the bench was marked unavailable: one that now reports a clean study is ready, not reset again.
        const status = await this.#client.call<BenchStatus>(bench, '/bench/v1/status').catch(() => null);
        if (status?.state === 'ready' && this.#eligible(status)) { slot.status = status; slot.lastSeen = this.#now(); slot.nextPoll = slot.lastSeen + 5000; slot.state = 'ready'; continue; }
        await this.#reset(bench);
      }
      if (now < slot.nextPoll) continue;
      slot.nextPoll = now + 5000;
      try {
        const status = await this.#client.call<BenchStatus>(bench, '/bench/v1/status');
        // Each bench call can take seconds: time after one is read again, never taken from the sweep's start.
        const at = this.#now();
        const place = [...this.#places.values()].find(p => p.lease?.bench === bench);
        // A leased bench whose process restarted reports `starting` until it has read its study back: as long as an unanswered one.
        if (place && status.state === 'starting' && at - slot.lastSeen < 15_000) { slot.status = status; continue; }
        slot.status = status; slot.lastSeen = at;
        if (place && (status.state !== 'leased' || status.lease?.leaseId !== place.lease!.id)) { await this.#end(place, 'bench-failed'); continue; }
        // Only a clean-lease-eligible bench is granted (LC11-ADR-02). A leased bench whose source is held stays leased.
        // A ready bench that isn't eligible (its last cleanup didn't finish) is reset again on the usual schedule.
        if (!place && status.state === 'ready') { if (this.#eligible(status)) slot.state = 'ready'; else { slot.state = 'unavailable'; slot.retryAt = at + 30_000; } }
        else if (status.state === 'failed' || slot.state === 'resetting' && at - slot.resetAt >= 60_000) { slot.state = 'unavailable'; slot.retryAt = at + 30_000; }
      } catch { const at = this.#now(); if (at - slot.lastSeen < 15_000) continue; const place = [...this.#places.values()].find(p => p.lease?.bench === bench); if (place) await this.#end(place, 'bench-failed'); slot.state = 'unavailable'; slot.retryAt = this.#now() + 30_000; }
    }
    for (const [bench, slot] of this.#slots) {
      if (slot.state !== 'ready') continue;
      const place = [...this.#places.values()].find(p => !p.lease);
      if (!place) break;
      const at = this.#now();
      const lease = { id: randomUUID(), bench, granted: at, expires: Math.min(at + this.#leaseMs, place.session.exp), claimed: false, nextAction: at };
      try {
        slot.status = await this.#client.call<BenchStatus>(bench, '/bench/v1/lease', 'PUT', { leaseId: lease.id, expiresAt: iso(lease.expires) });
        // The leased study is now open for scenario publication. One the gate refuses (closed before, or none named) is
        // never handed to a visitor: the bench is reset instead, and the visitor keeps their place.
        if (this.#studies && !this.#open(bench, slot.status.study?.studyId)) { await this.#reset(bench); continue; }
        // A lease's 30-second idle limit counts from the grant, not from a poll made in line under the queue's 90-second limit.
        place.lease = lease; place.heartbeat = lease.granted; slot.state = 'leased';
      }
      catch { slot.state = 'unavailable'; slot.retryAt = this.#now() + 30_000; }
    }
  }
  #open(bench: BenchId, studyId: string | undefined): boolean { if (!studyId) return false; try { this.#studies!.open(bench, studyId); return true; } catch { return false; } }
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
    if (this.#cap.full(address)) throw new LabError('too-many-places', 429);
    if ([...this.#places.values()].filter(p => !p.lease).length >= this.#queueMax) throw new LabError('queue-full', 503);
    this.#ended.delete(session.subject); this.#places.set(session.subject, { session, address, joined: this.#now(), heartbeat: this.#now() }); await this.sweep(); return this.view(session);
  }
  async leave(session: SessionClaims): Promise<LabLease> { const place = this.#places.get(session.subject); if (place) await this.#end(place, place.lease ? 'returned' : 'left'); await this.sweep(); return this.view(session); }
  #lease(session: SessionClaims, active = false): NonNullable<Place['lease']> { const lease = this.#places.get(session.subject)?.lease; if (!lease || active && !lease.claimed) throw new LabError('no-lease', 409); return lease; }
  async #call<T>(session: SessionClaims, path: string, body?: unknown): Promise<T> { const lease = this.#lease(session); try { return await this.#client.call<T>(lease.bench, path, body === undefined ? 'GET' : 'POST', body); } catch (error) { if (error instanceof LabError && error.status < 500) throw error; await this.#end(this.#places.get(session.subject)!, 'bench-failed'); throw new LabError('bench-unavailable', 503); } }
  async token(session: SessionClaims): Promise<LabToken> { const lease = this.#lease(session); const token = await this.#call<{ token: string; expiresAt: string }>(session, '/bench/v1/tokens', { leaseId: lease.id }); lease.claimed = true; return { ...token, bench: lease.bench, gatewayOrigin: this.#origin, gatewayPath: `/lab/${lease.bench}/socket.io` }; }
  async action(session: SessionClaims, action: LabAction): Promise<LabActionResult> { const lease = this.#lease(session, true); if (this.#now() < lease.nextAction) throw new LabError('too-many-actions', 429); const result = await this.#call<{ at: string; scenario: BenchStatus['scenario'] }>(session, '/bench/v1/actions', { leaseId: lease.id, action }); lease.nextAction = this.#now() + 1000; this.#slots.get(lease.bench)!.status!.scenario = result.scenario; return { action, at: result.at, nextActionAt: iso(lease.nextAction), benchState: result.scenario }; }
  /** The intent surface's view of the pool (intents.ts). */
  intentPool(): IntentPool {
    const place = (subject: string): Place => { const found = this.#places.get(subject); if (!found?.lease?.claimed) throw new LabError('no-lease', 409); return found; };
    return {
      lease: (subject): IntentLease => { const lease = place(subject).lease!; return { id: lease.id, bench: lease.bench, studyId: this.#slots.get(lease.bench)?.status?.study?.studyId ?? null, expires: lease.expires }; },
      spend: subject => { const lease = place(subject).lease!; if (this.#now() < lease.nextAction) throw new LabError('too-many-actions', 429); lease.nextAction = this.#now() + 1000; },
      read: (subject, path) => this.#call(place(subject).session, path),
      bench: (bench, path, method, body) => this.#client.call(bench, path, method, body)
    };
  }
  async feed(session: SessionClaims, after?: string): Promise<LabFeedPage> { const lease = this.#lease(session, true); return this.#call(session, `/bench/v1/feed?leaseId=${encodeURIComponent(lease.id)}&after=${encodeURIComponent(after ?? '')}`); }
}
/**
 * A bench's error answer as the field station's. The bench's own code passes through
 * where its status allows it, so a bench's `no-lease` reaches the visitor as `no-lease`
 * rather than `not-applicable`. Any other answer is the bench failing: 503
 * bench-unavailable, which ends the lease. A 404 is that too, marked BenchNotFound so an
 * operation lookup can tell a bench that forgot the operation (it restarted).
 */
export function benchError(status: number, code: unknown): LabError {
  if (status === 409) return new LabError(code === 'no-lease' ? 'no-lease' : 'not-applicable', 409);
  if (status === 429) return new LabError('too-many-actions', 429);
  if (status === 400) return new LabError('invalid-request', 400);
  if (status === 404) return new BenchNotFound();
  return new LabError('bench-unavailable', 503);
}
/** The deployment's capability options from the environment: LAB_FAILURE_HANDLING (default `off`) and LAB_LOCAL_EXERCISES (`1`). */
export function capabilityOptions(env: NodeJS.ProcessEnv): CapabilityOptions {
  const profile = (env['LAB_FAILURE_HANDLING'] ?? 'off') as BenchFailureProfile;
  if (!FAILURE_PROFILES.includes(profile)) throw new Error('LAB_FAILURE_HANDLING must be off, retry, or quarantine.');
  return { profile, localExercises: env['LAB_LOCAL_EXERCISES'] === '1' };
}
export function configuredLab(env: NodeJS.ProcessEnv, gatewayOrigin: string, cap?: AddressCap, studies?: LabStudies, sink?: ScenarioSink): { pool: LeasePool; tokens: string[] } {
  const urls = (env['LAB_BENCH_API_URLS'] ?? '').split(',').filter(Boolean).map(value => new URL(value).origin);
  if (urls.length > 3) throw new Error('At most three Lab benches are supported.');
  const tokens = urls.map((_, i) => { const token = env[`LAB_BENCH_${i + 1}_SERVICE_TOKEN`]; if (!token || token.length < 32) throw new Error('Each Lab service token needs 32 characters.'); return token; });
  const positive = (key: string, fallback: number): number => { const n = Number(env[key] ?? fallback); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${key} must be a positive integer.`); return n; };
  const client: BenchClient = { async call<T>(bench: BenchId, path: string, method = 'GET', body?: unknown): Promise<T> { const response = await fetch(`${urls[bench - 1]}${path}`, { method, headers: { authorization: `Bearer ${tokens[bench - 1]}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) }); if (!response.ok) { const error = benchError(response.status, (await response.json().catch(() => ({})) as { code?: unknown }).code); if (error.code === 'bench-unavailable' && !(error instanceof BenchNotFound && path.startsWith('/bench/v1/operations/'))) console.error(`${new Date().toISOString()} Lab bench ${bench} answered ${response.status} to ${method} ${path.split('?')[0]}.`); throw error; } return await response.json() as T; } };
  const leaseSeconds = positive('LAB_LEASE_SECONDS', MAX_LEASE_MS / 1000);
  if (leaseSeconds * 1000 > MAX_LEASE_MS) throw new Error(`LAB_LEASE_SECONDS must be at most ${MAX_LEASE_MS / 1000}: each bench refuses longer leases.`);
  const pool = new LeasePool({ client, benches: urls.map((_, i) => i + 1 as BenchId), gatewayOrigin, leaseMs: leaseSeconds * 1000, queueMax: positive('LAB_QUEUE_MAX', 50), capabilities: capabilityOptions(env), ...(cap ? { cap } : {}), ...(studies ? { studies } : {}) });
  attachIntents(pool, { ...(studies ? { studies } : {}), ...(sink ? { sink } : {}) });
  return { pool, tokens };
}
/** Gives a pool its source-failures intents: they follow its leases and end with them. */
export function attachIntents(pool: LeasePool, options: { studies?: LabStudies; sink?: ScenarioSink; now?: () => number; pollMs?: number } = {}): LabIntents {
  const intents = new LabIntents({ pool: pool.intentPool(), ...options });
  pool.onEnd((subject, leaseId) => intents.ended(subject, leaseId));
  pool.intents = intents; return intents;
}
