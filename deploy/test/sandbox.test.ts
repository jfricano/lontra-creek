/**
 * Runs against a real workbench sandbox behind Caddy (npm run dev:lab, or a stack with
 * deploy/compose.sandbox.yaml). Set SANDBOX_API_ORIGIN (the field station's public
 * origin) and SANDBOX_SITE_ORIGIN (the page's origin), and trust the stack's CA:
 *
 *   NODE_EXTRA_CA_CERTS=$PWD/.local/lab/secrets/origin/ca.pem SANDBOX_API_ORIGIN=https://localhost:8443 \
 *   SANDBOX_SITE_ORIGIN=https://localhost:8443 node --test --test-force-exit deploy/test/sandbox.test.ts
 *
 * Optional: SANDBOX_PAUSE_COMMAND and SANDBOX_UNPAUSE_COMMAND (shell commands that freeze and
 * thaw the sandbox container, for example `docker compose ... pause sandbox`) run the hung-service test.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createClient } from 'streamotter/client';
import type { Client } from 'streamotter/client';
import type { SandboxConnection, SandboxLease, SandboxReproDownload, SandboxStatus, WorkbenchDiscovery } from '../../apps/field-station/src/sandbox/contract.ts';
const API = process.env['SANDBOX_API_ORIGIN'];
const SITE = process.env['SANDBOX_SITE_ORIGIN'] ?? 'https://streamotter.dev';
// The Node SDK transport does not send a browser Origin automatically.
for (const transport of [http, https]) {
  const original = transport.request;
  transport.request = ((...args: unknown[]) => {
    const options = args[0];
    if (typeof options === 'object' && options !== null && !(options instanceof URL)) {
      const headers = (options as http.RequestOptions).headers as Record<string, unknown> | undefined;
      if (headers?.['Upgrade'] === 'websocket') headers['Origin'] = SITE;
    }
    return (original as (...values: unknown[]) => ReturnType<typeof http.request>)(...args);
  }) as typeof transport.request;
}
const require = createRequire(createRequire(import.meta.url).resolve('streamotter/package.json'));
const VERSION = (require('streamotter/package.json') as { version: string }).version;
const WORKBENCH = (require('@streamotter/workbench/host') as { version: string }).version;
type Channels = Record<string, { version: 1; params: Record<string, string>; data: never }>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 35_000) { const deadline = Date.now() + timeout; while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await sleep(1000); } }
let cookie = '';
async function life<T>(path: string, method = 'GET', status = method === 'POST' && path === 'session/reset' ? 202 : 200): Promise<T> {
  const response = await fetch(`${API}/api/sandbox/${path}`, { method, headers: { origin: SITE, cookie } });
  if (response.headers.get('set-cookie') && !cookie) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const body = await response.json(); assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(body)}`); return body as T;
}
/** One WHC-1 call, paced under the per-session rate of two operations a second (the burst is left for the page). */
async function wb<T>(path: string, body?: unknown): Promise<{ status: number; body: { ok: boolean; data?: T; error?: { code: string; details?: { code?: string } } } }> {
  await sleep(600);
  const response = await fetch(`${API}/api/sandbox/wb/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin: SITE, cookie, 'x-streamotter-workbench': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as { ok: boolean; data?: T } };
}
async function ok<T>(path: string, body?: unknown): Promise<T> { const r = await wb<T>(path, body); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`); assert.equal(r.body.ok, true); return r.body.data as T; }

