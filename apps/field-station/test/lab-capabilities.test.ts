import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { INSTALLED_STREAMOTTER, INTENTS, SCENARIOS, labCapabilities, parseIntent, refuseIntent } from '../src/lab/capabilities.ts';
import type { LabCapabilities, LabScenarioId } from '../src/lab/contract.ts';
import { LabError } from '../src/lab/errors.ts';
import { LeasePool } from '../src/lab/leases.ts';
import { publicApi } from '../src/server/http.ts';
import { readConfig } from '../src/server/config.ts';
import type { FieldStation } from '../src/server/station.ts';
import type { Notebooks } from '../src/server/notebooks.ts';

const NEW: LabScenarioId[] = ['garbled-reading', 'bad-projection', 'inspect-old-reading', 'conflicting-readings', 'calibration-blip', 'too-many-bad-readings', 'restart-recovery', 'unavailable-evidence'];
const EXISTING: LabScenarioId[] = ['fouled-sensor', 'relay-cut', 'slow-client', 'relay-restart'];
const scenario = (summary: LabCapabilities, id: LabScenarioId) => summary.scenarios.find(s => s.id === id)!;
async function serving(server: Server, run: (origin: string) => Promise<void>) { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } }

test('the summary reports the installed StreamOtter version, read from the package itself', () => {
  // An independent read of the same file, not the module's constant.
  const installed = (JSON.parse(readFileSync(new URL('../../../node_modules/streamotter/package.json', import.meta.url), 'utf8')) as { version: string }).version;
  assert.equal(INSTALLED_STREAMOTTER, installed);
  assert.equal(labCapabilities({ labEnabled: true, now: 0 }).library.version, installed);
});

test('every new source-failures scenario is unavailable on 0.1.0-rc.3, with the capability it lacks', () => {
  const summary = labCapabilities({ labEnabled: true, now: Date.parse('2026-10-03T00:00:00Z'), version: '0.1.0-rc.3' });
  assert.deepEqual(summary.scenarios.map(s => s.id).sort(), [...SCENARIOS].sort());
  assert.equal(summary.scenarios.length, 12);
  for (const id of NEW) {
    const s = scenario(summary, id);
    assert.equal(s.available, false, id);
    assert.equal(s.reason?.code, 'library-lacks-capability', id);
    assert.match(s.reason!.text, /^This backend's StreamOtter release \(0\.1\.0-rc\.3\) doesn't provide /, id);
  }
  assert.equal(scenario(summary, 'garbled-reading').reason!.text, "This backend's StreamOtter release (0.1.0-rc.3) doesn't provide quarantine.");
  assert.equal(scenario(summary, 'bad-projection').reason!.text, "This backend's StreamOtter release (0.1.0-rc.3) doesn't provide quarantine or a recovery guard.");
  for (const feature of Object.values(summary.features)) assert.equal(feature.available, false);
  assert.equal(summary.features.incidentProjection.reason!.text, "This backend's StreamOtter release (0.1.0-rc.3) doesn't provide quarantine.");
  assert.deepEqual(summary.backend, { mode: 'real-kafka-synthetic', lab: 'enabled' });
  assert.equal(summary.now, '2026-10-03T00:00:00.000Z');
});

test('existing scenarios follow the Lab itself; new ones never become available with the Lab', () => {
  const on = labCapabilities({ labEnabled: true, now: 0 }); const off = labCapabilities({ labEnabled: false, now: 0 });
  for (const id of EXISTING) {
    assert.deepEqual({ ...scenario(on, id) }, { id, available: true, reason: null });
    assert.equal(scenario(off, id).available, false); assert.equal(scenario(off, id).reason!.code, 'lab-disabled');
  }
  for (const id of NEW) assert.equal(scenario(on, id).available, false);
  assert.equal(off.backend.lab, 'disabled');
});

test('an unverified release is reported as not integrated rather than claimed to lack anything', () => {
  const summary = labCapabilities({ labEnabled: true, now: 0, version: '9.9.9' });
  for (const id of NEW) { assert.equal(scenario(summary, id).available, false); assert.equal(scenario(summary, id).reason!.code, 'not-integrated'); assert.match(scenario(summary, id).reason!.text, /9\.9\.9/); }
});

