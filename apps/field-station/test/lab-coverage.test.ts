/**
 * The application coverage ledger, recovery guard, snapshot acknowledgment, and
 * publisher gate (LC11-ADR-01, LC11-ADR-02 step 3; acceptance LC11-A25, A26 and
 * the application half of A09–A13 that W9b binds).
 *
 * The simulation is real (seeded, deterministic); the clock, Kafka, and the
 * served state's lag are stand-ins. An independent expected-state ledger in this
 * file (`Expected`) states which instances each mutation affects, what revision it
 * carries, and what the guard must answer, by hand: it never calls the derivation,
 * ledger, or guard under test. Evidence level: unit. Nothing here touches a native
 * guard: StreamOtter 0.1.0-rc.3 has none.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { advanceTo, createWorld, currentEmissions, type Emission, type WorldState } from '@lontra-creek/sim';
import { snapshotAcknowledges } from '../src/lab/bench.ts';
import type { RecordCoordinates, RecoveryAssessment } from '../src/lab/contract.ts';
import { deriveMutation, FileCoverageLedger, type DomainMutation, type ServedState } from '../src/lab/coverage.ts';
import { LabStudies, StudyClosedError, type ScenarioSink } from '../src/lab/studies.ts';
import { internalApi } from '../src/server/http.ts';
import type { FieldStation } from '../src/server/station.ts';
import type { Notebooks } from '../src/server/notebooks.ts';

const TICK = 500;
const S1 = 'studyAAAAAAAAAAA'; const S2 = 'studyBBBBBBBBBBB';

/**
 * The expected-state ledger. Facts are restated from the simulation's published
 * shape (views.ts): a station's view shows its own readings; the creek overview
 * shows every station's flow and trend but no other reading; Slate Canyon (LC-03's
 * reach) has no camera trap, so there is no `reach` instance for it; holts never
 * reach a bench. A revision is generation × 10^12 + tick.
 */
const Expected = {
  revision: (tick: number) => String(1_000_000_000_000 + tick),
  affected(mutation: DomainMutation): string[] {
    const keys = [`station:${mutation.stationId}`];
    if ('flowCfs' in mutation.reading) keys.push('creekOverview:lontra');
    return keys.sort();
  },
  /** What the guard must answer for an incident, from this ledger's own record of each run. */
  decision(runs: Map<string, { status: 'withheld' | 'pending' | 'established'; at: RecordCoordinates | null }>, record?: RecordCoordinates): 'hold' | 'recoverable' {
    if (!record) return 'hold';
    const run = [...runs.values()].find(item => item.at && item.at.topic === record.topic && item.at.partition === record.partition && item.at.offset === record.offset);
    return run?.status === 'established' ? 'recoverable' : 'hold';
  }
};

