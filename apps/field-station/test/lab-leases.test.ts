import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BenchId, BenchStatus } from '../src/lab/contract.ts';
import { LeasePool, type BenchClient } from '../src/lab/leases.ts';
import { LabError } from '../src/lab/errors.ts';
import { LabFeed } from '../src/lab/feed.ts';
import { benchConfig, benchEnvironment, benchHandlers } from '../src/lab/bench.ts';
import { createGateway } from 'streamotter/gateway';
import { BenchRuntime, requireNoDevelopmentPrincipals } from '../src/lab/runtime.ts';
import type { Trace } from 'streamotter/contracts';
function fixture(count = 3, leaseMs = 300_000) {
  let now = Date.parse('2026-09-27T00:00:00Z');
  const slots = new Map<BenchId, BenchStatus>();
  for (let i = 1; i <= count; i++) slots.set(i as BenchId, { bench: i as BenchId, state: 'ready', lease: null, scenario: { gateway: 'running', source: { status: 'healthy' }, relay: 'up', calibration: 'present', satellite: 'idle', receiptTimeoutMs: 5000 }, checks: { developmentPrincipals: 0, fixtureSources: 0, managementHost: '127.0.0.1' } });
  const calls: { bench: BenchId; path: string; body: unknown }[] = [];
  const client: BenchClient = { async call<T>(bench: BenchId, path: string, _method?: string, body?: unknown): Promise<T> {
    calls.push({ bench, path, body }); const slot = slots.get(bench)!; const input = body as { leaseId: string; expiresAt: string };
    if (path === '/bench/v1/reset') { slot.state = 'ready'; slot.lease = null; }
    if (path === '/bench/v1/lease') { slot.state = 'leased'; slot.lease = input; }
    if (path === '/bench/v1/tokens') return { token: `token-${bench}`, expiresAt: slot.lease!.expiresAt } as T;
    if (path === '/bench/v1/actions') return { at: new Date(now).toISOString(), scenario: slot.scenario } as T;
    return structuredClone(slot) as T;
  } };
  return { pool: new LeasePool({ client, benches: [...slots.keys()], gatewayOrigin: 'https://demo.test', now: () => now, leaseMs }), calls, slots, advance: (ms: number) => { now += ms; }, session: (id: string, ttl = 1_800_000) => ({ subject: id, role: 'volunteer' as const, exp: now + ttl }) };
}
const code = (name: string) => (error: unknown) => error instanceof LabError && error.code === name;
test('concurrent joins grant each bench once; FIFO advances after return; requests cannot choose another bench', async () => {
  const f = fixture(); await f.pool.initialize(); await f.pool.run(() => f.pool.sweep());
  const sessions = ['a', 'b', 'c', 'd'].map(id => f.session(id));
  const joined = await Promise.all(sessions.map(s => f.pool.run(() => f.pool.join(s, s.subject))));
  assert.deepEqual(joined.map(v => v.status), ['ready', 'ready', 'ready', 'queued']);
  assert.equal(joined[3]?.status === 'queued' && joined[3].position, 1);
  await f.pool.run(() => f.pool.leave(sessions[0]!));
  assert.equal(f.pool.view(sessions[3]!).status, 'ready');
  await assert.rejects(f.pool.token(sessions[0]!), code('no-lease'));
  assert.equal((await f.pool.token(sessions[3]!)).bench, 1);
  assert.equal(f.pool.view(sessions[1]!).status, 'ready');
});
test('per-address places, unclaimed timeout, active idle, queue idle, and session cap', async () => {
  const f = fixture(1); await f.pool.initialize(); await f.pool.sweep();
  const a = f.session('a'), b = f.session('b'), c = f.session('c');
  await f.pool.join(a, 'same'); await f.pool.join(b, 'same');
  await assert.rejects(f.pool.join(c, 'same'), code('too-many-places'));
  f.advance(29_000); f.pool.heartbeat(b); f.advance(1000); await f.pool.sweep();
  assert.equal(f.pool.view(a).status === 'ended' && (f.pool.view(a) as { reason: string }).reason, 'unclaimed');
  await f.pool.token(b); f.advance(30_000); await f.pool.sweep();
  assert.equal((f.pool.view(b) as { reason: string }).reason, 'idle');
  const short = f.session('short', 10_000); const lease = await f.pool.join(short, 'new');
  assert.equal(lease.status === 'ready' && Date.parse(lease.expiresAt), short.exp);
  await f.pool.token(short); f.advance(10_000); await f.pool.sweep();
  assert.equal((f.pool.view(short) as { reason: string }).reason, 'session-ended');
});
test('active lease expiration, action throttling, heartbeat, and restart reset', async () => {
  const f = fixture(1, 10_000); await f.pool.initialize(); await f.pool.sweep(); const s = f.session('a'); await f.pool.join(s, 'ip');
  await assert.rejects(f.pool.action(s, 'relay.cut'), code('no-lease'));
  await f.pool.token(s); await f.pool.action(s, 'relay.cut'); await assert.rejects(f.pool.action(s, 'relay.restore'), code('too-many-actions'));
  f.advance(1000); await f.pool.action(s, 'relay.restore'); f.advance(9000); f.pool.heartbeat(s); await f.pool.sweep();
  assert.equal((f.pool.view(s) as { reason: string }).reason, 'expired');
  assert.ok(f.calls.filter(c => c.path === '/bench/v1/reset').length >= 2);
});
test('redaction drops handshakes and map noise, replaces identifiers, bounds pages and rejects foreign cursors', () => {
  const feed = new LabFeed(); feed.reset('first');
  const trace: Trace = { id: 'internal', requestId: 'sensitive-request', at: new Date().toISOString(), stage: 'authorize', outcome: 'ok' };
  feed.trace(trace, new Set()); feed.trace({ ...trace, stage: 'map', outcome: 'filtered' }, new Set());
  assert.equal(feed.page().items.length, 0);
  feed.trace({ ...trace, subscriptionId: 'raw-subscription' }, new Set(['raw-subscription']));
  const output = JSON.stringify(feed.page()); assert.ok(!output.includes('sensitive-request')); assert.ok(!output.includes('raw-subscription')); assert.ok(output.includes('satellite'));
  for (let i = 0; i < 600; i++) feed.add({ kind: 'bench', event: 'gap' });
  assert.equal(feed.page().items.length, 100); assert.equal(feed.page().gap, true);
  const cursor = feed.page().next; feed.reset('second'); assert.throws(() => feed.page(cursor), code('invalid-request'));
  assert.throws(() => feed.page('second:999'), code('invalid-request'));
});
test('bench environment rejects production and other-bench secrets; options have no protected channels or development principals', () => {
  const env = { LAB_BENCH: '1', LAB_BENCH_1_SERVICE_TOKEN: 's'.repeat(32), LAB_BENCH_1_RELAY_TOKEN: 'r'.repeat(32) };
  assert.equal(benchEnvironment(env).number, 1);
  for (const key of ['FIELD_STATION_SECRET', 'FIELD_STATION_SERVICE_TOKEN', 'KAFKA_GATEWAY_PASSWORD', 'KAFKA_FIELD_STATION_PASSWORD', 'LAB_BENCH_2_SERVICE_TOKEN', 'LAB_BENCH_3_RELAY_TOKEN']) assert.throws(() => benchEnvironment({ ...env, [key]: 'secret' }), /forbidden/);
  const config = benchConfig(1); assert.deepEqual(Object.keys(config.channels).sort(), ['creekOverview', 'otter', 'reach', 'station']); assert.ok(Object.values(config.sources).every(source => source.kind === 'kafka'));
  const handlers = benchHandlers(1, { authenticate: () => null, serviceToken: env.LAB_BENCH_1_SERVICE_TOKEN, snapshotOrigin: 'http://field.test', calibration: () => true, record: () => {} });
  assert.doesNotThrow(() => createGateway({ config, handlers, mode: 'production' }));
  const runtime = new BenchRuntime(env); assert.equal(runtime.authenticate('sop_' + 'x'.repeat(43)), null); assert.equal(runtime.authenticate('badge'), null);
});

test('startup self-check refuses any registered development principal', () => {
  assert.doesNotThrow(() => requireNoDevelopmentPrincipals([]));
  assert.throws(() => requireNoDevelopmentPrincipals([{ id: 'preview-researcher' }]), /forbidden/);
});
