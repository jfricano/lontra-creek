/**
 * The public /api/sandbox/* routes (sandbox contract §§2, 4, 6) through publicApi,
 * the sandbox service's private API, and the production backend. Evidence level:
 * fixture (HTTP on loopback). LC11-A42–A45 server side.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfig } from '../src/server/config.ts';
import { publicApi } from '../src/server/http.ts';
import type { FieldStation } from '../src/server/station.ts';
import type { Notebooks } from '../src/server/notebooks.ts';
import { publishedBackend } from '../src/sandbox/seam.ts';
import { SandboxService, sandboxEnvironment } from '../src/sandbox/service.ts';
import { configuredSandbox, SANDBOX_CALL_TIMEOUT_MS, SANDBOX_DEFAULTS, SANDBOX_OPS_TIMEOUT_MS } from '../src/sandbox/leases.ts';
import { CALL_TIMEOUT_MS } from '../src/sandbox/seam.ts';
import { harness, SERVICE_TOKEN } from './support/sandbox-harness.ts';

const SITE = 'https://site.test';
async function serving(server: Server, run: (origin: string) => Promise<void>) { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } }
const api = (sandbox?: Awaited<ReturnType<typeof harness>>['pool']) => publicApi({ config: readConfig({ SITE_ORIGIN: SITE }), station: {} as FieldStation, notebooks: {} as Notebooks, ...(sandbox ? { sandbox } : {}) });
const WB = { 'x-streamotter-workbench': '1', origin: SITE };
/** An install from before WHC-1: the rc.3 workbench shipped no host manifest contract. */
const PRE_WHC1 = { package: '@streamotter/workbench', version: '0.1.0-rc.3' };
// Spread requests over client addresses so this test exercises the routes, not the shared request budget.
let client = 0;
const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { 'x-client-ip': `198.51.100.${++client % 250}`, ...(init.headers as Record<string, string> ?? {}) } });