function world(): WorldState { const w = createWorld({ seed: 'lontra-creek' }); advanceTo(w, TICK); return w; }
/** The field station's world, as LabStudies sees it. */
function source(w: WorldState) {
  const views = new Map<string, Emission>(currentEmissions(w).map(e => [e.key, e]));
  return { get tick() { return w.tick; }, view: (key: string) => views.get(key), world: () => structuredClone(w), views };
}
async function studies(t: TestContext, w = world()) {
  const dataDir = await mkdtemp(join(tmpdir(), 'lab-coverage-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-03T12:00:00Z');
  const src = source(w);
  const registry = new LabStudies({ dataDir, world: src, now: () => now, closeWaitMs: 50 });
  let offset = 100;
  const sent: { topic: string; key: string; value: string }[] = [];
  const sink: ScenarioSink = { async send(record) { sent.push(record); return { topic: record.topic, partition: 1, offset: String(offset++) }; } };
  return { dataDir, registry, src, w, sink, sent, advance: (ms: number) => { now += ms; } };
}
const flowLc03 = (tick = TICK + 1): DomainMutation => ({ kind: 'station-reading', stationId: 'LC-03', tick, reading: { flowCfs: 412 } });
const tempLc01 = (tick = TICK + 2): DomainMutation => ({ kind: 'station-reading', stationId: 'LC-01', tick, reading: { waterTempC: 21.5 } });
const record = (runId: string) => ({ topic: 'lab-1.field.gauges', key: `station:${runId}`, value: '{"scenario":true}' });

describe('affected instances come from the simulation\'s own view derivation', () => {
  test('an LC-03 flow reading affects its station and the creek overview; a temperature reading only its station', () => {
    const w = world();
    for (const mutation of [flowLc03(), tempLc01(), { ...flowLc03(), reading: { stageFt: 9.99 } } as DomainMutation]) {
      const derived = deriveMutation(w, mutation);
      assert.deepEqual(derived.affected, Expected.affected(mutation));
      assert.equal(derived.revision, Expected.revision(mutation.tick));
      assert.deepEqual(derived.views.map(view => view.key).sort(), Expected.affected(mutation));
      assert.ok(derived.views.every(view => view.channel !== 'holt'));
    }
    const lc03 = deriveMutation(w, flowLc03()).views.find(view => view.key === 'station:LC-03')!;
    assert.equal((lc03.data as { flowCfs: number }).flowCfs, 412);
    assert.equal(w.stations['LC-03'].flowCfs === 412, false, 'the world itself is untouched');
  });

  test('a mutation in the past, or one that changes nothing a bench serves, is refused', () => {
    const w = world();
    assert.throws(() => deriveMutation(w, flowLc03(TICK - 1)), RangeError);
    assert.throws(() => deriveMutation(w, { ...flowLc03(), reading: {} }), RangeError);
    assert.throws(() => deriveMutation(w, { ...flowLc03(), reading: { flowCfs: w.stations['LC-03'].flowCfs } }), RangeError);
  });
});

describe('the recovery guard', () => {
  test('holds while coverage is withheld or pending, and for incidents the ledger cannot match', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'lab-ledger-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const ledger = await FileCoverageLedger.open(join(dir, 'ledger.json'), 1, S1, () => 0);
    const derived = deriveMutation(world(), flowLc03());
    await ledger.record({ scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), derived, coverage: 'withheld' });
    const at = { topic: 'lab-1.field.gauges', partition: 1, offset: '100' };
    await ledger.published('run-1', at);
    const runs = new Map([['run-1', { status: 'withheld' as const, at }]]);
    const withheld = await ledger.assess({ studyId: S1, sourceId: 'field', record: at });
    assert.equal(withheld.decision, Expected.decision(runs, at));
    assert.deepEqual(withheld, { decision: 'hold', studyId: S1, reason: 'coverage-withheld', evidenceRef: `ledger:lab-1/${S1}#run-1` });
    await ledger.release('run-1');
    // The served state lags: LC-03 is still one tick behind the mutation.
    const lagging: ServedState = { tick: () => TICK, revision: key => key === 'station:LC-03' ? Expected.revision(TICK) : Expected.revision(TICK + 1) };
    assert.equal((await ledger.establish('run-1', lagging)).status, 'pending');
    const pending = await ledger.assess({ studyId: S1, sourceId: 'field', record: at });
    assert.deepEqual([pending.decision, pending.decision === 'hold' && pending.reason], ['hold', 'coverage-pending']);
    assert.deepEqual(await ledger.assess({ studyId: S1, sourceId: 'field' }), { decision: 'hold', studyId: S1, reason: 'no-coordinates', evidenceRef: null });
    const unknown = await ledger.assess({ studyId: S1, sourceId: 'field', record: { ...at, offset: '101' } });
    assert.deepEqual([unknown.decision, unknown.decision === 'hold' && unknown.reason], ['hold', 'unknown-record']);
    assert.equal(ledger.barriers().length, 0, 'a hold issues no barrier');
  });

  test('established coverage yields a barrier over every affected instance; a second incident keeps the first obligation', async t => {
    const s = await studies(t); s.registry.open(1, S1);
    const runs = new Map<string, { status: 'withheld' | 'pending' | 'established'; at: RecordCoordinates | null }>();
    // Run 1: S03's withheld coverage, then prepare-coverage.
    const first = await s.registry.beginRun(1, S1, { scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), coverage: 'withheld' });
    assert.equal(first.entry.status, 'withheld');
    const at1 = await s.registry.publish(1, S1, 'run-1', record('run-1'), s.sink); runs.set('run-1', { status: 'withheld', at: at1 });
    assert.equal((await s.registry.assess(1, { studyId: S1, sourceId: 'field', record: at1 })).decision, Expected.decision(runs, at1));
    const prepared = await s.registry.prepareCoverage(1, S1, 'run-1'); runs.set('run-1', { status: 'established', at: at1 });
    assert.equal(prepared.status, 'established');
    assert.deepEqual(Object.keys(prepared.watermark!.revisions).sort(), Expected.affected(flowLc03()));
    const one = await s.registry.assess(1, { studyId: S1, sourceId: 'field', record: at1 }) as Extract<RecoveryAssessment, { decision: 'recoverable' }>;
    assert.equal(one.decision, Expected.decision(runs, at1));
    assert.deepEqual(one.covers, Expected.affected(flowLc03()));
    assert.equal(one.evidenceRef, `ledger:lab-1/${S1}#run-1`);
    assert.ok(one.barrier.length <= 96);
    // Run 2: the normal rule, write before publish: established before it is published.
    const second = await s.registry.beginRun(1, S1, { scenarioId: 'S04', runId: 'run-2', mutation: tempLc01(), coverage: 'pending' });
    assert.equal(second.entry.status, 'established');
    const at2 = await s.registry.publish(1, S1, 'run-2', record('run-2'), s.sink); runs.set('run-2', { status: 'established', at: at2 });
    const two = await s.registry.assess(1, { studyId: S1, sourceId: 'field', record: at2 }) as Extract<RecoveryAssessment, { decision: 'recoverable' }>;
    assert.notEqual(two.barrier, one.barrier);
    assert.deepEqual(two.covers, [...new Set([...Expected.affected(flowLc03()), ...Expected.affected(tempLc01())])].sort(), 'the cumulative barrier keeps the first obligation');
    assert.equal(two.evidenceRef, `ledger:lab-1/${S1}#run-1,run-2`);
    // Asking about the first incident again does not roll the barrier back.
    const again = await s.registry.assess(1, { studyId: S1, sourceId: 'field', record: at1 }) as Extract<RecoveryAssessment, { decision: 'recoverable' }>;
    assert.equal(again.barrier, two.barrier);
    const ledger = await s.registry.ledger(1, S1);
    assert.equal(ledger.obligations().length, 2);
    const barrier = ledger.barriers().at(-1)!;
    assert.equal(barrier.revisions['station:LC-03'], Expected.revision(TICK + 1));
    assert.equal(barrier.revisions['station:LC-01'], Expected.revision(TICK + 2));
  });

  test('the ledger survives a reopen (a bench restart within the study) and only the open study may be assessed', async t => {
    const s = await studies(t); s.registry.open(1, S1);
    await s.registry.beginRun(1, S1, { scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), coverage: 'pending' });
    const at = await s.registry.publish(1, S1, 'run-1', record('run-1'), s.sink);
    const answer = await s.registry.assess(1, { studyId: S1, sourceId: 'field', record: at });
    const reopened = await FileCoverageLedger.open(join(s.dataDir, 'lab', 'lab-1', 'studies', S1, 'ledger.json'), 1, S1);
    assert.equal(reopened.entries()[0]?.status, 'established'); assert.deepEqual(reopened.entries()[0]?.publication, at);
    assert.equal(answer.decision === 'recoverable' && reopened.barriers().at(-1)?.id, answer.decision === 'recoverable' && answer.barrier);
    await assert.rejects(s.registry.assess(1, { studyId: S2, sourceId: 'field', record: at }), StudyClosedError);
    await assert.rejects(s.registry.assess(2, { studyId: S1, sourceId: 'field', record: at }), StudyClosedError);
  });
});

