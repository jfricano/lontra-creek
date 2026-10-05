/**
 * One sandbox slot's server-owned project (LC11-ADR-04 decision 4): the creek's
 * `station` channel on a fixture of the simulation's first study day, and the pinned
 * `streamotter init` example's `jobProgress` on that example's own fixture records,
 * for two development principals. Every call builds fresh handlers and read models,
 * so no state crosses a slot or a study.
 *
 * Schemas come from the field station's own project (`station`) and from the
 * published scaffold's `streamotter.json` (`jobProgress`). The scaffold's handler
 * and fixture records are ported here, never executed; test/slot-project.test.ts
 * holds the port to the scaffold. This module reads no secret: the sandbox's
 * environment guard forbids the field station's.
 */
import { createWorld, currentEmissions, step, TENANT_ID, TICKS_PER_DAY } from '@lontra-creek/sim';
import { scaffoldFiles } from 'streamotter/cli';
import type { ChannelContract, DevelopmentOptions, FixtureRecord, HandlerRegistry, Json, Principal, ProjectConfig, Schema } from 'streamotter/contracts';
import { projectConfig } from '../project.ts';
import { fromRecord, instanceKey, toRecord, type FieldRecord } from '../records.ts';
import type { SlotId } from './contract.ts';
import type { EditableMaxima } from './editor.ts';

export type SlotChannels = {
  station: ChannelContract<{ stationId: string }, Json, 1>;
  jobProgress: ChannelContract<{ jobId: string }, Json, 1>;
};

/** ADR-04 slot gateway limits. */
export const SLOT_LIMITS = { maxConnections: 4, maxSubscriptionsPerConnection: 8 } as const;
/** Server maxima for the editable limits (sandbox contract §5). */
export const SLOT_MAXIMA: EditableMaxima = { receiptTimeoutMs: 10_000, maxSubscriptionsPerConnection: 8, maxPendingFramesPerSubscription: 100 };
/** How much of the simulation the creek fixture holds. */
export const CREEK_FIXTURE_TICKS = TICKS_PER_DAY;

/** The synthetic visitor who previews `station` (tenant lontra-creek). */
export const CREEK_PRINCIPAL: Principal = { subject: 'creek-volunteer', tenantId: TENANT_ID, sessionId: 'sandbox-creek-volunteer', expiresAt: '2099-01-01T00:00:00.000Z', claims: { role: 'volunteer', name: 'Volunteer' } };
/** The scaffold's own development principal, verbatim, who previews `jobProgress` (tenant local). */
export const SCAFFOLD_PRINCIPAL: Principal = { subject: 'developer', tenantId: 'local', sessionId: 'dev-session', expiresAt: '2099-01-01T00:00:00.000Z', claims: {} };
export const SLOT_PRINCIPALS: Readonly<Record<string, Principal>> = { 'creek-volunteer': CREEK_PRINCIPAL, developer: SCAFFOLD_PRINCIPAL };

/** The scaffold's fixture records for its `jobs` source, verbatim. */
export const SCAFFOLD_JOBS: readonly FixtureRecord[] = [
  { key: 'job_1', value: { tenantId: 'local', revision: '2', job: { jobId: 'job_1', state: 'running', percent: 25 } } },
  { key: 'job_1', value: { tenantId: 'local', revision: '3', job: { jobId: 'job_1', state: 'running', percent: 60 } } },
  { key: 'job_1', value: { tenantId: 'local', revision: '4', job: { jobId: 'job_1', state: 'running', percent: 90 } } },
  { key: 'job_1', value: { tenantId: 'local', revision: '5', job: { jobId: 'job_1', state: 'succeeded', percent: 100 } } }
];
/** The scaffold's read model before any record, verbatim. */
const SCAFFOLD_JOBS_INITIAL: readonly [string, { revision: string; data: Json }][] = [['local/job_1', { revision: '1', data: { jobId: 'job_1', state: 'queued', percent: 0 } }]];

interface ScaffoldConfig { sources: Record<string, ProjectConfig['sources'][string]>; schemas: Record<string, Schema>; channels: { jobProgress: ProjectConfig['channels'][string] } }
let scaffold: (ScaffoldConfig & { fixtureRef: string }) | undefined;
/** The pinned scaffold's project file (a pure published call, parsed as data), and the fixture its `jobProgress` source reads. */
export function scaffoldConfig(): ScaffoldConfig & { fixtureRef: string } {
  if (!scaffold) {
    const file = scaffoldFiles('lontra-creek-sandbox').find(f => f.path === 'streamotter.json');
    if (!file) throw new Error('The installed streamotter init scaffold has no streamotter.json.');
    const config = JSON.parse(file.content) as ScaffoldConfig; const source = config.sources[config.channels.jobProgress?.source ?? ''];
    if (source?.kind !== 'fixture') throw new Error('The installed streamotter init scaffold has no jobProgress fixture source.');
    scaffold = { ...config, fixtureRef: source.fixtureRef };
  }
  return scaffold;
}

