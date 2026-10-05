import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BenchId, BenchStatus } from '../src/lab/contract.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { benchError, configuredLab, LeasePool, type BenchClient } from '../src/lab/leases.ts';
import { BenchNotFound, LabError, MAX_LEASE_MS } from '../src/lab/errors.ts';
import { LabFeed } from '../src/lab/feed.ts';
import { benchConfig, benchEnvironment, benchHandlers } from '../src/lab/bench.ts';
import { createGateway } from 'streamotter/gateway';
import { BenchRuntime, requireNoDevelopmentPrincipals } from '../src/lab/runtime.ts';
import type { Trace } from 'streamotter/contracts';
import { publicApi } from '../src/server/http.ts';
import { readConfig } from '../src/server/config.ts';
import type { FieldStation } from '../src/server/station.ts';
import type { Notebooks } from '../src/server/notebooks.ts';
function fixture(count = 3, leaseMs = 300_000) {
  let now = Date.parse('2026-09-27T00:00:00Z');
  const slots = new Map<BenchId, BenchStatus>();
  // Every study is new: a reset never brings an earlier study ID back.
  let seq = 0; const fresh = (bench: number) => `b${bench}study${String(++seq).padStart(9, '0')}`;
  for (let i = 1; i <= count; i++) slots.set(i as BenchId, { bench: i as BenchId, state: 'ready', lease: null, scenario: { gateway: 'running', source: { status: 'healthy' }, relay: 'up', calibration: 'present', satellite: 'idle', receiptTimeoutMs: 5000 }, checks: { developmentPrincipals: 0, fixtureSources: 0, managementHost: '127.0.0.1' }, readiness: { control: true, source: true, cleanLease: true }, study: { ...((id: string) => ({ studyId: id, generation: `lab-${i}-${id}`, consumerGroup: `streamotter-lab-${i}-${id}` }))(fresh(i)), createdAt: new Date(now).toISOString(), phase: 'clean', restarts: { gateway: 0, process: 0 } } });
  const calls: { bench: BenchId; path: string; body: unknown }[] = [];
  /** Benches whose status calls hang until the client's 5-second timeout. */
  const hanging = new Set<BenchId>();
  const client: BenchClient = { async call<T>(bench: BenchId, path: string, _method?: string, body?: unknown): Promise<T> {
    calls.push({ bench, path, body }); const slot = slots.get(bench)!; const input = body as { leaseId: string; expiresAt: string };
    if (path === '/bench/v1/status' && hanging.has(bench)) { now += 5000; throw new Error('The operation was aborted due to timeout.'); }
    if (path === '/bench/v1/reset') { slot.state = 'ready'; slot.lease = null; slot.readiness = { ...slot.readiness, cleanLease: true }; const id = fresh(bench); slot.study = { ...slot.study!, studyId: id, generation: `lab-${bench}-${id}`, consumerGroup: `streamotter-lab-${bench}-${id}`, phase: 'clean' }; }
    if (path === '/bench/v1/lease') { slot.state = 'leased'; slot.lease = input; slot.readiness = { ...slot.readiness, cleanLease: false }; slot.study = { ...slot.study!, phase: 'open' }; }
    if (path === '/bench/v1/tokens') return { token: `token-${bench}`, expiresAt: slot.lease!.expiresAt } as T;
    if (path === '/bench/v1/actions') return { at: new Date(now).toISOString(), scenario: slot.scenario } as T;
    return structuredClone(slot) as T;
  } };
  // The field station's publisher gate, as studies.ts keeps it: the study it opened per bench, and every one it closed, which never reopens.
  const gate: string[] = []; const opened = new Map<BenchId, string>(); const closed = new Set<string>();
  const studies = {
    open: (bench: BenchId, studyId: string) => { if (closed.has(studyId)) throw new Error('The study is not open.'); gate.push(`open ${bench} ${studyId}`); opened.set(bench, studyId); },
    close: async (bench: BenchId, studyId: string) => { gate.push(`close ${bench} ${studyId}`); calls.push({ bench, path: 'gate.close', body: studyId }); closed.add(studyId); if (opened.get(bench) === studyId) opened.delete(bench); },
    current: (bench: BenchId) => opened.get(bench) ?? null
  };
  return { pool: new LeasePool({ client, benches: [...slots.keys()], gatewayOrigin: 'https://demo.test', now: () => now, leaseMs, studies }), calls, slots, gate, studies, hanging, advance: (ms: number) => { now += ms; }, session: (id: string, ttl = 1_800_000) => ({ subject: id, role: 'volunteer' as const, exp: now + ttl }) };
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
  assert.throws(() => feed.page('second:0.1'), code('invalid-request'), 'not issued yet');
  feed.add({ kind: 'bench', event: 'lease-started' }); assert.equal(feed.page().items[0]?.id, 'second:0.1');
  feed.reset('second', 1); feed.add({ kind: 'bench', event: 'gap' });
  assert.deepEqual(feed.page('second:0.1'), { items: feed.page().items, next: 'second:1.1', gap: true }, 'an earlier epoch is answered from the start');
});
test('bench environment rejects production and other-bench secrets; options have no protected channels or development principals', () => {
  const env = { LAB_BENCH: '1', LAB_BENCH_1_SERVICE_TOKEN: 's'.repeat(32), LAB_BENCH_1_RELAY_TOKEN: 'r'.repeat(32) };
  assert.equal(benchEnvironment(env).number, 1);
  for (const key of ['FIELD_STATION_SECRET', 'FIELD_STATION_SERVICE_TOKEN', 'FIELD_STATION_INTERNAL_URL', 'KAFKA_GATEWAY_PASSWORD', 'KAFKA_FIELD_STATION_PASSWORD', 'LAB_BENCH_2_SERVICE_TOKEN', 'LAB_BENCH_3_RELAY_TOKEN', 'SANDBOX_SERVICE_TOKEN', 'KAFKA_LAB_2_PASSWORD', 'CLOUDFLARE_API_TOKEN', 'SOME_FUTURE_SECRET', 'DEPLOY_KEY', 'lowercase_token']) assert.throws(() => benchEnvironment({ ...env, [key]: 'secret' }), /forbidden/, key);
  // Its own credentials, and ordinary settings that merely look alike, are fine.
  assert.doesNotThrow(() => benchEnvironment({ ...env, KAFKA_LAB_PASSWORD: 'p', KAFKA_LAB_USERNAME: 'lab-1', KAFKA_CA_FILE: '/etc/ca.pem', PATH: '/usr/bin', NODE_VERSION: '24.21.0', HOSTNAME: 'lab-1', LAB_STATE_DIR: '/var/lib/lontra', MONKEY: 'x' }));
  const config = benchConfig(1); assert.deepEqual(Object.keys(config.channels).sort(), ['creekOverview', 'otter', 'reach', 'station']); assert.ok(Object.values(config.sources).every(source => source.kind === 'kafka'));
  const handlers = benchHandlers(1, { authenticate: () => null, serviceToken: env.LAB_BENCH_1_SERVICE_TOKEN, snapshotOrigin: 'http://field.test', calibration: () => true, record: () => {} });
  assert.doesNotThrow(() => createGateway({ config, handlers, mode: 'production' }));
  const runtime = new BenchRuntime(env); assert.equal(runtime.authenticate('sop_' + 'x'.repeat(43)), null); assert.equal(runtime.authenticate('badge'), null);
});