describe('snapshot acknowledgment', () => {
  async function established(t: TestContext) {
    const s = await studies(t); s.registry.open(1, S1);
    await s.registry.beginRun(1, S1, { scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), coverage: 'pending' });
    const at = await s.registry.publish(1, S1, 'run-1', record('run-1'), s.sink);
    const answer = await s.registry.assess(1, { studyId: S1, sourceId: 'field', record: at });
    assert.equal(answer.decision, 'recoverable');
    return { ...s, barrier: (answer as Extract<RecoveryAssessment, { decision: 'recoverable' }>).barrier };
  }

  test('a snapshot at or past the barrier acknowledges it, for affected and unaffected instances', async t => {
    const s = await established(t);
    const lc03 = await s.registry.snapshot(1, 'station:LC-03', s.barrier);
    assert.deepEqual(lc03?.boundary, { barrier: s.barrier, acknowledged: true });
    assert.equal(lc03?.revision, Expected.revision(TICK + 1));
    assert.equal((lc03?.data as { flowCfs: number }).flowCfs, 412, 'the bench serves its study\'s authoritative write');
    assert.equal((await s.registry.snapshot(1, 'station:LC-02', s.barrier))?.boundary?.acknowledged, true);
    assert.equal(snapshotAcknowledges(s.barrier, lc03!), true);
    // Another bench never sees bench 1's study state.
    assert.notEqual(((await s.registry.snapshot(2, 'station:LC-03', null))?.data as { flowCfs: number }).flowCfs, 412);
  });

  test('lagging, missing, or wrong acknowledgments never acknowledge', async t => {
    const s = await established(t);
    const ledger = await s.registry.ledger(1, S1);
    const barrier = ledger.barriers()[0]!;
    // Lagging: the served LC-03 revision is behind the barrier, or the whole state is.
    assert.deepEqual(ledger.acknowledge({ barrier: s.barrier, key: 'station:LC-03', served: { tick: barrier.tick, revision: Expected.revision(TICK) } }), { barrier: s.barrier, acknowledged: false, reason: 'lagging' });
    assert.equal(ledger.acknowledge({ barrier: s.barrier, key: 'station:LC-02', served: { tick: barrier.tick - 1, revision: Expected.revision(TICK + 5) } }).reason, 'lagging');
    // Missing: no boundary asked for, no acknowledgment given; and a body without one never counts.
    const plain = await s.registry.snapshot(1, 'station:LC-03', null);
    assert.equal(plain && 'boundary' in plain, false);
    assert.equal(snapshotAcknowledges(s.barrier, plain!), false);
    // Wrong: another study's barrier, one never issued, a malformed one, or an echo of a different barrier.
    assert.equal((await s.registry.snapshot(1, 'station:LC-03', `lcb1.${S2}.1`))?.boundary?.reason, 'wrong-study');
    assert.equal((await s.registry.snapshot(1, 'station:LC-03', `lcb1.${S1}.9`))?.boundary?.reason, 'unknown-barrier');
    assert.equal((await s.registry.snapshot(1, 'station:LC-03', 'anything'))?.boundary?.reason, 'malformed');
    const other = await s.registry.snapshot(1, 'station:LC-03', s.barrier);
    assert.equal(snapshotAcknowledges(`lcb1.${S1}.2`, other!), false, 'an acknowledgment of a different barrier is not this one');
    assert.equal(snapshotAcknowledges(s.barrier, { revision: '1', data: {}, boundary: { barrier: s.barrier, acknowledged: false, reason: 'lagging' } }), false);
    assert.equal(snapshotAcknowledges('', { revision: '1', data: {}, boundary: { barrier: '', acknowledged: true } }), false);
    // A closed study acknowledges nothing.
    await s.registry.close(1, S1);
    assert.deepEqual((await s.registry.snapshot(1, 'station:LC-03', s.barrier))?.boundary, { barrier: s.barrier, acknowledged: false, reason: 'wrong-study' });
  });
});

