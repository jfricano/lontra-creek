import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { INSTALLED_INTEGRITY, INSTALLED_STREAMOTTER, INTENTS, LAB_CONTRACT, SCENARIOS, VERIFIED_WITH, labCapabilities, parseIntent, streamOtterIntegrity, type Verification } from '../src/lab/capabilities.ts';
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
    assert.equal(parseIntent(body).intent, intent);
  }
});

test('0.2.0-rc.1 is verified for every new scenario, and the deployment still decides which are offered', () => {
  // Each one passed deploy/test/lab-source-failures.test.ts on dev:lab (section 12.9): all under quarantine, calibration-blip also under retry.
  const recorded = VERIFIED_WITH.get('0.2.0-rc.1')!;
  assert.deepEqual(Object.keys(recorded.scenarios).sort(), [...NEW].sort());
  for (const id of NEW) assert.deepEqual([...recorded.scenarios[id as keyof Verification['scenarios']]!].sort(), id === 'calibration-blip' ? ['quarantine', 'retry'] : ['quarantine'], id);
  assert.match(LAB_CONTRACT, /W9b/);
  const at = (profile: 'off' | 'retry' | 'quarantine', localExercises = false) => labCapabilities({ labEnabled: true, now: 0, version: '0.2.0-rc.1', profile, localExercises, integrity: recorded.packages });
  // The hosted default: retry, no local exercises. Only calibration-blip is offered.
  for (const id of NEW) assert.equal(scenario(at('retry'), id).available, id === 'calibration-blip', id);
  for (const id of NEW) assert.equal(scenario(at('quarantine', true), id).available, true, id);
  for (const id of NEW) assert.equal(scenario(at('off', true), id).reason?.code, 'deployment-restricted', id);
  // A release nobody verified is still not integrated.
  for (const id of NEW) assert.equal(scenario(labCapabilities({ labEnabled: true, now: 0, version: '0.2.0-rc.2', profile: 'quarantine', localExercises: true }), id).reason?.code, 'not-integrated', id);
});

test('the recorded evidence ran exactly the StreamOtter packages the lockfile installs', () => {
  // An independent read of package-lock.json. When it changes (the registry release replacing the
  // pre-publish pack, or any other rebuild of a recorded version), this fails until
  // deploy/test/lab-source-failures.test.ts (and deploy/test/sandbox.test.ts) are run again on dev:lab
  // against that install and VERIFIED_WITH records the new integrity (lab-api.md section 12.3).
  const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8')) as Parameters<typeof streamOtterIntegrity>[0];
  const locked = streamOtterIntegrity(lock);
  assert.equal(Object.keys(locked).length, 6, JSON.stringify(locked));
  assert.deepEqual(INSTALLED_INTEGRITY, locked, 'the field station reads the same lockfile');
  const recorded = VERIFIED_WITH.get(INSTALLED_STREAMOTTER);
  if (recorded) assert.deepEqual(locked, recorded.packages, `StreamOtter ${INSTALLED_STREAMOTTER}'s packages differ from the ones its real-Kafka evidence ran: run deploy/test/lab-source-failures.test.ts and deploy/test/sandbox.test.ts on this install, then re-record VERIFIED_WITH`);
  for (const [version, verification] of VERIFIED_WITH) {
    assert.equal(Object.keys(verification.packages).length, 6, version);
    for (const value of Object.values(verification.packages)) assert.match(value, /^sha512-[A-Za-z0-9+/]{86}==$/, version);
  }
});

test('another build of a verified release offers nothing new, and says so', () => {
  const recorded = VERIFIED_WITH.get('0.2.0-rc.1')!;
  const other = { ...recorded.packages, 'node_modules/streamotter': `sha512-${'A'.repeat(86)}==` };
  for (const integrity of [other, null, { ...recorded.packages, 'node_modules/@streamotter/extra': recorded.packages['node_modules/streamotter']! }]) {
    const summary = labCapabilities({ labEnabled: true, now: 0, version: '0.2.0-rc.1', profile: 'quarantine', localExercises: true, integrity });
    for (const id of NEW) {
      assert.equal(scenario(summary, id).reason?.code, 'not-integrated', id);
      assert.match(scenario(summary, id).reason!.text, /another build of StreamOtter 0\.2\.0-rc\.1/);
    }
    for (const feature of Object.values(summary.features)) assert.equal(feature.reason?.code, 'not-integrated');
  }
});

