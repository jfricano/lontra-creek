/**
 * The bench's failure handling against the installed StreamOtter 0.2.0-rc.1 (Lab
 * contract section 8b, LC11-S01 to S08 bench side).
 *
 * Evidence level: the real library on a fixture source. Every bench in this file is a
 * real BenchRuntime whose gateway is the installed library's own `createGateway`, with
 * the study's journal created by `streamotter init --failures` (`runCli`, through
 * journal.ts) and opened by the library; the bench's real handlers, recovery guard, and
 * operator adapter; and the library's own management route to advance the fixture.
 * Incidents, policies, outcomes, and boundaries below are what the library decided.
 *
 * What is a stand-in, and what that leaves unproven:
 *   - The source is a fixture, not Kafka. The services stand-in swaps the bench's Kafka
 *     source for a fixture source with the same generation (the journal allows a source
 *     kind change while no incident is open). With a fixture source the library keeps
 *     quarantine evidence in the journal (`local`): no quarantine topic write, no
 *     committed offset, and no Kafka coordinates for the guard. The quarantine topic
 *     write, its grants, and the committed offset are proven only by the real-Kafka
 *     stack tests (W9b slice D).
 *   - The field station's recovery-assess and snapshot routes are a stub that answers
 *     what each test sets. The real ledger, guard, and acknowledgment are tested in
 *     lab-coverage.test.ts; here the stub stands in for them so the library's side of
 *     the exchange can be observed.
 *   - The relay control and the field station's study gate are stand-ins, as in
 *     lab-study.test.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { advanceTo, createWorld, currentEmissions } from '@lontra-creek/sim';
import { createGateway } from 'streamotter/gateway';
import { startManagementServer } from 'streamotter/gateway/management';
import { getGatewayOperator } from 'streamotter/gateway/operator';
import type { DataFrame, FixtureRecord, Json, ProjectConfig, SubscriptionFrame } from 'streamotter/contracts';
import { benchConfig, benchHandlers, handlerBuildId, PROJECTION_V2, READING_BATCH, type LabChannels } from '../src/lab/bench.ts';
import type { BenchIncidentFacts, BenchIntentRequest, BenchOperation, BenchSnapshot, RecoveryAssessment } from '../src/lab/contract.ts';
import { createJournal, JOURNAL_FILE } from '../src/lab/journal.ts';
import { BenchRuntime, type BenchJournal, type BenchServices } from '../src/lab/runtime.ts';
import { generationFor, newStudyId } from '../src/lab/study.ts';
import { toRecord } from '../src/records.ts';

const SERVICE = 's'.repeat(32);
const SITE = 'https://lab.test';

// ---------------------------------------------------------------------------
// Records, from the real simulation: LC-03's current reading and the scenario
// variants the field station would publish (section 12.5).
// ---------------------------------------------------------------------------
const world = createWorld({ seed: 'lontra-creek' }); advanceTo(world, 500);
const lc03 = (): { key: string; value: Record<string, Json> } => {
  const emission = currentEmissions(world).find(item => item.key === 'station:LC-03')!;
  const { key, value } = toRecord(emission); return { key, value: value as unknown as Record<string, Json> };
};
const READING = lc03();
const DATA = READING.value['data'] as Record<string, Json>;
const at = (tick: number) => { const w = createWorld({ seed: 'lontra-creek' }); advanceTo(w, tick); const e = currentEmissions(w).find(item => item.key === 'station:LC-03')!; return toRecord(e) as unknown as { key: string; value: Record<string, Json> }; };
const live = (tick = 500): FixtureRecord => { const r = tick === 500 ? READING : at(tick); return { key: r.key, value: r.value }; };
const garbled = (): FixtureRecord => ({ key: READING.key, raw: JSON.stringify(READING.value).slice(0, 60) });
const v2 = (tick = 500): FixtureRecord => { const r = tick === 500 ? READING : at(tick); return { key: r.key, value: { ...r.value, mapping: PROJECTION_V2 } }; };
const batch = (): FixtureRecord => ({ key: READING.key, value: { ...READING.value, mapping: READING_BATCH, readings: [DATA, { ...DATA, flowCfs: Number(DATA['flowCfs']) + 7 }] } });

// ---------------------------------------------------------------------------
// The field station stub: recovery-assess and snapshot routes, answering what the
// test sets. Not the real ledger (see the header).
// ---------------------------------------------------------------------------
const station = {
  assess: null as ((studyId: string) => RecoveryAssessment) | null,
  acknowledge: true,
  assessed: [] as Record<string, unknown>[],
  views: [] as { path: string; boundary: string | null }[]
};
function listen(server: Server): Promise<string> { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))); }
const closeServer = (server: Server) => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); };
const json = (response: import('node:http').ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
const fieldStation = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://station.invalid');
  if (request.headers.authorization !== `Bearer ${SERVICE}`) return json(response, 401, { error: 'Unauthorized.' });
  if (request.method === 'POST' && url.pathname === '/lab-internal/1/recovery/assess') {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { studyId: string }; station.assessed.push(body);
    return station.assess ? json(response, 200, station.assess(body.studyId)) : json(response, 200, { decision: 'hold', studyId: body.studyId, reason: 'coverage-withheld', evidenceRef: null });
  }
  if (request.method === 'GET' && url.pathname.startsWith('/lab-internal/1/views/')) {
    const boundary = url.searchParams.get('boundary'); station.views.push({ path: url.pathname, boundary });
    const snapshot: BenchSnapshot = { revision: String(READING.value['revision']), data: DATA, ...(boundary ? { boundary: { barrier: boundary, acknowledged: station.acknowledge, ...(station.acknowledge ? {} : { reason: 'lagging' as const }) } } : {}) };
    return json(response, 200, snapshot);
  }
  json(response, 404, { error: 'Not found.' });
});
const relay = createServer((_request, response) => json(response, 200, {}));
let stationOrigin = ''; let relayOrigin = '';
before(async () => { stationOrigin = await listen(fieldStation); relayOrigin = await listen(relay); });
after(async () => { await closeServer(fieldStation); await closeServer(relay); });

async function freePort(): Promise<number> { const server = createServer(); await listen(server); const { port } = server.address() as AddressInfo; await closeServer(server); return port; }

/**
 * The bench's gateway on a fixture source: the installed library's createGateway with
 * the journal options the bench passes, its management server, and its operator API.
 * This is the only difference from the bench's production `gatewayServices`, which
 * also validates the config under production rules (a fixture source never would).
 */