describe('the publisher gate and study discard', () => {
  test('a closed study can publish nothing, never reopens, and its late completions stay in its own ledger', async t => {
    const s = await studies(t); s.registry.open(1, S1);
    await s.registry.beginRun(1, S1, { scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), coverage: 'withheld' });
    // A publication in flight while the reset closes the gate.
    let land!: (at: RecordCoordinates) => void;
    const slow: ScenarioSink = { send: () => new Promise(resolve => { land = resolve; }) };
    const inFlight = s.registry.publish(1, S1, 'run-1', record('run-1'), slow);
    await new Promise(resolve => setImmediate(resolve));
    const closed = await s.registry.close(1, S1);
    assert.deepEqual(closed, { studyId: S1, state: 'closed', inFlight: 1 }, 'the bounded wait ends with the publication still in flight');
    await assert.rejects(s.registry.publish(1, S1, 'run-1', record('run-1'), s.sink), StudyClosedError);
    assert.equal(s.sent.length, 0, 'nothing reached Kafka for the closed study');
    land({ topic: 'lab-1.field.gauges', partition: 0, offset: '41' }); await inFlight;
    const ledger = await FileCoverageLedger.open(join(s.dataDir, 'lab', 'lab-1', 'studies', S1, 'ledger.json'), 1, S1);
    assert.deepEqual(ledger.entries()[0]?.publication, { topic: 'lab-1.field.gauges', partition: 0, offset: '41' }, 'recorded honestly in the old study');
    assert.throws(() => s.registry.open(1, S1), StudyClosedError);
    s.registry.open(1, S2);
    await assert.rejects(s.registry.publish(1, S1, 'run-1', record('run-1'), s.sink), StudyClosedError);
    assert.equal((await s.registry.ledger(1, S2)).entries().length, 0, 'the new study starts with an empty ledger');
  });

  test('scenario records go only to the bench\'s own copy of a creek topic', async t => {
    const s = await studies(t); s.registry.open(1, S1);
    await s.registry.beginRun(1, S1, { scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), coverage: 'withheld' });
    for (const topic of ['lab-2.field.gauges', 'field.gauges', 'lab-1.field.notebooks', 'lab-1.field.holts', 'lab-1.quarantine']) await assert.rejects(s.registry.publish(1, S1, 'run-1', { ...record('run-1'), topic }, s.sink), RangeError, topic);
    assert.equal(s.sent.length, 0);
  });

  test('discard summarizes without payloads, removes the ledger, and refuses an open study', async t => {
    const s = await studies(t); s.registry.open(1, S1);
    await s.registry.beginRun(1, S1, { scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), coverage: 'pending' });
    await s.registry.publish(1, S1, 'run-1', record('run-1'), s.sink);
    await assert.rejects(s.registry.discard(1, S1), StudyClosedError);
    await s.registry.close(1, S1);
    const summary = await s.registry.discard(1, S1);
    assert.deepEqual(summary.entries, [{ scenarioId: 'S03', runId: 'run-1', status: 'established', affected: Expected.affected(flowLc03()), published: true }]);
    const text = await readFile(join(s.dataDir, 'lab', 'lab-1', 'summaries', `${S1}.json`), 'utf8');
    for (const forbidden of ['412', 'scenario":true', 'data', 'value']) assert.ok(!text.includes(forbidden), `no payload in the summary: ${forbidden}`);
    await assert.rejects(stat(join(s.dataDir, 'lab', 'lab-1', 'studies', S1)));
    // Discarding again (a retried reset) is harmless.
    assert.equal((await s.registry.discard(1, S1)).entries.length, 0);
  });

  test('opening a new study sweeps strays a crash left on disk', async t => {
    const s = await studies(t); s.registry.open(1, S1);
    await s.registry.beginRun(1, S1, { scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), coverage: 'pending' });
    // A field station restart forgets every study; the files remain.
    const restarted = new LabStudies({ dataDir: s.dataDir, world: s.src });
    restarted.open(1, S2); await restarted.close(1, 'studyCCCCCCCCCCC');
    for (let i = 0; i < 20 && (await readdir(join(s.dataDir, 'lab', 'lab-1', 'studies'))).includes(S1); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(await readdir(join(s.dataDir, 'lab', 'lab-1', 'studies')), []);
    assert.ok((await readdir(join(s.dataDir, 'lab', 'lab-1', 'summaries'))).includes(`${S1}.json`));
  });
});

