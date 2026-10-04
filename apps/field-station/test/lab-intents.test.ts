/**
 * The field station's source-failures intents (Lab contract sections 12.5 to 12.7):
 * the order of answers, idempotency, the action budget, stale revisions, cancellation
 * at lease end, the projection and its revision, the scenario records, and the HTTP
 * routes.
 *
 * Evidence level: application, with a scripted bench. The lease pool, the intents, the
 * study registry and coverage ledger, the simulation, and the public HTTP API are the
 * real ones; the bench is a stand-in whose incident facts and operation outcomes each
 * test writes, so nothing here says what StreamOtter decides (lab-failures.test.ts does,
 * against the installed library). The records the field station publishes are checked
 * against an expected ledger restated by hand in this file (`Expected`).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { advanceTo, createWorld, currentEmissions } from '@lontra-creek/sim';
import type { BenchId, BenchIncident, BenchIncidentFacts, BenchIntentRequest, BenchOperation, BenchStatus, LabIncidentView, LabOperation, LabScenarioId, RecordCoordinates } from '../src/lab/contract.ts';
import { LabError } from '../src/lab/errors.ts';
import { runsUnder } from '../src/lab/bench.ts';
import { INSTALLED_INTEGRITY, type Verification } from '../src/lab/capabilities.ts';
import { compose } from '../src/lab/intents.ts';
import { attachIntents, LeasePool, type BenchClient } from '../src/lab/leases.ts';
import { LabStudies } from '../src/lab/studies.ts';
import { publicApi } from '../src/server/http.ts';
import { readConfig } from '../src/server/config.ts';
import type { FieldStation } from '../src/server/station.ts';
import type { Notebooks } from '../src/server/notebooks.ts';

const TICK = 500;
const STUDY = 'b1studyAAAAAAAAA';
const NEW: LabScenarioId[] = ['garbled-reading', 'bad-projection', 'inspect-old-reading', 'conflicting-readings', 'calibration-blip', 'too-many-bad-readings', 'restart-recovery', 'unavailable-evidence'];
// Evidence for every new scenario under every profile it can run under, for the packages installed here.
const VERIFIED: ReadonlyMap<string, Verification> = new Map([['0.2.0-rc.1', { packages: INSTALLED_INTEGRITY!, evidence: 'injected', scenarios: Object.fromEntries(NEW.map(id => [id, runsUnder(id).filter(profile => profile !== 'off')])) }]]);

/**
 * The expected ledger, by hand: an LC-03 flow reading affects LC-03's station view and
 * the creek overview (which shows every station's flow); an LC-01 water temperature
 * reading affects only LC-01's station view. A revision is generation × 10^12 + tick.
 */
const Expected = {
  revision: (tick: number) => String(1_000_000_000_000 + tick),
  flowAffects: ['creekOverview:lontra', 'station:LC-03'],
  temperatureAffects: ['station:LC-01'],
  topic: 'lab-1.field.gauges'
};

