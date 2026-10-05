/**
 * The bench's failure-handling pieces in isolation (Lab contract section 8b): the
 * per-profile configuration, the map handler's scenario variants, the recovery guard,
 * the snapshot's boundary acknowledgment, plan tokens, and the operator adapter's
 * bookkeeping.
 *
 * Evidence level: unit. The guard and snapshot tests use a stand-in `fetch` for the
 * field station; the adapter tests use a typed fake `OperatorApi` whose answers are
 * written here, so they are fixture-level evidence of the bench's own bookkeeping
 * (cancellation, error mapping, token binding) and prove nothing about the library.
 * What the installed library actually decides is tested in lab-failures.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createGateway, TransientMappingError } from 'streamotter/gateway';
import { validateProjectConfig, type Json, type OperationResult, type OperatorApi, type RecoveryBoundary, type RecoveryIncident } from 'streamotter/contracts';
import { benchConfig, benchEnvironment, benchHandlers, failureHandlingFor, handlerBuildId, PROJECTION_V2, READING_BATCH, recoveryGuard, runsUnder } from '../src/lab/bench.ts';
import type { FeedEvent } from '../src/lab/feed.ts';
import { BenchFailures, MAX_TOKENS, operationStatus, PlanTokens } from '../src/lab/operator.ts';

const SERVICE = 's'.repeat(32);
const STUDY = 'studyAAAAAAAAAAA';
const GENERATION = `lab-1-${STUDY}`;
const context = () => ({ signal: new AbortController().signal, requestId: 'r' });
const reading = { stationId: 'LC-03', flowCfs: 87.5, stageFt: 3.1 };
const record = (value: Record<string, Json>, position: Record<string, unknown> = { kind: 'kafka', topic: 'lab-1.field.gauges', partition: 0, offset: '41' }) =>
  ({ ...context(), record: { value: { tenantId: 'lontra-creek', channel: 'station', params: { stationId: 'LC-03' }, revision: '1000000000500', data: reading, ...value }, position } }) as never;

describe('the bench config per failure profile', () => {
  test('off has no failure handling; retry only bounded retries; quarantine the full policy, valid under the installed validator', () => {
    assert.equal(failureHandlingFor(1, 'off'), undefined);
    assert.deepEqual(failureHandlingFor(2, 'retry'), { sources: { field: { transientMapperRetries: 2, replaySafeMapping: true } } });
    assert.deepEqual(failureHandlingFor(3, 'quarantine'), {
      quarantine: { topic: 'lab-3.quarantine', capture: 'full-record' },
      sources: { field: { invalidJson: 'quarantine-hold', invalidPublicPayload: 'quarantine-resync', transientMapperRetries: 2, replaySafeMapping: true, automaticAdvanceLimit: { incidents: 5, windowMs: 60_000 }, boundaryRetirement: 'generation' } }
    });
    for (const profile of ['off', 'retry', 'quarantine'] as const) {
      const config = benchConfig(1, { profile, generation: GENERATION });
      const validation = validateProjectConfig(config); assert.equal(validation.valid, true, JSON.stringify(validation.issues));
      assert.equal('failureHandling' in config, profile !== 'off');
      assert.equal(config.limits?.maxSourceRecordBytes, 262_144);
    }
    assert.equal(handlerBuildId('corrected'), 'lontra-lab@1.1.0+projection-v2-corrected');
    assert.deepEqual([runsUnder('fouled-sensor'), runsUnder('calibration-blip'), runsUnder('bad-projection')], [['retry', 'quarantine'], ['retry', 'quarantine'], ['quarantine']]);
  });

  test('the installed library constructs each profile\'s gateway under production rules with the bench\'s own handlers', () => {
    for (const profile of ['off', 'retry', 'quarantine'] as const) {
      const handlers = benchHandlers(1, { authenticate: () => null, serviceToken: SERVICE, snapshotOrigin: 'http://station.invalid', calibration: () => true, record: () => undefined, ...(profile === 'quarantine' ? { recovery: { study: () => null } } : {}) });
      const journal = profile === 'off' ? {} : { stateDirectory: '/nonexistent/lab-1/studies/x/journal', handlerBuildId: handlerBuildId('broken') };
      // Construction validates; the journal opens only at start, so a missing directory is fine here.
      createGateway({ config: benchConfig(1, { profile, generation: GENERATION }), handlers, mode: 'production', ...journal });
    }
    const unguarded = benchHandlers(1, { authenticate: () => null, serviceToken: SERVICE, snapshotOrigin: 'http://station.invalid', calibration: () => true, record: () => undefined });
    assert.throws(() => createGateway({ config: benchConfig(1, { profile: 'quarantine', generation: GENERATION }), handlers: unguarded, mode: 'production', stateDirectory: '/nonexistent' }), /recovery guard/);
    assert.throws(() => createGateway({ config: benchConfig(1, { profile: 'quarantine', generation: GENERATION }), handlers: benchHandlers(1, { authenticate: () => null, serviceToken: SERVICE, snapshotOrigin: 'http://station.invalid', calibration: () => true, record: () => undefined, recovery: { study: () => null } }), mode: 'production' }), /stateDirectory|state directory/i, 'production needs the journal directory');
  });

  test('LAB_FAILURE_HANDLING defaults to off and accepts only the three profiles', () => {
    const env = { LAB_BENCH: '1', LAB_BENCH_1_SERVICE_TOKEN: SERVICE, LAB_BENCH_1_RELAY_TOKEN: 'r'.repeat(32) };
    assert.equal(benchEnvironment(env).profile, 'off');
    assert.equal(benchEnvironment({ ...env, LAB_FAILURE_HANDLING: 'quarantine' }).profile, 'quarantine');
    assert.throws(() => benchEnvironment({ ...env, LAB_FAILURE_HANDLING: 'skip' }), /LAB_FAILURE_HANDLING/);
  });
});

describe('the map handler\'s scenario variants', () => {
  const setup = (options: { mapping?: 'broken' | 'corrected'; blips?: number; calibration?: boolean } = {}) => {
    const feed: FeedEvent[] = []; let blips = options.blips ?? 0;
    const handlers = benchHandlers(1, { authenticate: () => null, serviceToken: SERVICE, snapshotOrigin: 'http://station.invalid', calibration: () => options.calibration ?? true, record: event => feed.push(event), mapping: () => options.mapping ?? 'broken', blip: () => blips > 0 && blips-- > 0 });
    return { map: handlers.channels.station!.map, feed };
  };

  test('lab-projection-v2 writes flowCfs as a string until the projection is corrected', async () => {
    const broken = await setup().map(record({ mapping: PROJECTION_V2 }));
    assert.deepEqual(broken.map(output => output.data), [{ ...reading, flowCfs: '87.5' }]);
    const corrected = await setup({ mapping: 'corrected' }).map(record({ mapping: PROJECTION_V2 }));
    assert.deepEqual(corrected.map(output => output.data), [reading]);
  });

  test('lab-reading-batch maps one output per reading at the record\'s one revision; anything else is refused', async () => {
    const other = { ...reading, flowCfs: 90 };
    const outputs = await setup().map(record({ mapping: READING_BATCH, readings: [reading, other] }));
    assert.deepEqual(outputs.map(output => [output.revision, output.data]), [['1000000000500', reading], ['1000000000500', other]]);
    assert.throws(() => setup().map(record({ mapping: READING_BATCH, readings: [reading, reading, reading] })), /Invalid reading batch/);
    assert.throws(() => setup().map(record({ mapping: 'lab-something-else' })), /Unknown mapping/);
  });

  test('a blip fails a live LC-03 reading transiently, once per armed attempt; only unmarked Kafka records reach the feed', async () => {
    const { map, feed } = setup({ blips: 1 });
    assert.throws(() => map(record({})), (error: unknown) => TransientMappingError.is(error));
    assert.equal((await map(record({}))).length, 1, 'the next attempt maps');
    assert.deepEqual(feed.map(event => event.kind === 'record' && event.outcome), ['failed', 'processed']);
    const fixture = setup({ blips: 1 });
    assert.throws(() => fixture.map(record({}, { kind: 'fixture', index: '0' })), (error: unknown) => TransientMappingError.is(error));
    await fixture.map(record({ mapping: PROJECTION_V2 }));
    assert.deepEqual(fixture.feed, [], 'no Kafka coordinates, and scenario records (evaluated or redriven too) are never annotated');
    assert.throws(() => setup({ calibration: false }).map(record({})), (error: unknown) => !TransientMappingError.is(error) && /calibration is unavailable/.test(String(error)));
  });
});

describe('the recovery guard (LC11-ADR-01, bench side)', () => {
  type Call = { url: string; body: Record<string, unknown> };
  const guard = (answer: { status: number; body?: unknown }, study: { studyId: string; generation: string } | null = { studyId: STUDY, generation: GENERATION }) => {
    const calls: Call[] = [];
    const fetcher = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status }); }) as unknown as typeof fetch;
    return { recover: recoveryGuard(1, { serviceToken: SERVICE, snapshotOrigin: 'http://station.invalid', study: () => study, fetch: fetcher }).recover, calls };
  };
  const incident = (position: RecoveryIncident['position'] = { kind: 'kafka', topic: 'lab-1.field.gauges', partition: 0, offset: '41' }): RecoveryIncident => ({ failureId: 'f1:x', failureClass: 'payload-schema', position, evidenceHash: 'sha256:0' });
  const input = (prior: RecoveryBoundary | null = null, generation = GENERATION, position?: RecoveryIncident['position']) => ({ ...context(), sourceId: 'field', generation, incident: incident(position), prior });
  const recoverable = (seq: number, studyId = STUDY) => ({ status: 200, body: { decision: 'recoverable', studyId, barrier: `lcb1.${studyId}.${seq}`, covers: ['station:LC-03'], evidenceRef: 'run-1' } });

  test('it asks the ledger by coordinates only, and returns the cumulative barrier as the boundary\'s context', async () => {
    const { recover, calls } = guard(recoverable(2));
    assert.deepEqual(await recover(input({ id: 'rb1:a', context: { barrier: `lcb1.${STUDY}.1`, covers: [] } })), { decision: 'recoverable', context: { barrier: `lcb1.${STUDY}.2`, covers: ['station:LC-03'] }, evidenceRef: 'run-1' });
    assert.deepEqual(calls, [{ url: 'http://station.invalid/lab-internal/1/recovery/assess', body: { studyId: STUDY, sourceId: 'field', record: { topic: 'lab-1.field.gauges', partition: 0, offset: '41' } } }]);
    const fixture = guard(recoverable(1)); await fixture.recover(input(null, GENERATION, { kind: 'fixture', index: '0' }));
    assert.deepEqual(fixture.calls[0]!.body, { studyId: STUDY, sourceId: 'field' }, 'no coordinates for a non-Kafka position');
  });

  test('every doubt holds, with its reason', async () => {
    assert.deepEqual(await guard(recoverable(1)).recover(input(null, 'lab-1-otherAAAAAAAAAAA')), { decision: 'hold', reason: 'wrong-study' });
    assert.deepEqual(await guard(recoverable(1), null).recover(input()), { decision: 'hold', reason: 'wrong-study' }, 'a closed study');
    assert.deepEqual(await guard({ status: 409 }).recover(input()), { decision: 'hold', reason: 'study-closed' });
    assert.deepEqual(await guard({ status: 500 }).recover(input()), { decision: 'hold', reason: 'assessment-unavailable' });
    assert.deepEqual(await guard({ status: 200, body: { decision: 'hold', studyId: STUDY, reason: 'coverage-pending', evidenceRef: null } }).recover(input()), { decision: 'hold', reason: 'coverage-pending' });
    assert.deepEqual(await guard(recoverable(1, 'studyBBBBBBBBBBB')).recover(input()), { decision: 'hold', reason: 'wrong-study' });
    assert.deepEqual(await guard(recoverable(1)).recover(input({ id: 'rb1:a', context: { barrier: `lcb1.${STUDY}.2` } })), { decision: 'hold', reason: 'prior-not-covered' }, 'a barrier never goes backwards');
    assert.deepEqual(await guard(recoverable(3)).recover(input({ id: 'rb1:a', context: { barrier: 'lcb1.studyBBBBBBBBBBB.1' } })), { decision: 'hold', reason: 'prior-not-covered' });
  });
});

describe('the snapshot\'s boundary acknowledgment', () => {
  const snapshot = (answer: Record<string, unknown>) => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ revision: '7', data: reading, ...answer }), { status: 200 }); }) as unknown as typeof fetch;
    const handlers = benchHandlers(1, { authenticate: () => null, serviceToken: SERVICE, snapshotOrigin: 'http://station.invalid', calibration: () => true, record: () => undefined, fetch: fetcher });
    return { take: (recovery?: { boundaryId: string; context: Json }) => handlers.channels.station!.snapshot({ ...context(), principal: {} as never, params: { stationId: 'LC-03' }, ...(recovery ? { recovery } : {}) }), urls };
  };
  const recovery = { boundaryId: 'rb1:abc', context: { barrier: `lcb1.${STUDY}.1`, covers: ['station:LC-03'] } };

  test('it echoes the boundary only when the served state acknowledges exactly its barrier', async () => {
    const acknowledged = snapshot({ boundary: { barrier: `lcb1.${STUDY}.1`, acknowledged: true } });
    assert.deepEqual(await acknowledged.take(recovery), { revision: '7', data: reading, recoveryBoundaryId: 'rb1:abc' });
    assert.deepEqual(acknowledged.urls, [`http://station.invalid/lab-internal/1/views/station/LC-03?boundary=${encodeURIComponent(`lcb1.${STUDY}.1`)}`]);
    assert.deepEqual(await snapshot({ boundary: { barrier: `lcb1.${STUDY}.1`, acknowledged: false, reason: 'lagging' } }).take(recovery), { revision: '7', data: reading });
    assert.deepEqual(await snapshot({ boundary: { barrier: `lcb1.${STUDY}.2`, acknowledged: true } }).take(recovery), { revision: '7', data: reading }, 'another barrier is not this one');
    assert.deepEqual(await snapshot({}).take(recovery), { revision: '7', data: reading });
  });

  test('without a boundary in force it asks for none and echoes none', async () => {
    const plain = snapshot({ boundary: { barrier: 'x', acknowledged: true } });
    assert.deepEqual(await plain.take(), { revision: '7', data: reading });
    assert.deepEqual(plain.urls, ['http://station.invalid/lab-internal/1/views/station/LC-03']);
  });
});

describe('plan tokens', () => {
  const binding = (over: Partial<Parameters<PlanTokens['mint']>[0]> = {}) => ({ leaseId: 'lease-1', studyId: STUDY, failureId: 'f1:a', incidentRevision: 3, planId: 'pl1:x', fingerprint: 'fp', expiresAt: 10_000, ...over });

  test('single use, bound to lease, study, incident, and its revision, and expiring', () => {
    let now = 0; const tokens = new PlanTokens(() => now);
    const token = tokens.mint(binding());
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(tokens.current('f1:a', 3), { token, expiresAt: 10_000 });
    assert.equal(tokens.current('f1:a', 4), null, 'another revision has no token');
    for (const scope of [{ leaseId: 'lease-2', studyId: STUDY, failureId: 'f1:a', incidentRevision: 3 }, { leaseId: 'lease-1', studyId: 'studyBBBBBBBBBBB', failureId: 'f1:a', incidentRevision: 3 }, { leaseId: 'lease-1', studyId: STUDY, failureId: 'f1:b', incidentRevision: 3 }]) assert.equal(tokens.take(token, scope), 'plan-unknown');
    const scope = { leaseId: 'lease-1', studyId: STUDY, failureId: 'f1:a', incidentRevision: 3 };
    assert.equal((tokens.take(token, scope) as { planId: string }).planId, 'pl1:x');
    assert.equal(tokens.take(token, scope), 'plan-unknown', 'spent');
    const moved = tokens.mint(binding());
    assert.equal(tokens.take(moved, { ...scope, incidentRevision: 4 }), 'stale-revision', 'the incident moved on since the evaluation');
    assert.equal(tokens.take(moved, scope), 'plan-unknown', 'and the stale token is spent');
    const late = tokens.mint(binding()); now = 10_000;
    assert.equal(tokens.current('f1:a', 3), null);
    assert.equal(tokens.take(late, scope), 'plan-expired');
  });

  test('at most MAX_TOKENS are kept, oldest forgotten first', () => {
    const tokens = new PlanTokens(() => 0);
    const minted = Array.from({ length: MAX_TOKENS + 1 }, (_, i) => tokens.mint(binding({ failureId: `f1:${i}` })));
    assert.equal(tokens.take(minted[0]!, { leaseId: 'lease-1', studyId: STUDY, failureId: 'f1:0', incidentRevision: 3 }), 'plan-unknown');
    assert.notEqual(typeof tokens.take(minted.at(-1)!, { leaseId: 'lease-1', studyId: STUDY, failureId: `f1:${MAX_TOKENS}`, incidentRevision: 3 }), 'string');
  });

  test('an approval redrives at the revision its plan was evaluated at, and refuses one sent for another', async () => {
    const failures = new BenchFailures({ number: 1, studyId: STUDY });
    const redrives: unknown[] = [];
    const api = {
      evaluate: async () => ({ validation: 'valid', eligible: true, ineligibleReason: null, errors: [], outputs: [{}], plan: { planId: 'pl1:x', fingerprint: 'fp', expiresAt: new Date(Date.now() + 60_000).toISOString() } }),
      redrive: async (input: unknown) => { redrives.push(input); return { operationId: 'op1:r', result: 'completed', outcome: 'superseded', incidentRevision: 3 }; }
    } as unknown as OperatorApi;
    const at = (revision: number, planToken?: string) => ({ leaseId: 'lease-1', operationId: `lop_${'r'.repeat(21)}${revision}`, intent: planToken ? 'incident.approve-reprocess' as const : 'incident.evaluate' as const, incident: { failureId: 'f1:a', revision }, ...(planToken ? { planToken } : {}) });
    assert.equal((await failures.incident(api, at(3), Infinity)).status, 'succeeded');
    const token = failures.tokens.current('f1:a', 3)!.token;
    assert.deepEqual(await failures.incident(api, at(4, token), Infinity), { status: 'refused', outcome: 'stale-revision', incidentRevision: null });
    assert.deepEqual(redrives, [], 'nothing was redriven');
    assert.equal((await failures.incident(api, at(3), Infinity)).status, 'succeeded');
    const fresh = failures.tokens.current('f1:a', 3)!.token;
    assert.equal((await failures.incident(api, at(3, fresh), Infinity)).outcome, 'superseded');
    assert.deepEqual(redrives.map(input => (input as { expectedRevision: number }).expectedRevision), [3]);
  });
});

describe('the operator adapter\'s bookkeeping (typed fake OperatorApi: fixture-level evidence)', () => {
  const settle = async (failures: BenchFailures, id: string) => { for (let i = 0; i < 100; i++) { const op = failures.operation('lease-1', id)!; if (op.status !== 'running') return op; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('never settled'); };
  const request = (operationId: string, intent: 'incident.retry-current' | 'incident.reassess' = 'incident.retry-current') => ({ leaseId: 'lease-1', operationId, intent, incident: { failureId: 'f1:a', revision: 2 } });
  const result = (over: Partial<OperationResult> = {}): OperationResult => ({ operationId: 'op1:x', result: 'completed', outcome: 'retried', incidentRevision: 3, ...over } as OperationResult);

  test('library results map onto operation statuses; a throw is unknown unless the request was malformed', async () => {
    assert.deepEqual(['completed', 'refused', 'failed', 'unknown'].map(r => operationStatus(r as OperationResult['result'])), ['succeeded', 'refused', 'failed', 'unknown']);
    const failures = new BenchFailures({ number: 1, studyId: STUDY });
    const api = { retryCurrent: async () => { throw Object.assign(new Error('boom'), { code: 'SOURCE_UNAVAILABLE' }); }, reassess: async () => { throw Object.assign(new Error('bad'), { code: 'INVALID_REQUEST' }); } } as unknown as OperatorApi;
    failures.accept(request('lop_a'), () => failures.incident(api, request('lop_a'), Infinity));
    assert.deepEqual([(await settle(failures, 'lop_a')).status, (await settle(failures, 'lop_a')).outcome], ['unknown', 'SOURCE_UNAVAILABLE']);
    failures.accept(request('lop_b', 'incident.reassess'), () => failures.incident(api, request('lop_b', 'incident.reassess'), Infinity));
    assert.deepEqual([(await settle(failures, 'lop_b')).status, (await settle(failures, 'lop_b')).outcome], ['refused', 'invalid-request']);
    failures.accept(request('lop_c'), () => failures.incident(null, request('lop_c'), Infinity));
    assert.deepEqual([(await settle(failures, 'lop_c')).status, (await settle(failures, 'lop_c')).outcome], ['refused', 'gateway-not-running']);
  });

  test('closing the study cancels unfinished operations; a late result changes nothing', async () => {
    const failures = new BenchFailures({ number: 1, studyId: STUDY });
    let release!: (value: OperationResult) => void;
    const api = { retryCurrent: () => new Promise<OperationResult>(resolve => { release = resolve; }) } as unknown as OperatorApi;
    const accepted = failures.accept(request('lop_a'), () => failures.incident(api, request('lop_a'), Infinity));
    assert.equal(accepted.status, 'running');
    failures.close();
    assert.deepEqual([failures.operation('lease-1', 'lop_a')!.status, failures.operation('lease-1', 'lop_a')!.outcome], ['cancelled', 'study-closed']);
    release(result()); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(failures.operation('lease-1', 'lop_a')!.status, 'cancelled');
    assert.throws(() => failures.accept(request('lop_b'), async () => ({ status: 'succeeded', outcome: 'x', incidentRevision: null })), { code: 'no-lease' });
    assert.equal(failures.operation('lease-1', 'lop_a')!.operationId, 'lop_a', 'a re-sent request still finds its record');
    assert.equal(failures.operation('lease-2', 'lop_a'), null, 'never another lease\'s');
  });
});
