/**
 * The bench runtime against stand-ins for its gateway, loopback management API, and
 * relay control: background polling (review findings L1 and L5) and the bench API's
 * error answers (L3).
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Gateway } from 'streamotter/contracts';
import type { BenchStatus } from '../src/lab/contract.ts';
import { BenchRuntime, POLL_GRACE_MS } from '../src/lab/runtime.ts';

const SERVICE = 's'.repeat(32);
/** What the stand-ins answer; each test sets what it needs. */
const world = { sources: 'healthy' as 'healthy' | 'paused' | 'fail', relayFails: false, sourcePolls: 0, resume: 'ok' as 'ok' | 'conflict' };

function listen(server: Server): Promise<string> { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))); }
const close = (server: Server) => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); };
const json = (response: import('node:http').ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };

const management = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://management.invalid').pathname;
  if (path === '/management/v1/dev/principals') return json(response, 200, { ok: true, data: { items: [] } });
  if (path === '/management/v1/traces') return json(response, 200, { ok: true, data: { items: [], nextCursor: null } });
  if (path === '/management/v1/sources') {
    world.sourcePolls++;
    if (world.sources === 'fail') return json(response, 503, { ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    return json(response, 200, { ok: true, data: { items: [{ sourceId: 'field', status: world.sources, ...(world.sources === 'paused' ? { reason: 'HANDLER_FAILED' } : {}) }] } });
  }
  json(response, 404, { ok: false });
});
const relay = createServer((_request, response) => json(response, world.relayFails ? 502 : 200, {}));
const gateway = {
  async start() {}, async stop() {}, async revoke() {},
  async resumeSource() { if (world.resume === 'conflict') throw Object.assign(new Error('Source "field" is degraded; only paused sources can be resumed.'), { code: 'SOURCE_UNAVAILABLE', details: { status: 409 } }); return { sourceId: 'field', status: 'healthy' }; }
} as unknown as Gateway;

let managementOrigin = '';
let relayOrigin = '';
before(async () => { managementOrigin = await listen(management); relayOrigin = await listen(relay); });
after(async () => { await close(management); await close(relay); });
beforeEach(() => { Object.assign(world, { sources: 'healthy', relayFails: false, sourcePolls: 0, resume: 'ok' }); });

async function bench(t: import('node:test').TestContext) {
  let now = Date.parse('2026-10-03T00:00:00Z');
  const runtime = new BenchRuntime({ LAB_BENCH: '1', LAB_BENCH_1_SERVICE_TOKEN: SERVICE, LAB_BENCH_1_RELAY_TOKEN: 'r'.repeat(32), LAB_RELAY_ORIGIN: relayOrigin }, {
    now: () => now, tickMs: 3_600_000,
    services: async () => ({ gateway, management: { origin: managementOrigin, async close() {} } })
  });
  await runtime.start();
  t.after(() => runtime.close());
  return { runtime, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe('a bench polling its gateway', () => {
  test('one failed poll leaves the bench working; only POLL_GRACE_MS of failures fails it', async t => {
    const { runtime, advance } = await bench(t);
    world.sources = 'fail';
    await runtime.tick();
    assert.equal(runtime.status().state, 'ready', 'a single failed poll must not fail the bench');
    advance(POLL_GRACE_MS - 1); await runtime.tick();
    assert.equal(runtime.status().state, 'ready');
    world.sources = 'healthy'; advance(1000); await runtime.tick();
    world.sources = 'fail'; advance(1000); await runtime.tick(); advance(POLL_GRACE_MS - 1); await runtime.tick();
    assert.equal(runtime.status().state, 'ready', 'a successful poll restarts the grace period');
    advance(1); await runtime.tick();
    assert.equal(runtime.status().state, 'failed');
  });

  test('a long operation holding the queue leaves at most one poll waiting behind it', async t => {
    const { runtime } = await bench(t);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = runtime.run(() => gate);
    const before = world.sourcePolls;
    const ticks = Array.from({ length: 30 }, () => runtime.tick());
    release(); await held; await Promise.all(ticks);
    assert.equal(world.sourcePolls - before, 1);
    await runtime.tick();
    assert.equal(world.sourcePolls - before, 2, 'polling resumes once the queue is free');
  });
});

describe("a bench's API answers", () => {
  async function api(t: import('node:test').TestContext) {
    const b = await bench(t);
    const server = b.runtime.api(); const origin = await listen(server); t.after(() => close(server));
    const call = async (method: string, path: string, body?: unknown, raw?: string) => {
      const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${SERVICE}`, 'content-type': 'application/json' }, ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const lease = (leaseId = 'lease-1') => call('PUT', '/bench/v1/lease', { leaseId, expiresAt: new Date(b.at() + 60_000).toISOString() });
    return { ...b, call, lease };
  }

  test('a bench-side failure is 500 bench-unavailable, not the caller\'s invalid request', async t => {
    const { call, lease } = await api(t);
    world.sources = 'fail';
    const refused = await lease();
    assert.equal(refused.status, 500, 'the management API failing during a lease is the bench\'s failure');
    assert.equal(refused.body['code'], 'bench-unavailable');
    world.sources = 'healthy';
    assert.equal((await lease()).status, 200);
    world.relayFails = true;
    const cut = await call('POST', '/bench/v1/actions', { leaseId: 'lease-1', action: 'relay.cut' });
    assert.deepEqual([cut.status, cut.body['code']], [500, 'bench-unavailable']);
    const malformed = await call('POST', '/bench/v1/actions', undefined, '{not json');
    assert.deepEqual([malformed.status, malformed.body['code']], [400, 'invalid-request']);
    const other = await call('POST', '/bench/v1/tokens', { leaseId: 'someone-else' });
    assert.deepEqual([other.status, other.body['code']], [409, 'no-lease']);
  });

  test('a failed action does not spend the one-a-second budget', async t => {
    const { call, lease } = await api(t);
    await lease();
    world.relayFails = true;
    assert.equal((await call('POST', '/bench/v1/actions', { leaseId: 'lease-1', action: 'relay.cut' })).status, 500);
    world.relayFails = false;
    const cut = await call('POST', '/bench/v1/actions', { leaseId: 'lease-1', action: 'relay.cut' });
    assert.equal(cut.status, 200, 'the retry is accepted at once');
    assert.equal((cut.body['scenario'] as BenchStatus['scenario']).relay, 'cut');
    const again = await call('POST', '/bench/v1/actions', { leaseId: 'lease-1', action: 'relay.restore' });
    assert.deepEqual([again.status, again.body['code']], [429, 'too-many-actions'], 'a successful action still spends it');
  });

  test('resuming a source that left paused since the last poll is not-applicable', async t => {
    const { runtime, call, lease, advance } = await api(t);
    await lease();
    world.sources = 'paused'; await runtime.tick();
    assert.equal(runtime.status().scenario.source.status, 'paused');
    world.resume = 'conflict';
    const resumed = await call('POST', '/bench/v1/actions', { leaseId: 'lease-1', action: 'source.resume' });
    assert.deepEqual([resumed.status, resumed.body['code']], [409, 'not-applicable']);
    assert.equal(runtime.status().state, 'leased');
    world.resume = 'ok'; advance(1000);
    assert.equal((await call('POST', '/bench/v1/actions', { leaseId: 'lease-1', action: 'source.resume' })).status, 200);
  });
});