/** A scripted bench: its incident facts and how each intent ends are the test's to write. */
function scriptedBench(now: () => number) {
  const status: BenchStatus = { bench: 1, state: 'ready', lease: null, scenario: { gateway: 'running', source: { status: 'healthy' }, relay: 'up', calibration: 'present', satellite: 'idle', receiptTimeoutMs: 5000 }, checks: { developmentPrincipals: 0, fixtureSources: 0, managementHost: '127.0.0.1' }, readiness: { control: true, source: true, cleanLease: true }, study: { studyId: STUDY, generation: `lab-1-${STUDY}`, consumerGroup: `streamotter-lab-1-${STUDY}`, createdAt: new Date(now()).toISOString(), phase: 'clean', restarts: { gateway: 0, process: 0 } }, failures: { profile: 'quarantine', durable: true, handlerBuildId: 'lontra-lab@1.1.0+projection-v2-broken' } };
  const facts: BenchIncidentFacts = { profile: 'quarantine', studyId: STUDY, app: { calibration: 'present', mapping: 'broken', blips: 0, blipArmed: false }, incident: null, circuit: { state: 'closed', recentIncidents: 0, limit: 5 }, evaluation: null, reprocess: null, resynchronizedAt: null, steps: [] };
  const sent: BenchIntentRequest[] = [];
  const operations = new Map<string, BenchOperation>();
  /** How each intent ends; `hold` keeps it running until the test settles it. */
  const outcomes = new Map<string, { status: BenchOperation['status']; outcome: string } | 'hold'>();
  let restarting = false; let failing = false; let resets = 0;
  /** Runs as the bench accepts an intent: the world can tick meanwhile, as it does every two seconds. */
  const hooks: { onIntent?: () => void; beforeFacts?: () => Promise<void> } = {};
  const client: BenchClient = { async call<T>(_bench: BenchId, path: string, method = 'GET', body?: unknown): Promise<T> {
    const at = new Date(now()).toISOString();
    if (failing) throw new LabError('bench-unavailable', 503);
    // Every reset after the first discards the study for a new one, as a bench does; the field station never reopens a closed study.
    if (path === '/bench/v1/reset' && resets++ > 0) { const id = `b1study${String(resets).padStart(9, '0')}`; status.study = { ...status.study!, studyId: id, generation: `lab-1-${id}`, consumerGroup: `streamotter-lab-1-${id}` }; facts.studyId = id; }
    if (path === '/bench/v1/reset') { status.state = 'ready'; status.lease = null; status.readiness.cleanLease = true; return structuredClone(status) as T; }
    if (path === '/bench/v1/lease') { status.state = 'leased'; status.lease = body as BenchStatus['lease']; status.readiness.cleanLease = false; return structuredClone(status) as T; }
    if (path === '/bench/v1/tokens') return { token: 'lab1_token', expiresAt: status.lease!.expiresAt } as T;
    if (path.startsWith('/bench/v1/incident')) { if (restarting) throw new LabError('not-applicable', 409); const read = structuredClone(facts); await hooks.beforeFacts?.(); return read as T; }
    if (path === '/bench/v1/intents' && method === 'POST') {
      const request = body as BenchIntentRequest; sent.push(request); hooks.onIntent?.();
      const outcome = outcomes.get(request.intent) ?? { status: 'succeeded', outcome: 'armed' };
      const operation: BenchOperation = { operationId: request.operationId, intent: request.intent, status: 'running', outcome: null, incidentRevision: null, acceptedAt: at, updatedAt: at };
      if (outcome !== 'hold') Object.assign(operation, { status: outcome.status, outcome: outcome.outcome });
      operations.set(request.operationId, operation); return structuredClone(operation) as T;
    }
    const operation = /^\/bench\/v1\/operations\/([^?]+)/.exec(path);
    if (operation) { const found = operations.get(operation[1]!); if (!found) throw new LabError('bench-unavailable', 503); return structuredClone(found) as T; }
    return structuredClone(status) as T;
  } };
  return { client, status, facts, sent, operations, outcomes, hooks, setRestarting: (value: boolean) => { restarting = value; }, setFailing: (value: boolean) => { failing = value; } };
}

const incident = (over: Partial<BenchIncident> = {}): BenchIncident => ({
  failureId: 'f1:aaaa', revision: 3, ordinal: 1, failureClass: 'payload-schema', stage: 'map', errorCode: 'INVALID_PAYLOAD', policy: 'quarantine-resync', state: 'open', progress: 'held', recovery: 'denied', quarantine: 'acknowledged', nextAction: 'reassess',
  evidence: { location: 'kafka', completeness: 'complete', hash: 'sha256:' + 'a'.repeat(64) }, position: { topic: 'lab-1.field.gauges', partition: 0, offset: '41' }, generation: `lab-1-${STUDY}`, handlerBuildId: 'lontra-lab@1.1.0+projection-v2-broken',
  firstObservedAt: '2026-10-04T12:00:01.000Z', lastObservedAt: '2026-10-04T12:00:01.000Z', guard: { decision: 'hold', reason: 'coverage-withheld' }, boundary: null,
  history: [{ at: '2026-10-04T12:00:01.000Z', event: 'detected' }, { at: '2026-10-04T12:00:01.100Z', event: 'quarantined' }, { at: '2026-10-04T12:00:01.200Z', event: 'held' }], ...over
});

