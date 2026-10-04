/** A Kafka-only public-creek project. A bench has no badge or notebook credentials. */
import type { FailureHandlingConfig, Json, KafkaConnection, Limits, Principal, ProjectConfig, SourceRecoveryHandlers } from 'streamotter/contracts';
import { TransientMappingError, type ChannelHandlers, type HandlerRegistry } from 'streamotter/gateway';
import type { AppChannels } from '../generated/streamotter.generated.ts';
import { fromRecord, topicFor, viewPath } from '../records.ts';
import { projectConfig } from '../project.ts';
import { bench } from './benches.ts';
import type { FeedEvent } from './feed.ts';
import type { BenchFailureProfile, BenchSnapshot, LabScenarioId, RecoveryAssessment } from './contract.ts';
export type LabChannels = Omit<AppChannels, 'notebook' | 'holt'>;
export type BenchChannels = LabChannels;
export interface BenchOptions { host?: string; port?: number; brokers?: readonly string[]; caFile?: string; consumerGroup?: string; allowedOrigins?: readonly string[]; /** The study's source generation, `lab-N-<studyId>` (study.ts). */ generation?: string; /** LAB_FAILURE_HANDLING; `off` when omitted. */ profile?: BenchFailureProfile; }
/** The quarantine writer copies a whole source record plus its envelope, so the quarantine topic must accept this plus about 80 KiB; the broker default does. */
const BENCH_LIMITS: Partial<Limits> = { maxConnections: 8, maxSubscriptionsPerConnection: 12, maxSourceRecordBytes: 262_144 };
export const FAILURE_PROFILES: readonly BenchFailureProfile[] = ['off', 'retry', 'quarantine'];
/**
 * The profiles a source-failures scenario runs under (section 12.3). A fouled sensor
 * and a calibration blip need only bounded retry; everything else needs quarantine.
 */
export function runsUnder(scenario: LabScenarioId): readonly BenchFailureProfile[] {
  return scenario === 'fouled-sensor' || scenario === 'calibration-blip' ? ['retry', 'quarantine'] : ['quarantine'];
}
/** Bumped when the bench's handlers change behavior; recorded in every incident as part of the handler build ID. */
export const BENCH_HANDLERS_VERSION = '1.1.0';
/** What incidents record as the handlers that produced them: the projection a `lab-projection-v2` record goes through is part of it. */
export const handlerBuildId = (mapping: 'broken' | 'corrected'): string => `lontra-lab@${BENCH_HANDLERS_VERSION}+projection-v2-${mapping}`;
/**
 * The bench source's failure policies (Lab contract section 8b). `retry`: up to two
 * retries of a transient mapper failure, every class pauses. `quarantine`: a garbled
 * record is quarantined and held; an invalid public payload is quarantined and, when
 * the recovery guard agrees, advanced past under a recovery boundary that every later
 * snapshot must acknowledge. A boundary retires when the generation changes, which a
 * reset always does; it stays in force for the whole study (LC11-ADR-02).
 */
export function failureHandlingFor(number: number, profile: BenchFailureProfile): FailureHandlingConfig | undefined {
  if (profile === 'off') return undefined;
  if (profile === 'retry') return { sources: { field: { transientMapperRetries: 2, replaySafeMapping: true } } };
  return {
    quarantine: { topic: `${bench(number).topicPrefix}quarantine`, capture: 'full-record' },
    sources: { field: { invalidJson: 'quarantine-hold', invalidPublicPayload: 'quarantine-resync', transientMapperRetries: 2, replaySafeMapping: true, automaticAdvanceLimit: { incidents: 5, windowMs: 60_000 }, boundaryRetirement: 'generation' } }
  };
}
/**
 * Reading quarantine evidence back joins a throwaway consumer group, `<clientId>-quarantine-read-<uuid>`,
 * with StreamOtter's client ID `streamotter-<projectId>`; the library deletes it after use. Bench N's
 * Kafka user may read and delete exactly these (deploy/kafka/start.sh, lab-api.md 10.9).
 */
