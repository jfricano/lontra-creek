/**
 * The production slot backend on the published seam (streamotter 0.2.0-rc.1): real
 * development gateways and createManagementHandler, driven through SandboxService and
 * the field station's pool. Evidence level: fixture (loopback, real StreamOtter).
 * LC11-A42 isolation, A43 allowlist and credentials, A44 cleanup.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { createClient } from 'streamotter/client';
import { WORKBENCH_OPERATIONS } from 'streamotter/contracts';
import type { SlotId } from '../src/sandbox/contract.ts';
import { SANDBOX_OPERATIONS, TRACE_LIMIT } from '../src/sandbox/operations.ts';
import { publishedBackend, type PublishedRuntime } from '../src/sandbox/seam.ts';
import type { SlotBackend } from '../src/sandbox/service.ts';
import { harness, wb } from './support/sandbox-harness.ts';

const SITE = 'https://site.test';
// The Node SDK transport sends no browser Origin; the slot gateways allow only the site's.
let origin: string | undefined = SITE;
const original = http.request;
http.request = ((...args: unknown[]) => {
  const options = args[0];
  if (typeof options === 'object' && options !== null && !(options instanceof URL)) {
    const headers = (options as http.RequestOptions).headers as Record<string, unknown> | undefined;
    if (headers?.['Upgrade'] === 'websocket' && origin) headers['Origin'] = origin;
  }
  return (original as (...values: unknown[]) => http.ClientRequest)(...args);
}) as typeof http.request;

const free = (port: number) => new Promise<boolean>(done => { const s = createServer(); s.once('error', () => done(false)); s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => done(true))); });
/** A port base whose three slot ports are free on loopback. */
async function portBase(): Promise<number> {
  for (;;) { const base = 20_000 + Math.floor(Math.random() * 40_000); if ((await Promise.all([1, 2, 3].map(n => free(base + n)))).every(Boolean)) return base; }
}
/** The published backend, recording each runtime it opens. */
function recording(base: number) {
  const opened: PublishedRuntime[] = [];
  const inner = publishedBackend({ siteOrigins: [SITE], gatewayHost: '127.0.0.1', portBase: base });
  const backend: SlotBackend = { describe: () => inner.describe(), open: async (slot: SlotId) => { const runtime = await inner.open(slot) as PublishedRuntime; opened.push(runtime); return runtime; } };
  return { backend, opened, current: (slot: SlotId) => opened.filter(r => r.base.gateway.path === `/sandbox/${slot}/socket.io`).at(-1)! };
}
const require = createRequire(createRequire(import.meta.url).resolve('streamotter/package.json'));
const VERSION = (require('streamotter/package.json') as { version: string }).version;
const HOST = require('@streamotter/workbench/host') as { version: string; hostContract: number };
const until = async (check: () => boolean, label: string, ms = 10_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 25)); } };

test('A43/A46: the backend reports the installed versions and WHC-1, and a pre-WHC-1 install is seam-unavailable', async () => {
  const backend = publishedBackend({ siteOrigins: [SITE], gatewayHost: '127.0.0.1', portBase: 0 });
  const before = backend.describe(); assert.ok(before.available);
  assert.deepEqual(before.runtime, { packages: { streamotter: VERSION, workbench: HOST.version }, mode: 'synthetic-fixture', contractVersion: '1' });
  assert.equal(HOST.hostContract, 1);
  assert.deepEqual(before.operations, [], 'nothing is offered before a runtime has answered discovery');
  const runtime = await backend.open(1) as PublishedRuntime;
  try {
    const after = backend.describe(); assert.ok(after.available);
    assert.deepEqual(after.operations, SANDBOX_OPERATIONS, 'every allowlisted operation, from the slot handler\'s own discovery');
    assert.deepEqual([...runtime.discovery.operations].sort(), [...SANDBOX_OPERATIONS, 'workbench'].sort(), 'the handler lists only the allowlist');
    assert.ok(WORKBENCH_OPERATIONS.filter(op => !(SANDBOX_OPERATIONS as readonly string[]).includes(op) && op !== 'workbench').every(op => !runtime.discovery.operations.includes(op)));
  } finally { await runtime.close(); }
  for (const manifest of [null, {}, { package: '@streamotter/workbench', version: '0.1.0-rc.3' }, { hostContract: 2, package: '@streamotter/workbench', version: '9.0.0' }, { hostContract: 1, package: 'workbench-lookalike', version: '0.2.0-rc.1' }]) {
    const old = publishedBackend({ siteOrigins: [SITE], manifest });
    assert.deepEqual(old.describe(), { available: false, reason: 'seam-unavailable' }, JSON.stringify(manifest));
    await assert.rejects(old.open(1), /No published workbench seam/);
  }
});