async function lab(t: TestContext, options: { profile?: 'retry' | 'quarantine'; verified?: typeof VERIFIED } = {}) {
  let now = Date.parse('2026-10-04T12:00:00Z');
  const dataDir = await mkdtemp(join(tmpdir(), 'lab-intents-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const world = createWorld({ seed: 'lontra-creek' }); advanceTo(world, TICK);
  const views = new Map(currentEmissions(world).map(emission => [emission.key, emission]));
  const studies = new LabStudies({ dataDir, world: { get tick() { return world.tick; }, view: key => views.get(key), world: () => world }, now: () => now });
  const published: { topic: string; key: string; value: string; at: RecordCoordinates }[] = [];
  let offset = 40;
  const sink = { async send(record: { topic: string; key: string; value: string }) { const at = { topic: record.topic, partition: 0, offset: String(++offset) }; published.push({ ...record, at }); return at; } };
  const bench = scriptedBench(() => now);
  if (options.profile === 'retry') bench.status.failures!.profile = 'retry';
  const pool = new LeasePool({ client: bench.client, benches: [1], gatewayOrigin: 'https://demo.test', now: () => now, studies, capabilities: { profile: options.profile ?? 'quarantine', localExercises: true, verified: options.verified ?? VERIFIED } });
  const intents = attachIntents(pool, { studies, sink, now: () => now, pollMs: 1 });
  await pool.initialize(); await pool.run(() => pool.sweep());
  const session = { subject: 'visitor-1', role: 'volunteer' as const, exp: now + 1_800_000 };
  await pool.run(() => pool.join(session, '203.0.113.9')); await pool.token(session);
  const submit = (body: Record<string, unknown>) => pool.run(() => intents.submit(session.subject, { requestId: `req-${Math.random().toString(36).slice(2, 12)}`, ...body } as never));
  const settled = async (operationId: string): Promise<LabOperation> => { for (let i = 0; i < 500; i++) { const op = intents.operation(session.subject, operationId)!; if (!['accepted', 'running'].includes(op.status)) return op; await sleep(2); } throw new Error('never settled'); };
  const view = () => pool.run(() => intents.incident(session.subject));
  return { pool, intents, bench, studies, world, published, session, submit, settled, view, advance: (ms: number) => { now += ms; }, now: () => now };
}
const revisionOf = (view: LabIncidentView) => view.status === 'open' ? view.incident.scenarioRevision : null;
const refused = (code: string) => (error: unknown) => error instanceof LabError && error.code === code;

describe('the answers to an intent, in order (section 12.5)', () => {
  test('a re-sent request ID with the same body answers the recorded operation, even inside the action budget; a different body is not-applicable', async t => {
    const l = await lab(t);
    const body = { requestId: 'req-00000001', intent: 'scenario.start', scenario: 'calibration-blip' };
    const first = await l.submit(body);
    assert.equal(first.status, 'accepted'); assert.match(first.operationId, /^lop_[A-Za-z0-9_-]{22}$/);
    const again = await l.submit(body);
    assert.equal(again.operationId, first.operationId, 'the same operation, without spending the budget');
    await assert.rejects(l.submit({ ...body, scenario: 'fouled-sensor' }), refused('not-applicable'));
    assert.equal((await l.settled(first.operationId)).status, 'succeeded');
    await assert.rejects(l.submit({ requestId: 'req-00000002', intent: 'scenario.start', scenario: 'fouled-sensor' }), refused('too-many-actions'), 'a new decision within the second');
    assert.equal(l.bench.sent.length, 1, 'the bench saw the intent once');
  });

  test('one intent at a time: another is not-applicable while one is accepted or running', async t => {
    const l = await lab(t);
    l.bench.outcomes.set('scenario.start', 'hold');
    const first = await l.submit({ requestId: 'req-00000001', intent: 'scenario.start', scenario: 'calibration-blip' });
    l.advance(1000);
    await assert.rejects(l.submit({ requestId: 'req-00000002', intent: 'scenario.start', scenario: 'fouled-sensor' }), refused('not-applicable'));
    assert.equal((await l.submit({ requestId: 'req-00000001', intent: 'scenario.start', scenario: 'calibration-blip' })).operationId, first.operationId, 'the running one is still answered by its request ID');
    l.bench.operations.get(first.operationId)!.status = 'succeeded';
    assert.equal((await l.settled(first.operationId)).status, 'succeeded');
    l.bench.outcomes.delete('scenario.start');
    const second = await l.submit({ requestId: 'req-00000002', intent: 'scenario.start', scenario: 'fouled-sensor' });
    assert.equal(second.status, 'accepted', 'accepted once the first is final');
    assert.deepEqual(l.bench.sent.map(request => request.scenario), ['calibration-blip', 'fouled-sensor']);
  });

  test('preconditions: no incident for incident intents, nothing to restore, no withheld run, a start while an incident is open', async t => {
    const l = await lab(t);
    await assert.rejects(l.submit({ intent: 'incident.retry-current', expectedRevision: 1 }), refused('not-applicable'));
    await assert.rejects(l.submit({ intent: 'scenario.restore-calibration', expectedRevision: 1 }), refused('not-applicable'));
    await assert.rejects(l.submit({ intent: 'scenario.prepare-coverage', expectedRevision: 1 }), refused('not-applicable'));
    l.bench.facts.incident = incident();
    const revision = revisionOf(await l.view())!;
    await assert.rejects(l.submit({ intent: 'scenario.start', scenario: 'garbled-reading' }), refused('not-applicable'), 'one incident at a time');
    await assert.rejects(l.submit({ intent: 'incident.reassess', expectedRevision: revision - 1 }), refused('not-applicable'), 'a stale revision');
    await assert.rejects(l.submit({ intent: 'incident.approve-reprocess', expectedRevision: revision, planToken: 'x'.repeat(43) }), refused('not-applicable'), 'not the projection\'s token');
    assert.equal(l.bench.sent.length, 0, 'nothing reached the bench');
  });

  test('an incident intent names the library incident and revision the projection showed, never anything from the browser', async t => {
    const l = await lab(t);
    l.bench.facts.incident = incident();
    const revision = revisionOf(await l.view())!;
    l.bench.outcomes.set('incident.reassess', { status: 'refused', outcome: 'integrity-class' });
    const op = await l.submit({ intent: 'incident.reassess', expectedRevision: revision });
    const done = await l.settled(op.operationId);
    assert.deepEqual(l.bench.sent.map(request => [request.intent, request.incident, request.operationId]), [['incident.reassess', { failureId: 'f1:aaaa', revision: 3 }, op.operationId]]);
    assert.equal(done.status, 'refused'); assert.match(done.detail!, /integrity fault/);
    assert.equal(done.scenarioRevision, revision, 'the projection didn\'t change');
  });

  test('scenario.restore-calibration names no incident: only incident intents do (section 8b)', async t => {
    const l = await lab(t);
    l.bench.facts.app.calibration = 'removed';
    l.bench.facts.incident = incident({ failureClass: 'mapper-error', policy: 'pause', quarantine: 'not-required', nextAction: 'repair-and-retry', recovery: 'not-applicable' });
    const op = await l.submit({ intent: 'scenario.restore-calibration', expectedRevision: revisionOf(await l.view()) });
    assert.equal((await l.settled(op.operationId)).status, 'succeeded');
    assert.deepEqual(l.bench.sent.map(request => [request.intent, 'incident' in request]), [['scenario.restore-calibration', false]]);
  });

  test('a lease that ends cancels unfinished operations; they and the last projection stay readable for a minute', async t => {
    const l = await lab(t);
    l.bench.facts.incident = incident();
    const revision = revisionOf(await l.view())!;
    l.bench.outcomes.set('incident.reassess', 'hold');
    const op = await l.submit({ intent: 'incident.reassess', expectedRevision: revision });
    await sleep(5);
    await l.pool.run(() => l.pool.leave(l.session));
    const cancelled = l.intents.operation(l.session.subject, op.operationId)!;
    assert.equal(cancelled.status, 'cancelled'); assert.match(cancelled.detail!, /lease ended/);
    // A late bench result changes nothing.
    l.bench.operations.get(op.operationId)!.status = 'succeeded';
    await sleep(10);
    assert.equal(l.intents.operation(l.session.subject, op.operationId)!.status, 'cancelled');
    const discarded = await l.view();
    assert.equal(discarded.status === 'open' && discarded.incident.discarded, true);
    l.advance(60_000);
    assert.equal(l.intents.operation(l.session.subject, op.operationId), null);
    await assert.rejects(l.view(), refused('no-lease'));
  });
});

describe('the projection (section 12.7)', () => {
  test('scenarioRevision moves whenever the projection does, and the plan token is offered exactly with approval', async t => {
    const l = await lab(t);
    assert.deepEqual((await l.view()).status, 'none');
    l.bench.facts.incident = incident({ state: 'resolved', progress: 'advanced', recovery: 'boundary-in-force', nextAction: 'evaluate', boundary: 'in-force' });
    l.bench.facts.app.mapping = 'corrected';
    const first = await l.view();
    assert.equal(revisionOf(await l.view()), revisionOf(first), 'nothing changed, so the revision holds');
    assert.equal(first.status === 'open' && first.incident.nextIntent, 'incident.evaluate');
    const expiresAt = new Date(l.now() + 120_000).toISOString();
    l.bench.facts.evaluation = { at: new Date(l.now()).toISOString(), incidentRevision: 3, validation: 'valid', eligible: true, ineligibleReason: null, errorClass: null, outputs: 1, expiresAt, planToken: 't'.repeat(43) };
    const offered = await l.view();
    assert.ok(revisionOf(offered)! > revisionOf(first)!, 'a new evaluation and token move the revision');
    assert.equal(offered.status === 'open' && offered.incident.nextIntent, 'incident.approve-reprocess');
    assert.equal(offered.status === 'open' && offered.incident.evaluation?.planToken, 't'.repeat(43));
    // The token spent or expired: no token and no approval, and a new revision.
    l.bench.facts.evaluation = { ...l.bench.facts.evaluation, planToken: null };
    const spent = await l.view();
    assert.ok(revisionOf(spent)! > revisionOf(offered)!);
    assert.equal(spent.status === 'open' && spent.incident.evaluation?.planToken, null);
    assert.equal(spent.status === 'open' && spent.incident.nextIntent, 'incident.evaluate');
    l.bench.facts.evaluation = { ...l.bench.facts.evaluation, planToken: 'u'.repeat(43), expiresAt: new Date(l.now() - 1).toISOString() };
    const expired = await l.view();
    assert.deepEqual(expired.status === 'open' && [expired.incident.evaluation?.planToken, expired.incident.nextIntent], [null, 'incident.evaluate'], 'an expired token is never offered');
  });

  test('an older read that answers late never rolls the projection back', async t => {
    const l = await lab(t);
    l.bench.facts.incident = incident();
    const first = await l.view();
    // A read is asked for (it captures the bench's facts now) and answers only after a newer one.
    let release!: () => void;
    l.bench.hooks.beforeFacts = () => new Promise<void>(resolve => { release = resolve; });
    const late = l.intents.incident(l.session.subject);
    await sleep(5);
    delete l.bench.hooks.beforeFacts;
    l.bench.facts.incident = incident({ revision: 4, quarantine: 'acknowledged', progress: 'advanced', state: 'resolved', nextAction: 'evaluate', recovery: 'boundary-in-force', boundary: 'in-force' });
    const newer = await l.view();
    assert.ok(revisionOf(newer)! > revisionOf(first)!);
    release();
    const answered = await late;
    assert.deepEqual(answered.status === 'open' && [answered.incident.scenarioRevision, answered.incident.source], [revisionOf(newer), 'advanced'], 'the late read answers the newer projection');
    const after = await l.view();
    assert.deepEqual(after.status === 'open' && [after.incident.scenarioRevision, after.incident.source], [revisionOf(newer), 'advanced'], 'and the revision did not move back');
  });

  test('while the bench\'s gateway restarts, the last projection is answered unchanged', async t => {
    const l = await lab(t);
    l.bench.facts.incident = incident();
    const before = await l.view();
    l.bench.setRestarting(true);
    assert.deepEqual(await l.view(), { ...before, now: (await l.view()).now });
  });

  test('composition from facts, against expectations written here', () => {
    const facts: BenchIncidentFacts = { profile: 'quarantine', studyId: STUDY, app: { calibration: 'present', mapping: 'broken', blips: 0, blipArmed: false }, incident: incident(), circuit: { state: 'closed', recentIncidents: 1, limit: 5 }, evaluation: null, reprocess: null, resynchronizedAt: null, steps: [{ at: '2026-10-04T12:00:00.500Z', text: 'Bench step' }] };
    const entry = { scenarioId: 'bad-projection', runId: 'r1', mutation: { kind: 'station-reading' as const, stationId: 'LC-03' as const, tick: 1, reading: { flowCfs: 1 } }, revision: '1', affected: [], status: 'withheld' as const, watermark: null, publication: { topic: 'lab-1.field.gauges', partition: 0, offset: '41' }, recordedAt: '', establishedAt: null };
    const summary = compose({ facts, scenario: 'bad-projection', entries: [entry], steps: [{ at: '2026-10-04T12:00:00.000Z', text: 'Published' }], now: 0 })!;
    assert.deepEqual([summary.label, summary.evidence, summary.source, summary.recovery, summary.nextIntent, summary.policy, summary.failure], ['Incident 1', 'saved', 'held', 'coverage-not-ready', 'scenario.prepare-coverage', 'quarantine-resync', { stage: 'map', class: 'payload-schema' }]);
    assert.deepEqual(summary.steps.map(step => [step.origin, step.text]), [['application', 'Published'], ['application', 'Bench step'], ['library', 'StreamOtter detected the failure'], ['library', 'The quarantine copy was acknowledged'], ['library', 'The source is held at the record']]);
    assert.equal(summary.stepsGap, false);
    const established = compose({ facts, scenario: 'bad-projection', entries: [{ ...entry, status: 'established' }], steps: [], now: 0 })!;
    assert.deepEqual([established.recovery, established.nextIntent], ['coverage-established', 'incident.reassess']);
    const resynced = compose({ facts: { ...facts, incident: incident({ progress: 'advanced', state: 'resolved', nextAction: 'evaluate' }), resynchronizedAt: '2026-10-04T12:00:05.000Z' }, scenario: 'bad-projection', entries: [{ ...entry, status: 'established' }], steps: [], now: 0 })!;
    assert.deepEqual([resynced.recovery, resynced.source, resynced.nextIntent], ['view-resynchronized', 'advanced', null], 'evaluation waits for the corrected projection');
    const paused = compose({ facts: { ...facts, app: { ...facts.app, blipArmed: true }, incident: incident({ failureClass: 'mapper-transient', policy: 'pause', quarantine: 'not-required', evidence: { location: 'none', completeness: 'complete', hash: '' }, nextAction: 'repair-and-retry', recovery: 'not-applicable' }) }, scenario: 'calibration-blip', entries: [], steps: [], now: 0 })!;
    assert.deepEqual([paused.evidence, paused.recovery, paused.nextIntent, paused.detail.evidenceFingerprint], ['not-required', 'none', 'scenario.restore-calibration', null]);
    const circuit = compose({ facts: { ...facts, circuit: { state: 'open', recentIncidents: 5, limit: 5 }, incident: incident({ nextAction: 'reopen-circuit', recovery: 'held' }) }, scenario: 'too-many-bad-readings', entries: [], steps: [], now: 0 })!;
    assert.equal(circuit.nextIntent, null); assert.match(circuit.reason, /no action to reopen it/);
    const gap = compose({ facts: { ...facts, incident: incident({ history: [{ at: '2026-10-04T12:00:01.200Z', event: 'held' }] }) }, scenario: 'bad-projection', entries: [], steps: [], now: 0 })!;
    assert.equal(gap.stepsGap, true, 'the library\'s bounded history no longer starts at detected');
    // LC11-S09: the library learns the copy is gone only when an evaluation reads it back; that finding is the evidence's.
    const expired = { at: '2026-10-04T12:00:09.000Z', incidentRevision: 3, validation: 'invalid' as const, eligible: false, ineligibleReason: 'evidence-expired', errorClass: null, outputs: 0, expiresAt: null, planToken: null };
    const gone = compose({ facts: { ...facts, evaluation: expired, incident: incident({ progress: 'advanced', state: 'resolved', nextAction: 'evaluate' }) }, scenario: 'unavailable-evidence', entries: [], steps: [], now: 0 })!;
    assert.deepEqual([gone.evidence, gone.evaluation?.result, gone.evaluation?.summary], ['unavailable', 'failed', 'The saved record couldn\'t be evaluated: the saved record is no longer available.']);
    const stillFails = compose({ facts: { ...facts, evaluation: { ...expired, ineligibleReason: 'still-fails', errorClass: 'invalid-json' } }, scenario: 'garbled-reading', entries: [], steps: [], now: 0 })!;
    assert.deepEqual([stillFails.evidence, stillFails.evaluation?.summary], ['saved', 'The saved record still fails with today\'s handlers (invalid-json).']);
    for (const s of [summary, established, resynced, paused, circuit, gone]) assert.doesNotMatch(JSON.stringify(s), /f1:|rb1:|op1:|pl1:|\/(?:var|tmp|home|run)\//);
  });
});

describe('scenario records against the expected ledger', () => {
  const parse = (value: string) => JSON.parse(value) as { tenantId: string; channel: string; params: { stationId: string }; revision: string; data: Record<string, unknown>; mapping?: string; readings?: Record<string, unknown>[] };
  const start = async (l: Awaited<ReturnType<typeof lab>>, scenario: LabScenarioId) => { const op = await l.submit({ intent: 'scenario.start', scenario }); l.advance(1000); return l.settled(op.operationId); };

  test('garbled-reading: a truncated LC-03 record that isn\'t JSON, coverage withheld', async t => {
    const l = await lab(t);
    assert.equal((await start(l, 'garbled-reading')).status, 'succeeded');
    assert.equal(l.published.length, 1);
    const [record] = l.published;
    assert.deepEqual([record!.topic, record!.key], [Expected.topic, 'station:LC-03']);
    assert.throws(() => JSON.parse(record!.value));
    const runs = await l.studies.runs(1, STUDY);
    assert.deepEqual(runs.map(run => [run.scenarioId, run.status, run.revision, [...run.affected]]), [['garbled-reading', 'withheld', Expected.revision(TICK), Expected.flowAffects]]);
    assert.deepEqual(runs[0]!.publication, record!.at);
  });

  test('bad-projection: a v2 record carrying exactly the derived LC-03 view at the current tick; prepare-coverage releases it', async t => {
    const l = await lab(t);
    await start(l, 'bad-projection');
    const value = parse(l.published[0]!.value);
    assert.deepEqual([value.mapping, value.channel, value.params, value.revision], ['lab-projection-v2', 'station', { stationId: 'LC-03' }, Expected.revision(TICK)]);
    const current = currentEmissions(l.world).find(e => e.key === 'station:LC-03')!.data as unknown as Record<string, unknown>;
    assert.notEqual(value.data['flowCfs'], current['flowCfs'], 'a reading that differs from the current one');
    assert.deepEqual(await l.studies.snapshot(1, 'station:LC-03', null), { revision: currentEmissions(l.world).find(e => e.key === 'station:LC-03')!.revision, data: current }, 'withheld: served state is still the creek\'s');
    // The bench reports the incident at the record's coordinates: the projection points at preparing coverage.
    l.bench.facts.incident = incident({ position: { ...l.published[0]!.at } });
    const shown = await l.view();
    assert.equal(shown.status === 'open' && shown.incident.nextIntent, 'scenario.prepare-coverage');
    assert.equal(shown.status === 'open' && shown.incident.recovery, 'coverage-not-ready');
    const prepare = await l.submit({ intent: 'scenario.prepare-coverage', expectedRevision: revisionOf(shown) });
    assert.equal((await l.settled(prepare.operationId)).status, 'succeeded');
    const served = await l.studies.snapshot(1, 'station:LC-03', null);
    assert.deepEqual([served!.revision, served!.data], [Expected.revision(TICK), value.data], 'the study\'s authoritative update is the record\'s own view');
    const after = await l.view();
    assert.deepEqual(after.status === 'open' && [after.incident.recovery, after.incident.nextIntent], ['coverage-established', 'incident.reassess']);
    assert.ok(after.status === 'open' && after.incident.steps.some(step => /Snapshot coverage released/.test(step.text)));
  });

  test('a run is built at the tick it is published: the world moving on while the bench arms doesn\'t fail the start', async t => {
    const l = await lab(t);
    l.bench.hooks.onIntent = () => { advanceTo(l.world, TICK + 1); };
    assert.equal((await start(l, 'bad-projection')).status, 'succeeded');
    assert.equal(parse(l.published[0]!.value).revision, Expected.revision(TICK + 1));
    assert.deepEqual((await l.studies.runs(1, STUDY)).map(run => run.revision), [Expected.revision(TICK + 1)]);
  });

  test('conflicting-readings: one batch record, two different readings at one revision', async t => {
    const l = await lab(t);
    await start(l, 'conflicting-readings');
    const value = parse(l.published[0]!.value);
    assert.equal(value.mapping, 'lab-reading-batch');
    assert.equal(value.readings!.length, 2);
    assert.notDeepEqual(value.readings![0], value.readings![1]);
    assert.deepEqual(value.readings![0], value.data);
    assert.equal((await l.studies.runs(1, STUDY))[0]!.status, 'established', 'coverage pending is established before publication');
  });

  test('too-many-bad-readings publishes six; restart-recovery an LC-03 flow and an LC-01 temperature reading', async t => {
    const l = await lab(t);
    await start(l, 'too-many-bad-readings');
    assert.equal(l.published.length, 6);
    assert.ok(l.published.every(record => parse(record.value).mapping === 'lab-projection-v2' && record.key === 'station:LC-03'));
    assert.equal(new Set(l.published.map(record => parse(record.value).data['flowCfs'])).size, 6, 'six different readings');
    const r = await lab(t);
    await start(r, 'restart-recovery');
    assert.deepEqual(r.published.map(record => record.key), ['station:LC-03', 'station:LC-01']);
    assert.deepEqual((await r.studies.runs(1, STUDY)).map(run => [...run.affected]), [Expected.flowAffects, Expected.temperatureAffects]);
  });

  test('calibration-blip and fouled-sensor publish nothing: the bench arms them', async t => {
    const l = await lab(t, { profile: 'retry' });
    await start(l, 'calibration-blip');
    assert.equal(l.published.length, 0);
    assert.deepEqual(l.bench.sent.map(request => [request.intent, request.scenario]), [['scenario.start', 'calibration-blip']]);
  });

  test('a bench that refuses to arm publishes nothing', async t => {
    const l = await lab(t);
    l.bench.outcomes.set('scenario.start', { status: 'refused', outcome: 'not-applicable' });
    const done = await start(l, 'bad-projection');
    assert.equal(done.status, 'refused'); assert.equal(l.published.length, 0);
  });
});

describe('the public routes (sections 12.5 to 12.7)', () => {
  async function serving(server: Server, run: (origin: string) => Promise<void>) { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } }

  test('202 with a LabOperation, CORS, session, Origin; operations and the incident are 404 when not offered', async t => {
    const l = await lab(t);
    const config = readConfig({ SITE_ORIGIN: 'https://site.test' });
    // Visitor-1 holds the only bench (lab()); the HTTP visitor queues behind it.
    const server = publicApi({ config, station: {} as FieldStation, notebooks: {} as Notebooks, lab: l.pool });
    await serving(server, async origin => {
      const join = await fetch(`${origin}/api/lab/lease`, { method: 'POST', headers: { origin: 'https://site.test' } });
      const cookie = join.headers.get('set-cookie')!.split(';')[0]!;
      const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/lab/actions`, { method: 'POST', headers: { origin: 'https://site.test', cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      // Queued behind visitor-1: no active lease yet.
      const queued = await post({ intent: 'scenario.start', requestId: 'req-00000010', scenario: 'bad-projection' });
      assert.deepEqual([queued.status, (await queued.json() as { code: string }).code], [409, 'no-lease']);
      assert.equal(queued.headers.get('access-control-allow-origin'), 'https://site.test');
      assert.equal((await post({ intent: 'scenario.start', requestId: 'req-00000010', scenario: 'bad-projection' }, { origin: 'https://evil.test' })).status, 403);
      assert.equal((await fetch(`${origin}/api/lab/incident`)).status, 401);
      assert.equal((await fetch(`${origin}/api/lab/operations/lop_${'a'.repeat(22)}`, { headers: { cookie } })).status, 404);
      // Visitor-1 returns the bench; the HTTP visitor gets it.
      await l.pool.run(() => l.pool.leave(l.session));
      await fetch(`${origin}/api/lab/lease/token`, { method: 'POST', headers: { origin: 'https://site.test', cookie } });
      l.bench.outcomes.set('scenario.start', 'hold');
      const accepted = await post({ intent: 'scenario.start', requestId: 'req-00000011', scenario: 'bad-projection' });
      assert.equal(accepted.status, 202);
      const operation = await accepted.json() as LabOperation;
      assert.equal(operation.status, 'accepted');
      const repeated = await post({ intent: 'scenario.start', requestId: 'req-00000011', scenario: 'bad-projection' });
      assert.deepEqual([repeated.status, (await repeated.json() as LabOperation).operationId], [202, operation.operationId], 'a lost answer re-sent with the same requestId');
      const running = await post({ intent: 'scenario.start', requestId: 'req-00000012', scenario: 'garbled-reading' });
      assert.deepEqual([running.status, (await running.json() as { code: string }).code], [409, 'not-applicable'], 'one intent at a time');
      l.bench.outcomes.delete('scenario.start'); l.bench.operations.get(operation.operationId)!.status = 'succeeded';
      let final: LabOperation | undefined;
      for (let i = 0; i < 200 && !(final && !['accepted', 'running'].includes(final.status)); i++) { final = await (await fetch(`${origin}/api/lab/operations/${operation.operationId}`, { headers: { cookie } })).json() as LabOperation; await sleep(5); }
      assert.equal(final!.status, 'succeeded');
      const budget = await post({ intent: 'scenario.start', requestId: 'req-00000013', scenario: 'garbled-reading' });
      assert.deepEqual([budget.status, budget.headers.get('retry-after'), (await budget.json() as { code: string }).code], [429, '1', 'too-many-actions']);
      const view = await (await fetch(`${origin}/api/lab/incident`, { headers: { cookie, origin: 'https://site.test' } })).json() as LabIncidentView;
      assert.equal(view.status, 'none');
      assert.equal((await fetch(`${origin}/api/lab/incident?x=1`, { headers: { cookie } })).status, 400);
    });
    // The same backend without a verified release serves neither route.
    const plain = new LeasePool({ client: l.bench.client, benches: [1], gatewayOrigin: 'https://demo.test', capabilities: { profile: 'quarantine', localExercises: true, verified: new Map() } });
    attachIntents(plain);
    await serving(publicApi({ config, station: {} as FieldStation, notebooks: {} as Notebooks, lab: plain }), async origin => {
      const join = await fetch(`${origin}/api/lab/lease`, { method: 'POST', headers: { origin: 'https://site.test' } });
      const cookie = join.headers.get('set-cookie')!.split(';')[0]!;
      assert.equal((await fetch(`${origin}/api/lab/incident`, { headers: { cookie } })).status, 404);
      assert.equal((await fetch(`${origin}/api/lab/operations/lop_${'a'.repeat(22)}`, { headers: { cookie } })).status, 404);
      const refusedIntent = await fetch(`${origin}/api/lab/actions`, { method: 'POST', headers: { origin: 'https://site.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify({ intent: 'scenario.start', requestId: 'req-00000020', scenario: 'bad-projection' }) });
      assert.deepEqual([refusedIntent.status, (await refusedIntent.json() as { code: string }).code], [409, 'unsupported-scenario']);
    });
  });

  test('a bench whose failure-handling profile isn\'t the deployment\'s is never granted', async () => {
    const bench = scriptedBench(Date.now);
    bench.status.failures = { profile: 'retry', durable: true, handlerBuildId: null };
    const pool = new LeasePool({ client: bench.client, benches: [1], gatewayOrigin: 'https://demo.test', capabilities: { profile: 'quarantine', localExercises: false } });
    await pool.initialize(); await pool.run(() => pool.sweep());
    assert.equal(pool.status().benches[0]!.state, 'unavailable');
    const old = scriptedBench(Date.now); delete old.status.failures;
    const offPool = new LeasePool({ client: old.client, benches: [1], gatewayOrigin: 'https://demo.test' });
    await offPool.initialize(); await offPool.run(() => offPool.sweep());
    assert.equal(offPool.status().benches[0]!.state, 'ready', 'an older bench counts as off, which an off deployment grants');
  });
});