describe('the private recovery surface over HTTP', () => {
  const tokens = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
  async function serving(server: Server, run: (origin: string) => Promise<void>) { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } }

  test('bench N\'s own token only; coordinates only; closed studies are refused', async t => {
    const s = await studies(t); s.registry.open(1, S1);
    await s.registry.beginRun(1, S1, { scenarioId: 'S03', runId: 'run-1', mutation: flowLc03(), coverage: 'withheld' });
    const at = await s.registry.publish(1, S1, 'run-1', record('run-1'), s.sink);
    const station = { ready: true, view: s.src.view } as unknown as FieldStation;
    const server = internalApi({ serviceToken: 'production-secret-production-secret', station, notebooks: {} as Notebooks, labTokens: tokens, studies: s.registry });
    await serving(server, async origin => {
      const post = (path: string, body: unknown, token = tokens[0]) => fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const held = await post('/lab-internal/1/recovery/assess', { studyId: S1, sourceId: 'field', record: at });
      assert.equal(held.status, 200); assert.deepEqual(await held.json(), { decision: 'hold', studyId: S1, reason: 'coverage-withheld', evidenceRef: `ledger:lab-1/${S1}#run-1` });
      assert.equal((await post('/lab-internal/1/recovery/assess', { studyId: S1, sourceId: 'field', record: at }, tokens[1])).status, 401, 'another bench\'s token');
      assert.equal((await post('/lab-internal/1/recovery/assess', { studyId: S1, sourceId: 'field', record: at }, 'production-secret-production-secret')).status, 401, 'the production service token');
      assert.equal((await post('/lab-internal/2/recovery/assess', { studyId: S1, sourceId: 'field', record: at }, tokens[1])).status, 409, 'not bench 2\'s study');
      assert.equal((await post('/lab-internal/1/recovery/assess', { studyId: S1, sourceId: 'field', record: at, value: 'bytes' })).status, 400, 'record bytes are never accepted');
      assert.equal((await post('/lab-internal/1/recovery/assess', { studyId: S1, sourceId: 'field', record: { ...at, offset: 'x' } })).status, 400);
      const view = await fetch(`${origin}/lab-internal/1/views/station/LC-03?boundary=${encodeURIComponent(`lcb1.${S1}.1`)}`, { headers: { authorization: `Bearer ${tokens[0]}` } });
      assert.deepEqual((await view.json() as { boundary: unknown }).boundary, { barrier: `lcb1.${S1}.1`, acknowledged: false, reason: 'unknown-barrier' });
      assert.equal((await post(`/lab-internal/1/studies/${S1}/discard`, {})).status, 409, 'an open study is closed first');
      assert.deepEqual(await (await post(`/lab-internal/1/studies/${S1}/close`, {})).json(), { studyId: S1, state: 'closed', inFlight: 0 });
      assert.equal((await post('/lab-internal/1/recovery/assess', { studyId: S1, sourceId: 'field', record: at })).status, 409, 'a closed study is never assessed');
      assert.equal((await post(`/lab-internal/1/studies/${S1}/discard`, {})).status, 200);
      for (const path of ['/lab-internal/1/views/holt/A', '/lab-internal/1/views/notebook/someone']) assert.equal((await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${tokens[0]}` } })).status, 401);
    });
  });
});