describe('the capability matrix with an injected verified set (section 12.3)', () => {
  const packages = { 'node_modules/streamotter': `sha512-${'B'.repeat(86)}==` };
  // Evidence for every profile a scenario can run under, unless a test says otherwise.
  const evidence = (only: LabScenarioId[], profiles?: ('retry' | 'quarantine')[]): ReadonlyMap<string, Verification> => new Map([['0.2.0-rc.1', {
    packages, evidence: 'injected', scenarios: Object.fromEntries(only.map(id => [id, profiles ?? (id === 'calibration-blip' ? ['retry', 'quarantine'] : ['quarantine'])]))
  }]]);
  const verified = evidence(NEW);
  const summary = (options: { profile: 'off' | 'retry' | 'quarantine'; localExercises?: boolean; labEnabled?: boolean; only?: LabScenarioId[]; profiles?: ('retry' | 'quarantine')[] }) =>
    labCapabilities({ labEnabled: options.labEnabled ?? true, now: 0, version: '0.2.0-rc.1', profile: options.profile, localExercises: options.localExercises ?? false, integrity: packages, verified: options.only || options.profiles ? evidence(options.only ?? NEW, options.profiles) : verified });
  // Restated by hand from section 12.2, not read from the implementation.
  const RETRY_ONLY = ['calibration-blip'];
  const LOCAL = ['too-many-bad-readings', 'restart-recovery', 'unavailable-evidence'];

  test('hosted (retry, no local exercises) offers only calibration-blip among the new scenarios', () => {
    const hosted = summary({ profile: 'retry' });
    for (const id of NEW) {
      const s = scenario(hosted, id);
      assert.equal(s.available, RETRY_ONLY.includes(id), id);
      if (!s.available) assert.equal(s.reason!.code, 'deployment-restricted', id);
    }
    assert.match(scenario(hosted, 'bad-projection').reason!.text, /Kafka authorization/);
    assert.equal(hosted.features.intents.available, true); assert.equal(hosted.features.incidentProjection.available, true);
    for (const id of EXISTING) assert.equal(scenario(hosted, id).available, true);
  });

  test('local and CI (quarantine with local exercises) offer every new scenario; without them, the local ones say so', () => {
    for (const id of NEW) assert.equal(scenario(summary({ profile: 'quarantine', localExercises: true }), id).available, true, id);
    const shared = summary({ profile: 'quarantine' });
    for (const id of NEW) {
      assert.equal(scenario(shared, id).available, !LOCAL.includes(id), id);
      if (LOCAL.includes(id)) { assert.equal(scenario(shared, id).reason!.code, 'deployment-restricted'); assert.match(scenario(shared, id).reason!.text, /only on a local Lab and in CI/); }
    }
  });

  test('profile off offers nothing new, and neither feature', () => {
    const off = summary({ profile: 'off', localExercises: true });
    for (const id of NEW) assert.equal(scenario(off, id).reason?.code, 'deployment-restricted', id);
    for (const feature of Object.values(off.features)) { assert.equal(feature.available, false); assert.equal(feature.reason?.code, 'deployment-restricted'); }
  });

  test('the reasons come in order: library, verification, the Lab itself, then the deployment', () => {
    assert.equal(scenario(labCapabilities({ labEnabled: false, now: 0, version: '0.1.0-rc.3', profile: 'off', verified, integrity: packages }), 'garbled-reading').reason!.code, 'library-lacks-capability');
    assert.equal(scenario(summary({ profile: 'off', labEnabled: false, only: [] }), 'garbled-reading').reason!.code, 'not-integrated');
    assert.equal(scenario(summary({ profile: 'off', labEnabled: false }), 'garbled-reading').reason!.code, 'lab-disabled');
    assert.equal(scenario(summary({ profile: 'off' }), 'garbled-reading').reason!.code, 'deployment-restricted');
  });

  test('a scenario is offered only under a profile it was proven under', () => {
    // Proven under quarantine only: under retry it is not integrated, not merely restricted.
    const retry = summary({ profile: 'retry', profiles: ['quarantine'] });
    assert.equal(scenario(retry, 'calibration-blip').reason?.code, 'not-integrated');
    assert.match(scenario(retry, 'calibration-blip').reason!.text, /failure handling \(retry\)/);
    assert.equal(retry.features.intents.available, false);
    assert.equal(scenario(summary({ profile: 'quarantine', profiles: ['quarantine'] }), 'calibration-blip').available, true);
    // A profile the scenario can't run under at all is still the deployment's restriction.
    assert.equal(scenario(summary({ profile: 'retry', profiles: ['quarantine'] }), 'bad-projection').reason?.code, 'deployment-restricted');
  });

  test('the features are available exactly when some new scenario is', () => {
    for (const profile of ['off', 'retry', 'quarantine'] as const) for (const localExercises of [false, true]) for (const only of [[], ['calibration-blip'], ['restart-recovery'], NEW] as LabScenarioId[][]) {
      const s = summary({ profile, localExercises, only });
      const any = s.scenarios.some(item => NEW.includes(item.id) && item.available);
      assert.equal(s.features.intents.available, any, JSON.stringify({ profile, localExercises, only }));
      assert.equal(s.features.incidentProjection.available, any);
    }
  });
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