test('startup self-check refuses any registered development principal', () => {
  assert.doesNotThrow(() => requireNoDevelopmentPrincipals([]));
  assert.throws(() => requireNoDevelopmentPrincipals([{ id: 'preview-researcher' }]), /forbidden/);
});

test('a lease longer than a bench accepts is refused at startup, not on every grant', () => {
  const env = { LAB_BENCH_API_URLS: 'http://bench-1.test:7420', LAB_BENCH_1_SERVICE_TOKEN: 's'.repeat(32) };
  assert.equal(configuredLab({ ...env, LAB_LEASE_SECONDS: '300' }, 'https://demo.test').pool.enabled, true);
  assert.throws(() => configuredLab({ ...env, LAB_LEASE_SECONDS: '301' }, 'https://demo.test'), /at most 300/);
  assert.throws(() => configuredLab({ ...env, LAB_LEASE_SECONDS: '600' }, 'https://demo.test'), /at most 300/);
  assert.throws(() => new LeasePool({ client: { call: async () => { throw new Error('unused'); } }, benches: [1], gatewayOrigin: 'https://demo.test', leaseMs: MAX_LEASE_MS + 1 }), RangeError);
});

test("a bench's error codes reach the visitor as the contract names them", () => {
  const mapped = (status: number, code?: unknown) => { const error = benchError(status, code); return [error.code, error.status]; };
  assert.deepEqual(mapped(409, 'no-lease'), ['no-lease', 409]);
  assert.deepEqual(mapped(409, 'not-applicable'), ['not-applicable', 409]);
  assert.deepEqual(mapped(409, 'something-else'), ['not-applicable', 409]);
  assert.deepEqual(mapped(429, 'too-many-actions'), ['too-many-actions', 429]);
  assert.deepEqual(mapped(400), ['invalid-request', 400]);
  for (const status of [401, 404, 500, 502]) assert.deepEqual(mapped(status, 'no-lease'), ['bench-unavailable', 503]);
  // A 404 is the bench failing like the rest, marked so an operation lookup can tell an operation the bench forgot.
  assert.ok(benchError(404, undefined) instanceof BenchNotFound);
  for (const status of [401, 500]) assert.ok(!(benchError(status, undefined) instanceof BenchNotFound));
});

