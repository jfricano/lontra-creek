import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, type Server } from 'node:http';
import { TENANT_ID } from '@lontra-creek/sim';
import { createGateway } from 'streamotter/gateway';
import { startManagementServer } from 'streamotter/gateway/management';
import { getGatewayOperator } from 'streamotter/gateway/operator';
import type { Gateway, OperatorApi, Principal, ProjectConfig, SourceStatus, Trace, Page } from 'streamotter/contracts';
import type { HandlerRegistry } from 'streamotter/gateway';
import { io, type Socket } from 'socket.io-client';
import { Kafka } from 'kafkajs';
import { readFileSync } from 'node:fs';
import { benchConfig, benchHandlers, benchEnvironment, handlerBuildId, runsUnder, type LabChannels } from './bench.ts';
import { INTENTS, SOURCE_SCENARIOS } from './capabilities.ts';
import type { BenchIncidentFacts, BenchIntent, BenchIntentRequest, BenchOperation, BenchStatus, LabAction, LabBenchState, LabScenarioId, StudySummary } from './contract.ts';
import { createJournal, hasJournal } from './journal.ts';
import { BenchFailures, SOURCE_ID, type Outcome } from './operator.ts';
import { LabFeed } from './feed.ts';
import { ACTIONS, LabError, MAX_LEASE_MS } from './errors.ts';
import { consumerGroupFor, newStudy, StudyStore, type StudyDescriptor } from './study.ts';
/** How long background polls may keep failing before the bench reports `failed`: one slow answer must not end a visitor's lease. */
export const POLL_GRACE_MS = 15_000;
/** How long a reset waits for the closing study's pending work before it carries on (LC11-ADR-02 step 4). */
export const QUIESCE_MS = 5_000;
/** A sustained calibration outage (LC11-S06's second start): more attempts than any retry budget, cleared by `scenario.restore-calibration`. */
export const SUSTAINED_BLIP = 1_000;
/** Kafka's error for a group that doesn't exist: a group that never committed is already gone. */
const GROUP_ID_NOT_FOUND = 69;
/**
 * The field station's half of a reset: its publisher gate and its coverage ledger
 * (Lab contract section 8a). Both calls are idempotent; either failing fails the reset.
 */
export interface StudyGateClient { close(studyId: string): Promise<void>; discard(studyId: string): Promise<void> }
/**
 * What one study's callbacks may touch. Each gateway's handlers, satellite socket,
 * and background job capture the scope of the study they started under; once it is
 * closed they write nothing, and are only counted (late) in that study's summary.
 */
interface StudyScope { studyId: string; closed: boolean; pending: Set<Promise<unknown>>; counts: StudySummary['counts']; lastSource: StudySummary['lastSource'] }
const scopeFor = (studyId: string): StudyScope => ({ studyId, closed: false, pending: new Set(), counts: { actions: 0, recordsProcessed: 0, recordsFailed: 0, lateCallbacks: 0 }, lastSource: null });
/**
 * A running gateway and its loopback management API. With failure handling, also its
 * in-process operator API (section 8b); stand-ins without failure handling leave it out.
 */