test('A43: every allowlisted operation runs on a real development gateway through the sandbox service', async () => {
  const slots = recording(await portBase());
  const h = await harness({ slots: 1, backend: () => slots.backend });
  try {
    assert.equal(h.pool.status().availability, 'available'); assert.equal(h.pool.status().runtime?.contractVersion, '1');
    assert.equal(h.pool.discovery().operations.length, 15, 'workbench plus the fourteen allowlisted operations');
    const s = h.session('s'); await h.join(s); await h.claim(s);
    const runtime = slots.current(1);
    assert.equal((await h.opSlow(s, 'capabilities') as { protocolVersion: number }).protocolVersion, 1);
    assert.deepEqual(await h.opSlow(s, 'health'), { ready: true, sources: [{ sourceId: 'creek', kind: 'fixture', status: 'healthy' }, { sourceId: 'jobs', kind: 'fixture', status: 'healthy' }] });
    assert.deepEqual((await h.opSlow(s, 'sources') as { items: { sourceId: string }[] }).items.map(i => i.sourceId), ['creek', 'jobs']);
    assert.deepEqual((await h.opSlow(s, 'channels') as { items: { name: string }[] }).items.map(i => i.name), ['station', 'jobProgress']);
    const { config } = await h.opSlow(s, 'config') as { config: Record<string, unknown> };
    assert.deepEqual(config, runtime.base, 'the gateway runs exactly the base the editor compares candidates with');
    assert.deepEqual(await h.opSlow(s, 'config.validate', { config }), { valid: true, issues: [] });
    const refused = await h.opSlow(s, 'config.validate', { config: { ...config, projectId: 'mine' } }) as { valid: boolean; issues: { code: string }[] };
    assert.equal(refused.issues[0]!.code, 'FIELD_NOT_EDITABLE');
    const exported = await h.opSlow(s, 'config.export', { config }) as { filename: string; content: string };
    assert.equal(exported.filename, 'streamotter.json'); assert.deepEqual(JSON.parse(exported.content), config);
    assert.equal((await h.opSlow(s, 'source-checks', { sourceId: 'creek' }) as { steps: { stage: string }[] }).steps[0]!.stage, 'resolve');
    assert.equal((await h.opSlow(s, 'sources.resume', { sourceId: 'jobs' }) as { status: string }).status, 'healthy');
    assert.deepEqual((await h.opSlow(s, 'dev.principals') as { items: { ref: string; tenantId: string }[] }).items, [
      { ref: 'creek-volunteer', tenantId: 'lontra-creek', subject: 'creek-volunteer' }, { ref: 'developer', tenantId: 'local', subject: 'developer' }
    ]);
    const preview = await h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'developer' }) as { token: string; previewSessionId: string; expiresAt: string };
    assert.ok(preview.token.length > 20); assert.ok(Date.parse(preview.expiresAt) <= Date.parse((h.view(s) as { expiresAt: string }).expiresAt));
    await assert.rejects(h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'volunteer' }), wb('INVALID_REQUEST'), 'only the slot\'s own principals');
    assert.deepEqual(await h.opSlow(s, 'dev.fixtures.advance', { sourceId: 'jobs', count: 4 }), { advanced: 4 });
    const traces = await h.opSlow(s, 'traces', { sourceId: 'jobs' }) as { items: { sourceId: string; requestId?: string }[]; nextCursor: string | null };
    assert.ok(traces.items.length >= 4 && traces.items.every(t => t.sourceId === 'jobs'));
    assert.equal(await h.opSlow(s, 'dev.disconnect', { previewSessionId: preview.previewSessionId }), null);
    const repro = JSON.parse((await h.pool.repro(s)).content) as { packages: { streamotter: string }; contractVersion: string; traces: unknown[] };
    assert.deepEqual([repro.packages.streamotter, repro.contractVersion], [VERSION, '1']); assert.ok(repro.traces.length >= 4);
  } finally { await h.service.close(); }
});