let creek: { initial: readonly FieldRecord[]; records: readonly FixtureRecord[] } | undefined;
/** The creek's `station` views at the start of the simulation, then every `station` record of its first study day. */
export function creekFixture(): { initial: readonly FieldRecord[]; records: readonly FixtureRecord[] } {
  if (!creek) {
    const world = createWorld({ seed: 'lontra-creek' });
    const initial = currentEmissions(world).filter(e => e.channel === 'station').map(e => toRecord(e).value);
    const records: FixtureRecord[] = [];
    while (world.tick < CREEK_FIXTURE_TICKS) {
      for (const emission of step(world)) if (emission.channel === 'station') { const record = toRecord(emission); records.push({ key: record.key, value: record.value as unknown as Json }); }
    }
    creek = { initial, records };
  }
  return creek;
}

/** The slot's base configuration; the candidate editor compares every candidate to it. */
export function slotConfig(slot: SlotId, options: { host: string; port: number; siteOrigins: readonly string[] }): ProjectConfig<SlotChannels> {
  const field = projectConfig('fixture'); const init = scaffoldConfig(); const channel = init.channels.jobProgress;
  const schema = (name: string, from: Readonly<Record<string, Schema>>): Schema => { const s = from[name]; if (!s) throw new Error(`Schema ${name} is missing.`); return structuredClone(s); };
  return {
    configVersion: 1, projectId: `lontra-creek-sandbox-${slot}`,
    gateway: { host: options.host, port: options.port, path: `/sandbox/${slot}/socket.io`, allowedOrigins: [...options.siteOrigins] },
    connections: {},
    sources: { creek: { kind: 'fixture', generation: 'creek-fixture-1', fixtureRef: 'creek' }, [channel.source]: structuredClone(init.sources[channel.source]!) },
    schemas: {
      StationParams: schema('StationParams', field.schemas), GaugeReading: schema('GaugeReading', field.schemas),
      [channel.paramsSchema]: schema(channel.paramsSchema, init.schemas), [channel.payloadSchema]: schema(channel.payloadSchema, init.schemas)
    },
    channels: {
      station: { version: 1, source: 'creek', paramsSchema: 'StationParams', payloadSchema: 'GaugeReading', handlersRef: 'station', delivery: { kind: 'state', overflow: 'resync' } },
      jobProgress: { ...structuredClone(channel), version: 1, handlersRef: 'jobProgress' }
    },
    limits: { ...SLOT_LIMITS }
  };
}

/** Fresh handlers, read models, and development options for one runtime. */
export function slotRuntimeParts(): { handlers: HandlerRegistry<SlotChannels>; development: DevelopmentOptions } {
  const fixture = creekFixture();
  const stations = new Map(fixture.initial.map(record => [instanceKey(record.channel, record.params), record]));
  const jobs = new Map(SCAFFOLD_JOBS_INITIAL.map(([key, job]) => [key, structuredClone(job)]));
  const handlers: HandlerRegistry<SlotChannels> = {
    // Previews use preview tokens the gateway resolves itself; no application token is accepted.
    authenticate: () => null,
    channels: {
      station: {
        authorize: ({ principal }) => principal.tenantId === TENANT_ID,
        map: ({ record }) => {
          const field = fromRecord(record.value);
          if (field === null || field.channel !== 'station' || typeof field.params['stationId'] !== 'string') return [];
          const key = instanceKey('station', field.params); const current = stations.get(key);
          if (current === undefined || BigInt(field.revision) > BigInt(current.revision)) stations.set(key, field);
          return [{ tenantId: field.tenantId, params: { stationId: field.params['stationId'] }, revision: field.revision, data: field.data }];
        },
        snapshot: ({ params }) => {
          const current = stations.get(instanceKey('station', params));
          if (current === undefined) throw new Error('Unknown station');
          return { revision: current.revision, data: current.data };
        }
      },
      // A port of the scaffold's jobProgress handler, with this runtime's own read model.
      jobProgress: {
        authorize: ({ principal, params }) => jobs.has(`${principal.tenantId}/${params.jobId}`),
        map: ({ record }) => {
          const value = record.value as { tenantId: string; revision: string; job: { jobId: string; state: string; percent: number } };
          const key = `${value.tenantId}/${value.job.jobId}`; const current = jobs.get(key);
          if (current === undefined || BigInt(value.revision) > BigInt(current.revision)) jobs.set(key, { revision: value.revision, data: value.job });
          return [{ tenantId: value.tenantId, params: { jobId: value.job.jobId }, revision: value.revision, data: value.job }];
        },
        snapshot: ({ principal, params }) => {
          const job = jobs.get(`${principal.tenantId}/${params.jobId}`);
          if (job === undefined) throw new Error('Unknown job');
          return { revision: job.revision, data: job.data };
        }
      }
    }
  };
  return { handlers, development: { principals: structuredClone(SLOT_PRINCIPALS), fixtures: { creek: fixture.records, [scaffoldConfig().fixtureRef]: SCAFFOLD_JOBS } } };
}