test('A44/A46: unconfigured sandbox is honestly unavailable and never starts a session', async () => {
  await serving(api(), async origin => {
    const status = await (await fetch(`${origin}/api/sandbox/status`)).json() as { availability: string; reason: string; slots: unknown[] };
    assert.deepEqual([status.availability, status.reason, status.slots.length], ['unavailable', 'disabled', 0]);
    const join = await fetch(`${origin}/api/sandbox/session`, { method: 'POST', headers: { origin: SITE } });
    assert.equal(join.status, 503); assert.equal((await join.json() as { code: string }).code, 'sandbox-unavailable'); assert.equal(join.headers.get('set-cookie'), null);
    const anonymous = await fetch(`${origin}/api/sandbox/wb/v1/workbench`, { headers: WB });
    assert.equal(anonymous.status, 401, 'discovery is behind the session check, as in createManagementHandler');
    const preflight = await fetch(`${origin}/api/sandbox/wb/v1/health`, { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-headers': 'x-streamotter-workbench' } });
    assert.equal(preflight.status, 204); assert.match(preflight.headers.get('access-control-allow-headers')!, /x-streamotter-workbench/);
  });
});

test('A42/A43: lifecycle and WHC-1 routes enforce Origin, the workbench header, session, bodies, and the allowlist', async () => {
  const h = await harness();
  await serving(api(h.pool), async origin => {
    assert.equal((await fetch(`${origin}/api/sandbox/session`, { method: 'POST', headers: { origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/sandbox/session`)).status, 401);
    assert.equal((await fetch(`${origin}/api/sandbox/session/claim`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${origin}/api/sandbox/nope`)).status, 404);
    const join = await fetch(`${origin}/api/sandbox/session`, { method: 'POST', headers: { origin: SITE } });
    assert.equal(join.status, 200); assert.equal(join.headers.get('access-control-allow-origin'), SITE);
    const cookie = join.headers.get('set-cookie')!.split(';')[0]!; assert.match(join.headers.get('set-cookie')!, /HttpOnly/);
    const lease = await join.json() as { status: string; slot: number }; assert.equal(lease.status, 'ready');
    const joinFrom = (ip: string) => fetch(`${origin}/api/sandbox/session`, { method: 'POST', headers: { origin: SITE, 'x-client-ip': ip } });
    for (let i = 0; i < 2; i++) assert.ok((await joinFrom('192.0.2.9')).headers.get('set-cookie'));
    const capped = await joinFrom('192.0.2.9'); assert.equal(capped.status, 429); assert.equal(capped.headers.get('set-cookie'), null, 'a refused join starts no session');
    assert.equal(capped.headers.get('retry-after'), '1'); assert.equal(capped.headers.get('access-control-expose-headers'), 'retry-after', 'the cross-origin page can read Retry-After');
    assert.equal((await fetch(`${origin}/api/sandbox/session`, { method: 'POST', headers: { origin: SITE, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ slot: 3 }) })).status, 400, 'a request cannot name a slot');
    assert.equal((await fetch(`${origin}/api/sandbox/session?slot=3`, { headers: { cookie } })).status, 400);
    const call = (path: string, init: RequestInit = {}) => fetch(`${origin}/api/sandbox/wb/v1${path}`, { ...init, headers: { ...WB, cookie, ...(init.headers as Record<string, string> ?? {}) } });
    const unclaimed = await call('/health'); assert.equal(unclaimed.status, 401); assert.equal((await unclaimed.json() as { error: { details: { code: string } } }).error.details.code, 'no-lease');
    const claim = await fetch(`${origin}/api/sandbox/session/claim`, { method: 'POST', headers: { origin: SITE, cookie } });
    const connection = await claim.json() as { gatewayPath: string }; assert.equal(connection.gatewayPath, `/sandbox/${lease.slot}/socket.io`);

    const health = await call('/health'); const body = await health.json() as { ok: boolean; requestId: string; data: { ready: boolean } };
    assert.equal(health.status, 200); assert.equal(body.ok, true); assert.equal(body.data.ready, true); assert.equal(health.headers.get('x-request-id'), body.requestId);
    assert.deepEqual(health.headers.get('access-control-expose-headers')?.split(/,\s*/).sort(), ['retry-after', 'x-request-id'], 'the cross-origin workbench can read X-Request-Id and Retry-After');
    const discovery = await (await call('/workbench')).json() as { ok: boolean; data: { hostContract: number; operations: string[]; limits: { maxRequestBytes: number } } };
    assert.deepEqual([discovery.ok, discovery.data.hostContract, discovery.data.operations.length, discovery.data.limits.maxRequestBytes], [true, 1, 15, 65_536]);
    assert.ok(discovery.data.operations.includes('workbench') && !discovery.data.operations.some(op => op.startsWith('failures')));
    const noHeader = await fetch(`${origin}/api/sandbox/wb/v1/source-checks`, { method: 'POST', headers: { cookie, origin: SITE, 'content-type': 'application/json' }, body: '{"sourceId":"creek"}' });
    assert.equal(noHeader.status, 403, 'a POST without X-StreamOtter-Workbench is refused'); assert.equal((await noHeader.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
    await h.advance(1000);
    const bearer = await call('/health', { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    assert.equal(bearer.status, 200, 'an Authorization header is ignored, never forwarded or honored');
    assert.equal((await call('/nope')).status, 404); assert.equal((await fetch(`${origin}/api/sandbox/wb/v1/nope`, { headers: WB })).status, 401, 'the session check runs before the route lookup');
    assert.equal((await call('/health', { headers: { origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/sandbox/wb/v1/health`, { headers: { 'x-streamotter-workbench': '1' } })).status, 401, 'no session');
    assert.equal((await call('/failures?x=1')).status, 403, 'the allowlist is checked before the query');
    assert.equal((await call('/source-checks?x=1', { method: 'POST', headers: { 'x-streamotter-workbench': '0', 'content-type': 'application/json' }, body: '{}' })).status, 400, 'the query is checked before the POST header');
    const forbidden = await call('/failures'); assert.equal(forbidden.status, 403); assert.equal((await forbidden.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
    for (const path of ['/operator/status', '/failures/f-1']) assert.equal((await call(path)).status, 403);
    assert.equal((await call('/sources/retry-current', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await call('/sources/retire-boundary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
    assert.equal((await call('/health?verbose=1')).status, 400);
    const big = JSON.stringify({ config: { pad: 'x'.repeat(66_000) } });
    assert.equal((await call('/config/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status, 413, '64 KB for config operations');
    assert.equal((await call('/source-checks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'x'.repeat(5000) }) })).status, 413, '4 KB otherwise');
    assert.equal((await call('/source-checks', { method: 'POST', body: '{"sourceId":"creek"}' })).status, 400, 'JSON content type required');
    await h.advance(1000);
    const repro = await fetch(`${origin}/api/sandbox/session/repro`, { method: 'POST', headers: { origin: SITE, cookie } }); assert.equal(repro.status, 200);
    const reset = await fetch(`${origin}/api/sandbox/session/reset`, { method: 'POST', headers: { origin: SITE, cookie } });
    assert.equal(reset.status, 202); assert.equal((await reset.json() as { status: string }).status, 'resetting');
    const returned = await fetch(`${origin}/api/sandbox/session/return`, { method: 'POST', headers: { cookie } });
    assert.equal((await returned.json() as { status: string; reason: string }).reason, 'returned');
    const after = await call('/health'); assert.equal(after.status, 401); assert.equal((await after.json() as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
  });
});

test('A44/A46: on a pre-WHC-1 install the production backend reports seam-unavailable and allocates nothing', async () => {
  const h = await harness({ backend: () => publishedBackend({ siteOrigins: [SITE], manifest: PRE_WHC1 }) });
  const status = h.pool.status(); assert.equal(status.availability, 'unavailable'); assert.equal(status.reason, 'seam-unavailable'); assert.equal(status.runtime, null);
  assert.deepEqual(h.pool.discovery().operations, ['workbench'], 'nothing but discovery while the seam is unavailable');
  await serving(api(h.pool), async origin => {
    const join = await fetch(`${origin}/api/sandbox/session`, { method: 'POST', headers: { origin: SITE } });
    assert.equal(join.status, 503); assert.equal((await join.json() as { code: string }).code, 'sandbox-unavailable'); assert.equal(join.headers.get('set-cookie'), null, 'no session is started');
    const body = await fetch(`${origin}/api/sandbox/session`, { method: 'POST', headers: { origin: SITE }, body: 'x' });
    assert.equal(body.status, 400); assert.equal(body.headers.get('set-cookie'), null);
  });
});

test('A43: the sandbox service API needs its bearer token, and production cannot select a test runtime', async () => {
  const service = new SandboxService({ backend: publishedBackend({ siteOrigins: [SITE], manifest: PRE_WHC1 }), slots: [1], serviceToken: SERVICE_TOKEN }); await service.start();
  await serving(service.api(), async origin => {
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    assert.equal((await fetch(`${origin}/sandbox/v1/status`)).status, 401);
    assert.equal((await fetch(`${origin}/sandbox/v1/status`, { headers: { authorization: `Bearer ${'x'.repeat(40)}` } })).status, 401);
    const status = await (await fetch(`${origin}/sandbox/v1/status`, { headers: { authorization: `Bearer ${SERVICE_TOKEN}` } })).json() as { reason: string };
    assert.equal(status.reason, 'seam-unavailable');
  });
  const env = { SANDBOX_SERVICE_TOKEN: SERVICE_TOKEN, SANDBOX_RUNTIME: 'fixture' };
  assert.deepEqual(sandboxEnvironment(env).slots, [1, 2, 3]);
  for (const key of ['FIELD_STATION_SECRET', 'KAFKA_GATEWAY_PASSWORD', 'KAFKA_LAB_USERNAME', 'LAB_BENCH_1_SERVICE_TOKEN', 'LAB_PROXY_TOKEN']) assert.throws(() => sandboxEnvironment({ ...env, [key]: 'secret' }), /forbidden/);
  // A shared env file: every secret deploy/make-secrets.sh writes is refused; the service's own and other non-secret settings are not.
  const generated = [...readFileSync(new URL('../../../deploy/make-secrets.sh', import.meta.url), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=\$\(secret\)$/gm)].map(m => m[1]!);
  assert.ok(generated.includes('LAB_RELAY_TOKEN') && generated.includes('SANDBOX_SERVICE_TOKEN') && generated.length >= 15, 'the secrets the script writes');
  for (const key of generated.filter(k => k !== 'SANDBOX_SERVICE_TOKEN')) assert.throws(() => sandboxEnvironment({ ...env, [key]: 'secret' }), /forbidden/, key);
  assert.deepEqual(sandboxEnvironment({ ...env, SANDBOX_SLOTS: '2', SANDBOX_API_PORT: '7620', LAB_BENCH_API_URLS: 'http://lab-1:7420', LAB_LEASE_SECONDS: '600', NODE_ENV: 'production', SITE_ORIGIN: 'https://streamotter.dev' }).slots, [1, 2]);
  assert.throws(() => sandboxEnvironment({ SANDBOX_SERVICE_TOKEN: 'short' }), /32/);
  const settings = sandboxEnvironment(env);
  assert.deepEqual([settings.siteOrigins, settings.gatewayHost, settings.portBase, settings.port], [['https://localhost:8443'], '0.0.0.0', 7600, 7620], 'slot N listens on 7600 + N, clear of the API on 7620');
  assert.deepEqual(sandboxEnvironment({ ...env, SITE_ORIGIN: 'https://streamotter.dev, https://localhost:8443' }).siteOrigins, ['https://streamotter.dev', 'https://localhost:8443']);
  assert.throws(() => sandboxEnvironment({ ...env, NODE_ENV: 'production' }), /SITE_ORIGIN is required/);
  for (const origin of ['https://streamotter.dev/', 'streamotter.dev', 'https://streamotter.dev/workbench']) assert.throws(() => sandboxEnvironment({ ...env, SITE_ORIGIN: origin }), /exact origins/, origin);
  assert.throws(() => sandboxEnvironment({ ...env, SANDBOX_GATEWAY_PORT_BASE: '7618' }), /API port 7620/, 'slot 2 would take the API port');
  assert.equal(sandboxEnvironment({ ...env, SANDBOX_GATEWAY_PORT_BASE: '7618', SANDBOX_SLOTS: '1' }).portBase, 7618);
  assert.throws(() => sandboxEnvironment({ ...env, SANDBOX_GATEWAY_PORT_BASE: '0' }), /port number/);
  const main = readFileSync(new URL('../src/sandbox/sandbox-main.ts', import.meta.url), 'utf8');
  assert.match(main, /backend: publishedBackend\(\{ siteOrigins: settings\.siteOrigins, gatewayHost: settings\.gatewayHost, portBase: settings\.portBase \}\)/); assert.doesNotMatch(main, /SANDBOX_RUNTIME|sandbox-fixture|FixtureBackend|manifest/);
  const src = new URL('../src/', import.meta.url).pathname;
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts'));
  for (const file of files) assert.doesNotMatch(readFileSync(join(src, file), 'utf8'), /from ['"][^'"]*(test\/|sandbox-fixture)/, file);
  assert.equal(configuredSandbox({}, 'https://demo.test'), undefined, 'no SANDBOX_API_URL, no sandbox');
  assert.throws(() => configuredSandbox({ SANDBOX_API_URL: 'http://sandbox:7620', SANDBOX_SERVICE_TOKEN: 'short' }, 'https://demo.test'), /32/);
});

test('A44: while one visitor\'s call to the sandbox service hangs, every other sandbox request is still answered', async () => {
  let hang: Promise<void> | null = null; let entered = false;
  const h = await harness({ client: inner => ({ async request(path, method, body) { if (hang && path.endsWith('/claim')) { entered = true; await hang; } return inner.request(path, method, body); } }) });
  await serving(api(h.pool), async origin => {
    const join = (ip: string) => fetch(`${origin}/api/sandbox/session`, { method: 'POST', headers: { origin: SITE, 'x-client-ip': ip } });
    const a = (await join('192.0.2.1')).headers.get('set-cookie')!.split(';')[0]!; const b = (await join('192.0.2.2')).headers.get('set-cookie')!.split(';')[0]!;
    let release!: () => void; hang = new Promise(r => { release = r; });
    const claiming = fetch(`${origin}/api/sandbox/session/claim`, { method: 'POST', headers: { origin: SITE, cookie: a } });
    while (!entered) await new Promise(r => setTimeout(r, 5));
    const quick = async (path: string, init: RequestInit = {}) => { const started = Date.now(); const r = await fetch(`${origin}/api/sandbox/${path}`, { ...init, signal: AbortSignal.timeout(2000) }); assert.ok(Date.now() - started < 1000, path); return r; };
    assert.equal((await quick('status')).status, 200);
    assert.equal((await quick('session', { headers: { cookie: b } })).status, 200);
    assert.equal((await quick('session', { method: 'POST', headers: { origin: SITE, 'x-client-ip': '192.0.2.3' } })).status, 200, 'a new session gets the last free slot');
    hang = null; release(); assert.equal((await claiming).status, 200);
  });
});

test('A44: the field station waits 3 s for a lifecycle call or status poll, and longer than the service for a slot operation', async () => {
  assert.ok(SANDBOX_CALL_TIMEOUT_MS < SANDBOX_DEFAULTS.failMs && SANDBOX_CALL_TIMEOUT_MS < SANDBOX_DEFAULTS.pollMs, 'a poll times out before the next is due, well inside the outage limit');
  assert.ok(CALL_TIMEOUT_MS < SANDBOX_OPS_TIMEOUT_MS, 'the service gives up on a slot before the field station gives up on the service');
  const silent = createServer(() => undefined); await new Promise<void>(r => silent.listen(0, '127.0.0.1', r));
  try {
    const pool = configuredSandbox({ SANDBOX_API_URL: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, SANDBOX_SERVICE_TOKEN: SERVICE_TOKEN, SANDBOX_SLOTS: '1' }, 'https://demo.test')!;
    const started = Date.now(); await pool.initialize(); const waited = Date.now() - started;
    assert.ok(waited >= SANDBOX_CALL_TIMEOUT_MS - 100 && waited < SANDBOX_CALL_TIMEOUT_MS + 2000, `returned after ${waited} ms`);
    assert.deepEqual(pool.status().slots, [{ slot: 1, state: 'unavailable' }]);
  } finally { silent.closeAllConnections(); silent.close(); }
});