test('A43: the slot handler answers only its own key and the allowlist; Authorization is ignored', async () => {
  const slots = recording(await portBase());
  const h = await harness({ slots: 1, backend: () => slots.backend });
  try {
    const runtime = slots.current(1); const at = (path: string, headers: Record<string, string> = {}) => fetch(`${runtime.managementOrigin}${path}`, { headers });
    assert.match(runtime.managementOrigin, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback only');
    assert.equal((await at('/health')).status, 401);
    assert.equal((await at('/health', { 'x-lc-slot-key': 'a'.repeat(64) })).status, 401, 'a wrong key');
    assert.equal((await at('/health', { authorization: 'Bearer anything' })).status, 401, 'Authorization is no credential here');
    assert.equal((await at('/management/v1/health', { 'x-lc-slot-key': 'a'.repeat(64) })).status, 401);
    // Even with the key, operator and failure operations are not served.
    for (const op of ['operator.status', 'failures.list', 'sources.retry-current'] as const) await assert.rejects(runtime.call(op as never, null as never), (e: { code?: string }) => e.code === 'FORBIDDEN' || e.code === 'INVALID_REQUEST', op);
  } finally { await h.service.close(); }
});

test('A42/A44: reset revokes previews and stops the old gateway; the old token fails on the new one, on the same port', async () => {
  const slots = recording(await portBase());
  const h = await harness({ slots: 1, backend: () => slots.backend });
  const clients: { close(): Promise<void> }[] = [];
  try {
    const s = h.session('s'); await h.join(s); await h.claim(s);
    const old = slots.current(1); const address = old.gatewayAddress;
    const subscribe = (token: string, channel: 'station' | 'jobProgress', params: Record<string, string>) => {
      const client = createClient<Record<string, { version: 1; params: Record<string, string>; data: never }>>({ origin: address.origin, path: address.path, getToken: () => token }); clients.push(client);
      const states: string[] = []; const view = client.subscribe(channel, { channelVersion: 1, params }); view.on('state', e => { states.push(e.state); });
      return { view, states };
    };
    const volunteer = await h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'creek-volunteer' }) as { token: string };
    const developer = await h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'developer' }) as { token: string };
    const station = subscribe(volunteer.token, 'station', { stationId: 'LC-03' }); await station.view.ready({ timeoutMs: 5000 });
    const jobs = subscribe(developer.token, 'jobProgress', { jobId: 'job_1' }); await jobs.view.ready({ timeoutMs: 5000 });
    assert.equal(station.view.state, 'live'); assert.equal(jobs.view.state, 'live');
    await assert.rejects(subscribe(developer.token, 'station', { stationId: 'LC-03' }).view.ready({ timeoutMs: 5000 }), 'the scaffold principal cannot read the creek');
    await assert.rejects(subscribe(volunteer.token, 'jobProgress', { jobId: 'job_1' }).view.ready({ timeoutMs: 5000 }), 'the creek principal cannot read the scaffold\'s jobs');

    await h.reset(s); await h.settle();
    const fresh = slots.current(1); assert.notEqual(fresh, old); assert.deepEqual(fresh.gatewayAddress, address, 'the slot keeps its port across studies');
    await until(() => station.view.state !== 'live' && jobs.view.state !== 'live', 'previews end with the study');
    origin = SITE;
    await assert.rejects(subscribe(volunteer.token, 'station', { stationId: 'LC-03' }).view.ready({ timeoutMs: 5000 }), 'an old study\'s preview token means nothing to the new gateway');
    const s2 = await h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'creek-volunteer' }) as { token: string };
    origin = 'https://evil.test';
    await assert.rejects(subscribe(s2.token, 'station', { stationId: 'LC-03' }).view.ready({ timeoutMs: 5000 }), 'the gateway allows only the site origin');
    origin = SITE;
    await subscribe(s2.token, 'station', { stationId: 'LC-03' }).view.ready({ timeoutMs: 5000 });
  } finally { origin = SITE; for (const c of clients) await c.close().catch(() => undefined); await h.service.close(); }
  assert.ok(await free(Number(new URL(slots.current(1).gatewayAddress.origin).port)), 'close() frees the slot port');
});