test('over HTTP, a bench no-lease stays no-lease and a bench failure ends the lease as bench-failed', async () => {
  const token = 's'.repeat(32);
  let leaseId: string | null = null; let expiresAt = '';
  let mode: 'ok' | 'no-lease' | 'broken' = 'ok';
  const status = (): BenchStatus => ({ bench: 1, state: leaseId ? 'leased' : 'ready', lease: leaseId ? { leaseId, expiresAt } : null, scenario: { gateway: 'running', source: { status: 'healthy' }, relay: 'up', calibration: 'present', satellite: 'idle', receiptTimeoutMs: 5000 }, checks: { developmentPrincipals: 0, fixtureSources: 0, managementHost: '127.0.0.1' }, readiness: { control: true, source: true, cleanLease: !leaseId }, study: null });
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) as { leaseId?: string; expiresAt?: string } : {};
    const send = (code: number, value: unknown) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized.' });
    if (request.url === '/bench/v1/reset') { leaseId = null; return send(202, status()); }
    if (request.url === '/bench/v1/lease') { leaseId = body.leaseId!; expiresAt = body.expiresAt!; return send(200, status()); }
    if (request.url === '/bench/v1/tokens') return mode === 'no-lease' ? send(409, { error: 'no-lease', code: 'no-lease' }) : send(200, { token: 'lab1_x', expiresAt });
    if (request.url === '/bench/v1/actions') return mode === 'broken' ? send(500, { error: 'Bench failure.', code: 'bench-unavailable' }) : send(200, { at: new Date().toISOString(), scenario: status().scenario });
    send(200, status());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { pool } = configuredLab({ LAB_BENCH_API_URLS: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, LAB_BENCH_1_SERVICE_TOKEN: token }, 'https://demo.test');
    await pool.initialize(); await pool.run(() => pool.sweep());
    const visitor = { subject: 'visitor', role: 'volunteer' as const, exp: Date.now() + 1_800_000 };
    assert.equal((await pool.run(() => pool.join(visitor, '192.0.2.9'))).status, 'ready');
    assert.equal((await pool.token(visitor)).token, 'lab1_x');
    mode = 'no-lease';
    await assert.rejects(pool.token(visitor), code('no-lease'));
    mode = 'broken';
    await assert.rejects(pool.action(visitor, 'relay.cut'), (error: unknown) => error instanceof LabError && error.code === 'bench-unavailable' && error.status === 503);
    const ended = pool.view(visitor);
    assert.equal(ended.status === 'ended' && ended.reason, 'bench-failed');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('only a clean-lease-eligible bench is granted; a held source keeps its lease; the gate closes before every reset', async () => {
  const f = fixture(2); await f.pool.initialize(); await f.pool.sweep();
  // Bench 1 reports ready but its last cleanup didn't finish: never granted.
  f.slots.get(1)!.readiness = { control: true, source: true, cleanLease: false };
  f.advance(5000); await f.pool.sweep();
  const a = f.session('a'); const granted = await f.pool.join(a, 'a');
  assert.equal(granted.status === 'ready' && granted.bench, 2);
  const study = f.slots.get(2)!.study!.studyId;
  assert.deepEqual(f.gate.filter(line => line.startsWith('open')), [`open 2 ${study}`], 'the leased study is opened for publication');
  await f.pool.token(a);
  const b = f.session('b'); assert.equal((await f.pool.join(b, 'b')).status, 'queued', 'bench 1 stays out of the pool');
  // A held source: control available, source not ready, lease intact.
  Object.assign(f.slots.get(2)!, { readiness: { control: true, source: false, cleanLease: false }, scenario: { ...f.slots.get(2)!.scenario, source: { status: 'paused', reason: 'HANDLER_FAILED' } } });
  f.advance(5000); f.pool.heartbeat(a); f.pool.heartbeat(b); await f.pool.sweep();
  assert.equal(f.pool.view(a).status, 'active', 'a held source does not end the lease');
  const before = f.calls.length;
  await f.pool.leave(a);
  const after = f.calls.slice(before).map(call => call.path);
  assert.ok(after.indexOf('gate.close') >= 0 && after.indexOf('gate.close') < after.indexOf('/bench/v1/reset'), 'the gate closes before the reset is asked for');
  assert.ok(f.gate.includes(`close 2 ${study}`));
});

test('the gate closes the study the field station opened, never one taken from a polled status', async () => {
  const f = fixture(1); await f.pool.initialize(); await f.pool.sweep();
  const a = f.session('a'); await f.pool.join(a, 'a'); await f.pool.token(a);
  const opened = f.slots.get(1)!.study!.studyId;
  // The bench rebooted with an unreadable study.json: it now runs, and reports, a different study.
  Object.assign(f.slots.get(1)!, { state: 'ready', lease: null, study: { ...f.slots.get(1)!.study!, studyId: 'b1rebootedstudy0', phase: 'clean' } });
  f.advance(5000); f.pool.heartbeat(a); await f.pool.sweep();
  assert.equal((f.pool.view(a) as { reason: string }).reason, 'bench-failed');
  assert.deepEqual(f.gate.filter(line => line.startsWith('close')), [`close 1 ${opened}`], 'the opened study is closed, not the polled one');
});

test('a reset retried while the bench provisions never closes the study it is provisioning', async () => {
  const f = fixture(1); await f.pool.initialize();
  // The bench is slow: still resetting, provisioning a new study, when the pool gives up and retries.
  Object.assign(f.slots.get(1)!, { state: 'resetting', readiness: { control: false, source: false, cleanLease: false }, study: { ...f.slots.get(1)!.study!, studyId: 'b1provisioning00', phase: 'provisioning' } });
  for (let i = 0; i < 20; i++) { f.advance(5000); await f.pool.sweep(); f.slots.get(1)!.state = 'resetting'; }
  assert.deepEqual(f.gate.filter(line => line.startsWith('close')), [], 'nothing was opened, so nothing is closed');
  // The bench ignored the retried reset (it was already resetting) and finishes provisioning the same study.
  Object.assign(f.slots.get(1)!, { state: 'ready', readiness: { control: true, source: true, cleanLease: true }, study: { ...f.slots.get(1)!.study!, studyId: 'b1provisioning00', phase: 'clean' } });
  f.advance(30_000); await f.pool.sweep(); f.advance(5000); await f.pool.sweep();
  const a = f.session('a'); assert.equal((await f.pool.join(a, 'a')).status, 'ready');
  assert.deepEqual(f.gate, ['open 1 b1provisioning00'], 'the leased study is open for publication');
});

test('a study the gate refuses to open is never granted: the bench is reset and the visitor keeps their place', async () => {
  const f = fixture(1); await f.pool.initialize(); await f.pool.sweep();
  const refused = f.slots.get(1)!.study!.studyId;
  // The bench's own reset step 3 closed this study earlier; a closed study never reopens.
  await f.studies.close(1, refused);
  const before = f.calls.filter(call => call.path === '/bench/v1/reset').length;
  const a = f.session('a'); const view = await f.pool.join(a, 'a');
  assert.equal(view.status, 'queued', 'no lease on a study the gate refused');
  assert.equal(f.calls.filter(call => call.path === '/bench/v1/reset').length, before + 1, 'the bench is reset instead');
  f.advance(5000); f.pool.heartbeat(a); await f.pool.sweep();
  const granted = f.pool.view(a);
  assert.equal(granted.status, 'ready', 'granted on the next clean study');
  assert.ok(f.gate.includes(`open 1 ${f.slots.get(1)!.study!.studyId}`)); assert.notEqual(f.slots.get(1)!.study!.studyId, refused);
});

test('a leased bench that reports starting while its process restarts keeps the lease for at most 15 seconds', async () => {
  const f = fixture(1); await f.pool.initialize(); await f.pool.sweep();
  const a = f.session('a'); await f.pool.join(a, 'a'); await f.pool.token(a);
  const leased = { ...f.slots.get(1)! };
  Object.assign(f.slots.get(1)!, { state: 'starting', lease: null, study: null });
  f.advance(5000); f.pool.heartbeat(a); await f.pool.sweep();
  assert.equal(f.pool.view(a).status, 'active');
  Object.assign(f.slots.get(1)!, { state: leased.state, lease: leased.lease, study: leased.study });
  f.advance(5000); f.pool.heartbeat(a); await f.pool.sweep();
  assert.equal(f.pool.view(a).status, 'active', 'the restarted bench resumed the lease');
  Object.assign(f.slots.get(1)!, { state: 'starting', lease: null, study: null });
  for (let i = 0; i < 3; i++) { f.advance(5000); f.pool.heartbeat(a); await f.pool.sweep(); }
  assert.equal((f.pool.view(a) as { reason: string }).reason, 'bench-failed', 'a bench that never resumes ends the lease');
});

test('a place granted after a slow poll in line gets the whole 30-second claim window, not an idle end', async () => {
  const f = fixture(1); await f.pool.initialize(); await f.pool.sweep();
  const a = f.session('a'), b = f.session('b');
  await f.pool.join(a, 'a'); await f.pool.token(a);
  assert.equal((await f.pool.join(b, 'b')).status, 'queued');
  // b's tab is in the background: its last poll was 50 s ago, inside the queue's 90 s limit. a keeps polling.
  f.advance(50_000); f.pool.heartbeat(a);
  await f.pool.leave(a);
  assert.equal(f.pool.view(b).status, 'ready');
  f.advance(5000); await f.pool.sweep();
  assert.equal(f.pool.view(b).status, 'ready', 'the next sweep leaves the grant alone');
  // The tab comes back 25 s after the grant: its poll counts, and it can still claim.
  f.advance(20_000); f.pool.heartbeat(b); await f.pool.sweep();
  assert.equal(f.pool.view(b).status, 'ready');
  await f.pool.token(b); assert.equal(f.pool.view(b).status, 'active');
});

test('a grant made after a slow bench call in the same sweep starts when it is made, not at the sweep\'s start', async () => {
  const f = fixture(2); await f.pool.initialize(); await f.pool.sweep();
  const a = f.session('a'), b = f.session('b');
  await f.pool.join(a, 'a'); await f.pool.token(a);
  const joined = await f.pool.join(b, 'b'); assert.equal(joined.status === 'ready' && joined.bench, 2);
  await f.pool.leave(b);
  // Bench 1 stops answering; the next join's sweep waits out its timeout before granting bench 2.
  f.hanging.add(1); f.advance(5000); f.pool.heartbeat(a);
  const c = f.session('c'); const view = await f.pool.join(c, 'c');
  const now = Date.parse(f.pool.view(c).now);
  assert.ok(view.status === 'ready');
  assert.deepEqual([Date.parse(view.grantedAt), Date.parse(view.claimBy!), Date.parse(view.expiresAt)], [now, now + 30_000, now + 300_000]);
});

test('a bench whose reset takes longer than 60 seconds is granted once it is clean, not reset again', async () => {
  const f = fixture(1); const slot = f.slots.get(1)!;
  const resets = () => f.calls.filter(call => call.path === '/bench/v1/reset').length;
  // Each reset takes 70 s: a slow gate close, the quiesce, the group delete, and a gateway start.
  let seen = 0; let readyAt = 0;
  const bench = () => {
    if (resets() > seen) { seen = resets(); readyAt = Date.parse(f.pool.status().now) + 70_000; }
    const ready = Date.parse(f.pool.status().now) >= readyAt;
    Object.assign(slot, { state: ready ? 'ready' : 'resetting', readiness: { control: ready, source: ready, cleanLease: ready } });
  };
  await f.pool.initialize(); bench();
  const states: string[] = [];
  for (let i = 0; i < 40; i++) { f.advance(5000); await f.pool.sweep(); bench(); states.push(f.pool.status().benches[0]!.state); }
  assert.ok(states.includes('unavailable'), 'the slow reset is marked unavailable after 60 s');
  assert.equal(states.at(-1), 'ready');
  assert.equal(resets(), 1, 'the retry found the bench clean and did not reset it again');
  const a = f.session('a'); assert.equal((await f.pool.join(a, 'a')).status, 'ready');
});

test('requests that arrive while the pool starts grant nothing until every bench has been reset', async () => {
  const f = fixture(1);
  // The API listens before the pool initializes: a status poll sweeps, and a visitor joins.
  await f.pool.run(() => f.pool.sweep());
  const a = f.session('a');
  await assert.rejects(f.pool.run(() => f.pool.join(a, 'a')), code('lab-unavailable'));
  assert.deepEqual(f.calls.map(call => call.path), [], 'no bench is touched before the startup reset');
  await f.pool.initialize();
  assert.deepEqual(f.calls.map(call => call.path), ['/bench/v1/reset']);
  const view = await f.pool.run(() => f.pool.join(a, 'a'));
  assert.equal(view.status, 'ready', 'granted after the startup reset');
  await f.pool.token(a); f.advance(5000); f.pool.heartbeat(a); await f.pool.sweep();
  assert.equal(f.pool.view(a).status, 'active');
});

test('a bench with another failure handling is logged once and left unavailable, never reset for it', async t => {
  const f = fixture(1); const slot = f.slots.get(1)!;
  const resets = () => f.calls.filter(call => call.path === '/bench/v1/reset').length;
  const logged: string[] = []; t.mock.method(console, 'error', (line: string) => { logged.push(line); });
  // This field station runs profile off; the bench was started with retry.
  slot.failures = { profile: 'retry', durable: true, handlerBuildId: 'h' };
  await f.pool.initialize();
  for (let i = 0; i < 120; i++) { f.advance(5000); await f.pool.sweep(); }
  assert.equal(resets(), 1, 'only the startup reset: another one cannot change the profile');
  assert.equal(f.pool.status().benches[0]!.state, 'unavailable');
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /Lab bench 1 reports failure handling retry; this field station requires off\.$/);
  // Restarted with the deployment's profile, it is granted without another reset.
  delete slot.failures;
  for (let i = 0; i < 7; i++) { f.advance(5000); await f.pool.sweep(); }
  assert.equal(f.pool.status().benches[0]!.state, 'ready');
  assert.equal(resets(), 1);
  assert.equal((await f.pool.join(f.session('a'), 'a')).status, 'ready');
});

