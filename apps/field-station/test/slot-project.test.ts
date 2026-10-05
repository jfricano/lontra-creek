/**
 * The sandbox slot's server-owned project (LC11-ADR-04 decision 4): a valid base,
 * schemas taken from the field station and the pinned init scaffold, the scaffold's
 * jobProgress handler and fixture ported faithfully, the creek fixture taken from the
 * simulation, and no state shared between runtimes. Evidence level: unit.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createWorld, currentEmissions, step, TENANT_ID } from '@lontra-creek/sim';
import { scaffoldFiles } from 'streamotter/cli';
import { validateProjectConfig, type HandlerContext, type Json, type Principal, type SourceRecord } from 'streamotter/contracts';
import { createKafkaHandlers } from '../src/kafka-handlers.ts';
import { toRecord } from '../src/records.ts';
import { creekFixture, CREEK_PRINCIPAL, SCAFFOLD_JOBS, SCAFFOLD_PRINCIPAL, SLOT_PRINCIPALS, slotConfig, slotRuntimeParts } from '../src/sandbox/slot-project.ts';

const context: HandlerContext = { signal: new AbortController().signal, requestId: 'slot-test' };
const record = (value: Json, index: number, key: string | null = null): SourceRecord => ({ id: `r${index}`, sourceId: 'test', key, value, receivedAt: '2026-10-04T00:00:00.000Z', position: { kind: 'fixture', index: String(index) } });
const options = { host: '0.0.0.0', port: 7602, siteOrigins: ['https://streamotter.dev'] };

test('A43: the slot base is valid, server-owned, and limited to ADR-04\'s gateway bounds', () => {
  for (const slot of [1, 2, 3] as const) {
    const config = slotConfig(slot, { ...options, port: 7600 + slot });
    assert.deepEqual(validateProjectConfig(config), { valid: true, issues: [] });
    assert.deepEqual([config.projectId, config.gateway.port, config.gateway.path], [`lontra-creek-sandbox-${slot}`, 7600 + slot, `/sandbox/${slot}/socket.io`]);
    assert.deepEqual(config.gateway.allowedOrigins, ['https://streamotter.dev']); assert.deepEqual(config.connections, {});
    assert.deepEqual(Object.values(config.sources).map(s => s.kind), ['fixture', 'fixture'], 'fixture sources only');
    assert.deepEqual(config.limits, { maxConnections: 4, maxSubscriptionsPerConnection: 8 });
  }
  const config = slotConfig(2, options);
  const field = JSON.parse(readFileSync(new URL('../streamotter.json', import.meta.url), 'utf8')) as { schemas: Record<string, unknown> };
  assert.deepEqual([config.schemas['StationParams'], config.schemas['GaugeReading']], [field.schemas['StationParams'], field.schemas['GaugeReading']], 'station schemas are the field station\'s');
  const init = JSON.parse(scaffoldFiles('check').find(f => f.path === 'streamotter.json')!.content) as { sources: Record<string, unknown>; schemas: Record<string, unknown>; channels: Record<string, unknown> };
  assert.deepEqual(config.channels.jobProgress, init.channels['jobProgress'], 'jobProgress is the scaffold\'s channel, verbatim');
  assert.deepEqual(config.sources['jobs'], init.sources['jobs']);
  assert.deepEqual([config.schemas['JobParams'], config.schemas['JobProgress']], [init.schemas['JobParams'], init.schemas['JobProgress']]);
  assert.notEqual(slotConfig(2, options).schemas['GaugeReading'], config.schemas['GaugeReading'], 'every base is a fresh copy');
});

test('A43: the jobProgress handler, fixture, and principal match the pinned init scaffold', async () => {
  const files = new Map(scaffoldFiles('slot-check').map(file => [file.path, file.content]));
  const directory = await mkdtemp(join(tmpdir(), 'lontra-slot-'));
  try {
    await mkdir(join(directory, 'server')); await writeFile(join(directory, 'server', 'handlers.mjs'), files.get('server/handlers.mjs')!);
    // The scaffold keeps module-level state: each comparison imports a fresh copy.
    let copy = 0;
    const load = async () => await import(`${pathToFileURL(join(directory, 'server', 'handlers.mjs')).href}?copy=${++copy}`) as {
      handlers: { channels: { jobProgress: { authorize(i: unknown): Promise<boolean>; map(i: unknown): unknown; snapshot(i: unknown): Promise<unknown> } } };
      development: { principals: Record<string, Principal>; fixtures: { jobs: unknown[] } };
    };
    const scaffold = await load();
    assert.deepEqual(SCAFFOLD_JOBS, scaffold.development.fixtures.jobs);
    assert.deepEqual(SCAFFOLD_PRINCIPAL, scaffold.development.principals['developer']);
    assert.deepEqual(Object.keys(scaffold.development.principals), ['developer']);

    const ours = slotRuntimeParts().handlers.channels.jobProgress; const theirs = scaffold.handlers.channels.jobProgress;
    const outcome = async (run: () => unknown) => { try { return { value: await run() }; } catch (error) { return { error: (error as Error).message }; } };
    const steps: [string, (h: typeof theirs) => unknown][] = [];
    for (const principal of [SCAFFOLD_PRINCIPAL, CREEK_PRINCIPAL]) for (const jobId of ['job_1', 'job_2']) {
      steps.push([`authorize ${principal.subject} ${jobId}`, h => h.authorize({ ...context, principal, params: { jobId } })]);
      steps.push([`snapshot ${principal.subject} ${jobId}`, h => h.snapshot({ ...context, principal, params: { jobId } })]);
    }
    SCAFFOLD_JOBS.forEach((r, i) => {
      steps.push([`map ${i}`, h => h.map({ ...context, record: record((r as { value: Json }).value, i, r.key) })]);
      steps.push([`snapshot after ${i}`, h => h.snapshot({ ...context, principal: SCAFFOLD_PRINCIPAL, params: { jobId: 'job_1' } })]);
    });
    steps.push(['map an older revision', h => h.map({ ...context, record: record({ tenantId: 'local', revision: '3', job: { jobId: 'job_1', state: 'running', percent: 60 } }, 9) })]);
    steps.push(['snapshot keeps the newest', h => h.snapshot({ ...context, principal: SCAFFOLD_PRINCIPAL, params: { jobId: 'job_1' } })]);
    for (const [label, run] of steps) assert.deepEqual(await outcome(() => run(ours as unknown as typeof theirs)), await outcome(() => run(theirs)), label);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('A43: the creek fixture is the simulation\'s first study day of station records, mapped as the field station maps them', async () => {
  const world = createWorld({ seed: 'lontra-creek' });
  const initial = currentEmissions(world).filter(e => e.channel === 'station');
  const first = step(world).filter(e => e.channel === 'station');
  const fixture = creekFixture();
  assert.deepEqual(fixture.initial, initial.map(e => toRecord(e).value));
  assert.deepEqual(fixture.records.slice(0, first.length), first.map(e => { const r = toRecord(e); return { key: r.key, value: r.value }; }));
  assert.ok(fixture.records.length > 0 && fixture.records.every(r => 'value' in r && (r.value as { channel: string }).channel === 'station'));

  const { handlers } = slotRuntimeParts(); const station = handlers.channels.station;
  const kafka = createKafkaHandlers({ secret: 's'.repeat(32), serviceToken: 't'.repeat(32), internalOrigin: 'http://127.0.0.1:1' }).channels.station;
  const sample = fixture.records[0] as { key: string; value: Json };
  const kafkaRecord: SourceRecord = { ...record(sample.value, 0, sample.key), position: { kind: 'kafka', topic: 'field.gauges', partition: 0, offset: '0' } };
  assert.deepEqual(await station.map({ ...context, record: record(sample.value, 0, sample.key) }), await kafka.map({ ...context, record: kafkaRecord }));
  const params = { stationId: (sample.value as { params: { stationId: string } }).params.stationId };
  assert.deepEqual(await station.snapshot({ ...context, principal: CREEK_PRINCIPAL, params }), { revision: (sample.value as { revision: string }).revision, data: (sample.value as { data: Json }).data }, 'the snapshot follows the mapped record');
  assert.equal(await station.authorize({ ...context, principal: CREEK_PRINCIPAL, params }), true);
  assert.equal(await station.authorize({ ...context, principal: SCAFFOLD_PRINCIPAL, params }), false, 'the scaffold\'s tenant cannot read the creek');
  assert.equal(CREEK_PRINCIPAL.tenantId, TENANT_ID);
  assert.deepEqual(await station.map({ ...context, record: record({ tenantId: TENANT_ID, channel: 'otter', params: { otterId: 'x' }, revision: '1', data: {} }, 1) }), [], 'only station records');
});

test('A42: every runtime has its own read models and principals', async () => {
  const a = slotRuntimeParts(); const b = slotRuntimeParts();
  assert.notEqual(a.development.principals, b.development.principals); assert.deepEqual(a.development.principals, SLOT_PRINCIPALS);
  assert.equal(await a.handlers.authenticate({ ...context, token: 'anything', origin: 'https://streamotter.dev' }), null, 'only gateway-resolved preview tokens');
  const job = SCAFFOLD_JOBS.at(-1) as { key: string; value: Json };
  await a.handlers.channels.jobProgress.map({ ...context, record: record(job.value, 0, job.key) });
  const params = { jobId: 'job_1' };
  assert.equal((await a.handlers.channels.jobProgress.snapshot({ ...context, principal: SCAFFOLD_PRINCIPAL, params })).revision, '5');
  assert.equal((await b.handlers.channels.jobProgress.snapshot({ ...context, principal: SCAFFOLD_PRINCIPAL, params })).revision, '1', 'another runtime is untouched');
  const later = creekFixture().records.at(-1) as { key: string; value: { params: { stationId: string }; revision: string } & Json };
  await a.handlers.channels.station.map({ ...context, record: record(later.value, 1, later.key) });
  const station = { stationId: later.value.params.stationId };
  assert.equal((await a.handlers.channels.station.snapshot({ ...context, principal: CREEK_PRINCIPAL, params: station })).revision, later.value.revision);
  assert.notEqual((await b.handlers.channels.station.snapshot({ ...context, principal: CREEK_PRINCIPAL, params: station })).revision, later.value.revision);
});
