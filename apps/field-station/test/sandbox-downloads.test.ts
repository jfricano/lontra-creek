/**
 * Bounded, current-study downloads and mode/version truth (sandbox contract §7).
 * Evidence level: fixture (unit). LC11-A45 server side.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SandboxReproBundle } from '../src/sandbox/contract.ts';
import { fixtureBase } from './support/sandbox-fixture.ts';
import { code, harness, SERVICE_TOKEN, wb } from './support/sandbox-harness.ts';

const leaks = (text: string, extra: string[]) => [SERVICE_TOKEN, 'lc_session', '/etc/', '/home/', 'Bearer', 'requestId', 'subscriptionId', 'req-', 'sub-', ...extra].filter(s => text.includes(s));

test('A45: config export returns canonical configuration of the validated candidate, capped at 256 KB, without secrets or host paths', async () => {
  const h = await harness({ slots: 1 }); const s = h.session('s'); await h.join(s); const connection = await h.claim(s);
  const preview = await h.opSlow(s, 'preview-sessions', { fixturePrincipalRef: 'visitor' }) as { token: string };
  const candidate = structuredClone(fixtureBase(1)) as unknown as { channels: { station: { version: number } } }; candidate.channels.station.version = 2;
  const exported = await h.opSlow(s, 'config.export', { config: candidate }) as { filename: string; content: string };
  assert.equal(exported.filename, 'streamotter.json'); assert.equal(JSON.parse(exported.content).channels.station.version, 2);
  assert.deepEqual(leaks(exported.content, [preview.token, connection.leaseId, connection.studyId]), []);
  const runtime = h.fixture.current(1);
  runtime.exportContent = 'x'.repeat(262_145);
  await assert.rejects(h.opSlow(s, 'config.export', { config: candidate }), wb('INVALID_REQUEST', 'candidate-too-large'));
  for (const content of ['{"caFile": "/etc/lontra/kafka/ca.pem"}', `{"token": "${preview.token}"}`, `{"note": "${SERVICE_TOKEN}"}`, '{"path": "C:\\\\Users\\\\x"}']) {
    runtime.exportContent = content;
    await assert.rejects(h.opSlow(s, 'config.export', { config: candidate }), wb('INTERNAL', 'invalid-request'), content);
  }
});

test('A45: the reproduction bundle holds only this study\'s metadata, labels the mode and exact packages, and stays under 256 KB', async () => {
  const h = await harness(); const a = h.session('a'); const b = h.session('b');
  await h.join(a); await h.join(b); const ca = await h.claim(a); const cb = await h.claim(b);
  await assert.rejects(h.pool.repro(h.session('nobody')), code('no-lease'));
  const pa = await h.opSlow(a, 'preview-sessions', { fixturePrincipalRef: 'visitor' }) as { token: string; previewSessionId: string };
  await h.opSlow(b, 'dev.fixtures.advance', { sourceId: 'creek', count: 10 });
  await h.opSlow(a, 'dev.fixtures.advance', { sourceId: 'jobs', count: 2 });
  const download = await h.pool.repro(a); assert.equal(download.filename, 'lontra-creek-sandbox-repro.json');
  const bundle = JSON.parse(download.content) as SandboxReproBundle;
  assert.equal(bundle.mode, 'synthetic-fixture'); assert.deepEqual(bundle.packages, { streamotter: '0.1.0-rc.3', workbench: '0.1.0-rc.3' }); assert.equal(bundle.hostContract, 1);
  assert.equal(bundle.traces.length, 2, 'only A\'s study'); assert.ok(bundle.traces.every(t => t.sourceId === 'jobs'));
  assert.equal(bundle.study.operations['preview-sessions'], 1);
  assert.deepEqual(leaks(download.content, [pa.token, pa.previewSessionId, ca.leaseId, ca.studyId, cb.leaseId, cb.studyId, 'lontra-creek-sandbox-2', 'lontra-creek-sandbox-3']), []);

  await h.reset(a); await h.settle(); await h.advance(1000);
  const afterReset = JSON.parse((await h.pool.repro(a)).content) as SandboxReproBundle;
  assert.equal(afterReset.traces.length, 0); assert.deepEqual(afterReset.study.operations, {}, 'a reset study starts empty');

  const runtime = h.fixture.current((h.view(b) as { slot: 1 | 2 | 3 }).slot);
  for (let i = 0; i < 600; i++) runtime.traces.push({ id: `bulk-${i}`, requestId: 'r', at: new Date().toISOString(), stage: 'map', outcome: 'failed', sourceId: 'creek', channel: 'station', errorCode: 'HANDLER_FAILED' });
  await h.advance(1000); const bulk = await h.pool.repro(b);
  assert.ok(Buffer.byteLength(bulk.content) <= 262_144);
  const parsed = JSON.parse(bulk.content) as SandboxReproBundle; assert.equal(parsed.traces.length, 500); assert.equal(parsed.gaps.tracesTruncated, true, 'a longer study is flagged, not silently cut');
});

test('A45: status reports the running service\'s mode and package identity, or an honest reason', async () => {
  const h = await harness();
  const status = h.pool.status(); assert.equal(status.availability, 'available'); assert.deepEqual(status.runtime, { packages: { streamotter: '0.1.0-rc.3', workbench: '0.1.0-rc.3' }, mode: 'synthetic-fixture', contractVersion: null });
  const s = h.session('s'); const lease = await h.join(s); assert.ok(lease.status === 'ready' && lease.runtime.mode === 'synthetic-fixture');
});