describe('the real workbench sandbox', { skip: !API && 'SANDBOX_API_ORIGIN not set' }, () => {
  let connection: SandboxConnection; let heartbeat: NodeJS.Timeout; const clients: Client<Channels>[] = [];
  const preview = (token: string, channel: string, params: Record<string, string>) => {
    const client = createClient<Channels>({ origin: connection.gatewayOrigin, path: connection.gatewayPath, getToken: () => token }); clients.push(client);
    const view = client.subscribe(channel, { channelVersion: 1, params }); return view;
  };
  before(async () => {
    await until(async () => (await life<SandboxStatus>('status')).availability === 'available', 'sandbox available', 90_000);
    const lease = await life<SandboxLease>('session', 'POST'); assert.equal(lease.status, 'ready', JSON.stringify(lease));
    connection = await life<SandboxConnection>('session/claim', 'POST');
    heartbeat = setInterval(() => void life('session').catch(() => {}), 5000);
  });
  after(async () => { clearInterval(heartbeat); for (const c of clients) await c.close().catch(() => {}); if (cookie) await life('session/return', 'POST').catch(() => {}); });

  test('status reports the installed release and WHC-1; discovery lists the allowlist', async () => {
    const status = await life<SandboxStatus>('status');
    assert.deepEqual(status.runtime, { packages: { streamotter: VERSION, workbench: WORKBENCH }, mode: 'synthetic-fixture', contractVersion: '1' });
    const session = await life<SandboxLease>('session'); assert.equal(session.status, 'active');
    assert.match(connection.gatewayPath, /^\/sandbox\/[123]\/socket\.io$/); assert.equal(connection.gatewayOrigin, new URL(API!).origin);
    const discovery = await ok<WorkbenchDiscovery>('/workbench');
    assert.deepEqual([...discovery.operations].sort(), ['capabilities', 'channels', 'config', 'config.export', 'config.validate', 'dev.disconnect', 'dev.fixtures.advance', 'dev.principals', 'health', 'preview-sessions', 'source-checks', 'sources', 'sources.resume', 'traces', 'workbench']);
  });

  test('every allowlisted operation answers from the slot\'s own gateway, and failures stay unserved', async () => {
    // The published workbench reads these five at once when it mounts; the budget's burst admits them.
    const mount = await Promise.all(['/config', '/channels', '/sources', '/dev/principals', '/health'].map(path => fetch(`${API}/api/sandbox/wb/v1${path}`, { headers: { origin: SITE, cookie, 'x-streamotter-workbench': '1' } })));
    assert.deepEqual(mount.map(r => r.status), [200, 200, 200, 200, 200]); await sleep(3000);
    assert.equal((await ok<{ protocolVersion: number }>('/capabilities')).protocolVersion, 1);
    assert.equal((await ok<{ ready: boolean }>('/health')).ready, true);
    assert.deepEqual((await ok<{ items: { sourceId: string }[] }>('/sources')).items.map(s => s.sourceId), ['creek', 'jobs']);
    assert.deepEqual((await ok<{ items: { name: string }[] }>('/channels')).items.map(c => c.name), ['station', 'jobProgress']);
    const { config } = await ok<{ config: { projectId: string; schemas: Record<string, unknown> } }>('/config');
    assert.equal(config.projectId, `lontra-creek-sandbox-${connection.gatewayPath.split('/')[2]}`);
    assert.deepEqual(await ok('/config/validate', { config }), { valid: true, issues: [] });
    assert.equal((await ok<{ filename: string }>('/config/export', { config })).filename, 'streamotter.json');
    assert.ok((await ok<{ steps: unknown[] }>('/source-checks', { sourceId: 'creek' })).steps.length > 0);
    assert.equal((await ok<{ status: string }>('/sources/resume', { sourceId: 'jobs' })).status, 'healthy');
    assert.deepEqual((await ok<{ items: { ref: string }[] }>('/dev/principals')).items.map(p => p.ref), ['creek-volunteer', 'developer']);
    assert.deepEqual(await ok('/dev/fixtures/advance', { sourceId: 'jobs', count: 2 }), { advanced: 2 });
    const traces = await ok<{ items: unknown[]; nextCursor: string | null }>('/traces?limit=500');
    assert.ok(traces.items.length > 0 && traces.items.length <= 100);
    const session = await ok<{ previewSessionId: string }>('/preview-sessions', { fixturePrincipalRef: 'developer' });
    assert.equal(await ok('/dev/disconnect', { previewSessionId: session.previewSessionId }), null);
    for (const path of ['/failures', '/operator/status']) assert.equal((await wb(path)).status, 403, path);
    await sleep(1100);
    const repro = await life<SandboxReproDownload>('session/repro', 'POST'); assert.equal(repro.filename, 'lontra-creek-sandbox-repro.json');
  });

  test('a 64 KB candidate passes Caddy and reaches the editor', async () => {
    const { config } = await ok<{ config: { schemas: Record<string, { properties: Record<string, Record<string, unknown>> }> } }>('/config');
    const candidate = structuredClone(config); const names: string[] = []; candidate.schemas['StationParams']!.properties['stationId']!['enum'] = names;
    while (JSON.stringify({ config: candidate }).length < 63_000) names.push(`station-${String(names.length).padStart(4, '0')}-${'x'.repeat(24)}`);
    const body = JSON.stringify({ config: candidate }); assert.ok(body.length > 8192 * 7 && body.length <= 65_536, String(body.length));
    const answer = await wb<{ valid: boolean }>('/config/validate', body);
    assert.equal(answer.status, 200, JSON.stringify(answer.body).slice(0, 300)); assert.equal(answer.body.ok, true);
    assert.equal((await wb('/config/validate', JSON.stringify({ config: { ...candidate, pad: 'x'.repeat(70_000) } }))).status, 413, 'over 64 KB is refused');
  });

  test('a candidate nested too deep is refused as invalid and the session keeps its slot', async () => {
    const { config } = await ok<{ config: { schemas: Record<string, unknown> } }>('/config');
    const body = `{"config":${JSON.stringify(config).replace(/^\{"/, () => `{"deepSchema":${'['.repeat(7000)}1${']'.repeat(7000)},"`)}}`;
    assert.ok(body.length > 14_000 && body.length < 65_536, String(body.length));
    const answer = await wb('/config/validate', body);
    assert.equal(answer.status, 400, JSON.stringify(answer.body).slice(0, 300)); assert.equal(answer.body.error?.details?.code, 'invalid-request');
    assert.equal((await life<SandboxLease>('session')).status, 'active');
    assert.equal((await ok<{ ready: boolean }>('/health')).ready, true);
  });

  test('previews reach live through /sandbox/N/socket.io; edge routes stay closed', async () => {
    const volunteer = await ok<{ token: string }>('/preview-sessions', { fixturePrincipalRef: 'creek-volunteer' });
    const station = preview(volunteer.token, 'station', { stationId: 'LC-03' }); await station.ready({ timeoutMs: 15_000 }); assert.equal(station.state, 'live');
    const developer = await ok<{ token: string }>('/preview-sessions', { fixturePrincipalRef: 'developer' });
    const jobs = preview(developer.token, 'jobProgress', { jobId: 'job_1' }); await jobs.ready({ timeoutMs: 15_000 }); assert.equal(jobs.state, 'live');
    const slot = connection.gatewayPath.split('/')[2];
    for (const headers of [{}, { origin: 'https://foreign.test' }]) assert.equal((await fetch(`${API}/sandbox/${slot}/socket.io/?EIO=4&transport=websocket`, { headers })).status, 403);
    for (const path of [`/sandbox/${slot}/`, `/sandbox/${slot}/management/v1/health`, '/sandbox/v1/status', `/sandbox/${slot}/workbench`]) assert.equal((await fetch(`${API}${path}`)).status, 404, path);
    const host = new URL(API!).hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      for (const port of [7620, 7601, 7602, 7603]) {
        const reached = await new Promise<boolean>(done => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); done(true); }); socket.once('error', () => done(false)); });
        assert.equal(reached, false, `port ${port} is not published`);
      }
    }
  });

  test('reset ends the study\'s previews; the next study previews again', async () => {
    const volunteer = await ok<{ token: string }>('/preview-sessions', { fixturePrincipalRef: 'creek-volunteer' });
    const station = preview(volunteer.token, 'station', { stationId: 'LC-03' }); await station.ready({ timeoutMs: 15_000 });
    const before = await life<{ studyId: string }>('session');
    await sleep(1100); const resetting = await life<SandboxLease>('session/reset', 'POST'); assert.equal(resetting.status, 'resetting');
    await until(() => station.state !== 'live', 'the old study\'s preview ends', 15_000);
    await until(async () => (await life<SandboxLease>('session')).status === 'active', 'the new study is active');
    assert.notEqual((await life<{ studyId: string }>('session')).studyId, before.studyId);
    await assert.rejects(preview(volunteer.token, 'station', { stationId: 'LC-03' }).ready({ timeoutMs: 5000 }), 'the old token means nothing to the new study');
    const fresh = await ok<{ token: string }>('/preview-sessions', { fixturePrincipalRef: 'creek-volunteer' });
    await preview(fresh.token, 'station', { stationId: 'LC-03' }).ready({ timeoutMs: 15_000 });
  });

  test('a hung sandbox service delays no other request, and a short hang ends nothing', { skip: !(process.env['SANDBOX_PAUSE_COMMAND'] && process.env['SANDBOX_UNPAUSE_COMMAND']) && 'Set SANDBOX_PAUSE_COMMAND and SANDBOX_UNPAUSE_COMMAND' }, async () => {
    await until(async () => (await life<SandboxLease>('session')).status === 'active', 'the session is active');
    execSync(process.env['SANDBOX_PAUSE_COMMAND']!, { stdio: 'inherit' });
    let pending: Promise<{ status: number }> | undefined;
    try {
      pending = wb('/health');
      // About 8 s: past several 3 s status polls, inside the 15 s outage limit; paced under the request budget.
      for (let i = 0; i < 8; i++) {
        const started = Date.now();
        assert.equal((await life<SandboxStatus>('status')).availability, 'available');
        assert.equal((await life<SandboxLease>('session')).status, 'active');
        assert.ok(Date.now() - started < 1500, `status and session answered in ${Date.now() - started} ms while the service hung`);
        await sleep(1000);
      }
    } finally { execSync(process.env['SANDBOX_UNPAUSE_COMMAND']!, { stdio: 'inherit' }); }
    await pending;
    await sleep(1000); assert.equal((await life<SandboxLease>('session')).status, 'active', 'a hang shorter than the outage limit ends nothing');
    assert.equal((await ok<{ ready: boolean }>('/health')).ready, true);
  });
});
