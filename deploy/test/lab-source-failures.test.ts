/**
 * The source-failures exercises (LC11-S01 to S09) on the real-Kafka Lab, end to end:
 * the visitor's intents through Caddy, each bench's StreamOtter 0.2.0-rc.1 failure
 * handling on Kafka with ACLs, and an independent observer of the broker. Run against
 * `npm run dev:lab` (docs/LOCAL_LAB.md), or a CI stack with LAB_FAILURE_HANDLING=quarantine
 * and LAB_LOCAL_EXERCISES=1:
 *
 *   C="docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml \
 *     -f deploy/compose.sandbox.yaml -f deploy/compose.local-lab.yaml --env-file .local/lab/.env"
 *   LAB_API_ORIGIN=https://localhost:8443 LAB_SITE_ORIGIN=https://localhost:8443 \
 *   NODE_EXTRA_CA_CERTS=$PWD/.local/lab/secrets/origin/ca.pem \
 *   LAB_STACK_EXEC="$C exec -T" LAB_STACK_RESTART="$C restart" \
 *     node --test --test-force-exit deploy/test/lab-source-failures.test.ts
 *
 * Each scenario runs on a study of its own: it leases a bench, starts the scenario, follows
 * the projection and its operations, and returns the bench, which discards the study. A
 * scenario the backend's capability summary doesn't offer is skipped with its reason.
 *
 * LAB_STACK_EXEC (a shell prefix that runs a command in a Compose service) adds the
 * observer: as the broker's own loopback super user it reads the quarantine topic's
 * bytes and headers and each study group's committed offset, deletes S09's evidence, and
 * looks at the benches' volumes. LAB_STACK_RESTART (a prefix the service name is appended
 * to) restarts a bench container with its volume for S08. Without them those checks skip.
 */
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { after, before, describe, test } from 'node:test';
import { createClient } from 'streamotter/client';
import type { Client, SubscriptionState } from 'streamotter/client';
import type { LabChannels } from '../../apps/field-station/src/lab/bench.ts';
import type { LabCapabilities, LabFeedPage, LabIncidentSummary, LabIncidentView, LabIntent, LabLease, LabOperation, LabScenarioId, LabToken } from '../../apps/field-station/src/lab/contract.ts';