function fixtureServices(records: readonly FixtureRecord[], seen: { management?: { origin: string; token: string }; journals: (BenchJournal | null)[] }) {
  return async (config: ProjectConfig<LabChannels>, handlers: Parameters<typeof createGateway<LabChannels>>[0]['handlers'], token: string, _port: number, journal: BenchJournal | null): Promise<BenchServices> => {
    const generation = config.sources['field']!.generation;
    const fixture = { ...config, sources: { field: { kind: 'fixture' as const, generation, fixtureRef: 'field' } } } as ProjectConfig<LabChannels>;
    seen.journals.push(journal);
    const gateway = createGateway({ config: fixture, handlers, mode: 'development', development: { principals: {}, fixtures: { field: records } }, ...(journal ?? {}) });
    await gateway.start();
    try {
      const management = await startManagementServer({ gateway, host: '127.0.0.1', port: 0, token, workbenchDir: null });
      seen.management = { origin: management.origin, token };
      return { gateway, management, operator: journal ? getGatewayOperator(gateway) : null };
    } catch (error) { await gateway.stop(); throw error; }
  };
}

interface Bench {
  runtime: BenchRuntime; stateDir: string; port: number; seen: { management?: { origin: string; token: string }; journals: (BenchJournal | null)[] };
  /** Advances the fixture source through the library's management route; resolves with how many records it committed. */
  advance(count?: number): Promise<number>;
  intent(request: Omit<BenchIntentRequest, 'leaseId' | 'operationId'> & { operationId?: string }): Promise<BenchOperation>;
  /** Waits for an operation to reach a final status. */
  settled(operationId: string): Promise<BenchOperation>;
  facts(): Promise<BenchIncidentFacts>;
  /** Waits until the facts satisfy `check`. */
  until(check: (facts: BenchIncidentFacts) => boolean, what: string): Promise<BenchIncidentFacts>;
}
let operations = 0;
const operationId = () => `lop_${String(++operations).padStart(22, '0')}`;