test('the summary carries no URL, secret, path, or operator capability', () => {
  const text = JSON.stringify(labCapabilities({ labEnabled: true, now: 0 }));
  for (const forbidden of [/https?:/, /127\.0\.0\.1|localhost/, /socket/i, /token/i, /secret/i, /management/i, /\/(?:var|tmp|home|run)\//]) assert.doesNotMatch(text, forbidden);
});

test('proposed intents parse only in their closed shape', () => {
  const id = 'b3b8c8f4-0d0e-4a65-9c1d-6d1f2a7b9e10';
  assert.deepEqual(parseIntent({ intent: 'scenario.start', requestId: id, scenario: 'bad-projection' }), { intent: 'scenario.start', requestId: id, scenario: 'bad-projection' });
  assert.deepEqual(parseIntent({ intent: 'incident.reassess', requestId: id, expectedRevision: 3 }), { intent: 'incident.reassess', requestId: id, expectedRevision: 3 });
  assert.equal(parseIntent({ intent: 'incident.approve-reprocess', requestId: id, expectedRevision: 4, planToken: 'p'.repeat(32) }).planToken, 'p'.repeat(32));
  const bad: Record<string, unknown>[] = [
    { intent: 'scenario.skip', requestId: id },                                      // not in the closed set
    { intent: 'quarantine.redrive', requestId: id, expectedRevision: 1 },            // a library-shaped name is not an intent
    { intent: 'scenario.start', requestId: id },                                     // no scenario
    { intent: 'scenario.start', requestId: id, scenario: 'relay-cut' },              // not a source-failures scenario
    { intent: 'incident.reassess', requestId: id },                                  // no expected revision
    { intent: 'incident.reassess', requestId: id, expectedRevision: -1 },
    { intent: 'incident.reassess', requestId: id, expectedRevision: '3' },
    { intent: 'incident.reassess', requestId: 'short', expectedRevision: 1 },
    { intent: 'incident.reassess', requestId: id, expectedRevision: 1, scenario: 'bad-projection' },
    { intent: 'incident.approve-reprocess', requestId: id, expectedRevision: 1 },    // no plan token
    { intent: 'incident.evaluate', requestId: id, expectedRevision: 1, planToken: 'p'.repeat(32) },
    ...['bench', 'sourceId', 'topic', 'partition', 'offset', 'incidentId', 'payload', 'handler', 'policy', 'action'].map(key => ({ intent: 'incident.retry-current', requestId: id, expectedRevision: 1, [key]: 1 }))
  ];
  for (const body of bad) assert.throws(() => parseIntent(body), (error: unknown) => error instanceof LabError && error.code === 'invalid-request' && error.status === 400, JSON.stringify(body));
  for (const intent of INTENTS) {
    const body = { intent, requestId: id, ...(intent === 'scenario.start' ? { scenario: 'garbled-reading' } : { expectedRevision: 0 }), ...(intent === 'incident.approve-reprocess' ? { planToken: 'p'.repeat(16) } : {}) };
    assert.throws(() => refuseIntent(body), (error: unknown) => error instanceof LabError && error.code === 'unsupported-scenario' && error.status === 409, intent);
  }
});

test('GET /api/lab/capabilities needs no session, and intents are refused before any bench is touched', async () => {
  const calls: string[] = [];
  const pool = new LeasePool({ client: { async call<T>(_bench: 1 | 2 | 3, path: string): Promise<T> { calls.push(path); throw new Error('no bench in this test'); } }, benches: [1], gatewayOrigin: 'https://demo.test' });
  for (const lab of [undefined, pool]) {
    const server = publicApi({ config: readConfig({ SITE_ORIGIN: 'https://site.test' }), station: {} as FieldStation, notebooks: {} as Notebooks, ...(lab ? { lab } : {}) });
    await serving(server, async origin => {
      const answer = await fetch(`${origin}/api/lab/capabilities`, { headers: { origin: 'https://site.test' } });
      assert.equal(answer.status, 200); assert.equal(answer.headers.get('access-control-allow-origin'), 'https://site.test'); assert.equal(answer.headers.get('set-cookie'), null);
      const summary = await answer.json() as LabCapabilities;
      assert.equal(summary.backend.lab, lab ? 'enabled' : 'disabled');
      assert.equal(summary.library.version, INSTALLED_STREAMOTTER);
      assert.equal((await fetch(`${origin}/api/lab/capabilities?scenario=bad-projection`)).status, 400);
      assert.equal((await fetch(`${origin}/api/lab/capabilities`, { method: 'POST', headers: { origin: 'https://site.test' } })).status, 404);

      const intent = { intent: 'scenario.start', requestId: 'req-00000001', scenario: 'garbled-reading' };
      const post = (body: unknown, cookie?: string) => fetch(`${origin}/api/lab/actions`, { method: 'POST', headers: { origin: 'https://site.test', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      assert.equal((await post(intent)).status, 401);
      const join = await fetch(`${origin}/api/lab/lease`, { method: 'POST', headers: { origin: 'https://site.test' } });
      const cookie = join.headers.get('set-cookie')!.split(';')[0]!;
      const refused = await post(intent, cookie);
      assert.equal(refused.status, 409); assert.equal((await refused.json() as { code: string }).code, 'unsupported-scenario');
      assert.equal(refused.headers.get('access-control-allow-origin'), 'https://site.test');
      assert.equal((await post({ ...intent, bench: 2 }, cookie)).status, 400);
      assert.equal((await post({ ...intent, action: 'sensor.foul' }, cookie)).status, 400);
      const foreign = await fetch(`${origin}/api/lab/actions`, { method: 'POST', headers: { origin: 'https://evil.test', cookie, 'content-type': 'application/json' }, body: JSON.stringify(intent) });
      assert.equal(foreign.status, 403);
      // An existing action keeps its old behavior: with no lease, no-lease (or lab-unavailable with no Lab at all).
      const action = await post({ action: 'sensor.foul' }, cookie);
      assert.equal((await action.json() as { code: string }).code, lab ? 'no-lease' : 'lab-unavailable');
    });
  }
  assert.ok(!calls.some(path => path.startsWith('/bench/v1/actions')), 'no intent reached a bench');
});