const API = process.env['LAB_API_ORIGIN'];
const SITE = process.env['LAB_SITE_ORIGIN'] ?? 'https://streamotter.dev';
const EXEC = process.env['LAB_STACK_EXEC'];
const RESTART = process.env['LAB_STACK_RESTART'];
// The Node SDK transport sends no browser Origin; the site's page would.
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
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, label: string, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(1000);
  }
}
/** Runs a shell command, optionally feeding it standard input; rejects on a non-zero exit. */
function sh(command: string, input?: string, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(command, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${command.slice(0, 160)}: ${error.message}\n${stderr}`)) : resolve(stdout));
    child.stdin?.end(input ?? '');
  });
}

// ---------------------------------------------------------------------------
// The observer: the broker's own tools on its loopback listener, never the bench's client.
// ---------------------------------------------------------------------------
const kafkaTool = (tool: string, args: string, input?: string) => sh(`${EXEC} kafka env KAFKA_HEAP_OPTS=-Xmx256m /opt/kafka/bin/${tool} --bootstrap-server 127.0.0.1:9092 ${args}`, input);
/** The console consumer exits non-zero when --timeout-ms ends it, which is how a read of everything so far ends. */
const consume = (args: string) => sh(`${EXEC} kafka env KAFKA_HEAP_OPTS=-Xmx256m /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server 127.0.0.1:9092 ${args} 2> /dev/null || true`);
interface QuarantineCopy { offset: number; envelope: { generation: string; position: { topic: string; partition: number; offset: string }; diagnosis: { failureClass: string }; evidence: { hash: string } }; failureId: string; key: string; value: string }
const SEP = '~|~';
const HEADER_SEP = '~|H|~';
const END = '~|END|~';
/** Every record in a bench's quarantine topic, with its headers. */
async function quarantineCopies(bench: number): Promise<QuarantineCopy[]> {
  const format = ['print.offset=true', 'print.headers=true', 'print.key=true', `key.separator=${SEP}`, `headers.separator=${HEADER_SEP}`, `line.separator=${END}`].map(option => `--property '${option}'`).join(' ');
  const out = await consume(`--topic lab-${bench}.quarantine --from-beginning --timeout-ms 8000 ${format}`);
  return out.split(END).map(line => line.trim()).filter(line => line.startsWith('Offset:')).map(line => {
    const [offset, headers, key, ...value] = line.split(SEP);
    const named = new Map((headers ?? '').split(HEADER_SEP).map(item => [item.slice(0, item.indexOf(':')), item.slice(item.indexOf(':') + 1)] as const));
    return { offset: Number(offset!.slice('Offset:'.length)), envelope: JSON.parse(named.get('streamotter-envelope') ?? 'null') as QuarantineCopy['envelope'], failureId: named.get('streamotter-failure-id') ?? '', key: key ?? '', value: value.join(SEP) };
  });
}
/** The source record at the incident's coordinates, as Kafka holds it. */
async function sourceRecord(topic: string, partition: number, offset: string): Promise<string> {
  const out = await consume(`--topic ${topic} --partition ${partition} --offset ${offset} --max-messages 1 --timeout-ms 10000`);
  return out.replace(/\n$/, '');
}
/** A study group's committed offset on one partition; null when nothing is committed. */
async function committed(group: string, topic: string, partition: number): Promise<number | null> {
  const out = await kafkaTool('kafka-consumer-groups.sh', `--describe --group ${group} --offsets`).catch(() => '');
  for (const line of out.split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells[0] === group && cells[1] === topic && Number(cells[2]) === partition) return /^\d+$/.test(cells[3] ?? '') ? Number(cells[3]) : null;
  }
  return null;
}
const groups = async (): Promise<string[]> => (await kafkaTool('kafka-consumer-groups.sh', '--list')).split('\n').map(line => line.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// The visitor: the public Lab API through Caddy, with the session cookie the page would hold.
// ---------------------------------------------------------------------------
let cookie = '';
/** One Lab request. The Lab request budget (3 a second per address) is waited out, as the page waits it out. */
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  for (;;) {
    const response = await fetch(`${API}/api/lab/${path}`, { method, headers: { origin: SITE, cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const set = response.headers.get('set-cookie');
    if (set && !cookie) cookie = set.split(';')[0]!;
    const answer = await response.json() as T & { code?: string };
    if (response.status === 429 && answer.code === 'too-many-requests') { await sleep(1000 * Number(response.headers.get('retry-after') ?? 1)); continue; }
    return { status: response.status, body: answer };
  }
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const answer = await request<T>(path, method, body);
  assert.equal(answer.status, 200, `${method} ${path}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}
const NATIVE = /\bf1:|\brb1:|\bop1:|\bpl1:|\/var\/lib|\/journal|\.sqlite/;

/** One lease on one study: its bench, the visitor's LC-03 view, and the intents it sends. */
class Exercise {
  readonly bench: number;
  readonly views: LabIncidentView[] = [];
  readonly states: SubscriptionState[] = [];
  state: SubscriptionState = 'authorizing';
  frames = 0;
  #lastIntent = 0;
  #heartbeat: NodeJS.Timeout;
  readonly token: LabToken;
  #client: Client<LabChannels> | null = null;
  private constructor(token: LabToken) {
    this.token = token; this.bench = token.bench;
    this.#heartbeat = setInterval(() => void request('lease').catch(() => undefined), 5000);
  }
  static async start(): Promise<Exercise> {
    let lease = await api<LabLease>('lease', 'POST', {});
    lease = await until(async () => { const now = lease.status === 'ready' ? lease : await api<LabLease>('lease'); return now.status === 'ready' || now.status === 'active' ? now : false; }, 'a ready bench', 180_000);
    const exercise = new Exercise(await api<LabToken>('lease/token', 'POST', {}));
    await exercise.subscribe();
    return exercise;
  }
  /** A new SDK client and a new LC-03 subscription, as a page that reloads makes. */
  async subscribe(): Promise<void> {
    const client = createClient<LabChannels>({ origin: this.token.gatewayOrigin, path: this.token.gatewayPath, getToken: async () => (await api<LabToken>('lease/token', 'POST', {})).token });
    this.#client = client;
    const view = client.subscribe('station', { channelVersion: 1, params: { stationId: 'LC-03' } });
    view.on('state', event => { if (this.#client !== client) return; this.state = event.state; this.states.push(event.state); });
    view.on('data', () => { if (this.#client === client) this.frames++; });
    await view.ready({ timeoutMs: 60_000 });
  }
  /** Closes the page's client: nothing of this visitor reaches the bench until subscribe() (heartbeats don't). */
  async close(): Promise<void> { const client = this.#client; this.#client = null; this.state = 'closed'; await client?.close().catch(() => undefined); }
  async end(): Promise<void> {
    clearInterval(this.#heartbeat);
    await this.close();
    await request('lease/return', 'POST').catch(() => undefined);
  }
  /** The projection, checked for native identifiers and paths every time it is read. */
  async incident(): Promise<LabIncidentView> {
    const answer = await request<LabIncidentView>('incident');
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.doesNotMatch(JSON.stringify(answer.body), NATIVE, 'the projection carries no native ID or path');
    this.views.push(answer.body);
    return answer.body;
  }
  async open(check: (incident: LabIncidentSummary) => boolean, label: string, timeout = 45_000): Promise<LabIncidentSummary> {
    let last: LabIncidentView | undefined;
    try { return await until(async () => { last = await this.incident(); return last.status === 'open' && check(last.incident) ? last.incident : false; }, label, timeout); }
    catch (error) { throw new Error(`${(error as Error).message}; last projection: ${JSON.stringify(last)}`); }
  }
  /** Sends one intent (spacing them past the lease's one-a-second budget) and follows its operation to a final status. */
  async send(intent: LabIntent, extra: { scenario?: LabScenarioId; planToken?: string } = {}, attempts = 5): Promise<LabOperation> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.#lastIntent + 1100 - Date.now(); if (wait > 0) await sleep(wait);
      const view = intent === 'scenario.start' ? null : await this.incident();
      const expectedRevision = view?.status === 'open' ? view.incident.scenarioRevision : undefined;
      const answer = await request<LabOperation & { code?: string }>('actions', 'POST', { intent, requestId: randomUUID(), ...extra, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
      this.#lastIntent = Date.now();
      // The projection moved between reading it and sending: read it again, as the page would.
      if (answer.status === 409 && answer.body.code === 'not-applicable' && attempt < attempts) { await sleep(500); continue; }
      assert.equal(answer.status, 202, `${intent}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.status, 'accepted');
      return until(async () => { const op = await api<LabOperation>(`operations/${answer.body.operationId}`); return op.status === 'accepted' || op.status === 'running' ? false : op; }, `${intent} finished`, 90_000);
    }
  }
  async succeeds(intent: LabIntent, extra: { scenario?: LabScenarioId; planToken?: string } = {}): Promise<LabOperation> {
    const operation = await this.send(intent, extra);
    assert.equal(operation.status, 'succeeded', `${intent}: ${JSON.stringify(operation)}`);
    return operation;
  }
  /** An intent the field station refuses before anything runs. */
  async refused(intent: LabIntent, extra: { planToken?: string } = {}): Promise<{ status: number; code?: string }> {
    const wait = this.#lastIntent + 1100 - Date.now(); if (wait > 0) await sleep(wait);
    const view = await this.incident();
    const answer = await request<{ code?: string }>('actions', 'POST', { intent, requestId: randomUUID(), ...extra, expectedRevision: view.status === 'open' ? view.incident.scenarioRevision : 1 });
    this.#lastIntent = Date.now();
    return { status: answer.status, ...(answer.body.code ? { code: answer.body.code } : {}) };
  }
  /** The whole trace feed of this lease so far. */
  async feed(): Promise<LabFeedPage['items']> {
    const items: LabFeedPage['items'] = [];
    let after = '';
    for (;;) { const page = await api<LabFeedPage>(`trace?after=${encodeURIComponent(after)}`); items.push(...page.items); if (page.items.length === 0 || page.next === after) return items; after = page.next; }
  }
  async live(label: string, timeout = 60_000): Promise<void> { await until(() => this.state === 'live', label, timeout); }
}
/** Runs one scenario on a lease of its own, returning the bench (which discards the study) whatever happens. */
async function exercise(run: (exercise: Exercise) => Promise<void>): Promise<void> {
  const current = await Exercise.start();
  try { await run(current); } finally { await current.end(); }
}
/** The study's consumer group, named from the projection's source generation (`lab-N-<studyId>`). */
const studyGroup = (incident: LabIncidentSummary): string => `streamotter-${incident.detail.sourceGeneration}`;

const capabilities: LabCapabilities | null = API ? await (await fetch(`${API}/api/lab/capabilities`)).json() as LabCapabilities : null;
const offered = (id: LabScenarioId): string | false => {
  const scenario = capabilities?.scenarios.find(item => item.id === id);
  return scenario?.available ? false : `${id} isn't offered here: ${scenario?.reason?.text ?? 'no capability summary'}`;
};

describe('the source-failures exercises on real Kafka', { skip: !API && 'LAB_API_ORIGIN not set' }, () => {
  before(async () => { await until(async () => (await api<{ benches: { state: string }[] }>('status')).benches.some(bench => bench.state === 'ready'), 'a ready bench', 120_000); });
  after(async () => { if (cookie) await request('lease/return', 'POST').catch(() => undefined); });

  test('the intent and incident routes are served exactly while a new scenario is offered', async () => {
    const any = capabilities!.scenarios.some(scenario => !['fouled-sensor', 'relay-cut', 'slow-client', 'relay-restart'].includes(scenario.id) && scenario.available);
    assert.equal(capabilities!.features.intents.available, any);
    assert.equal(capabilities!.features.incidentProjection.available, any);
    assert.equal(capabilities!.library.version, '0.2.0-rc.1');
  });

  test('LC11-S01 fouled sensor: a pause incident, no evidence, restored and retried in place', { skip: !capabilities?.features.intents.available && 'source-failure intents are not offered here' }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'fouled-sensor' });
    const held = await lab.open(i => i.source === 'held' && i.nextIntent === 'scenario.restore-calibration', 'a held mapper-error incident');
    assert.deepEqual([held.failure.class, held.policy, held.evidence, held.recovery], ['mapper-error', 'pause', 'not-required', 'none']);
    await until(() => lab.state === 'stale', 'the LC-03 view stale');
    await lab.succeeds('scenario.restore-calibration');
    await lab.open(i => i.nextIntent === 'incident.retry-current', 'retry offered once calibration is back');
    await lab.succeeds('incident.retry-current');
    const processed = await lab.open(i => i.source === 'processed', 'the record processed on retry');
    assert.equal(processed.nextIntent, null);
    assert.ok(processed.steps.some(step => step.origin === 'library' && step.text === 'StreamOtter retried the record'), JSON.stringify(processed.steps));
    await lab.live('the LC-03 view live again');
  }));

  test('LC11-S02 garbled reading: quarantined and held; reassess refused; evaluation still fails', { skip: offered('garbled-reading') }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'garbled-reading' });
    const held = await lab.open(i => i.evidence === 'saved' && i.source === 'held', 'a quarantined, held garbled record');
    assert.deepEqual([held.failure.class, held.policy, held.recovery, held.nextIntent], ['invalid-json', 'quarantine-hold', 'none', 'incident.retry-current']);
    await until(() => lab.state === 'stale', 'the LC-03 view stale');
    if (EXEC) {
      // The broker holds the record's exact bytes, under the incident's coordinates, and the study's group stays before it.
      const copies = (await quarantineCopies(lab.bench)).filter(copy => copy.envelope?.generation === held.detail.sourceGeneration);
      assert.equal(copies.length, 1, JSON.stringify(copies.map(copy => copy.envelope)));
      const copy = copies[0]!;
      assert.deepEqual(copy.envelope.position, { ...copy.envelope.position, topic: held.detail.topic, partition: held.detail.partition, offset: held.detail.offset });
      assert.equal(copy.envelope.diagnosis.failureClass, 'invalid-json');
      assert.equal(copy.envelope.evidence.hash, held.detail.evidenceFingerprint);
      assert.equal(copy.key, 'station:LC-03');
      assert.equal(copy.value, await sourceRecord(held.detail.topic, held.detail.partition, held.detail.offset));
      assert.throws(() => JSON.parse(copy.value), 'the evidence is the garbled record, not a repaired one');
      const at = await committed(studyGroup(held), held.detail.topic, held.detail.partition);
      assert.ok(at !== null && at <= Number(held.detail.offset), `committed ${at}, record ${held.detail.offset}`);
    }
    await lab.succeeds('incident.retry-current');
    assert.equal((await lab.open(i => i.source === 'held', 'still held after a retry')).evidence, 'saved');
    const reassess = await lab.send('incident.reassess');
    assert.equal(reassess.status, 'refused');
    assert.match(reassess.detail ?? '', /keeps the source held/);
    await lab.succeeds('incident.evaluate');
    const evaluated = await lab.open(i => i.evaluation !== null, 'an evaluation');
    assert.equal(evaluated.evaluation!.result, 'failed');
    assert.equal(evaluated.evaluation!.planToken, null);
    assert.match(evaluated.evaluation!.summary, /still fails/);
    assert.equal(evaluated.source, 'held');
    if (EXEC) {
      // Reading the evidence back used a throwaway group, deleted afterwards.
      const left = (await groups()).filter(group => group.startsWith(`streamotter-lontra-creek-lab-${lab.bench}-quarantine-read-`));
      assert.deepEqual(left, []);
    }
  }));

  test('LC11-S03 bad projection: held until coverage is established, then advanced under a boundary and resynchronized', { skip: offered('bad-projection') }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'bad-projection' });
    const held = await lab.open(i => i.source === 'held' && i.recovery === 'coverage-not-ready', 'held: coverage not ready');
    assert.deepEqual([held.failure.class, held.policy, held.evidence, held.nextIntent], ['payload-schema', 'quarantine-resync', 'saved', 'scenario.prepare-coverage']);
    await until(() => lab.state === 'stale', 'the LC-03 view stale');
    const before = EXEC ? await committed(studyGroup(held), held.detail.topic, held.detail.partition) : null;
    if (EXEC) assert.ok(before !== null && before <= Number(held.detail.offset), `committed ${before}`);
    await lab.succeeds('scenario.prepare-coverage');
    await lab.open(i => i.recovery === 'coverage-established' && i.nextIntent === 'incident.reassess', 'coverage established');
    assert.equal(lab.state, 'stale', 'coverage alone changes nothing on the source');
    await lab.succeeds('incident.reassess');
    const advanced = await lab.open(i => i.source === 'advanced', 'advanced past the record');
    assert.ok(advanced.steps.some(step => step.text.startsWith('The advance was confirmed')), JSON.stringify(advanced.steps));
    await lab.live('the LC-03 view live through a snapshot that acknowledges the boundary', 90_000);
    const resynchronized = await lab.open(i => i.recovery === 'view-resynchronized', 'the view resynchronized');
    assert.equal(resynchronized.nextIntent, null);
    if (EXEC) {
      const at = await committed(studyGroup(held), held.detail.topic, held.detail.partition);
      assert.ok(at !== null && at >= Number(held.detail.offset) + 1, `committed ${at}, record ${held.detail.offset}`);
      // The first hold saved one copy; reassessing wrote a fresh one before the guard was asked again.
      const copies = (await quarantineCopies(lab.bench)).filter(copy => copy.envelope?.generation === held.detail.sourceGeneration && copy.envelope.position.offset === held.detail.offset);
      assert.equal(copies.length, 2, JSON.stringify(copies.map(copy => copy.offset)));
      assert.equal(new Set(copies.map(copy => copy.failureId)).size, 1);
      assert.equal(copies[0]!.value, await sourceRecord(held.detail.topic, held.detail.partition, held.detail.offset));
    }
  }));

  test('LC11-S04 inspect an old reading: corrected handlers evaluate it, and one approved reprocessing is superseded', { skip: offered('inspect-old-reading') }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'inspect-old-reading' });
    const ready = await lab.open(i => i.source === 'advanced' && i.nextIntent === 'incident.evaluate', 'advanced, with corrected handlers');
    assert.equal(ready.failure.class, 'payload-schema');
    await lab.succeeds('incident.evaluate');
    const passed = await lab.open(i => i.evaluation?.result === 'passed' && i.nextIntent === 'incident.approve-reprocess', 'an evaluation that passed with a plan');
    const token = passed.evaluation!.planToken!;
    assert.match(token, /^[A-Za-z0-9_-]{16,512}$/);
    assert.ok(Date.parse(passed.evaluation!.expiresAt!) > Date.now());
    const approved = await lab.send('incident.approve-reprocess', { planToken: token });
    assert.equal(approved.status, 'succeeded', JSON.stringify(approved));
    const done = await lab.open(i => i.reprocess !== null, 'the reprocessing result');
    assert.ok(done.reprocess === 'superseded' || done.reprocess === 'reprocessed', String(done.reprocess));
    assert.equal(done.evaluation?.planToken ?? null, null, 'the token is spent');
    // A spent token is no longer the projection's: refused before anything runs.
    assert.deepEqual(await lab.refused('incident.approve-reprocess', { planToken: token }), { status: 409, code: 'not-applicable' });
    await lab.live('the LC-03 view live');
  }));

  test('LC11-S05 conflicting readings: an integrity hold that nothing continues past', { skip: offered('conflicting-readings') }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'conflicting-readings' });
    const held = await lab.open(i => i.source === 'held', 'a held revision conflict');
    assert.deepEqual([held.failure.class, held.policy, held.evidence], ['revision-conflict', 'pause', 'not-required']);
    const reassess = await lab.send('incident.reassess');
    assert.equal(reassess.status, 'refused');
    assert.match(reassess.detail ?? '', /integrity fault/);
    await lab.succeeds('incident.retry-current');
    assert.equal((await lab.open(i => i.source === 'held', 'still held after a retry')).failure.class, 'revision-conflict');
    await until(() => lab.state === 'stale', 'the LC-03 view stale');
  }));

  test('LC11-S06 calibration blip: one retry absorbs it; a sustained one runs out of retries, then is processed', { skip: offered('calibration-blip') }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'calibration-blip' });
    // The bounded retry succeeds: no incident opens and the view stays live.
    const framesBefore = lab.frames;
    await until(() => lab.frames >= framesBefore + 3, 'readings keep arriving', 60_000);
    assert.equal((await lab.incident()).status, 'none');
    assert.equal(lab.state, 'live');
    // The feed shows the timed-out attempt and the retry that mapped the same record.
    const feed = await lab.feed();
    const failed = feed.find(item => item.kind === 'record' && item.outcome === 'failed');
    assert.ok(failed?.kind === 'record', JSON.stringify(feed.filter(item => item.kind === 'record')));
    assert.ok(feed.some(item => item.kind === 'record' && item.outcome === 'processed' && item.offset === failed.offset && item.partition === failed.partition), 'the same record processed on retry');
    await lab.succeeds('scenario.start', { scenario: 'calibration-blip' });
    const held = await lab.open(i => i.source === 'held', 'retries exhausted', 60_000);
    assert.deepEqual([held.failure.class, held.policy, held.evidence, held.nextIntent], ['mapper-transient', 'pause', 'not-required', 'scenario.restore-calibration']);
    await lab.succeeds('scenario.restore-calibration');
    await lab.open(i => i.nextIntent === 'incident.retry-current', 'retry offered once the lookup is back');
    await lab.succeeds('incident.retry-current');
    await lab.open(i => i.source === 'processed', 'the record processed on retry');
    await lab.live('the LC-03 view live again');
  }));

  test('LC11-S07 too many bad readings: five advance, the sixth opens the circuit and holds', { skip: offered('too-many-bad-readings') }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'too-many-bad-readings' });
    const held = await lab.open(i => i.source === 'held' && i.label === 'Incident 6', 'the sixth incident held', 90_000);
    assert.equal(held.failure.class, 'payload-schema');
    assert.equal(held.nextIntent, null);
    assert.match(held.reason, /automatic continuation stopped/);
    const retry = await lab.send('incident.retry-current');
    assert.equal(retry.status, 'refused');
    assert.match(retry.detail ?? '', /automatic continuation stopped/);
    if (EXEC) {
      const at = await committed(studyGroup(held), held.detail.topic, held.detail.partition);
      assert.ok(at !== null && at <= Number(held.detail.offset), `committed ${at}, sixth record ${held.detail.offset}`);
    }
  }));

  test('LC11-S08 restart recovery: the boundary survives a gateway and a container restart', { skip: offered('restart-recovery') }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'restart-recovery' });
    const advanced = await lab.open(i => i.label === 'Incident 2' && i.source === 'advanced', 'both readings advanced past', 90_000);
    await lab.live('the LC-03 view live after the boundary', 90_000);
    const settled = await lab.open(i => i.recovery === 'view-resynchronized', 'resynchronized');
    const restartedOnce = lab.states.length;
    await sleep(1100);
    await api('actions', 'POST', { action: 'gateway.restart' });
    await until(() => lab.states.slice(restartedOnce).includes('stale') && lab.state === 'live', 'live again after the gateway restart', 120_000);
    const afterGateway = await lab.open(i => i.label === advanced.label, 'the same incident after the gateway restart');
    assert.deepEqual([afterGateway.detail, afterGateway.source], [settled.detail, 'advanced']);
    if (RESTART && EXEC) {
      // A bench container restart with its volume (LC11-A15). The visitor's page is closed meanwhile: any of its
      // calls that reaches a bench that doesn't answer ends the lease (section 4), and heartbeats don't reach it.
      const before = JSON.parse(await sh(`${EXEC} lab-${lab.bench} cat /var/lib/lontra/lab-${lab.bench}/study.json`)) as { studyId: string; restarts: { process: number } };
      await lab.close();
      await sh(`${RESTART} lab-${lab.bench}`, undefined, 120_000);
      // The new process counts itself before its gateway starts; until then the field station's last view can still say running.
      const study = async () => JSON.parse(await sh(`${EXEC} lab-${lab.bench} cat /var/lib/lontra/lab-${lab.bench}/study.json`).catch(() => 'null')) as typeof before | null;
      await until(async () => (await study())?.restarts.process !== before.restarts.process, 'the restarted process booted', 120_000);
      await until(async () => { const lease = await api<LabLease>('lease'); assert.equal(lease.status, 'active', JSON.stringify(lease)); return lease.status === 'active' && lease.benchState.gateway === 'running'; }, 'the lease kept and the bench\'s gateway running again', 120_000);
      const after = (await study())!;
      assert.deepEqual([after.studyId, after.restarts.process], [before.studyId, before.restarts.process + 1], 'the same study, resumed from the volume');
      // A new subscription after the restart goes live only through a snapshot that acknowledges the persisted boundary (LC11-A12).
      await lab.subscribe();
      await lab.live('live again after the container restart', 120_000);
      const afterContainer = await lab.open(i => i.label === advanced.label, 'the same incident after the container restart', 60_000);
      assert.deepEqual([afterContainer.detail, afterContainer.source], [settled.detail, 'advanced']);
    }
  }));

  test('LC11-S09 unavailable evidence: once its copy is deleted, evaluation finds the evidence gone', { skip: offered('unavailable-evidence') || (!EXEC && 'LAB_STACK_EXEC not set: deleting the evidence needs the broker') }, () => exercise(async lab => {
    await lab.succeeds('scenario.start', { scenario: 'unavailable-evidence' });
    const advanced = await lab.open(i => i.source === 'advanced' && i.evidence === 'saved', 'advanced with evidence saved', 60_000);
    // The harness, never a visitor, deletes the bench's quarantine topic up to its end.
    await kafkaTool('kafka-delete-records.sh', '--offset-json-file /dev/stdin', JSON.stringify({ version: 1, partitions: [{ topic: `lab-${lab.bench}.quarantine`, partition: 0, offset: -1 }] }));
    assert.deepEqual((await quarantineCopies(lab.bench)).filter(copy => copy.envelope?.generation === advanced.detail.sourceGeneration), []);
    await lab.succeeds('incident.evaluate');
    const evaluated = await lab.open(i => i.evaluation !== null, 'an evaluation');
    assert.equal(evaluated.evaluation!.result, 'failed');
    assert.equal(evaluated.evaluation!.planToken, null);
    assert.match(evaluated.evaluation!.summary, /couldn't be evaluated: the saved record is no longer available/);
    assert.equal(evaluated.evidence, 'unavailable');
    assert.equal(evaluated.source, 'advanced', 'the source stays where it was: nothing was reprocessed');
    assert.equal(evaluated.nextIntent, null);
  }));

  test('repeated resets leave no study groups, read groups, or study directories behind (LC11-A32)', { skip: !EXEC && 'LAB_STACK_EXEC not set' }, async () => {
    const status = await until(async () => { const now = await api<{ benches: { bench: number; state: string }[] }>('status'); return now.benches.every(bench => bench.state === 'ready') ? now : false; }, 'every bench ready', 180_000);
    const listed = await groups();
    for (const { bench } of status.benches) {
      assert.deepEqual(listed.filter(group => group.startsWith(`streamotter-lontra-creek-lab-${bench}-quarantine-read-`)), [], `bench ${bench} read groups`);
      assert.ok(listed.filter(group => group.startsWith(`streamotter-lab-${bench}-`)).length <= 1, `bench ${bench}: ${listed.join(', ')}`);
      const studies = (await sh(`${EXEC} lab-${bench} ls /var/lib/lontra/lab-${bench}/studies`)).split('\n').filter(Boolean);
      assert.equal(studies.length, 1, `bench ${bench} studies: ${studies.join(', ')}`);
      // No operator socket: failure handling is reached in process only (ADR-03, section 10.2 D8).
      assert.equal((await sh(`${EXEC} lab-${bench} find /var/lib/lontra/lab-${bench}/studies -type s`)).trim(), '');
      assert.equal((await sh(`${EXEC} lab-${bench} stat -c %a /var/lib/lontra/lab-${bench}/studies/${studies[0]}/journal`)).trim(), '700');
    }
  });
});