test('a role switch on the creek tablet (POST /api/badge) ends the Lab place held under the old session at once, and the new one sees why', async () => {
  const f = fixture(1); await f.pool.initialize(); await f.pool.run(() => f.pool.sweep());
  const server = publicApi({ config: readConfig({ SITE_ORIGIN: 'https://site.test' }), station: {} as FieldStation, notebooks: {} as Notebooks, lab: f.pool });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const headers = { origin: 'https://site.test', 'x-client-ip': '192.0.2.41' };
  try {
    const join = await fetch(`${origin}/api/lab/lease`, { method: 'POST', headers });
    const cookie = join.headers.get('set-cookie')!.split(';')[0]!; assert.equal((await join.json() as { status: string }).status, 'ready');
    const badge = await fetch(`${origin}/api/badge`, { method: 'POST', headers: { ...headers, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'researcher' }) });
    const switched = badge.headers.get('set-cookie')!.split(';')[0]!;
    const view = await (await fetch(`${origin}/api/lab/lease`, { headers: { ...headers, cookie: switched } })).json() as { status: string; reason?: string };
    assert.deepEqual([view.status, view.reason], ['ended', 'session-ended']);
    assert.equal(f.calls.filter(call => call.path === '/bench/v1/reset').length, 2, 'the bench was reset at once, not held until the idle limit');
    assert.equal(f.pool.placesFor('192.0.2.41'), 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