export interface BenchServices { gateway: Gateway; management: { origin: string; close(): Promise<void> }; operator?: OperatorApi | null }
/** What a gateway with failure handling is started with: the study's journal directory and the handlers' build ID. */
export interface BenchJournal { stateDirectory: string; handlerBuildId: string }
export interface BenchRuntimeOptions {
  now?: () => number;
  /** Background tick interval; tests pass a long one and call tick() themselves. */
  tickMs?: number;
  /** Starts the gateway and management API; tests substitute stand-ins. */
  services?: (config: ProjectConfig<LabChannels>, handlers: HandlerRegistry<LabChannels>, managementToken: string, port: number, journal: BenchJournal | null) => Promise<BenchServices>;
  /** The bench's volume. Defaults to LAB_STATE_DIR, else /var/lib/lontra in production and .data elsewhere. */
  stateDir?: string;
  /** Deletes a consumer group; tests substitute a stand-in for the Kafka admin client. */
  deleteGroup?: (group: string) => Promise<void>;
  /** The field station's study gate; defaults to its private API at LAB_SNAPSHOT_ORIGIN. */
  gate?: StudyGateClient;
  quiesceMs?: number;
}
function fieldStationGate(number: number, origin: string, token: string): StudyGateClient {
  const call = async (studyId: string, step: 'close' | 'discard') => {
    const response = await fetch(`${origin}/lab-internal/${number}/studies/${encodeURIComponent(studyId)}/${step}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`The field station refused to ${step} the study.`);
  };
  return { close: studyId => call(studyId, 'close'), discard: studyId => call(studyId, 'discard') };
}
async function gatewayServices(config: ProjectConfig<LabChannels>, handlers: HandlerRegistry<LabChannels>, token: string, port: number, journal: BenchJournal | null): Promise<BenchServices> {
  // The journal opens at start, not construction, so the production-rules check below never touches it.
  // No operator socket and no health listener: the bench reaches failure handling in process only (ADR-03).
  const options = journal ? { stateDirectory: journal.stateDirectory, handlerBuildId: journal.handlerBuildId } : {};
  // Validate the exact same config under production rules before development enables traces.
  createGateway({ config, handlers, mode: 'production', ...options });
  const gateway = createGateway({ config, handlers, mode: 'development', ...options });
  try { await gateway.start(); return { gateway, operator: journal ? getGatewayOperator(gateway) : null, management: await startManagementServer({ gateway, host: '127.0.0.1', port, token, workbenchDir: null }) }; }
  catch (error) { await gateway.stop().catch(() => undefined); throw error; }
}
const OPERATION_ID = /^lop_[A-Za-z0-9_-]{22}$/;
const FAILURE_ID = /^[\x21-\x7e]{1,200}$/;
const BENCH_INTENTS: readonly BenchIntent[] = INTENTS.filter((intent): intent is BenchIntent => intent !== 'scenario.prepare-coverage');
const INTENT_KEYS = new Set(['leaseId', 'operationId', 'intent', 'scenario', 'incident', 'planToken']);
/** Validates a `BenchIntentRequest` (section 8b): 400 `invalid-request` for anything outside its shape. */
export function parseBenchIntent(body: Record<string, unknown>): BenchIntentRequest {
  const { leaseId, operationId, intent, scenario, incident, planToken } = body;
  const target = incident as { failureId?: unknown; revision?: unknown } | undefined;
  const ok = Object.keys(body).every(key => INTENT_KEYS.has(key))
    && typeof leaseId === 'string' && typeof operationId === 'string' && OPERATION_ID.test(operationId)
    && BENCH_INTENTS.includes(intent as BenchIntent)
    && (intent === 'scenario.start' ? SOURCE_SCENARIOS.includes(scenario as LabScenarioId) : scenario === undefined)
    && (String(intent).startsWith('incident.')
      ? typeof target === 'object' && target !== null && !Array.isArray(target) && Object.keys(target).length === 2 && typeof target.failureId === 'string' && FAILURE_ID.test(target.failureId) && Number.isSafeInteger(target.revision) && (target.revision as number) >= 0
      : incident === undefined)
    && (intent === 'incident.approve-reprocess' ? typeof planToken === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(planToken) : planToken === undefined);
  if (!ok) throw new LabError('invalid-request', 400);
  return { leaseId: leaseId as string, operationId: operationId as string, intent: intent as BenchIntent,
    ...(scenario === undefined ? {} : { scenario: scenario as LabScenarioId }),
    ...(target === undefined ? {} : { incident: { failureId: target.failureId as string, revision: target.revision as number } }),
    ...(planToken === undefined ? {} : { planToken: planToken as string }) };
}
export function requireNoDevelopmentPrincipals(items: readonly unknown[]): void {
  if (items.length !== 0) throw new Error('Development principals are forbidden.');
}
export class BenchRuntime {
  readonly #env: NodeJS.ProcessEnv;
  readonly #settings: ReturnType<typeof benchEnvironment>;
  readonly #feed = new LabFeed();
  readonly #tokens = new Set<string>();
  readonly #satelliteIds = new Set<string>();
  #lease: { leaseId: string; expiresAt: string } | null = null;
  #state: BenchStatus['state'] = 'starting';
  #scenario: LabBenchState = { gateway: 'restarting', source: { status: 'starting' }, relay: 'up', calibration: 'present', satellite: 'idle', receiptTimeoutMs: 5000 };
  #gateway: Gateway | undefined;
  #management: BenchServices['management'] | undefined;
  /** The running gateway's operator API; null without failure handling or while the gateway is down. */
  #operator: OperatorApi | null = null;
  /** The running gateway's own report that its incident store is the SQLite journal (section 8b). */
  #durable = false;
  #handlerBuildId: string | null = null;
  /** The open study's intents, plan tokens, and steps (operator.ts); replaced with each study, closed by a reset. */
  #failures: BenchFailures | null = null;
  #managementToken = randomBytes(32).toString('base64url');
  #traceCursor: string | null = null;
  /** The study this bench runs; null only before boot and between discarding one study and provisioning the next. */
  #study: StudyDescriptor | null = null;
  #scope: StudyScope = scopeFor('');
  /** The lease the reset under way ended: revoked and named in its study's summary. Kept until that summary is written, so a retried reset still has it. */
  #ended: { leaseId: string; expiresAt: string } | null = null;
  /** Whether the last cleanup (reset, or provisioning at boot) completed. */
  #cleanupOk = false;
  readonly #store: StudyStore;
  readonly #gate: StudyGateClient;
  readonly #deleteGroupFn: (group: string) => Promise<void>;
  readonly #quiesceMs: number;
  #satellite: Socket | undefined;
  #nextAction = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #timer?: NodeJS.Timeout;
  #principalCount = -1;
  /** Fixture sources the running gateway's own configuration declares, as its management API reports it (S3); -1 until measured. */
  #fixtureSources = -1;
  #ticking: Promise<void> | undefined;
  #pollFailingSince: number | null = null;
  readonly #now: () => number;
  readonly #tickMs: number;
  readonly #services: NonNullable<BenchRuntimeOptions['services']>;
  constructor(env: NodeJS.ProcessEnv, options: BenchRuntimeOptions = {}) {
    this.#env = env; this.#settings = benchEnvironment(env); this.#now = options.now ?? Date.now; this.#tickMs = options.tickMs ?? 1000; this.#services = options.services ?? gatewayServices;
    this.#store = new StudyStore(options.stateDir ?? env['LAB_STATE_DIR'] ?? (env['NODE_ENV'] === 'production' ? '/var/lib/lontra' : '.data'), this.#settings.number);
    this.#gate = options.gate ?? fieldStationGate(this.#settings.number, this.#settings.snapshotOrigin, this.#settings.serviceToken);
    this.#deleteGroupFn = options.deleteGroup ?? (group => this.#deleteGroup(group)); this.#quiesceMs = options.quiesceMs ?? QUIESCE_MS;
  }
  run<T>(fn: () => Promise<T>): Promise<T> { const p = this.#tail.then(fn); this.#tail = p.catch(() => undefined); return p; }
  status(): BenchStatus {
    const study = this.#study;
    return { bench: this.#settings.number, state: this.#state, lease: this.#lease, scenario: structuredClone(this.#scenario), checks: { developmentPrincipals: this.#principalCount, fixtureSources: this.#fixtureSources, managementHost: '127.0.0.1' }, readiness: this.readiness(),
      study: study && { studyId: study.studyId, generation: study.generation, consumerGroup: study.consumerGroup, createdAt: study.createdAt, phase: study.phase, restarts: { ...study.restarts } },
      failures: { profile: this.#settings.profile, durable: this.#durable, handlerBuildId: this.#handlerBuildId } };
  }
  /**
   * LC11-ADR-02's three facts. Control: the gateway and its management API are up and
   * answering. Source: consuming. Clean lease: a provisioned study no lease has used,
   * after a cleanup that completed. A held or paused source changes only `source`.
   */
  readiness(): BenchStatus['readiness'] {
    const running = this.#scenario.gateway === 'running' && this.#management !== undefined;
    const control = running && (this.#state === 'ready' || this.#state === 'leased') && this.#pollFailingSince === null;
    return { control, source: running && this.#scenario.source.status === 'healthy', cleanLease: this.#state === 'ready' && this.#cleanupOk && this.#study?.phase === 'clean' };
  }
  authenticate(token: string): Principal | null { const lease = this.#lease; if (!lease || Date.parse(lease.expiresAt) <= this.#now() || !this.#tokens.has(token)) return null; return { tenantId: TENANT_ID, subject: `lab-${lease.leaseId}`, sessionId: lease.leaseId, expiresAt: lease.expiresAt, claims: { role: 'volunteer', bench: this.#settings.number } }; }
  async #managementCall<T>(path: string): Promise<T> {
    if (!this.#management) throw new Error('Management unavailable.');
    const response = await fetch(`${this.#management.origin}/management/v1/${path}`, {
      headers: { authorization: `Bearer ${this.#managementToken}` }, signal: AbortSignal.timeout(3000)
    });
    const envelope = await response.json() as { ok: boolean; data: T; error?: { code?: string } };
    if (!response.ok || !envelope.ok) {
      if (path.startsWith('traces?') && this.#traceCursor && envelope.error?.code === 'TRACE_CURSOR_EXPIRED') {
        this.#traceCursor = null;
        this.#feed.add({ kind: 'bench', event: 'gap' });
        return this.#managementCall<T>('traces?limit=500');
      }
      throw new Error('Management request failed.');
    }
    return envelope.data;
  }
  async #relay(cut: boolean): Promise<void> { const origin = this.#env['LAB_RELAY_ORIGIN'] ?? `http://lab-${this.#settings.number}-kafka:9180`; const response = await fetch(`${origin}/${cut ? 'cut' : 'restore'}`, { method: 'POST', headers: { authorization: `Bearer ${this.#settings.relayToken}` }, signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error('Relay unavailable.'); this.#scenario.relay = cut ? 'cut' : 'up'; }
  #config() { const study = this.#study; if (!study) throw new Error('No study.'); return benchConfig(this.#settings.number, { profile: this.#settings.profile, generation: study.generation, host: this.#env['BENCH_HOST'] ?? '0.0.0.0', port: Number(this.#env['BENCH_PORT'] ?? 7400), brokers: (this.#env['BENCH_KAFKA_BROKERS'] ?? `lab-${this.#settings.number}-kafka:${9100 + this.#settings.number}`).split(','), caFile: this.#env['KAFKA_CA_FILE'] ?? '/etc/lontra/kafka/ca.pem', consumerGroup: study.consumerGroup, allowedOrigins: (this.#env['SITE_ORIGIN'] ?? 'https://streamotter.dev').split(',') }); }
  /** Runs `fn` only while `scope` is the open study; otherwise counts a late callback against that study. */
  #within(scope: StudyScope, fn: () => void): void { if (scope.closed || scope !== this.#scope) { scope.counts.lateCallbacks++; return; } fn(); }
  /**
   * Starts the gateway for the current study. A source that isn't healthy afterwards is reported, not treated as failure.
   * With `graced`, a failed first poll starts the poll grace clock, as a background poll's would, instead of failing the start.
   */
  async #startGateway(graced = false): Promise<void> {
    const config = this.#config(); const scope = this.#scope; const study = this.#study!; const profile = this.#settings.profile;
    const open = () => scope === this.#scope && !scope.closed;
    const handlers = benchHandlers(this.#settings.number, { authenticate: token => this.authenticate(token), serviceToken: this.#settings.serviceToken, snapshotOrigin: this.#settings.snapshotOrigin, calibration: () => this.#scenario.calibration === 'present',
      record: item => this.#within(scope, () => { if (item.kind === 'record') scope.counts[item.outcome === 'failed' ? 'recordsFailed' : 'recordsProcessed']++; this.#feed.add(item); }),
      mapping: () => study.mapping,
      // One armed blip per attempt. The count is persisted through the work queue, so it never races the study's other writes.
      blip: () => {
        if (!open() || study.blip <= 0) return false;
        study.blip--; void this.run(async () => { if (open()) await this.#store.save(study); }).catch(() => undefined);
        return true;
      },
      ...(profile === 'quarantine' ? { recovery: { study: () => open() ? { studyId: study.studyId, generation: study.generation } : null } } : {}) });
    const build = handlerBuildId(study.mapping);
    const journal = profile === 'off' ? null : { stateDirectory: this.#store.journal(study.studyId), handlerBuildId: build };
    const services = await this.#services(config, handlers, this.#managementToken, Number(this.#env['BENCH_MANAGEMENT_PORT'] ?? 7401), journal); this.#gateway = services.gateway; this.#management = services.management;
    const principals = await this.#managementCall<{ items: unknown[] }>('dev/principals'); this.#principalCount = principals.items.length;
    requireNoDevelopmentPrincipals(principals.items);
    // Measured from the running gateway, not from the config the bench meant to pass (S3).
    const running = await this.#managementCall<{ config: ProjectConfig }>('config');
    this.#fixtureSources = Object.values(running.config.sources).filter(source => source.kind === 'fixture').length;
    if (journal) {
      // The library's own report, never the bench's expectation: a gateway whose incidents aren't in the journal fails the start.
      const operator = services.operator ?? null; const store = operator ? (await operator.status()).store : null;
      if (!operator || store?.kind !== 'sqlite' || !store.durable) throw new Error('The gateway\'s failure journal is not durable.');
      this.#operator = operator; this.#durable = true; this.#handlerBuildId = build;
    }
    this.#traceCursor = null; this.#scenario.gateway = 'running'; this.#pollFailingSince = null;
    try { await this.#poll(false); } catch (error) { if (!graced) throw error; this.#pollFailingSince = this.#now(); }
  }
  async #stopGateway(): Promise<void> { this.#scenario.gateway = 'restarting'; this.#operator = null; this.#durable = false; this.#satellite?.disconnect(); this.#satellite = undefined; this.#scenario.satellite = 'idle'; await this.#management?.close(); this.#management = undefined; await this.#gateway?.stop(); this.#gateway = undefined; }
  async #deleteGroup(group: string): Promise<void> { const connection = benchConfig(this.#settings.number, { brokers: (this.#env['BENCH_KAFKA_BROKERS'] ?? `lab-${this.#settings.number}-kafka:${9100 + this.#settings.number}`).split(',') }).connections['field']!; const kafka = new Kafka({ brokers: [...connection.brokers], ssl: { ca: [readFileSync(this.#env['KAFKA_CA_FILE'] ?? '/etc/lontra/kafka/ca.pem', 'utf8')] }, sasl: { mechanism: 'scram-sha-512', username: this.#env['KAFKA_LAB_USERNAME']!, password: this.#env['KAFKA_LAB_PASSWORD']! }, logLevel: 0 }); const admin = kafka.admin(); try { await admin.connect(); await admin.deleteGroups([group]); }
    catch (error) { if (!((error as { groups?: { errorCode: number }[] }).groups ?? [{ errorCode: -1 }]).every(item => item.errorCode === GROUP_ID_NOT_FOUND)) throw error; }
    finally { await admin.disconnect(); } }
  /**
   * Boots the bench. A persisted study that is clean, or open with a lease still
   * running, is resumed: same group, generation, and journal directory, counted as a
   * process restart. Anything else (no study, one mid-provisioning, an open study
   * whose lease has ended, an unreadable descriptor) is discarded and a new study
   * provisioned. A failure leaves the bench `failed` for the field station to reset;
   * it never exits, so a held source can't cause a restart loop (LC11-A33).
   */
  async start(): Promise<void> {
    await this.run(() => this.#boot()).catch(() => { this.#state = 'failed'; this.#cleanupOk = false; });
    this.#timer = setInterval(() => { void this.tick(); }, this.#tickMs);
  }
  async #boot(): Promise<void> {
    const loaded = await this.#store.load();
    const study = loaded === 'corrupt' ? null : loaded;
    const leaseLive = study?.lease ? Date.parse(study.lease.expiresAt) > this.#now() : false;
    // A study provisioned without a journal (failure handling was off) can't be resumed with failure handling on.
    const journaled = !study || this.#settings.profile === 'off' || hasJournal(this.#store.journal(study.studyId));
    if (study && journaled && (study.phase === 'clean' || study.phase === 'open' && leaseLive)) {
      study.restarts.process++; await this.#store.save(study);
      this.#study = study; this.#scope = scopeFor(study.studyId); this.#scenario.calibration = study.calibration; this.#failures = new BenchFailures({ number: this.#settings.number, studyId: study.studyId, now: this.#now });
      // The lease continues: report it at once, so the field station keeps it while the gateway starts (control stays false until then).
      // The feed starts a new epoch: the page's cursor from the old process is answered from here, with `gap`.
      if (study.phase === 'open') { this.#lease = study.lease; this.#feed.reset(study.lease!.leaseId, study.restarts.process); this.#feed.add({ kind: 'bench', event: 'gap' }); this.#state = 'leased'; }
      await this.#relay(false);
      await this.#startGateway();
      if (study.phase === 'clean') { this.#cleanupOk = true; this.#state = 'ready'; }
      return;
    }
    await this.#relay(false);
    this.#study = study; this.#scope = scopeFor(study?.studyId ?? ''); this.#scope.closed = true;
    await this.#discard(study?.lease ?? null, false);
    await this.#provision();
  }
  /**
   * One background step: reset after the lease's end, otherwise poll the gateway.
   * At most one tick waits in the queue, so a long reset or restart doesn't stack
   * polls ahead of visitors' calls. A failing poll fails the bench only once polls
   * have kept failing for POLL_GRACE_MS; the field station then ends the lease.
   */
  tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    const ticking = this.run(async () => {
      if (this.#lease && Date.parse(this.#lease.expiresAt) <= this.#now()) return this.reset();
      try { await this.#poll(true); this.#pollFailingSince = null; }
      catch (error) { const since = this.#pollFailingSince ??= this.#now(); if (this.#now() - since >= POLL_GRACE_MS) throw error; }
    }).catch(() => { this.#state = 'failed'; }).finally(() => { this.#ticking = undefined; });
    this.#ticking = ticking; return ticking;
  }
  async close(): Promise<void> { clearInterval(this.#timer); await this.run(() => this.#stopGateway()); }
  async #poll(record: boolean): Promise<void> {
    const sources = await this.#managementCall<{ items: SourceStatus[] }>('sources'); const source = sources.items.find(s => s.sourceId === 'field');
    if (source) { const next = { status: source.status, ...(source.reason ? { reason: source.reason } : {}) }; this.#scope.lastSource = source.status; if (record && JSON.stringify(next) !== JSON.stringify(this.#scenario.source)) this.#feed.add({ kind: 'source', sourceId: 'field', ...next }); this.#scenario.source = next; }
    // Drain bounded management pages, retaining the last cursor even on an empty page.
    for (let i = 0; i < 20; i++) { const traces = await this.#managementCall<Page<Trace>>(`traces?limit=500${this.#traceCursor ? `&cursor=${encodeURIComponent(this.#traceCursor)}` : ''}`); for (const trace of traces.items) if (record && this.#lease) { this.#feed.trace(trace, this.#satelliteIds); if (trace.stage === 'snapshot' && trace.outcome === 'ok' && trace.subscriptionId !== undefined && !this.#satelliteIds.has(trace.subscriptionId)) this.#failures?.observeSnapshot(trace.at); } if (traces.nextCursor) this.#traceCursor = traces.nextCursor; if (traces.items.length < 500) break; }
  }
  /** Binds a lease to the clean study, which is open from now until a reset discards it. The lease is persisted with the study; its tokens are not. */
  async lease(leaseId: string, expiresAt: string): Promise<void> {
    const study = this.#study;
    if (this.#state !== 'ready' || !this.readiness().cleanLease || !study) throw new LabError('not-applicable', 409); if (!/^[\w-]{1,80}$/.test(leaseId) || !(Date.parse(expiresAt) > this.#now()) || Date.parse(expiresAt) > this.#now() + MAX_LEASE_MS) throw new LabError('invalid-request', 400);
    await this.#poll(false);
    study.phase = 'open'; study.lease = { leaseId, expiresAt }; await this.#store.save(study);
    this.#lease = { leaseId, expiresAt }; this.#feed.reset(leaseId, study.restarts.process); this.#satelliteIds.clear(); this.#state = 'leased'; this.#nextAction = 0; this.#feed.add({ kind: 'bench', event: 'lease-started' }); }
  #check(leaseId: unknown): void { if (!this.#lease || leaseId !== this.#lease.leaseId || Date.parse(this.#lease.expiresAt) <= this.#now()) throw new LabError('no-lease', 409); }
  token(leaseId: unknown): { token: string; expiresAt: string } { this.#check(leaseId); const token = `lab${this.#settings.number}_${randomBytes(32).toString('base64url')}`; if (this.#tokens.size >= 128) return { token: [...this.#tokens][0]!, expiresAt: this.#lease!.expiresAt }; this.#tokens.add(token); return { token, expiresAt: this.#lease!.expiresAt }; }
  feed(leaseId: unknown, after?: string, limit?: number) { this.#check(leaseId); return this.#feed.page(after, limit); }
  /** LC11-ADR-02 step 1, synchronously: the lease, its tokens, and the study's callbacks stop now. */
  #invalidate(): void { if (this.#lease) this.#ended = this.#lease; this.#lease = null; this.#tokens.clear(); this.#state = 'resetting'; this.#scope.closed = true; this.#failures?.close(); }
  /**
   * Reset is study discard (LC11-ADR-02), in order: invalidate the lease and tokens;
   * revoke its subject; shut the field station's publisher gate for the study;
   * quiesce pending work with a bounded wait; write the study's bounded summary;
   * restore the relay; stop the gateway, delete its group, remove its journal directory, and have the
   * field station summarize and remove its ledger; then provision a new study. Any
   * failure leaves the bench `failed` and not clean-lease eligible; the field
   * station retries on its 30-second schedule.
   */
  async reset(): Promise<void> {
    this.#invalidate();
    const lease = this.#ended;
    try {
      const study = this.#study;
      if (study && study.lease) { study.lease = null; await this.#store.save(study); }
      if (lease) await this.#gateway?.revoke({ kind: 'subject', tenantId: TENANT_ID, subject: `lab-${lease.leaseId}` });
      await this.#discard(lease, true); this.#ended = null;
      await this.#provision();
    } catch { this.#state = 'failed'; this.#cleanupOk = false; throw new Error('Bench reset failed.'); }
  }
  /** Steps 3 to 6 for the current study, if any. Idempotent, so a retried reset finishes what a failed one began. */
  async #discard(lease: { leaseId: string } | null, quiesce: boolean): Promise<void> {
    this.#cleanupOk = false;
    const study = this.#study; const scope = this.#scope;
    if (study) await this.#gate.close(study.studyId);
    this.#satellite?.disconnect(); this.#satellite = undefined; this.#scenario.satellite = 'idle';
    const quiesced = !quiesce || await Promise.race([Promise.allSettled([...scope.pending]).then(() => true), sleep(this.#quiesceMs, false, { ref: false })]);
    if (study) await this.#store.summarize({ bench: this.#settings.number as StudySummary['bench'], studyId: study.studyId, generation: study.generation, consumerGroup: study.consumerGroup, createdAt: study.createdAt, closedAt: new Date(this.#now()).toISOString(), phase: study.phase, leaseId: lease?.leaseId ?? null, restarts: { ...study.restarts }, counts: { ...scope.counts }, lastSource: scope.lastSource, quiesced });
    // The admin client reaches Kafka through the relay proxy, so a lease that ended cut restores it first.
    await this.#relay(false);
    await this.#stopGateway();
    if (study) { await this.#deleteGroupFn(study.consumerGroup); await this.#store.remove(study.studyId); await this.#gate.discard(study.studyId); }
    // Directories a crash or an unreadable study.json left behind belong to no live study: each is discarded with the same steps.
    for (const stray of await this.#store.studies()) { await this.#gate.close(stray); await this.#deleteGroupFn(consumerGroupFor(this.#settings.number, stray)); await this.#store.remove(stray); await this.#gate.discard(stray); }
    this.#study = null; this.#feed.reset();
  }
  /** Step 7: a new identity, generation, group, and journal directory, then its gateway. A new study's source must consume. */
  async #provision(): Promise<void> {
    const study = newStudy(this.#settings.number, this.#now());
    await this.#store.save(study);
    this.#study = study; this.#scope = scopeFor(study.studyId); this.#failures = new BenchFailures({ number: this.#settings.number, studyId: study.studyId, now: this.#now });
    // The only published way to create a journal; a gateway never creates one (journal.ts).
    if (this.#settings.profile !== 'off') await createJournal(this.#config(), this.#store.journal(study.studyId), this.#store.directory(study.studyId));
    this.#scenario.calibration = 'present'; await this.#relay(false);
    await this.#startGateway();
    if (this.#scenario.source.status !== 'healthy') throw new Error('A new study\'s source did not become healthy.');
    study.phase = 'clean'; await this.#store.save(study);
    this.#feed.reset(); this.#cleanupOk = true; this.#state = 'ready';
  }
  async action(leaseId: unknown, action: LabAction): Promise<{ at: string; scenario: LabBenchState }> {
    this.#check(leaseId); if (this.#now() < this.#nextAction) throw new LabError('too-many-actions', 429);
    const s = this.#scenario;
    const allowed = action === 'sensor.foul' ? s.calibration === 'present' : action === 'sensor.restore' ? s.calibration === 'removed' : action === 'source.resume' ? s.source.status === 'paused' : action === 'relay.cut' ? s.relay === 'up' && s.gateway === 'running' : action === 'relay.restore' ? s.relay === 'cut' : action === 'satellite.start' ? s.satellite === 'idle' && s.source.status === 'healthy' && s.gateway === 'running' : action === 'gateway.restart' && s.gateway === 'running' && s.relay === 'up';
    if (!allowed || s.gateway !== 'running') throw new LabError('not-applicable', 409);
    const scope = this.#scope; const study = this.#study!;
    if (action === 'sensor.foul' || action === 'sensor.restore') { s.calibration = action === 'sensor.foul' ? 'removed' : 'present'; study.calibration = s.calibration; await this.#store.save(study); }
    // StreamOtter answers 409 when the source left `paused` since the last poll: the action no longer applies.
    if (action === 'source.resume') await this.#gateway!.resumeSource('field').catch((error: unknown) => { throw (error as { details?: { status?: unknown } }).details?.status === 409 ? new LabError('not-applicable', 409) : error; });
    if (action === 'relay.cut' || action === 'relay.restore') await this.#relay(action === 'relay.cut');
    if (action === 'gateway.restart') {
      // Return the restarting state promptly. Starting a Kafka gateway can take
      // 30 seconds; keeping that outside the public lease coordinator's lock
      // prevents a restart from starving other visitors' heartbeats.
      s.gateway = 'restarting';
      // Same study: same group and generation. A source that comes back held or
      // paused keeps the lease; only a gateway that can't start fails the bench.
      void this.run(() => this.#restartGateway(scope, study)).catch(() => { if (!scope.closed) this.#state = 'failed'; });
    }
    if (action === 'satellite.start') {
      const config = this.#config(); const token = this.token(leaseId).token;
      const socket = io(`http://127.0.0.1:${config.gateway.port}`, { path: config.gateway.path, transports: ['websocket'], auth: { token, protocolVersion: 1 }, extraHeaders: { Origin: config.gateway.allowedOrigins[0]! }, reconnection: false }); this.#satellite = socket; s.satellite = 'connected';
      // Every callback is confined to the study it started in.
      socket.on('so:hello', () => this.#within(scope, () => { this.#feed.add({ kind: 'bench', event: 'satellite-connected' }); socket.emit('so:subscribe', { requestId: randomUUID(), subscriptionId: randomUUID(), channel: 'station', channelVersion: 1, params: { stationId: 'LC-02' } }, (result: { ok: boolean; data?: { subscriptionId: string } }) => this.#within(scope, () => { if (result.ok && result.data) this.#satelliteIds.add(result.data.subscriptionId); })); }));
      socket.on('so:state', (state: { subscriptionId: string }) => this.#within(scope, () => this.#satelliteIds.add(state.subscriptionId)));
      socket.on('disconnect', () => this.#within(scope, () => { s.satellite = 'idle'; this.#feed.add({ kind: 'bench', event: 'satellite-disconnected' }); }));
      socket.on('connect_error', () => { socket.disconnect(); this.#within(scope, () => { s.satellite = 'idle'; }); });
      // Deliberately no so:receipt handler: the gateway disconnects this one client.
    }
    // A failed action doesn't spend the visitor's one-a-second budget.
    this.#nextAction = this.#now() + 1000; scope.counts.actions++;
    this.#feed.add({ kind: 'action', action }); return { at: new Date(this.#now()).toISOString(), scenario: structuredClone(s) };
  }
  /** A same-study gateway restart, run from the work queue: same group, generation, and journal. */
  async #restartGateway(scope: StudyScope, study: StudyDescriptor): Promise<void> {
    if (scope.closed) return;
    // Draining the old gateway's traces is best effort: one slow or failed poll changes nothing, and the `gap` below covers what it missed.
    await this.#poll(true).catch(() => undefined); await this.#stopGateway(); this.#feed.add({ kind: 'bench', event: 'gateway-stopped' });
    study.restarts.gateway++; await this.#store.save(study);
    await this.#startGateway(true); this.#feed.add({ kind: 'bench', event: 'gateway-started' }); this.#feed.add({ kind: 'bench', event: 'gap' });
  }
  /**
   * `POST /bench/v1/intents` (section 8b). Validates the request and its preconditions
   * synchronously, records it, and carries it out in the background: `scenario.*` in
   * the work queue (they change the study's handlers), `incident.*` outside it, since
   * the library's retry and reassess wait up to 15 seconds for the source to settle.
   * A repeated operation ID answers the recorded operation, whatever has changed since.
   */
  async intent(body: Record<string, unknown>): Promise<BenchOperation> {
    const request = parseBenchIntent(body);
    this.#check(request.leaseId);
    const failures = this.#failures; const scope = this.#scope; const study = this.#study;
    if (!failures || failures.closed || !study) throw new LabError('no-lease', 409);
    const recorded = failures.recorded(request);
    if (recorded) return recorded;
    const profile = this.#settings.profile; const s = this.#scenario;
    if (profile === 'off') throw new LabError('not-applicable', 409);
    const leaseEnd = Date.parse(this.#lease!.expiresAt);
    if (request.intent === 'scenario.start') {
      const scenario = request.scenario!;
      if (!runsUnder(scenario).includes(profile) || s.gateway !== 'running' || !this.#operator) throw new LabError('not-applicable', 409);
      // One incident at a time: a scenario can't start while the source holds one (section 12.5).
      if ((await this.#operator.status()).sources.find(source => source.sourceId === SOURCE_ID)?.heldIncident) throw new LabError('not-applicable', 409);
      if (scenario === 'fouled-sensor' && s.calibration !== 'present') throw new LabError('not-applicable', 409);
      return failures.accept(request, () => this.run(() => this.#arm(scope, study, scenario)));
    }
    if (request.intent === 'scenario.restore-calibration') {
      if (s.calibration === 'present' && study.blip === 0) throw new LabError('not-applicable', 409);
      return failures.accept(request, () => this.run(async (): Promise<Outcome> => {
        if (scope.closed) return { status: 'cancelled', outcome: 'study-closed', incidentRevision: null };
        s.calibration = 'present'; study.calibration = 'present'; study.blip = 0; await this.#store.save(study);
        failures.step('LC-03 calibration restored');
        return { status: 'succeeded', outcome: 'restored', incidentRevision: null };
      }));
    }
    return failures.accept(request, () => failures.incident(this.#operator, request, leaseEnd));
  }
  /** What `scenario.start` arms on the bench (section 12.5). The field station publishes the scenario's records itself. */
  async #arm(scope: StudyScope, study: StudyDescriptor, scenario: LabScenarioId): Promise<Outcome> {
    if (scope.closed) return { status: 'cancelled', outcome: 'study-closed', incidentRevision: null };
    const failures = this.#failures!; const s = this.#scenario;
    if (scenario === 'fouled-sensor') {
      if (s.calibration !== 'present') return { status: 'refused', outcome: 'not-applicable', incidentRevision: null };
      s.calibration = 'removed'; study.calibration = 'removed'; await this.#store.save(study);
      failures.step('LC-03 calibration removed');
    }
    if (scenario === 'calibration-blip') {
      // The first blip in a study fails once, which a bounded retry absorbs; later ones last until calibration is restored.
      study.blips++; study.blip = study.blips === 1 ? 1 : SUSTAINED_BLIP; await this.#store.save(study);
      failures.step(study.blip === 1 ? 'One calibration lookup will time out' : 'The next calibration lookups will time out');
    }
    if (scenario === 'inspect-old-reading' && study.mapping !== 'corrected') {
      // Corrected handlers are a new handler build: a same-study restart, so incidents record which build ran.
      study.mapping = 'corrected'; await this.#store.save(study);
      failures.step('Projection corrected; gateway restarted with the new handlers');
      await this.#restartGateway(scope, study);
    }
    return { status: 'succeeded', outcome: 'armed', incidentRevision: null };
  }
  /** `GET /bench/v1/incident`: the study's incident facts. While the gateway restarts there is no operator to ask: 409, never a guess. */
  async incident(leaseId: unknown): Promise<BenchIncidentFacts> {
    this.#check(leaseId);
    const failures = this.#failures; const study = this.#study;
    if (!failures || failures.closed || !study) throw new LabError('no-lease', 409);
    const profile = this.#settings.profile; const operator = this.#operator;
    if (profile !== 'off' && (this.#scenario.gateway !== 'running' || !operator)) throw new LabError('not-applicable', 409);
    const app = { calibration: this.#scenario.calibration, mapping: study.mapping, blips: study.blips };
    try { return await failures.facts(operator, { profile, app }); }
    catch (error) { if (operator !== this.#operator) throw new LabError('not-applicable', 409); throw error; }
  }
  /** `GET /bench/v1/operations/:operationId`: the lease's recorded operation, or null when there is none by that ID. */
  operation(leaseId: unknown, operationId: string): BenchOperation | null {
    this.#check(leaseId);
    return this.#failures?.operation(leaseId as string, operationId) ?? null;
  }
  api(): Server {
    const expected = Buffer.from(`Bearer ${this.#settings.serviceToken}`);
    return createServer(async (request, response) => {
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
      const url = new URL(request.url ?? '/', 'http://bench.invalid');
      // Control availability, not source readiness: a held source stays healthy here (LC11-A33).
      if (url.pathname === '/healthz') { const readiness = this.readiness(); return send(readiness.control ? 200 : 503, { state: this.#state, readiness }); }
      const provided = Buffer.from(request.headers.authorization ?? '');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return send(401, { error: 'Unauthorized.' });
      if (request.method === 'GET' && url.pathname === '/bench/v1/status') return send(200, this.status());
      try {
        let text = ''; for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 4096) throw new LabError('invalid-request', 400); }
        let body: Record<string, unknown>; try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { throw new LabError('invalid-request', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LabError('invalid-request', 400);
        if (request.method === 'POST' && url.pathname === '/bench/v1/actions' && this.#scenario.gateway === 'restarting') throw new LabError('not-applicable', 409);
        if (request.method === 'POST' && url.pathname === '/bench/v1/reset') {
          if (body['leaseId'] !== null) this.#check(body['leaseId']);
          if (this.#state !== 'resetting') {
            const previous = this.#lease; const scope = this.#scope;
            this.#invalidate();
            // Invalidate immediately, even when the gateway lifecycle queue is
            // busy restarting. Teardown itself remains serialized; the reset's
            // quiesce step waits (bounded) for this revocation.
            if (previous && this.#gateway) { const revoking = this.#gateway.revoke({ kind: 'subject', tenantId: TENANT_ID, subject: `lab-${previous.leaseId}` }).catch(() => undefined); scope.pending.add(revoking); void revoking.finally(() => scope.pending.delete(revoking)); }
            void this.run(() => this.reset()).catch(() => { this.#state = 'failed'; });
          }
          return send(202, this.status());
        }
        // Read-only feed and token renewal must remain available while Kafka
        // rejoins during a gateway restart. Both validate the current lease
        // synchronously before touching lease-owned data.
        if (request.method === 'POST' && url.pathname === '/bench/v1/tokens') return send(200, this.token(body['leaseId']));
        if (request.method === 'GET' && url.pathname === '/bench/v1/feed') {
          const limit = Number(url.searchParams.get('limit') ?? 100);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new LabError('invalid-request', 400);
          return send(200, this.feed(url.searchParams.get('leaseId'), url.searchParams.get('after') ?? undefined, limit));
        }
        // The intent surface (section 8b) answers at once, during a gateway restart too: the work runs in the background.
        if (request.method === 'POST' && url.pathname === '/bench/v1/intents') return send(202, await this.intent(body));
        if (request.method === 'GET' && url.pathname === '/bench/v1/incident') return send(200, await this.incident(url.searchParams.get('leaseId')));
        const operation = request.method === 'GET' ? /^\/bench\/v1\/operations\/(lop_[A-Za-z0-9_-]{22})$/.exec(url.pathname) : null;
        if (operation) { const found = this.operation(url.searchParams.get('leaseId'), operation[1]!); return found ? send(200, found) : send(404, { error: 'Not found.' }); }
        await this.run(async () => {
          if (request.method === 'GET' && url.pathname === '/bench/v1/status') return send(200, this.status());
          if (request.method === 'PUT' && url.pathname === '/bench/v1/lease') { if (typeof body['leaseId'] !== 'string' || typeof body['expiresAt'] !== 'string') throw new LabError('invalid-request', 400); await this.lease(body['leaseId'], body['expiresAt']); return send(200, this.status()); }
          if (request.method === 'POST' && url.pathname === '/bench/v1/tokens') return send(200, this.token(body['leaseId']));
          if (request.method === 'GET' && url.pathname === '/bench/v1/feed') { const limit = Number(url.searchParams.get('limit') ?? 100); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new LabError('invalid-request', 400); return send(200, this.feed(url.searchParams.get('leaseId'), url.searchParams.get('after') ?? undefined, limit)); }
          if (request.method === 'POST' && url.pathname === '/bench/v1/actions') { if (!ACTIONS.includes(body['action'] as LabAction)) throw new LabError('invalid-request', 400); return send(200, await this.action(body['leaseId'], body['action'] as LabAction)); }
          if (request.method === 'POST' && url.pathname === '/bench/v1/reset') { if (body['leaseId'] !== null) this.#check(body['leaseId']); this.#state = 'resetting'; const reset = this.reset(); send(202, this.status()); void reset.catch(() => { this.#state = 'failed'; }); await reset; return; }
          send(404, { error: 'Not found.' });
        });
      } catch (error) {
        // Only a LabError is the caller's fault or a refusal. Anything else (the relay
        // proxy down, the management API failing) is the bench's own failure: 500, which
        // the field station reports as bench-unavailable.
        if (!response.headersSent) send(error instanceof LabError ? error.status : 500, error instanceof LabError ? { error: error.code, code: error.code } : { error: 'Bench failure.', code: 'bench-unavailable' });
      }
    });
  }
}