async function bench(t: TestContext, profile: 'retry' | 'quarantine', records: readonly FixtureRecord[], stateDir?: string): Promise<Bench> {
  const dir = stateDir ?? await mkdtemp(join(tmpdir(), 'lab-failures-'));
  if (!stateDir) t.after(() => rm(dir, { recursive: true, force: true }));
  const port = await freePort(); const seen: Bench['seen'] = { journals: [] };
  const runtime = new BenchRuntime({ LAB_BENCH: '1', LAB_BENCH_1_SERVICE_TOKEN: SERVICE, LAB_BENCH_1_RELAY_TOKEN: 'r'.repeat(32), LAB_RELAY_ORIGIN: relayOrigin, LAB_SNAPSHOT_ORIGIN: stationOrigin, LAB_FAILURE_HANDLING: profile, BENCH_HOST: '127.0.0.1', BENCH_PORT: String(port), BENCH_MANAGEMENT_PORT: '0', SITE_ORIGIN: SITE }, {
    tickMs: 3_600_000, stateDir: dir, gate: { async close() {}, async discard() {} }, deleteGroup: async () => {}, quiesceMs: 50,
    services: fixtureServices(records, seen)
  });
  await runtime.start();
  t.after(() => runtime.close());
  assert.equal(runtime.status().state, 'ready', 'the bench provisions a study on the real library');
  await runtime.run(() => runtime.lease('lease-1', new Date(Date.now() + 240_000).toISOString()));
  const self: Bench = {
    runtime, stateDir: dir, port, seen,
    async advance(count = 1) {
      const response = await fetch(`${seen.management!.origin}/management/v1/dev/fixtures/advance`, { method: 'POST', headers: { authorization: `Bearer ${seen.management!.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'field', count }) });
      const body = await response.json() as { ok: boolean; data?: { advanced: number }; error?: { code: string } };
      return body.ok ? body.data!.advanced : -1;
    },
    intent: request => runtime.intent({ leaseId: 'lease-1', operationId: request.operationId ?? operationId(), ...request }),
    async settled(id) {
      for (let i = 0; i < 400; i++) { const operation = runtime.operation('lease-1', id)!; if (!['accepted', 'running'].includes(operation.status)) return operation; await sleep(50); }
      throw new Error(`Operation ${id} never settled.`);
    },
    facts: () => runtime.incident('lease-1'),
    async until(check, what) {
      let last: BenchIncidentFacts | undefined;
      for (let i = 0; i < 400; i++) { last = await runtime.incident('lease-1'); if (check(last)) return last; await sleep(50); }
      throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(last?.incident ?? null)}`);
    }
  };
  return self;
}
/** Sends an intent and waits for its final status. */
async function run(b: Bench, request: Parameters<Bench['intent']>[0]): Promise<BenchOperation> {
  const accepted = await b.intent(request);
  assert.equal(accepted.status, 'running');
  return b.settled(accepted.operationId);
}
const target = (facts: BenchIncidentFacts) => ({ failureId: facts.incident!.failureId, revision: facts.incident!.revision });
const recoverable = (seq: number) => (studyId: string): RecoveryAssessment => ({ decision: 'recoverable', studyId, barrier: `lcb1.${studyId}.${seq}`, covers: ['station:LC-03', 'creekOverview:lontra'], evidenceRef: `run-${seq}` });
const withheld = (studyId: string): RecoveryAssessment => ({ decision: 'hold', studyId, reason: 'coverage-withheld', evidenceRef: null });
function reset() { station.assess = null; station.acknowledge = true; station.assessed = []; station.views = []; }

describe('the study journal, created only by the published CLI', () => {
  test('a provisioned study gets an owner-only journal the running gateway reports durable', async t => {
    reset();
    const b = await bench(t, 'quarantine', []);
    const study = b.runtime.status().study!;
    const journal = join(b.stateDir, 'lab-1', 'studies', study.studyId, 'journal');
    assert.equal(((await stat(journal)).mode & 0o777), 0o700, 'the library creates the state directory owner-only');
    assert.ok((await readdir(journal)).includes(JOURNAL_FILE));
    assert.ok(!(await readdir(join(b.stateDir, 'lab-1', 'studies', study.studyId))).includes('failures-config.json'), 'the config written for the CLI is removed');
    assert.deepEqual(b.seen.journals, [{ stateDirectory: journal, handlerBuildId: handlerBuildId('broken') }]);
    assert.deepEqual(b.runtime.status().failures, { profile: 'quarantine', durable: true, handlerBuildId: handlerBuildId('broken') });
    // S3, measured from the running gateway: this test's stand-in really runs a fixture source.
    assert.equal(b.runtime.status().checks.fixtureSources, 1);
    assert.equal(b.runtime.status().checks.developmentPrincipals, 0);
  });

  test('init refuses a study that already has a journal: its decision state is never overwritten', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'lab-journal-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const studyId = newStudyId();
    const config = benchConfig(1, { profile: 'quarantine', generation: generationFor(1, studyId) });
    await createJournal(config, join(dir, 'journal'), dir);
    await assert.rejects(createJournal(config, join(dir, 'journal'), dir), /exited 2/);
    assert.deepEqual(await readdir(dir), ['journal'], 'the refused init leaves no config file behind');
  });

  test('a second gateway cannot open a journal a running one holds', async t => {
    reset();
    const b = await bench(t, 'quarantine', []);
    const study = b.runtime.status().study!;
    const config = benchConfig(1, { profile: 'quarantine', generation: study.generation, host: '127.0.0.1', port: await freePort() });
    const fixture = { ...config, sources: { field: { kind: 'fixture' as const, generation: study.generation, fixtureRef: 'field' } } } as ProjectConfig<LabChannels>;
    const handlers = benchHandlers(1, { authenticate: () => null, serviceToken: SERVICE, snapshotOrigin: stationOrigin, calibration: () => true, record: () => undefined, recovery: { study: () => null } });
    const second = createGateway({ config: fixture, handlers, mode: 'development', development: { principals: {}, fixtures: { field: [] } }, stateDirectory: join(b.stateDir, 'lab-1', 'studies', study.studyId, 'journal') });
    let refused: { code?: string; message?: string } | undefined;
    await assert.rejects(second.start(), (error: { code?: string; message?: string }) => { refused = error; return true; });
    await second.stop().catch(() => undefined);
    assert.equal(refused?.code, 'SOURCE_UNAVAILABLE'); assert.match(refused?.message ?? '', /owns this journal/);
    // The first gateway still runs on its journal.
    assert.equal((await b.facts()).incident, null);
    assert.equal(b.runtime.status().failures?.durable, true);
  });
});

describe('garbled-reading (LC11-S02): invalid JSON is quarantined and held', () => {
  test('quarantine-hold keeps evidence and holds; retry holds again, reassess and evaluate refuse', async t => {
    reset();
    const b = await bench(t, 'quarantine', [garbled(), live()]);
    assert.equal(await b.advance(), 0, 'the garbled record is not committed');
    const held = await b.until(f => f.incident?.progress === 'held', 'the held incident');
    const incident = held.incident!;
    assert.deepEqual([incident.failureClass, incident.stage, incident.policy, incident.state, incident.recovery, incident.quarantine, incident.nextAction], ['invalid-json', 'validate', 'quarantine-hold', 'open', 'held', 'acknowledged', 'repair-and-retry']);
    // A fixture source keeps the evidence in the journal; on Kafka it is the quarantine topic (slice D).
    assert.deepEqual([incident.evidence.location, incident.evidence.completeness], ['local', 'complete']);
    assert.match(incident.evidence.hash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual([incident.position, incident.generation, incident.handlerBuildId, incident.ordinal], [null, b.runtime.status().study!.generation, handlerBuildId('broken'), 1]);
    assert.deepEqual(incident.history.map(event => event.event), ['detected', 'captured', 'quarantined']);
    await b.runtime.tick();
    assert.deepEqual(b.runtime.status().scenario.source, { status: 'paused', reason: 'INVALID_PAYLOAD' }, 'the source holds the record');

    const retried = await run(b, { intent: 'incident.retry-current', incident: target(held) });
    assert.deepEqual([retried.status, retried.outcome], ['succeeded', 'held'], 'a retry that holds again still ran');
    const again = await b.facts();
    assert.equal(again.incident!.revision, retried.incidentRevision);
    assert.deepEqual(again.incident!.history.slice(-4).map(event => event.event), ['operator', 'retrying', 'detected', 'held']);
    const reassessed = await run(b, { intent: 'incident.reassess', incident: target(again) });
    assert.deepEqual([reassessed.status, reassessed.outcome], ['refused', 'policy-not-resync']);
    const evaluated = await run(b, { intent: 'incident.evaluate', incident: target(again) });
    assert.deepEqual([evaluated.status, evaluated.outcome], ['succeeded', 'evaluated']);
    // The library checks the saved bytes before whether the record advanced: undecodable bytes still fail.
    const { at: _at, ...evaluation } = (await b.facts()).evaluation!;
    assert.deepEqual(evaluation, { incidentRevision: again.incident!.revision, validation: 'invalid', eligible: false, ineligibleReason: 'still-fails', errorClass: 'invalid-json', outputs: 0, expiresAt: null, planToken: null });
    assert.equal(await b.advance(), -1, 'the held record blocks the source: nothing behind it advances');
  });

  test('a stale incident revision is refused by the library, not by a guess', async t => {
    reset();
    const b = await bench(t, 'quarantine', [garbled()]);
    await b.advance();
    const held = await b.until(f => f.incident?.progress === 'held', 'the held incident');
    const stale = await run(b, { intent: 'incident.retry-current', incident: { failureId: held.incident!.failureId, revision: held.incident!.revision - 1 } });
    assert.deepEqual([stale.status, stale.outcome], ['refused', 'stale-revision']);
    const evaluated = await run(b, { intent: 'incident.evaluate', incident: { failureId: held.incident!.failureId, revision: held.incident!.revision - 1 } });
    assert.deepEqual([evaluated.status, evaluated.outcome], ['refused', 'stale-revision'], 'an evaluation refused at the request stage is refused, and records nothing');
    assert.equal((await b.facts()).evaluation, null);
  });
});

describe('bad-projection (LC11-S03): an invalid public payload is quarantined, guarded, and advanced', () => {
  test('the guard holds until coverage is established; reassess then advances under a boundary', async t => {
    reset();
    const b = await bench(t, 'quarantine', [v2(), live()]);
    const studyId = b.runtime.status().study!.studyId;
    station.assess = withheld;
    await b.advance();
    const denied = await b.until(f => f.incident?.guard?.decision === 'hold', 'the guard to hold');
    const incident = denied.incident!;
    assert.deepEqual([incident.failureClass, incident.stage, incident.policy, incident.progress, incident.recovery, incident.quarantine, incident.nextAction, incident.boundary], ['payload-schema', 'map', 'quarantine-resync', 'held', 'denied', 'acknowledged', 'reassess', null]);
    assert.deepEqual(incident.guard, { decision: 'hold', reason: 'coverage-withheld' }, 'the guard\'s own reason, from the field station');
    // A fixture position names no record the ledger published: the guard sends no coordinates (on Kafka it sends topic, partition, offset).
    assert.ok(station.assessed.every(body => JSON.stringify(body) === JSON.stringify({ studyId, sourceId: 'field' })));
    station.assess = recoverable(1);
    const reassessed = await run(b, { intent: 'incident.reassess', incident: target(denied) });
    assert.deepEqual([reassessed.status, reassessed.outcome], ['succeeded', 'advanced']);
    const advanced = (await b.facts()).incident!;
    assert.deepEqual([advanced.state, advanced.progress, advanced.recovery, advanced.boundary, advanced.nextAction], ['resolved', 'advanced', 'boundary-in-force', 'in-force', 'evaluate']);
    assert.deepEqual(advanced.guard, { decision: 'recoverable', reason: null });
    assert.deepEqual(advanced.history.slice(-2).map(event => event.event), ['advance-pending', 'advance-confirmed']);
    assert.equal((await b.facts()).circuit?.recentIncidents, 1);
    await b.runtime.tick();
    assert.deepEqual(b.runtime.status().scenario.source, { status: 'healthy' }, 'the source continues past the record');
    assert.equal(await b.advance(), 1, 'the next record is processed');
  });
});

/** Subscribes the leaseholder to LC-03's station view and collects its state frames. */
async function subscribe(t: TestContext, b: Bench): Promise<{ states: SubscriptionFrame[]; until(state: string, ms?: number): Promise<boolean> }> {
  const { token } = b.runtime.token('lease-1');
  const socket = io(`http://127.0.0.1:${b.port}`, { path: '/lab/1/socket.io', transports: ['websocket'], auth: { token, protocolVersion: 1 }, extraHeaders: { Origin: SITE }, reconnection: false });
  t.after(() => { socket.disconnect(); });
  const states: SubscriptionFrame[] = [];
  socket.on('so:state', (frame: SubscriptionFrame) => states.push(frame));
  // A client acknowledges every frame it applied; the gateway reports the view live only then.
  socket.on('so:data', (frame: DataFrame) => socket.emit('so:receipt', { subscriptionId: frame.subscriptionId, epoch: frame.epoch, sequence: frame.sequence }));
  await new Promise<void>((resolve, reject) => { socket.on('so:hello', () => resolve()); socket.on('connect_error', reject); });
  await new Promise<void>((resolve, reject) => socket.emit('so:subscribe', { requestId: randomUUID(), subscriptionId: randomUUID(), channel: 'station', channelVersion: 1, params: { stationId: 'LC-03' } }, (result: { ok: boolean }) => result.ok ? resolve() : reject(new Error(JSON.stringify(result)))));
  return { states, async until(state, ms = 3000) { for (let i = 0; i < ms / 50; i++) { if (states.some(frame => frame.state === state)) return true; await sleep(50); } return false; } };
}

describe('the recovery boundary: every later snapshot must acknowledge it (LC11-ADR-01)', () => {
  test('a snapshot that does not acknowledge the barrier leaves the view stale; one that does makes it live', async t => {
    reset();
    const b = await bench(t, 'quarantine', [v2(), live()]);
    station.assess = recoverable(1);
    await b.advance();
    await b.until(f => f.incident?.progress === 'advanced', 'the automatic advance');
    station.acknowledge = false;
    const lagging = await subscribe(t, b);
    assert.equal(await lagging.until('live', 1500), false, 'an unacknowledged snapshot never goes live');
    assert.ok(lagging.states.some(frame => frame.state === 'stale'), 'the view is visibly stale');
    const studyId = b.runtime.status().study!.studyId;
    assert.ok(station.views.length > 0 && station.views.every(view => view.path === '/lab-internal/1/views/station/LC-03' && view.boundary === `lcb1.${studyId}.1`), 'every snapshot asks the served state about the boundary\'s barrier');
    await b.runtime.tick();
    assert.equal((await b.facts()).resynchronizedAt, null, 'no successful snapshot yet');

    station.acknowledge = true;
    const acknowledged = await subscribe(t, b);
    const wentLive = await acknowledged.until('live');
    assert.equal(wentLive, true, 'an acknowledged snapshot echoes the boundary and the view goes live');
    await b.runtime.tick();
    const facts = await b.facts();
    const confirmed = facts.incident!.history.findLast(event => event.event === 'advance-confirmed')!.at;
    assert.ok(facts.resynchronizedAt !== null && facts.resynchronizedAt >= confirmed, 'the bench saw the leaseholder\'s snapshot succeed after the advance');
  });
});

describe('calibration-blip (LC11-S06) and fouled-sensor (LC11-S01) under the retry profile', () => {
  test('one blip is absorbed by a bounded retry; three outlast it and pause until calibration is restored and the record retried', async t => {
    reset();
    const b = await bench(t, 'retry', [live(500), live(510)]);
    const first = await run(b, { intent: 'scenario.start', scenario: 'calibration-blip' });
    assert.deepEqual([first.status, first.outcome], ['succeeded', 'armed']);
    assert.equal(await b.advance(), 1, 'the retried attempt succeeds: the record is committed');
    const quiet = await b.facts();
    assert.deepEqual([quiet.incident, quiet.app.blips], [null, 1], 'no incident: the retry absorbed the blip');
    const second = await run(b, { intent: 'scenario.start', scenario: 'calibration-blip' });
    assert.equal(second.status, 'succeeded');
    await b.advance();
    const held = await b.until(f => f.incident !== null, 'the transient incident');
    const incident = held.incident!;
    assert.deepEqual([incident.failureClass, incident.stage, incident.policy, incident.progress, incident.quarantine, incident.evidence.location, incident.nextAction], ['mapper-transient', 'map', 'pause', 'held', 'not-required', 'none', 'repair-and-retry']);
    assert.equal(held.circuit?.state, 'closed');
    // Still timing out: a retry before restoring holds again.
    const early = await run(b, { intent: 'incident.retry-current', incident: target(held) });
    assert.deepEqual([early.status, early.outcome], ['succeeded', 'held']);
    assert.equal((await b.facts()).app.blipArmed, true);
    const restored = await run(b, { intent: 'scenario.restore-calibration' });
    assert.deepEqual([restored.status, restored.outcome], ['succeeded', 'restored']);
    assert.deepEqual([(await b.facts()).app.calibration, (await b.facts()).app.blipArmed], ['present', false]);
    await assert.rejects(b.intent({ intent: 'scenario.restore-calibration' }), { code: 'not-applicable' }, 'nothing left to restore');
    const retried = await run(b, { intent: 'incident.retry-current', incident: target(await b.facts()) });
    assert.deepEqual([retried.status, retried.outcome], ['succeeded', 'retried']);
    const done = await b.facts();
    assert.deepEqual([done.incident!.state, done.incident!.progress, done.incident!.nextAction], ['resolved', 'processed', 'none']);
    await b.runtime.tick(); assert.deepEqual(b.runtime.status().scenario.source, { status: 'healthy' });
    assert.deepEqual(done.steps.map(step => step.text), ['One calibration lookup will time out', 'The next calibration lookups will time out', 'LC-03 calibration restored']);
  });

  test('fouled-sensor as an intent: a mapper error pauses with nothing quarantined, and a retry after restoring processes it', async t => {
    reset();
    const b = await bench(t, 'retry', [live()]);
    const started = await run(b, { intent: 'scenario.start', scenario: 'fouled-sensor' });
    assert.deepEqual([started.status, started.outcome], ['succeeded', 'armed']);
    await b.advance();
    const held = await b.until(f => f.incident !== null, 'the mapper incident');
    const incident = held.incident!;
    assert.deepEqual([incident.failureClass, incident.policy, incident.progress, incident.quarantine, incident.evidence.location, incident.nextAction], ['mapper-error', 'pause', 'held', 'not-required', 'none', 'repair-and-retry']);
    assert.equal((await b.facts()).app.calibration, 'removed');
    await assert.rejects(b.intent({ intent: 'scenario.start', scenario: 'fouled-sensor' }), { code: 'not-applicable' }, 'one incident at a time');
    await run(b, { intent: 'scenario.restore-calibration' });
    const retried = await run(b, { intent: 'incident.retry-current', incident: target(await b.facts()) });
    assert.deepEqual([retried.status, retried.outcome], ['succeeded', 'retried']);
    assert.deepEqual([(await b.facts()).incident!.progress, (await b.facts()).incident!.state], ['processed', 'resolved']);
  });
});

describe('conflicting-readings (LC11-S05)', () => {
  test('two readings at one revision are an integrity fault: paused, no evidence, reassess refused', async t => {
    reset();
    const b = await bench(t, 'quarantine', [batch()]);
    await b.advance();
    const held = await b.until(f => f.incident !== null, 'the conflict incident');
    const incident = held.incident!;
    assert.deepEqual([incident.failureClass, incident.stage, incident.errorCode, incident.policy, incident.progress, incident.quarantine, incident.evidence.location], ['revision-conflict', 'queue', 'REVISION_CONFLICT', 'pause', 'held', 'not-required', 'none'], 'an integrity class always pauses, whatever the policy');
    const reassessed = await run(b, { intent: 'incident.reassess', incident: target(held) });
    assert.deepEqual([reassessed.status, reassessed.outcome], ['refused', 'integrity-class']);
    const retried = await run(b, { intent: 'incident.retry-current', incident: target(await b.facts()) });
    assert.deepEqual([retried.status, retried.outcome], ['succeeded', 'held'], 'the same record conflicts again: only a reset ends it');
  });
});

describe('too-many-bad-readings (LC11-S07)', () => {
  test('five advance automatically; the sixth opens the circuit and holds', async t => {
    reset();
    const b = await bench(t, 'quarantine', [v2(500), v2(501), v2(502), v2(503), v2(504), v2(505)]);
    let seq = 0; station.assess = studyId => recoverable(++seq)(studyId);
    for (let i = 1; i <= 5; i++) { await b.advance(); await b.until(f => f.incident?.ordinal === i && f.incident.progress === 'advanced', `incident ${i} to advance`); }
    await b.advance();
    const held = await b.until(f => f.incident?.ordinal === 6 && f.incident.progress === 'held', 'the sixth incident held');
    assert.deepEqual(held.circuit, { state: 'open', recentIncidents: 5, limit: 5 });
    assert.deepEqual([held.incident!.recovery, held.incident!.nextAction, held.incident!.guard], ['held', 'reopen-circuit', null], 'the circuit holds before the guard is asked');
    assert.equal(seq, 5, 'the guard was asked once per advanced incident');
    const retried = await run(b, { intent: 'incident.retry-current', incident: target(held) });
    assert.deepEqual([retried.status, retried.outcome], ['refused', 'circuit-open']);
    const reassessed = await run(b, { intent: 'incident.reassess', incident: target(await b.facts()) });
    assert.deepEqual([reassessed.status, reassessed.outcome], ['refused', 'circuit-open']);
  });
});

describe('inspect-old-reading (LC11-S04): evaluate with corrected handlers, then approve a single-use plan', () => {
  test('a corrected-projection start restarts the gateway with the new build; evaluate issues a plan; approve redrives it once', async t => {
    reset();
    const b = await bench(t, 'quarantine', [v2(), live(510)]);
    station.assess = recoverable(1);
    await b.advance();
    const advanced = await b.until(f => f.incident?.progress === 'advanced', 'the S03 advance');
    const failureId = advanced.incident!.failureId;
    // Evaluating with the broken handlers: still fails, nothing to approve.
    const before = await run(b, { intent: 'incident.evaluate', incident: target(advanced) });
    assert.equal(before.status, 'succeeded');
    const broken = (await b.facts()).evaluation!;
    assert.deepEqual([broken.validation, broken.eligible, broken.ineligibleReason, broken.errorClass, broken.planToken], ['invalid', false, 'still-fails', 'payload-schema', null]);

    const started = await run(b, { intent: 'scenario.start', scenario: 'inspect-old-reading' });
    assert.deepEqual([started.status, started.outcome], ['succeeded', 'armed']);
    assert.deepEqual(b.runtime.status().failures, { profile: 'quarantine', durable: true, handlerBuildId: handlerBuildId('corrected') });
    assert.deepEqual(b.runtime.status().study!.restarts, { gateway: 1, process: 0 });
    assert.deepEqual(b.seen.journals.map(journal => journal?.handlerBuildId), [handlerBuildId('broken'), handlerBuildId('corrected')]);
    const resumed = await b.facts();
    assert.equal(resumed.incident!.failureId, failureId, 'the journal kept the incident across the restart');
    assert.equal(resumed.app.mapping, 'corrected');
    assert.equal(resumed.incident!.handlerBuildId, handlerBuildId('broken'), 'the incident records the build that failed');
    assert.equal(resumed.incident!.boundary, 'in-force', 'the boundary survives the restart: it retires only with the generation');

    const evaluated = await run(b, { intent: 'incident.evaluate', incident: target(resumed) });
    const evaluation = (await b.facts()).evaluation!;
    assert.deepEqual([evaluated.status, evaluated.outcome], ['succeeded', 'evaluated']);
    assert.deepEqual([evaluation.validation, evaluation.eligible, evaluation.ineligibleReason, evaluation.outputs], ['valid', true, null, 1]);
    const token = evaluation.planToken!;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, 'the bench\'s own token, never the library\'s plan ID');
    assert.ok(!token.startsWith('pl1'));
    const leaseEnd = Date.parse(b.runtime.status().lease!.expiresAt);
    assert.ok(Date.parse(evaluation.expiresAt!) <= leaseEnd, 'a plan token never outlives the lease');
    // A token is bound to its incident: naming another refuses, and doesn't spend it.
    const foreign = await run(b, { intent: 'incident.approve-reprocess', incident: { failureId: 'f1:' + '0'.repeat(64), revision: 1 }, planToken: token });
    assert.deepEqual([foreign.status, foreign.outcome], ['refused', 'plan-unknown']);
    const approved = await run(b, { intent: 'incident.approve-reprocess', incident: target(await b.facts()), planToken: token });
    // Served state is already at the record's revision: the library's safe answer is superseded, never a fabricated newer write.
    assert.deepEqual([approved.status, approved.outcome], ['succeeded', 'superseded']);
    const after = await b.facts();
    assert.deepEqual([after.reprocess?.result, after.reprocess?.outcome], ['completed', 'superseded']);
    assert.equal(after.evaluation!.planToken, null, 'a spent token is gone from the facts');
    const again = await run(b, { intent: 'incident.approve-reprocess', incident: target(after), planToken: token });
    assert.deepEqual([again.status, again.outcome], ['refused', 'plan-unknown'], 'single use');
  });
  test('a gateway restart forgets plan tokens: the library\'s plans went with it, and a new evaluation offers a new one', async t => {
    reset();
    const b = await bench(t, 'quarantine', [v2(), live(510)]);
    station.assess = recoverable(1);
    await b.advance();
    await b.until(f => f.incident?.progress === 'advanced', 'the S03 advance');
    await run(b, { intent: 'scenario.start', scenario: 'inspect-old-reading' });
    await run(b, { intent: 'incident.evaluate', incident: target(await b.facts()) });
    const token = (await b.facts()).evaluation!.planToken!;
    assert.ok(token);

    await b.runtime.action('lease-1', 'gateway.restart');
    for (let i = 0; i < 400 && b.runtime.status().scenario?.gateway !== 'running'; i++) await sleep(50);
    const restarted = await b.facts();
    assert.deepEqual(b.runtime.status().study!.restarts, { gateway: 2, process: 0 });
    assert.equal(restarted.evaluation!.planToken, null, 'no token is offered for a plan the library no longer holds');
    const stale = await run(b, { intent: 'incident.approve-reprocess', incident: target(restarted), planToken: token });
    assert.deepEqual([stale.status, stale.outcome], ['refused', 'plan-unknown']);

    await run(b, { intent: 'incident.evaluate', incident: target(restarted) });
    const fresh = (await b.facts()).evaluation!.planToken!;
    assert.ok(fresh && fresh !== token);
    const approved = await run(b, { intent: 'incident.approve-reprocess', incident: target(await b.facts()), planToken: fresh });
    assert.deepEqual([approved.status, approved.outcome], ['succeeded', 'superseded']);
  });
});

describe('restart durability and the intent surface', () => {
  test('a bench process restart on the same volume reopens the journal: same incident, same boundary', async t => {
    reset();
    const dir = await mkdtemp(join(tmpdir(), 'lab-failures-')); t.after(() => rm(dir, { recursive: true, force: true }));
    station.assess = recoverable(1);
    const first = await bench(t, 'quarantine', [v2()], dir);
    await first.advance();
    const advanced = await first.until(f => f.incident?.progress === 'advanced', 'the advance');
    const study = first.runtime.status().study!;
    await first.runtime.close();
    // The same process opens it again: the library treats this process's released lock as stale.
    const port = await freePort(); const seen: Bench['seen'] = { journals: [] };
    const second = new BenchRuntime({ LAB_BENCH: '1', LAB_BENCH_1_SERVICE_TOKEN: SERVICE, LAB_BENCH_1_RELAY_TOKEN: 'r'.repeat(32), LAB_RELAY_ORIGIN: relayOrigin, LAB_SNAPSHOT_ORIGIN: stationOrigin, LAB_FAILURE_HANDLING: 'quarantine', BENCH_HOST: '127.0.0.1', BENCH_PORT: String(port), BENCH_MANAGEMENT_PORT: '0', SITE_ORIGIN: SITE }, {
      tickMs: 3_600_000, stateDir: dir, gate: { async close() {}, async discard() {} }, deleteGroup: async () => {}, quiesceMs: 50, services: fixtureServices([v2()], seen) });
    await second.start(); t.after(() => second.close());
    assert.equal(second.status().state, 'leased', 'the open study and its lease resume');
    assert.deepEqual([second.status().study!.studyId, second.status().study!.restarts.process], [study.studyId, 1]);
    const facts = await second.incident('lease-1');
    assert.deepEqual([facts.incident!.failureId, facts.incident!.progress, facts.incident!.boundary], [advanced.incident!.failureId, 'advanced', 'in-force']);
    assert.equal(second.status().failures?.durable, true);
  });

  test('a reset discards the study with its journal; the next study gets a new one', async t => {
    reset();
    const b = await bench(t, 'quarantine', [garbled()]);
    await b.advance(); await b.until(f => f.incident !== null, 'the incident');
    const old = b.runtime.status().study!.studyId;
    const accepted = await b.intent({ intent: 'incident.reassess', incident: target(await b.facts()) });
    await b.runtime.run(() => b.runtime.reset());
    const fresh = b.runtime.status().study!;
    assert.notEqual(fresh.studyId, old);
    await assert.rejects(stat(join(b.stateDir, 'lab-1', 'studies', old)), { code: 'ENOENT' });
    assert.ok((await readdir(join(b.stateDir, 'lab-1', 'studies', fresh.studyId, 'journal'))).includes(JOURNAL_FILE));
    assert.equal(b.runtime.status().failures?.durable, true);
    assert.throws(() => b.runtime.operation('lease-1', accepted.operationId), { code: 'no-lease' }, 'the old lease\'s operations end with it');
  });

  test('intents: validation, idempotency, and preconditions answer synchronously', async t => {
    reset();
    const b = await bench(t, 'retry', [live()]);
    await assert.rejects(b.intent({ intent: 'scenario.start', scenario: 'bad-projection' }), { code: 'not-applicable' }, 'bad-projection needs the quarantine profile');
    await assert.rejects(b.intent({ intent: 'scenario.start', scenario: 'relay-cut' as never }), { code: 'invalid-request' });
    await assert.rejects(b.intent({ intent: 'scenario.prepare-coverage' as never }), { code: 'invalid-request' }, 'the field station\'s own intent');
    await assert.rejects(b.intent({ intent: 'incident.retry-current' }), { code: 'invalid-request' }, 'incident intents name the incident');
    await assert.rejects(b.intent({ intent: 'scenario.restore-calibration' }), { code: 'not-applicable' }, 'nothing to restore');
    await assert.rejects(b.runtime.intent({ leaseId: 'lease-2', operationId: operationId(), intent: 'scenario.restore-calibration' }), { code: 'no-lease' });
    const id = operationId();
    const first = await b.intent({ operationId: id, intent: 'scenario.start', scenario: 'calibration-blip' });
    const repeated = await b.intent({ operationId: id, intent: 'scenario.start', scenario: 'calibration-blip' });
    assert.equal(repeated.operationId, first.operationId);
    assert.equal((await b.settled(id)).status, 'succeeded');
    assert.equal((await b.intent({ operationId: id, intent: 'scenario.start', scenario: 'calibration-blip' })).status, 'succeeded', 'a re-sent intent answers the recorded operation, never runs again');
    assert.equal((await b.facts()).app.blips, 1);
    await assert.rejects(b.intent({ operationId: id, intent: 'scenario.start', scenario: 'fouled-sensor' }), { code: 'not-applicable' }, 'an operation ID reused for another request');
  });
});

describe('the bench API routes for intents (section 8b)', () => {
  test('service token, 202, operation lookup, and incident facts', async t => {
    reset();
    const b = await bench(t, 'retry', [live()]);
    const api = b.runtime.api(); const origin = await listen(api); t.after(() => closeServer(api));
    const headers = { authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${origin}/bench/v1/intents`, { method: 'POST', body: '{}' })).status, 401);
    const id = operationId();
    const accepted = await fetch(`${origin}/bench/v1/intents`, { method: 'POST', headers, body: JSON.stringify({ leaseId: 'lease-1', operationId: id, intent: 'scenario.start', scenario: 'calibration-blip' }) });
    assert.equal(accepted.status, 202); assert.equal((await accepted.json() as BenchOperation).operationId, id);
    await b.settled(id);
    const operation = await fetch(`${origin}/bench/v1/operations/${id}?leaseId=lease-1`, { headers });
    assert.equal(operation.status, 200); assert.deepEqual([(await operation.json() as BenchOperation).status], ['succeeded']);
    assert.equal((await fetch(`${origin}/bench/v1/operations/${operationId()}?leaseId=lease-1`, { headers })).status, 404);
    assert.equal((await fetch(`${origin}/bench/v1/operations/${id}?leaseId=lease-2`, { headers })).status, 409);
    const facts = await fetch(`${origin}/bench/v1/incident?leaseId=lease-1`, { headers });
    assert.equal(facts.status, 200);
    const body = await facts.json() as BenchIncidentFacts;
    assert.deepEqual([body.profile, body.incident, body.app.blips], ['retry', null, 1]);
    const bad = await fetch(`${origin}/bench/v1/intents`, { method: 'POST', headers, body: JSON.stringify({ leaseId: 'lease-1', operationId: 'op-1', intent: 'scenario.start', scenario: 'calibration-blip' }) });
    assert.deepEqual([bad.status, (await bad.json() as { code: string }).code], [400, 'invalid-request']);
  });
});