export const quarantineReadGroupPrefix = (number: number): string => `streamotter-${bench(number).projectId}-quarantine-read-`;
export function benchConfig(number: number, options: BenchOptions = {}): ProjectConfig<LabChannels> {
  const b = bench(number); const production = projectConfig('production'); const field = production.connections['field']; const source = production.sources['field'];
  if (!field || field.tls === false || source?.kind !== 'kafka') throw new Error('Production Kafka over TLS is required.');
  const connection: KafkaConnection = { brokers: [...(options.brokers ?? [`${b.proxyHost}:${b.proxyPort}`])], tls: { caFile: options.caFile ?? field.tls.caFile ?? '/etc/lontra/kafka/ca.pem' }, sasl: { mechanism: 'scram-sha-512', username: { env: 'KAFKA_LAB_USERNAME' }, password: { env: 'KAFKA_LAB_PASSWORD' } } };
  const { notebook: _n, holt: _h, ...channels } = production.channels;
  const failureHandling = failureHandlingFor(number, options.profile ?? 'off');
  return { configVersion: 1, projectId: b.projectId, gateway: { host: options.host ?? '0.0.0.0', port: options.port ?? 7400, path: b.gatewayPath, allowedOrigins: [...(options.allowedOrigins ?? production.gateway.allowedOrigins)] }, connections: { field: connection }, sources: { field: { ...source, generation: options.generation ?? `lab-${number}-field-1`, topics: [...b.topics], consumerGroup: options.consumerGroup ?? b.consumerGroup, startFrom: 'latest' } }, schemas: production.schemas, channels, limits: BENCH_LIMITS, ...(failureHandling ? { failureHandling } : {}) };
}
/**
 * Scenario records the field station publishes carry a `mapping` marker; `fromRecord`
 * ignores it, and live creek records have none.
 *
 *   lab-projection-v2   the record goes through the study's v2 projection. While it is
 *                       `broken` it writes flowCfs as a string, which the channel's
 *                       payload schema refuses (LC11-S03); `corrected` maps it as is.
 *   lab-reading-batch   `readings` holds two gauge readings for the record's station at
 *                       the record's one revision, so the outputs conflict (LC11-S05).
 */
export const PROJECTION_V2 = 'lab-projection-v2';
export const READING_BATCH = 'lab-reading-batch';
export interface BenchHandlerOptions {
  authenticate: (token: string) => Principal | null;
  serviceToken: string;
  snapshotOrigin: string;
  calibration: () => boolean;
  record: (event: FeedEvent) => void;
  /** The projection `lab-projection-v2` records go through. Default `broken`. */
  mapping?: () => 'broken' | 'corrected';
  /** Consumes one armed calibration-lookup blip, if any: true when this attempt must fail transiently (LC11-S06). */
  blip?: () => boolean;
  /** With profile `quarantine`: the study the recovery guard answers for. */
  recovery?: { study: () => { studyId: string; generation: string } | null };
  fetch?: typeof fetch;
}
/** A barrier the recovery guard returned, read back from a boundary's context: at most 96 characters (Lab contract section 8a). */
export function barrierOf(context: Json | undefined): string | null {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return null;
  const barrier = (context as Record<string, Json>)['barrier'];
  return typeof barrier === 'string' && barrier.length > 0 && barrier.length <= 96 ? barrier : null;
}
const BARRIER = /^lcb1\.([A-Za-z0-9_-]{16})\.([1-9]\d{0,5})$/;
/** True when `next` is this study's barrier and at least as far along as `prior`: cumulative barriers only grow (LC11-ADR-01). */
export function barrierCovers(studyId: string, prior: string | null, next: string): boolean {
  const n = BARRIER.exec(next);
  if (!n || n[1] !== studyId) return false;
  if (prior === null) return true;
  const p = BARRIER.exec(prior);
  return p !== null && p[1] === studyId && Number(n[2]) >= Number(p[2]);
}
/**
 * The bench's recovery guard (LC11-ADR-01): it asks the field station's coverage ledger
 * about the incident's record by its coordinates, never its bytes. The ledger answers
 * `hold` unless the study's authoritative update for that record is established; a
 * `recoverable` answer carries the study's cumulative barrier, which becomes the
 * boundary's context and which every later snapshot must acknowledge.
 */
