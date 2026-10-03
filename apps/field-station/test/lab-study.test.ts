/**
 * A bench's study identity, same-study restart versus reset (study discard), and its
 * three readiness facts (LC11-ADR-02; acceptance LC11-A14 app side, A25, A26, A33).
 *
 * Stand-ins replace the gateway, its management API, the relay control, the Kafka
 * admin client, and the field station's study gate; the clock is fake. Every
 * expectation is written out here (the expected group, generation, step order,
 * and summary), never computed with the code under test. Evidence level: unit.
 * StreamOtter 0.1.0-rc.3 has no recovery guard, barrier, or journal; a paused
 * source stands in for a held one.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import { validateProjectConfig, type Gateway, type ProjectConfig } from 'streamotter/contracts';
import type { HandlerRegistry } from 'streamotter/gateway';
import type { LabChannels } from '../src/lab/bench.ts';
import type { BenchId, BenchStatus, StudySummary } from '../src/lab/contract.ts';
import { LeasePool, type BenchClient } from '../src/lab/leases.ts';
import { BenchRuntime, type StudyGateClient } from '../src/lab/runtime.ts';
import { consumerGroupFor, generationFor, newStudyId } from '../src/lab/study.ts';

const SERVICE = 's'.repeat(32);
const world = { sources: 'healthy' as 'healthy' | 'paused', relay: 'up' as 'up' | 'cut' };
const json = (response: import('node:http').ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
const management = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://management.invalid').pathname;
  if (path === '/management/v1/dev/principals') return json(response, 200, { ok: true, data: { items: [] } });
  if (path === '/management/v1/traces') return json(response, 200, { ok: true, data: { items: [], nextCursor: null } });
  if (path === '/management/v1/sources') return json(response, 200, { ok: true, data: { items: [{ sourceId: 'field', status: world.sources, ...(world.sources === 'paused' ? { reason: 'HANDLER_FAILED' } : {}) }] } });
  json(response, 404, { ok: false });
});
// The relay control, as the proxy's: /cut and /restore flip the path to Kafka.
const relay = createServer((request, response) => { if (request.url === '/cut') world.relay = 'cut'; if (request.url === '/restore') world.relay = 'up'; json(response, 200, {}); });
function listen(server: Server): Promise<string> { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))); }
const close = (server: Server) => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); };
let managementOrigin = ''; let relayOrigin = '';
before(async () => { managementOrigin = await listen(management); relayOrigin = await listen(relay); });
after(async () => { await close(management); await close(relay); });
beforeEach(() => { world.sources = 'healthy'; world.relay = 'up'; });

/** One bench's volume and Kafka, shared by every BenchRuntime a test starts on it (a process restart). */
async function volume(t: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), 'lab-study-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  let now = Date.parse('2026-10-03T12:00:00Z');
  /** Every lifecycle step, in order, as the stand-ins saw it. */
  const steps: string[] = [];
  const configs: ProjectConfig<LabChannels>[] = []; const handlers: HandlerRegistry<LabChannels>[] = [];
  const groups = new Set<string>();
  const faults = { deleteGroup: false, close: false, discard: false };
  let holdClose: Promise<void> | null = null; let holdStart: Promise<void> | null = null; let releaseStart: (() => void) | null = null;
  const gate: StudyGateClient = {
    async close(studyId) { steps.push(`gate.close ${studyId}`); if (holdClose) await holdClose; if (faults.close) throw new Error('field station unavailable'); },
    async discard(studyId) { steps.push(`gate.discard ${studyId}`); if (faults.discard) throw new Error('field station unavailable'); }
  };
  const gateway = (group: string) => ({ async start() {}, async stop() { steps.push(`gateway.stop ${group}`); }, async revoke(target: { subject: string }) { steps.push(`revoke ${target.subject}`); } }) as unknown as Gateway;
  /** A bench process on this volume, not yet booted. */
  const create = () => {
    const bench = new BenchRuntime({ LAB_BENCH: '1', LAB_BENCH_1_SERVICE_TOKEN: SERVICE, LAB_BENCH_1_RELAY_TOKEN: 'r'.repeat(32), LAB_RELAY_ORIGIN: relayOrigin }, {
      now: () => now, tickMs: 3_600_000, stateDir, gate, quiesceMs: 50,
      // The real admin client reaches Kafka at BENCH_KAFKA_BROKERS, the relay proxy itself: refused while the relay is cut.
      deleteGroup: async group => { steps.push(`deleteGroup ${group}`); if (faults.deleteGroup) throw new Error('broker refused'); if (world.relay === 'cut') throw new Error('connect ECONNREFUSED lab-1-kafka:9101'); groups.delete(group); },
      services: async (config, registry) => {
        const group = config.sources['field']!.kind === 'kafka' ? (config.sources['field'] as { consumerGroup: string }).consumerGroup : '';
        steps.push(`gateway.start ${group}`); configs.push(config); handlers.push(registry); groups.add(group);
        if (holdStart) await holdStart;
        return { gateway: gateway(group), management: { origin: managementOrigin, async close() {} } };
      }
    });
    // A failing test still shuts its bench down: a held gateway start is let go and the boot finishes before close.
    let booting: Promise<void> | undefined; const start = bench.start.bind(bench); bench.start = () => (booting = start());
    t.after(async () => { releaseStart?.(); await booting; await bench.close(); });
    return bench;
  };
  const runtime = async () => { const bench = create(); await bench.start(); return bench; };
  return { stateDir, steps, configs, handlers, groups, faults, gate, create, runtime, advance: (ms: number) => { now += ms; }, at: () => now, hold: (p: Promise<void> | null) => { holdClose = p; }, /** Holds every gateway start until the returned function is called. */
    holdStart: () => { holdStart = new Promise<void>(resolve => { releaseStart = () => { holdStart = null; releaseStart = null; resolve(); }; }); return releaseStart!; } };
}
const studyOf = (bench: BenchRuntime) => bench.status().study!;
const lease = (bench: BenchRuntime, at: number, leaseId = 'lease-1', ms = 120_000) => bench.run(() => bench.lease(leaseId, new Date(at + ms).toISOString()));
const settle = (bench: BenchRuntime) => bench.run(async () => undefined);
/** An LC-03 reading as the bench's map handler receives it. */
const lc03 = (offset: string) => ({ record: { value: { tenantId: 'lontra-creek', channel: 'station', params: { stationId: 'LC-03' }, revision: '1000', data: {} }, position: { kind: 'kafka', topic: 'lab-1.field.gauges', partition: 0, offset } } });