test('A42: two slots never share traces, cursors, or previews', async () => {
  const slots = recording(await portBase());
  const h = await harness({ slots: 2, backend: () => slots.backend });
  const clients: { close(): Promise<void> }[] = [];
  try {
    const a = h.session('a'); const b = h.session('b'); await h.join(a); await h.join(b); await h.claim(a); await h.claim(b);
    const slotOf = (s: typeof a) => (h.view(s) as { slot: SlotId }).slot;
    assert.notEqual(slotOf(a), slotOf(b));
    await h.opSlow(a, 'dev.fixtures.advance', { sourceId: 'creek', count: 10 });
    assert.equal((await h.opSlow(b, 'traces', {}) as { items: unknown[] }).items.length, 0, 'B sees none of A\'s traces');
    const page = await h.opSlow(a, 'traces', { limit: 5 }) as { items: unknown[]; nextCursor: string };
    assert.equal(page.items.length, 5); assert.ok(page.nextCursor);
    await assert.rejects(h.opSlow(b, 'traces', { cursor: page.nextCursor }), wb('TRACE_CURSOR_EXPIRED', 'stale-study'), 'A\'s cursor is nothing to B');
    const token = (await h.opSlow(a, 'preview-sessions', { fixturePrincipalRef: 'creek-volunteer' }) as { token: string }).token;
    const other = slots.current(slotOf(b)).gatewayAddress;
    const client = createClient<Record<string, { version: 1; params: Record<string, string>; data: never }>>({ origin: other.origin, path: other.path, getToken: () => token }); clients.push(client);
    await assert.rejects(client.subscribe('station', { channelVersion: 1, params: { stationId: 'LC-03' } }).ready({ timeoutMs: 5000 }), 'A\'s preview token is nothing to B\'s gateway');
  } finally { for (const c of clients) await c.close().catch(() => undefined); await h.service.close(); }
});

test('A43: the workbench may ask for 500 traces; a page serves at most 100', async () => {
  const slots = recording(await portBase());
  const h = await harness({ slots: 1, backend: () => slots.backend });
  try {
    const s = h.session('s'); await h.join(s); await h.claim(s);
    for (let i = 0; i < 12; i++) await h.opSlow(s, 'dev.fixtures.advance', { sourceId: 'creek', count: 10 });
    const page = await h.opSlow(s, 'traces', { limit: 500 }) as { items: { id: string }[]; nextCursor: string };
    assert.equal(page.items.length, TRACE_LIMIT, 'the newest hundred'); assert.ok(page.nextCursor);
    assert.deepEqual((await h.opSlow(s, 'traces', { limit: 500, cursor: page.nextCursor }) as { items: unknown[] }).items, [], 'a cursor polls for newer traces');
    await h.opSlow(s, 'dev.fixtures.advance', { sourceId: 'creek', count: 10 });
    const next = await h.opSlow(s, 'traces', { limit: 500, cursor: page.nextCursor }) as { items: { id: string }[] };
    assert.ok(next.items.length > 0 && next.items.length <= TRACE_LIMIT); assert.ok(!next.items.some(t => page.items.some(p => p.id === t.id)));
    const repro = JSON.parse((await h.pool.repro(s)).content) as { traces: unknown[]; gaps: { tracesTruncated: boolean } };
    assert.equal(repro.traces.length, 500); assert.equal(repro.gaps.tracesTruncated, true, 'a full native page may not be the whole study');
  } finally { await h.service.close(); }
});