export function recoveryGuard(number: number, options: { serviceToken: string; snapshotOrigin: string; study: () => { studyId: string; generation: string } | null; fetch?: typeof fetch }): SourceRecoveryHandlers {
  const request = options.fetch ?? fetch;
  return {
    async recover({ generation, incident, prior, signal }) {
      const study = options.study();
      if (!study || generation !== study.generation) return { decision: 'hold', reason: 'wrong-study' };
      // A non-Kafka position names no record the ledger can have published: it answers no-coordinates.
      const record = incident.position.kind === 'kafka' ? { topic: incident.position.topic, partition: incident.position.partition, offset: incident.position.offset } : undefined;
      const response = await request(`${options.snapshotOrigin}/lab-internal/${number}/recovery/assess`, { method: 'POST', headers: { authorization: `Bearer ${options.serviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ studyId: study.studyId, sourceId: 'field', ...(record ? { record } : {}) }), signal });
      if (!response.ok) return { decision: 'hold', reason: response.status === 409 ? 'study-closed' : 'assessment-unavailable' };
      const answer = await response.json() as RecoveryAssessment;
      if (answer.studyId !== study.studyId) return { decision: 'hold', reason: 'wrong-study' };
      if (answer.decision !== 'recoverable') return { decision: 'hold', reason: answer.reason };
      // The library carries the prior boundary's obligations forward only through the context the guard returns.
      if (!barrierCovers(study.studyId, prior ? barrierOf(prior.context) : null, answer.barrier)) return { decision: 'hold', reason: 'prior-not-covered' };
      return { decision: 'recoverable', context: { barrier: answer.barrier, covers: answer.covers }, evidenceRef: answer.evidenceRef };
    }
  };
}
export function benchHandlers(number: number, options: BenchHandlerOptions): HandlerRegistry<LabChannels> {
  const b = bench(number); const request = options.fetch ?? fetch; const mapping = options.mapping ?? (() => 'broken');
  function channel<K extends keyof LabChannels>(name: K): ChannelHandlers<LabChannels[K]> {
    type C = LabChannels[K];
    return {
      authorize: ({ principal }) => principal.claims['bench'] === number && principal.claims['role'] === 'volunteer',
      map: ({ record }) => {
        const field = fromRecord(record.value);
        if (!field) throw new Error('Invalid field record.');
        if (record.position.kind === 'kafka' && record.position.topic !== `${b.topicPrefix}${topicFor(field.channel)}`) throw new Error('Wrong topic.');
        if (field.channel !== name) return [];
        const marker = (record.value as Record<string, Json>)['mapping'];
        const output = (data: Json) => ({ tenantId: field.tenantId, params: field.params as C['params'], revision: field.revision, data: data as C['data'] });
        if (marker === PROJECTION_V2) {
          const data = field.data;
          if (mapping() === 'corrected' || typeof data !== 'object' || data === null || Array.isArray(data)) return [output(data)];
          return [output({ ...data, flowCfs: String(data['flowCfs']) })];
        }
        if (marker === READING_BATCH) {
          const readings = (record.value as Record<string, Json>)['readings'];
          if (!Array.isArray(readings) || readings.length < 1 || readings.length > 2) throw new Error('Invalid reading batch.');
          return readings.map(output);
        }
        if (marker !== undefined) throw new Error('Unknown mapping.');
        // Only live LC-03 readings (no marker) need calibration, and only they are annotated in the feed.
        if (name === 'station' && field.params['stationId'] === 'LC-03') {
          const blipped = options.blip?.() ?? false;
          const failed = blipped || !options.calibration();
          if (record.position.kind === 'kafka') options.record({ kind: 'record', stationId: 'LC-03', topic: record.position.topic, partition: record.position.partition, offset: record.position.offset, outcome: failed ? 'failed' : 'processed' });
          if (blipped) throw new TransientMappingError('LC-03 calibration lookup timed out.');
          if (failed) throw new Error('LC-03 calibration is unavailable.');
        }
        return [output(field.data)];
      },
      snapshot: async ({ params, signal, recovery }) => {
        const barrier = recovery ? barrierOf(recovery.context) : null;
        const path = viewPath(name, params).replace('/internal/views/', `/lab-internal/${number}/views/`);
        const response = await request(`${options.snapshotOrigin}${path}${barrier ? `?boundary=${encodeURIComponent(barrier)}` : ''}`, { headers: { authorization: `Bearer ${options.serviceToken}` }, signal });
        if (!response.ok) throw new Error('Bench snapshot unavailable.');
        const body = await response.json() as BenchSnapshot & { data: C['data'] };
        // Echo the boundary only when the served state acknowledges its barrier: anything else leaves the view stale.
        if (recovery && barrier !== null && snapshotAcknowledges(barrier, body)) return { revision: body.revision, data: body.data, recoveryBoundaryId: recovery.boundaryId };
        return { revision: body.revision, data: body.data };
      }
    };
  }
  return {
    authenticate: ({ token }) => options.authenticate(token),
    channels: { station: channel('station'), otter: channel('otter'), reach: channel('reach'), creekOverview: channel('creekOverview') },
    ...(options.recovery ? { sources: { field: recoveryGuard(number, { serviceToken: options.serviceToken, snapshotOrigin: options.snapshotOrigin, study: options.recovery.study, ...(options.fetch ? { fetch: options.fetch } : {}) }) } } : {})
  };
}
export function benchEnvironment(env: NodeJS.ProcessEnv): { number: 1 | 2 | 3; serviceToken: string; relayToken: string; snapshotOrigin: string; profile: BenchFailureProfile } {
  const number = Number(env['LAB_BENCH']);
  if (![1, 2, 3].includes(number)) throw new Error('LAB_BENCH must be 1, 2, or 3.');
  for (const key of Object.keys(env)) {
    if (key.startsWith('FIELD_STATION_') || ['KAFKA_GATEWAY_PASSWORD', 'KAFKA_FIELD_STATION_PASSWORD'].includes(key) || /^LAB_BENCH_[123]_(SERVICE|RELAY)_TOKEN$/.test(key) && !key.startsWith(`LAB_BENCH_${number}_`)) throw new Error(`Production or other-bench secret forbidden: ${key}`);
  }
  const secret = (kind: string): string => { const value = env[`LAB_BENCH_${number}_${kind}_TOKEN`]; if (!value || value.length < 32) throw new Error(`Bench ${kind} token requires 32 characters.`); return value; };
  const profile = (env['LAB_FAILURE_HANDLING'] ?? 'off') as BenchFailureProfile;
  if (!FAILURE_PROFILES.includes(profile)) throw new Error('LAB_FAILURE_HANDLING must be off, retry, or quarantine.');
  return { number: number as 1 | 2 | 3, serviceToken: secret('SERVICE'), relayToken: secret('RELAY'), snapshotOrigin: new URL(env['LAB_SNAPSHOT_ORIGIN'] ?? 'http://field-station:7410').origin, profile };
}
/**
 * Whether a bench snapshot acknowledges the boundary the gateway requires. Only an
 * exact echo of that barrier with `acknowledged: true` counts: a missing, lagging,
 * or different acknowledgment never does (LC11-ADR-01).
 */
export function snapshotAcknowledges(required: string, snapshot: BenchSnapshot): boolean {
  return typeof required === 'string' && required !== '' && snapshot.boundary?.barrier === required && snapshot.boundary.acknowledged === true;
}
