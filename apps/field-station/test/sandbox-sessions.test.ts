/**
 * Sandbox session layer (sandbox contract §§4, 8; LC11-ADR-04), on a fake clock with
 * the design-fixture runtime. Evidence level: fixture (unit). LC11-A44 lifetime,
 * cleanup, queue, and cohost budget; LC11-A42 isolation and stale study references.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LeasePool, type BenchClient } from '../src/lab/leases.ts';
import type { BenchId, BenchStatus } from '../src/lab/contract.ts';
import { LabError } from '../src/lab/errors.ts';
import { AddressCap } from '../src/places.ts';
import type { SessionClaims } from '../src/sessions.ts';
import { SANDBOX_SWEEP_MS } from '../src/sandbox/leases.ts';
import { SandboxService } from '../src/sandbox/service.ts';
import { StreamOtterError } from 'streamotter/contracts';
import { code, harness, wb } from './support/sandbox-harness.ts';

test('A44: a slot is allocated only by an explicit join; status, view, heartbeat, and discovery allocate nothing', async () => {
  const h = await harness(); const s = h.session('visitor');
  assert.equal(h.pool.status().availability, 'available');
  assert.deepEqual(h.pool.status().slots.map(x => x.state), ['ready', 'ready', 'ready']);
  assert.equal(h.view(s).status, 'none'); h.pool.heartbeat(s); await h.advance(5000);
  assert.equal(h.pool.discovery().operations.length, 15, 'workbench plus the fourteen allowlisted operations');
  assert.equal(h.view(s).status, 'none'); assert.equal(h.pool.status().queueLength, 0);
  assert.ok(!h.requests.some(r => r.path.endsWith('/lease')), 'no lease was requested');
  const lease = await h.join(s);
  assert.equal(lease.status, 'ready'); assert.ok(lease.status === 'ready' && lease.runtime.mode === 'synthetic-fixture');
  assert.equal((await h.join(s)).status, 'ready', 'joining again is idempotent');
  assert.equal(h.requests.filter(r => r.path.endsWith('/lease')).length, 1);
});

test('A44: the line is first come, first served, and a freed slot goes to the head of the line after cleanup', async () => {
  const h = await harness(); const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(id => h.session(id)) as [SessionClaims, SessionClaims, SessionClaims, SessionClaims, SessionClaims];
  const joined = await Promise.all([a, b, c, d, e].map(s => h.join(s)));
  assert.deepEqual(joined.map(v => v.status), ['ready', 'ready', 'ready', 'queued', 'queued']);
  assert.deepEqual([h.view(d), h.view(e)].map(v => v.status === 'queued' && v.position), [1, 2]);
  const first = h.view(a); assert.ok(first.status === 'ready');
  await h.leave(a); assert.equal(h.reason(a), 'returned');
  await h.settle();
  const next = h.view(d); assert.ok(next.status === 'ready'); assert.equal(next.slot, first.slot, 'the freed slot goes to the head of the line');
  assert.notEqual(next.leaseId, first.leaseId); assert.notEqual(next.studyId, first.studyId);
  assert.equal(h.view(e).status === 'queued' && (h.view(e) as { position: number }).position, 1);
  const late = h.session('late'); await h.join(late); assert.equal((h.view(late) as { position: number }).position, 2, 'a later visitor joins behind');
  assert.ok(h.fixture.opened.filter(r => r.slot === first.slot).length >= 2 && h.fixture.opened.find(r => r.slot === first.slot)!.closed, 'the slot was cleaned and reopened between leases');
});

test('A44: one client address holds at most two places across the Lab and the sandbox combined', async () => {
  const cap = new AddressCap(); const h = await harness({ cap });
  const bench: BenchStatus = { bench: 1, state: 'ready', lease: null, scenario: { gateway: 'running', source: { status: 'healthy' }, relay: 'up', calibration: 'present', satellite: 'idle', receiptTimeoutMs: 5000 }, checks: { developmentPrincipals: 0, fixtureSources: 0, managementHost: '127.0.0.1' }, readiness: { control: true, source: true, cleanLease: true }, study: null };
  const client: BenchClient = { async call<T>(_b: BenchId, path: string, _m?: string, body?: unknown): Promise<T> { if (path === '/bench/v1/reset') { bench.state = 'ready'; bench.lease = null; bench.readiness.cleanLease = true; } if (path === '/bench/v1/lease') { bench.state = 'leased'; bench.lease = body as BenchStatus['lease']; bench.readiness.cleanLease = false; } return structuredClone(bench) as T; } };
  const lab = new LeasePool({ client, benches: [1], gatewayOrigin: 'https://demo.test', now: h.clock, cap }); await lab.initialize(); await lab.sweep();
  const [one, two, three] = [h.session('one'), h.session('two'), h.session('three')];
  await lab.join(one, '203.0.113.9');
  await h.join(two, '203.0.113.9');
  assert.equal(cap.held('203.0.113.9'), 2);
  await assert.rejects(h.join(three, '203.0.113.9'), code('too-many-places'));
  await assert.rejects(lab.join(three, '203.0.113.9'), (e: unknown) => e instanceof LabError && e.code === 'too-many-places');
  await h.join(three, '198.51.100.1'); assert.equal(h.view(three).status, 'ready', 'other addresses are unaffected');
  await h.leave(two); const four = h.session('four'); await h.join(four, '203.0.113.9');
  assert.notEqual(h.view(four).status, 'none', 'a place freed in either pool can be used in either pool');
});

test('A44: claim window, idle limit, lease expiry, and session end each end the lease and clean the slot', async () => {
  const h = await harness({ slots: 1 });
  const unclaimed = h.session('unclaimed'); await h.join(unclaimed);
  await h.advance(29_000); assert.equal(h.view(unclaimed).status, 'ready');
  await h.advance(1000); assert.equal(h.reason(unclaimed), 'unclaimed');

  const idle = h.session('idle'); await h.join(idle); await h.claim(idle);
  await h.advance(59_000); assert.equal(h.view(idle).status, 'active');
  await h.advance(1000); assert.equal(h.reason(idle), 'idle');

  const full = h.session('full'); await h.join(full); const connection = await h.claim(full);
  assert.equal(Date.parse(connection.expiresAt) - Date.parse((h.view(full) as { grantedAt: string }).grantedAt), 600_000);
  assert.equal(connection.gatewayPath, '/sandbox/1/socket.io'); assert.equal(connection.gatewayOrigin, 'https://demo.test');
  for (let t = 0; t < 590_000; t += 50_000) { h.pool.heartbeat(full); await h.advance(50_000); }
  h.pool.heartbeat(full); await h.advance(10_000); assert.equal(h.reason(full), 'expired');

  const short = h.session('short', 120_000); const lease = await h.join(short);
  assert.ok(lease.status === 'ready'); assert.equal(Date.parse(lease.expiresAt), short.exp, 'a lease never outlasts its session');
  await h.claim(short); h.pool.heartbeat(short); await h.advance(50_000); h.pool.heartbeat(short); await h.advance(50_000); h.pool.heartbeat(short); await h.advance(20_000);
  assert.equal(h.reason(short), 'session-ended');

  const holder = h.session('holder'); await h.join(holder); await h.claim(holder);
  const waiting = h.session('waiting'); await h.join(waiting); h.pool.heartbeat(holder); await h.advance(50_000); h.pool.heartbeat(holder); await h.advance(40_000);
  assert.equal(h.reason(waiting), 'idle', 'a place in line without a heartbeat for 90 s is dropped');
  assert.ok(h.fixture.opened.every((r, i, all) => i === all.length - 1 || r.closed), 'every ended study was cleaned');
  assert.ok(h.fixture.opened.slice(0, -1).every(r => r.revoked > 0), 'previews were revoked before cleanup');
});

test('A44: return frees the slot at once; the next lease gets a fresh runtime', async () => {
  const h = await harness({ slots: 1 }); const a = h.session('a'); const b = h.session('b');
  await h.join(a); await h.claim(a); await h.join(b);
  const before = h.fixture.current(1);
  const ended = await h.leave(a); assert.ok(ended.status === 'ended' && ended.reason === 'returned');
  await h.settle(); assert.ok(before.closed && before.revoked > 0);
  assert.equal(h.view(b).status, 'ready'); assert.notEqual(h.fixture.current(1), before);
  await assert.rejects(h.claim(a), code('no-lease'));
  assert.equal((await h.leave(b)).status, 'ended'); assert.equal((await h.leave(b)).status, 'ended', 'return is idempotent');
});

test('A44: without visitor traffic, maintenance polls every 1 s while a slot resets, so a returned slot reaches the next in line within a second', async () => {
  const h = await harness({ slots: 1 }); const a = h.session('a'); const b = h.session('b');
  await h.join(a); await h.claim(a); await h.join(b);
  await h.leave(a); assert.equal(h.view(b).status, 'queued', 'the slot is still being cleaned');
  await h.sweepAfter(SANDBOX_SWEEP_MS); assert.equal(h.view(b).status, 'ready', 'one maintenance sweep later');
  const main = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
  assert.match(main, /sandbox\.sweep\(\)\)[^\n]*\}, SANDBOX_SWEEP_MS\);/, 'main.ts sweeps the sandbox pool every SANDBOX_SWEEP_MS');
  assert.equal(SANDBOX_SWEEP_MS, 1000);
});

test('A44: a slot whose cleanup fails stays unavailable and is never handed out until a cleanup succeeds', async () => {
  const h = await harness({ slots: 1 }); const a = h.session('a'); await h.join(a); await h.claim(a);
  const dirty = h.fixture.current(1); h.fixture.failClose = 2;
  await h.leave(a); await h.settle();
  assert.deepEqual(h.pool.status().slots, [{ slot: 1, state: 'unavailable' }]);
  assert.equal(h.pool.status().reason, 'all-slots-unavailable');
  await assert.rejects(h.join(h.session('b')), code('sandbox-unavailable'));
  await h.advance(30_000); await h.settle(); assert.equal(h.pool.status().slots[0]!.state, 'unavailable', 'the first retry also fails');
  assert.equal(dirty.closed, false);
  await h.advance(30_000); await h.settle();
  assert.equal(dirty.closed, true, 'the same runtime was cleaned before reuse');
  assert.equal(h.pool.status().slots[0]!.state, 'ready');
  const c = h.session('c'); assert.equal((await h.join(c)).status, 'ready');
  assert.notEqual(h.fixture.current(1), dirty);
});

test('A44: an unreachable service ends leases as slot-failed; a restarted service as sandbox-restarted', async () => {
  const h = await harness({ slots: 1 }); const a = h.session('a'); await h.join(a); await h.claim(a);
  h.setDown(true); await h.advance(5000); assert.equal(h.view(a).status, 'active', 'a brief outage is tolerated');
  await h.advance(10_000); assert.equal(h.reason(a), 'slot-failed'); assert.equal(h.pool.status().reason, 'service-unavailable');
  await assert.rejects(h.join(h.session('x')), code('sandbox-unavailable'));
  h.setDown(false); await h.advance(5000); await h.advance(30_000); await h.settle();
  const b = h.session('b'); assert.equal((await h.join(b)).status, 'ready'); await h.claim(b);
  await h.restartService(); await h.advance(5000);
  assert.equal(h.reason(b), 'sandbox-restarted');
});

test('A44: on startup nothing is granted until the field station has returned every slot', async () => {
  // A request in the window between the API listening and initialize() (main.ts) runs a sweep.
  const h = await harness({ slots: 1, initialize: false }); const s = h.session('early');
  await h.settle();
  assert.equal(h.pool.status().availability, 'unavailable');
  await assert.rejects(h.join(s), code('sandbox-unavailable'));
  assert.ok(!h.requests.some(r => r.path.endsWith('/lease')), 'no lease was requested');
  await h.pool.initialize(); await h.settle();
  assert.equal((await h.join(s)).status, 'ready'); await h.claim(s);
  await h.advance(5000); assert.equal(h.view(s).status, 'active', 'a lease granted after initialize is kept');
});

test('A44: operations are limited to two a second per session, and only while active', async () => {
  const h = await harness(); const s = h.session('s'); await h.join(s);
  await assert.rejects(h.op(s, 'health'), code('no-lease'), 'a ready (unclaimed) lease cannot operate');
  await h.claim(s);
  await h.op(s, 'health'); await h.op(s, 'health');
  await assert.rejects(h.op(s, 'health'), code('too-many-requests'));
  await h.advance(1000); await h.op(s, 'health');
});

test('A42: reset rotates the study and invalidates previews, trace cursors, and late answers from the old study', async () => {
  const h = await harness({ slots: 1 }); const s = h.session('s'); await h.join(s); await h.claim(s);
  const first = h.view(s); assert.ok(first.status === 'active');
  const old = h.fixture.current(1);
  const preview = await h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'visitor' }) as { previewSessionId: string; token: string };
  await h.opSlow(s, 'dev.fixtures.advance', { sourceId: 'creek', count: 3 });
  const page = await h.opSlow(s, 'traces', { limit: 2 }) as { items: unknown[]; nextCursor: string };
  assert.equal(page.items.length, 2); assert.ok(page.nextCursor);
  assert.ok(!old.calls.some(c => c.op === 'traces' && (c.input as { cursor?: string }).cursor === page.nextCursor), 'the browser never sees native cursors');

  let open!: () => void; h.fixture.gate = new Promise(r => { open = r; });
  const resetting = await h.reset(s);
  assert.ok(resetting.status === 'resetting'); assert.equal(resetting.leaseId, first.leaseId); assert.equal(resetting.slot, first.slot); assert.notEqual(resetting.studyId, first.studyId);
  await assert.rejects(h.opSlow(s, 'health'), code('no-lease'), 'no operation runs while the study resets');
  assert.equal(h.view(s).status, 'resetting');
  h.fixture.gate = null; open(); await h.settle();
  const after = h.view(s); assert.ok(after.status === 'active'); assert.equal(after.studyId, resetting.studyId);
  assert.ok(old.revoked > 0 && old.closed, 'the old study was revoked and cleaned'); assert.equal(old.previews.size, 0);
  const fresh = h.fixture.current(1); assert.notEqual(fresh, old);
  await assert.rejects(h.opSlow(s, 'dev.disconnect', { previewSessionId: preview.previewSessionId }), wb('INVALID_REQUEST', 'invalid-request'));
  await assert.rejects(h.opSlow(s, 'traces', { cursor: page.nextCursor }), wb('TRACE_CURSOR_EXPIRED', 'stale-study'));
  assert.deepEqual((await h.opSlow(s, 'traces', {}) as { items: unknown[] }).items, [], 'the new study starts with no traces');

  // A late answer: the slot answers after the session has reset again.
  fresh.holdNext = true;
  const late = h.opSlow(s, 'dev.fixtures.advance', { sourceId: 'creek', count: 5 });
  while (!fresh.hold) await new Promise(r => setImmediate(r));
  await h.reset(s); fresh.hold.release();
  await assert.rejects(late, code('stale-study'));
  await h.settle();
  const newest = h.fixture.current(1); assert.notEqual(newest, fresh); assert.equal(newest.traces.length, 0, 'the late call had no effect on the new study');
  assert.equal(h.view(s).status, 'active');

  // A late failure: closing the old study's runtime fails its pending call, as a real gateway does. It is the old study's failure, not the slot's.
  h.fixture.failPending = new Error('Runtime closed.');
  newest.holdNext = true;
  const failed = h.opSlow(s, 'traces', {});
  while (!newest.hold) await new Promise(r => setImmediate(r));
  await h.reset(s);
  await assert.rejects(failed, code('stale-study'));
  assert.ok(newest.closed); await h.settle();
  const kept = h.view(s); assert.ok(kept.status === 'active', 'the reset kept the lease'); assert.equal(kept.leaseId, first.leaseId); assert.equal(kept.slot, first.slot);
});

test('A42: a call from the old study that fails during a reset ends nothing: stale-study, and the same slot and lease', async () => {
  // The transport to the slot fails after the reset (a timeout, a dropped connection), so only the field station sees it.
  let gate: Promise<void> | null = null; let entered = false;
  const h = await harness({ slots: 1, client: inner => ({ async request(path, method, body) { if (gate && path.endsWith('/ops')) { entered = true; await gate; throw new Error('socket hang up'); } return inner.request(path, method, body); } }) });
  const s = h.session('s'); const next = h.session('next'); await h.join(s); await h.claim(s); await h.join(next);
  const first = h.view(s); assert.ok(first.status === 'active');
  let open!: () => void; gate = new Promise(r => { open = r; });
  const dropped = h.opSlow(s, 'health');
  while (!entered) await new Promise(r => setImmediate(r));
  gate = null; await h.reset(s); open();
  await assert.rejects(dropped, code('stale-study'));
  await h.settle(); assert.equal(h.view(s).status, 'active'); assert.equal(h.view(next).status, 'queued', 'the slot was not given away');

  // The native management service fails a pending call with INTERNAL as its runtime closes.
  const runtime = h.fixture.current(1); h.fixture.failPending = new StreamOtterError('INTERNAL', { message: 'Gateway stopped.' });
  runtime.holdNext = true;
  const internal = h.opSlow(s, 'source-checks', { sourceId: 'creek' });
  while (!runtime.hold) await new Promise(r => setImmediate(r));
  await h.reset(s);
  await assert.rejects(internal, code('stale-study'));
  await h.settle();
  const kept = h.view(s); assert.ok(kept.status === 'active'); assert.equal(kept.leaseId, first.leaseId); assert.equal(kept.slot, first.slot);
  assert.equal(h.view(next).status, 'queued');
});

test('A42: two concurrent sessions never share a slot, candidate, traces, previews, or downloads', async () => {
  const h = await harness(); const a = h.session('a'); const b = h.session('b');
  await h.join(a); await h.join(b); await h.claim(a); await h.claim(b);
  const va = h.view(a); const vb = h.view(b); assert.ok(va.status === 'active' && vb.status === 'active'); assert.notEqual(va.slot, vb.slot);
  await h.opSlow(a, 'dev.fixtures.advance', { sourceId: 'jobs', count: 4 });
  const pa = await h.opSlow(a, 'preview-sessions', { fixturePrincipalRef: 'visitor' }) as { previewSessionId: string; token: string };
  assert.equal((await h.opSlow(b, 'traces', {}) as { items: unknown[] }).items.length, 0, 'B sees none of A\'s traces');
  assert.equal((await h.opSlow(a, 'traces', {}) as { items: unknown[] }).items.length, 4);
  await assert.rejects(h.opSlow(b, 'dev.disconnect', { previewSessionId: pa.previewSessionId }), wb('INVALID_REQUEST'), 'B cannot disconnect A\'s preview');
  const config = (await h.opSlow(b, 'config') as { config: { projectId: string } }).config;
  assert.equal(config.projectId, `lontra-creek-sandbox-${vb.slot}`);
  const reproB = await h.pool.repro(b); assert.ok(!reproB.content.includes(pa.token) && !reproB.content.includes(va.leaseId) && !reproB.content.includes(va.studyId));
  await h.reset(a); await h.settle();
  assert.equal(h.view(b).status, 'active'); assert.equal((h.view(b) as { studyId: string }).studyId, vb.studyId, 'A\'s reset leaves B\'s study alone');
});

test('A42: the service refuses another lease, an old study, or an unclaimed lease even if the field station were wrong', async () => {
  const h = await harness({ slots: 1 }); const s = h.session('s'); await h.join(s);
  const v = h.view(s); assert.ok(v.status === 'ready');
  const service: SandboxService = h.service;
  const call = (body: Record<string, unknown>) => service.dispatch('POST', '/sandbox/v1/slots/1/ops', { op: 'health', input: null, ...body });
  assert.equal((await call({ leaseId: v.leaseId, studyId: v.studyId })).status, 401, 'unclaimed');
  await h.claim(s);
  assert.equal((await call({ leaseId: v.leaseId, studyId: v.studyId })).status, 200);
  const wrongLease = await call({ leaseId: 'someone-else', studyId: v.studyId }); assert.equal((wrongLease.body as { error: { details: { code: string } } }).error.details.code, 'no-lease');
  const oldStudy = await call({ leaseId: v.leaseId, studyId: 'previous-study' }); assert.equal((oldStudy.body as { error: { details: { code: string } } }).error.details.code, 'stale-study');
  assert.equal((await service.dispatch('PUT', '/sandbox/v1/slots/1/lease', { leaseId: 'x', studyId: 'y', expiresAt: new Date(h.clock() + 1000).toISOString() })).status, 503, 'a leased slot cannot be leased again');
  // A call the old study's closing runtime fails is answered as stale-study, not as a failed slot.
  const runtime = h.fixture.current(1); h.fixture.failPending = new Error('Runtime closed.'); runtime.holdNext = true;
  const late = call({ leaseId: v.leaseId, studyId: v.studyId });
  while (!runtime.hold) await new Promise(r => setImmediate(r));
  service.reset(1, { leaseId: v.leaseId, studyId: 'next-study' });
  const answer = await late; assert.equal(answer.status, 401); assert.equal((answer.body as { error: { details: { code: string } } }).error.details.code, 'stale-study');
});