describe('study identity', () => {
  test('a new bench provisions a study: lab-N-<studyId>, streamotter-lab-N-<studyId>, a study directory, and study.json', async t => {
    const v = await volume(t); const bench = await v.runtime();
    const study = studyOf(bench);
    assert.match(study.studyId, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(study.generation, `lab-1-${study.studyId}`);
    assert.equal(study.consumerGroup, `streamotter-lab-1-${study.studyId}`);
    assert.equal(study.phase, 'clean');
    const source = v.configs[0]!.sources['field'] as { generation: string; consumerGroup: string; startFrom: string };
    assert.deepEqual([source.generation, source.consumerGroup, source.startFrom], [study.generation, study.consumerGroup, 'latest']);
    // The installed rc.3 validator accepts the study's generation and group.
    const validation = validateProjectConfig(v.configs[0]); assert.equal(validation.valid, true, JSON.stringify(validation.issues));
    assert.ok((await stat(join(v.stateDir, 'lab-1', 'studies', study.studyId))).isDirectory());
    const persisted = JSON.parse(await readFile(join(v.stateDir, 'lab-1', 'study.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(persisted['studyId'], study.studyId); assert.equal(persisted['phase'], 'clean');
    assert.deepEqual(bench.status().readiness, { control: true, source: true, cleanLease: true });
  });

  test('every study ID makes a generation and group rc.3 accepts', () => {
    for (let i = 0; i < 200; i++) {
      const id = newStudyId(); assert.match(id, /^[A-Za-z0-9_-]{16}$/);
      // rc.3's rules, restated: identifiers [A-Za-z][A-Za-z0-9_-]{0,63}; group names [A-Za-z0-9._-]{1,249}.
      assert.match(generationFor(3, id), /^[A-Za-z][A-Za-z0-9_-]{0,63}$/); assert.match(consumerGroupFor(3, id), /^[A-Za-z0-9._-]{1,249}$/);
    }
  });
});

describe('restart keeps the study (LC11-A14 app side, A33)', () => {
  test('a gateway restart reuses the group and generation and counts as a gateway restart', async t => {
    const v = await volume(t); const bench = await v.runtime(); const before = studyOf(bench);
    await lease(bench, v.at());
    await bench.run(() => bench.action('lease-1', 'gateway.restart')); await settle(bench);
    const after = studyOf(bench);
    assert.deepEqual([after.studyId, after.generation, after.consumerGroup, after.phase], [before.studyId, before.generation, before.consumerGroup, 'open']);
    assert.deepEqual(after.restarts, { gateway: 1, process: 0 });
    assert.deepEqual(v.steps.filter(step => step.startsWith('gateway.start')), [`gateway.start ${before.consumerGroup}`, `gateway.start ${before.consumerGroup}`]);
    assert.ok(!v.steps.some(step => step.startsWith('deleteGroup') || step.startsWith('gate.')), 'a restart discards nothing');
  });

  test('a source held after a same-study restart keeps the lease and control available', async t => {
    const v = await volume(t); const bench = await v.runtime(); await lease(bench, v.at());
    world.sources = 'paused';
    await bench.run(() => bench.action('lease-1', 'gateway.restart')); await settle(bench);
    const status: BenchStatus = bench.status();
    assert.equal(status.state, 'leased', 'a held source is not a failed bench');
    assert.equal(status.lease?.leaseId, 'lease-1');
    assert.deepEqual(status.readiness, { control: true, source: false, cleanLease: false });
    const api = bench.api(); const origin = await listen(api); t.after(() => close(api));
    const health = await fetch(`${origin}/healthz`); assert.equal(health.status, 200, '/healthz reports control availability, not source readiness');
    assert.equal((await bench.run(async () => bench.token('lease-1'))).expiresAt, status.lease!.expiresAt);
    await bench.tick(); assert.equal(bench.status().state, 'leased', 'polling a held source does not fail the bench either');
  });

  test('a bench process restart with the volume intact resumes the same study, lease, and calibration', async t => {
    const v = await volume(t); const first = await v.runtime(); const before = studyOf(first);
    await lease(first, v.at()); await first.run(() => first.action('lease-1', 'sensor.foul'));
    await first.close();
    world.sources = 'paused';
    const second = await v.runtime();
    const after = studyOf(second);
    assert.deepEqual([after.studyId, after.generation, after.consumerGroup], [before.studyId, before.generation, before.consumerGroup]);
    assert.deepEqual(after.restarts, { gateway: 0, process: 1 });
    assert.equal(second.status().state, 'leased'); assert.equal(second.status().lease?.leaseId, 'lease-1');
    assert.equal(second.status().scenario.calibration, 'removed');
    assert.deepEqual(second.status().readiness, { control: true, source: false, cleanLease: false });
    assert.ok(!v.steps.some(step => step.startsWith('deleteGroup')));
    // Tokens are not persisted: the old process's are gone, a new one can be minted for the same lease.
    assert.equal(second.authenticate('lab1_old'), null);
    const { token } = second.token('lease-1'); assert.equal(second.authenticate(token)?.sessionId, 'lease-1');
  });

  test('a process restart after the lease ended discards the study instead of resuming it', async t => {
    const v = await volume(t); const first = await v.runtime(); const old = studyOf(first);
    await lease(first, v.at(), 'lease-1', 10_000); await first.close();
    v.advance(10_001);
    const second = await v.runtime(); const fresh = studyOf(second);
    assert.notEqual(fresh.studyId, old.studyId); assert.equal(second.status().state, 'ready');
    assert.ok(v.steps.includes(`deleteGroup ${old.consumerGroup}`)); assert.ok(v.steps.includes(`gate.discard ${old.studyId}`));
    assert.deepEqual(await readdir(join(v.stateDir, 'lab-1', 'studies')), [fresh.studyId]);
  });

  test('an unreadable study.json at boot discards the old study with the reset steps', async t => {
    const v = await volume(t); const first = await v.runtime(); const old = studyOf(first);
    await lease(first, v.at()); await first.close();
    // A torn write: the descriptor can't be trusted, but the old study's directory names it.
    const path = join(v.stateDir, 'lab-1', 'study.json'); await writeFile(path, (await readFile(path, 'utf8')).slice(0, -7));
    v.steps.length = 0;
    const second = await v.runtime(); const fresh = studyOf(second);
    assert.notEqual(fresh.studyId, old.studyId); assert.equal(second.status().state, 'ready');
    assert.deepEqual(v.steps, [`gate.close ${old.studyId}`, `deleteGroup ${old.consumerGroup}`, `gate.discard ${old.studyId}`, `gateway.start ${fresh.consumerGroup}`]);
    assert.ok(!v.groups.has(old.consumerGroup));
    assert.deepEqual(await readdir(join(v.stateDir, 'lab-1', 'studies')), [fresh.studyId]);
  });

  test('the field station keeps the lease while a restarted bench process boots, and the same study resumes', async t => {
    const v = await volume(t);
    // The field station's pool, its publisher gate, and the bench API over HTTP, as in production.
    let origin = '';
    const client: BenchClient = { async call<T>(_bench: BenchId, path: string, method = 'GET', body?: unknown): Promise<T> {
      const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(`The bench answered ${response.status}.`); return await response.json() as T;
    } };
    const opened = new Map<BenchId, string>();
    const studies = { open: (bench: BenchId, studyId: string) => { opened.set(bench, studyId); }, close: async (bench: BenchId, studyId: string) => { if (opened.get(bench) === studyId) opened.delete(bench); }, current: (bench: BenchId) => opened.get(bench) ?? null };
    const pool = new LeasePool({ client, benches: [1], gatewayOrigin: 'https://demo.test', now: () => v.at(), studies });
    const first = v.create(); const firstApi = first.api(); origin = await listen(firstApi); await first.start();
    await pool.initialize(); await settle(first); v.advance(5000); await pool.sweep();
    const visitor = { subject: 'visitor', role: 'volunteer' as const, exp: v.at() + 1_800_000 };
    const granted = await pool.join(visitor, '192.0.2.9'); assert.equal(granted.status, 'ready');
    await pool.token(visitor);
    const before = studyOf(first);
    // The process exits with its volume intact; the new one listens before it boots, and its gateway takes a while to start.
    await close(firstApi); await first.close();
    const release = v.holdStart();
    const second = v.create(); const secondApi = second.api(); origin = await listen(secondApi); t.after(() => close(secondApi));
    const starts = v.steps.filter(step => step.startsWith('gateway.start')).length;
    const booting = second.start();
    while (v.steps.filter(step => step.startsWith('gateway.start')).length === starts) await new Promise(resolve => setImmediate(resolve));
    const during = await client.call<BenchStatus>(1, '/bench/v1/status');
    assert.deepEqual([during.state, during.lease?.leaseId, during.study?.studyId], ['leased', granted.status === 'ready' && granted.leaseId, before.studyId]);
    assert.equal(during.readiness.control, false, 'control is unavailable until the gateway is up');
    v.advance(5000); pool.heartbeat(visitor); await pool.sweep();
    assert.equal(pool.view(visitor).status, 'active', 'a booting bench does not end the lease');
    release(); await booting;
    v.advance(5000); pool.heartbeat(visitor); await pool.sweep();
    assert.equal(pool.view(visitor).status, 'active');
    const after = studyOf(second);
    assert.deepEqual([after.studyId, after.consumerGroup, after.restarts], [before.studyId, before.consumerGroup, { gateway: 0, process: 1 }]);
    assert.equal(second.status().readiness.control, true);
    assert.equal(opened.get(1), before.studyId, 'the study stays open for publication');
    assert.equal((await pool.token(visitor)).bench, 1, 'the page fetches a new token for the same lease');
  });
});

describe('reset discards the study (LC11-A25, A26)', () => {
  test('reset runs the ADR order, rotates every identity, and leaves a bounded summary', async t => {
    const v = await volume(t); const bench = await v.runtime(); const old = studyOf(bench);
    await lease(bench, v.at()); const { token } = bench.token('lease-1');
    await bench.run(() => bench.action('lease-1', 'sensor.foul'));
    v.steps.length = 0;
    await bench.run(() => bench.reset());
    const fresh = studyOf(bench);
    // The order LC11-ADR-02 fixes, written out independently.
    assert.deepEqual(v.steps, [
      'revoke lab-lease-1',
      `gate.close ${old.studyId}`,
      `gateway.stop ${old.consumerGroup}`,
      `deleteGroup ${old.consumerGroup}`,
      `gate.discard ${old.studyId}`,
      `gateway.start ${fresh.consumerGroup}`
    ]);
    assert.notEqual(fresh.studyId, old.studyId); assert.notEqual(fresh.generation, old.generation); assert.notEqual(fresh.consumerGroup, old.consumerGroup);
    assert.equal(fresh.generation, `lab-1-${fresh.studyId}`);
    assert.equal(bench.authenticate(token), null, 'old tokens are refused');
    assert.deepEqual(bench.status().readiness, { control: true, source: true, cleanLease: true });
    assert.equal(bench.status().scenario.calibration, 'present');
    assert.deepEqual(await readdir(join(v.stateDir, 'lab-1', 'studies')), [fresh.studyId], 'the old study directory is removed');
    const summary = JSON.parse(await readFile(join(v.stateDir, 'lab-1', 'summaries', `${old.studyId}.json`), 'utf8')) as StudySummary;
    assert.deepEqual(Object.keys(summary).sort(), ['bench', 'closedAt', 'consumerGroup', 'counts', 'createdAt', 'generation', 'lastSource', 'leaseId', 'phase', 'quiesced', 'restarts', 'studyId']);
    assert.deepEqual([summary.studyId, summary.leaseId, summary.phase, summary.counts.actions, summary.quiesced], [old.studyId, 'lease-1', 'open', 1, true]);
  });

  test('invalidation is immediate over the API, and late callbacks stay with the old study', async t => {
    const v = await volume(t); const bench = await v.runtime(); const old = studyOf(bench);
    const api = bench.api(); const origin = await listen(api); t.after(() => close(api));
    await lease(bench, v.at()); const { token } = bench.token('lease-1');
    const oldHandlers = v.handlers.at(-1)!;
    // Count one completed write in the open study, honestly.
    oldHandlers.channels.station!.map(lc03('7') as never);
    let release!: () => void; v.hold(new Promise<void>(resolve => { release = resolve; }));
    const response = await fetch(`${origin}/bench/v1/reset`, { method: 'POST', headers: { authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' }, body: JSON.stringify({ leaseId: 'lease-1' }) });
    assert.equal(response.status, 202);
    assert.equal(bench.authenticate(token), null, 'the lease and its tokens are refused before the reset finishes');
    assert.throws(() => bench.token('lease-1'), /no-lease/);
    // The publisher gate is still closing: a late record from the old gateway arrives now.
    while (!v.steps.includes(`gate.close ${old.studyId}`)) await new Promise(resolve => setImmediate(resolve));
    oldHandlers.channels.station!.map(lc03('8') as never);
    release(); v.hold(null); await settle(bench);
    await lease(bench, v.at(), 'lease-2');
    oldHandlers.channels.station!.map(lc03('9') as never);
    assert.deepEqual(bench.feed('lease-2').items.filter(item => item.kind === 'record'), [], 'nothing from the old study reaches the next lease');
    const summary = JSON.parse(await readFile(join(v.stateDir, 'lab-1', 'summaries', `${old.studyId}.json`), 'utf8')) as StudySummary;
    assert.deepEqual(summary.counts, { actions: 0, recordsProcessed: 1, recordsFailed: 0, lateCallbacks: 1 });
  });

  test('a cleanup failure keeps the bench failed and unleasable until a retried reset succeeds', async t => {
    const v = await volume(t); const bench = await v.runtime(); const old = studyOf(bench);
    await lease(bench, v.at());
    v.faults.deleteGroup = true;
    await assert.rejects(bench.run(() => bench.reset()));
    assert.equal(bench.status().state, 'failed');
    assert.equal(bench.status().readiness.cleanLease, false);
    await assert.rejects(lease(bench, v.at(), 'lease-2'), /not-applicable/);
    const api = bench.api(); const origin = await listen(api); t.after(() => close(api));
    assert.equal((await fetch(`${origin}/healthz`)).status, 503);
    v.faults.deleteGroup = false;
    await bench.run(() => bench.reset());
    assert.equal(bench.status().state, 'ready'); assert.equal(bench.status().readiness.cleanLease, true);
    assert.ok(!v.groups.has(old.consumerGroup), 'the retry finished deleting the old group');
    assert.notEqual(studyOf(bench).studyId, old.studyId);
  });

  test('a refused publisher gate fails the reset before anything is torn down', async t => {
    const v = await volume(t); const bench = await v.runtime(); const old = studyOf(bench);
    await lease(bench, v.at()); v.steps.length = 0; v.faults.close = true;
    await assert.rejects(bench.run(() => bench.reset()));
    assert.equal(bench.status().state, 'failed');
    assert.deepEqual(v.steps, ['revoke lab-lease-1', `gate.close ${old.studyId}`]);
  });

  test('a new study whose source will not consume fails the reset rather than reach a visitor', async t => {
    const v = await volume(t); const bench = await v.runtime(); await lease(bench, v.at());
    world.sources = 'paused';
    await assert.rejects(bench.run(() => bench.reset()));
    assert.equal(bench.status().state, 'failed'); assert.equal(bench.status().readiness.cleanLease, false);
  });

  test('a gateway restart queued behind a reset does not touch the next study', async t => {
    const v = await volume(t); const bench = await v.runtime(); await lease(bench, v.at());
    const api = bench.api(); const origin = await listen(api); t.after(() => close(api));
    let release!: () => void; const held = bench.run(() => new Promise<void>(resolve => { release = resolve; }));
    await bench.action('lease-1', 'gateway.restart');
    // The restart's job is queued first; the reset request invalidates its study before it runs.
    assert.equal((await fetch(`${origin}/bench/v1/reset`, { method: 'POST', headers: { authorization: `Bearer ${SERVICE}` }, body: JSON.stringify({ leaseId: 'lease-1' }) })).status, 202);
    release(); await held; await settle(bench); await settle(bench);
    assert.equal(studyOf(bench).restarts.gateway, 0);
    assert.equal(bench.status().state, 'ready');
  });

  test('a lease that ends with the relay cut restores the relay before the old group is deleted', async t => {
    const v = await volume(t); const bench = await v.runtime(); const old = studyOf(bench);
    await lease(bench, v.at()); await bench.run(() => bench.action('lease-1', 'relay.cut'));
    assert.equal(world.relay, 'cut');
    await bench.run(() => bench.reset());
    assert.equal(world.relay, 'up'); assert.equal(bench.status().scenario.relay, 'up');
    assert.equal(bench.status().state, 'ready'); assert.equal(bench.status().readiness.cleanLease, true);
    assert.ok(!v.groups.has(old.consumerGroup), 'the old group was deleted through the restored relay');
  });

  for (const retry of ['in the same process', 'after a reboot'] as const) {
    test(`a reset retried ${retry} keeps the first summary`, async t => {
      const v = await volume(t); let bench = await v.runtime(); const old = studyOf(bench);
      await lease(bench, v.at()); await bench.run(() => bench.action('lease-1', 'sensor.foul'));
      v.faults.discard = true;
      await assert.rejects(bench.run(() => bench.reset()));
      const path = join(v.stateDir, 'lab-1', 'summaries', `${old.studyId}.json`);
      const first = await readFile(path, 'utf8');
      v.faults.discard = false;
      if (retry === 'after a reboot') { await bench.close(); bench = await v.runtime(); } else await bench.run(() => bench.reset());
      assert.equal(bench.status().state, 'ready'); assert.ok(v.steps.filter(step => step === `gate.discard ${old.studyId}`).length === 2);
      assert.equal(await readFile(path, 'utf8'), first, 'the retry does not rewrite the summary');
      const summary = JSON.parse(first) as StudySummary;
      assert.deepEqual([summary.leaseId, summary.counts.actions, summary.lastSource], ['lease-1', 1, 'healthy']);
    });
  }
});
