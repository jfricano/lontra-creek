/** A Kafka-only public-creek project. A bench has no badge or notebook credentials. */
import type { KafkaConnection, Limits, Principal, ProjectConfig } from 'streamotter/contracts';
import type { ChannelHandlers, HandlerRegistry } from 'streamotter/gateway';
import type { AppChannels } from '../generated/streamotter.generated.ts';
import { fromRecord, topicFor, viewPath } from '../records.ts';
import { projectConfig } from '../project.ts';
import { bench } from './benches.ts';
import type { FeedEvent } from './feed.ts';
export type LabChannels = Omit<AppChannels, 'notebook' | 'holt'>;
export type BenchChannels = LabChannels;
export interface BenchOptions { host?: string; port?: number; brokers?: readonly string[]; caFile?: string; consumerGroup?: string; allowedOrigins?: readonly string[]; }
const BENCH_LIMITS: Partial<Limits> = { maxConnections: 8, maxSubscriptionsPerConnection: 12 };
export function benchConfig(number: number, options: BenchOptions = {}): ProjectConfig<LabChannels> {
  const b = bench(number); const production = projectConfig('production'); const field = production.connections['field']; const source = production.sources['field'];
  if (!field || field.tls === false || source?.kind !== 'kafka') throw new Error('Production Kafka over TLS is required.');
  const connection: KafkaConnection = { brokers: [...(options.brokers ?? [`${b.proxyHost}:${b.proxyPort}`])], tls: { caFile: options.caFile ?? field.tls.caFile ?? '/etc/lontra/kafka/ca.pem' }, sasl: { mechanism: 'scram-sha-512', username: { env: 'KAFKA_LAB_USERNAME' }, password: { env: 'KAFKA_LAB_PASSWORD' } } };
  const { notebook: _n, holt: _h, ...channels } = production.channels;
  return { configVersion: 1, projectId: b.projectId, gateway: { host: options.host ?? '0.0.0.0', port: options.port ?? 7400, path: b.gatewayPath, allowedOrigins: [...(options.allowedOrigins ?? production.gateway.allowedOrigins)] }, connections: { field: connection }, sources: { field: { ...source, generation: `lab-${number}-field-1`, topics: [...b.topics], consumerGroup: options.consumerGroup ?? b.consumerGroup, startFrom: 'latest' } }, schemas: production.schemas, channels, limits: BENCH_LIMITS };
}
export interface BenchHandlerOptions {
  authenticate: (token: string) => Principal | null;
  serviceToken: string;
  snapshotOrigin: string;
  calibration: () => boolean;
  record: (event: FeedEvent) => void;
  fetch?: typeof fetch;
}
export function benchHandlers(number: number, options: BenchHandlerOptions): HandlerRegistry<LabChannels> {
  const b = bench(number); const request = options.fetch ?? fetch;
  function channel<K extends keyof LabChannels>(name: K): ChannelHandlers<LabChannels[K]> {
    type C = LabChannels[K];
    return {
      authorize: ({ principal }) => principal.claims['bench'] === number && principal.claims['role'] === 'volunteer',
      map: ({ record }) => {
        const field = fromRecord(record.value);
        if (!field) throw new Error('Invalid field record.');
        if (record.position.kind === 'kafka' && record.position.topic !== `${b.topicPrefix}${topicFor(field.channel)}`) throw new Error('Wrong topic.');
        if (field.channel !== name) return [];
        if (name === 'station' && field.params['stationId'] === 'LC-03' && record.position.kind === 'kafka') {
          options.record({ kind: 'record', stationId: 'LC-03', topic: record.position.topic, partition: record.position.partition, offset: record.position.offset, outcome: options.calibration() ? 'processed' : 'failed' });
          if (!options.calibration()) throw new Error('LC-03 calibration is unavailable.');
        }
        return [{ tenantId: field.tenantId, params: field.params as C['params'], revision: field.revision, data: field.data as C['data'] }];
      },
      snapshot: async ({ params, signal }) => {
        const path = viewPath(name, params).replace('/internal/views/', `/lab-internal/${number}/views/`);
        const response = await request(`${options.snapshotOrigin}${path}`, { headers: { authorization: `Bearer ${options.serviceToken}` }, signal });
        if (!response.ok) throw new Error('Bench snapshot unavailable.');
        const body = await response.json() as { revision: string; data: C['data'] }; return body;
      }
    };
  }
  return { authenticate: ({ token }) => options.authenticate(token), channels: { station: channel('station'), otter: channel('otter'), reach: channel('reach'), creekOverview: channel('creekOverview') } };
}
export function benchEnvironment(env: NodeJS.ProcessEnv): { number: 1 | 2 | 3; serviceToken: string; relayToken: string; snapshotOrigin: string } {
  const number = Number(env['LAB_BENCH']);
  if (![1, 2, 3].includes(number)) throw new Error('LAB_BENCH must be 1, 2, or 3.');
  for (const key of Object.keys(env)) {
    if (key.startsWith('FIELD_STATION_') || ['KAFKA_GATEWAY_PASSWORD', 'KAFKA_FIELD_STATION_PASSWORD'].includes(key) || /^LAB_BENCH_[123]_(SERVICE|RELAY)_TOKEN$/.test(key) && !key.startsWith(`LAB_BENCH_${number}_`)) throw new Error(`Production or other-bench secret forbidden: ${key}`);
  }
  const secret = (kind: string): string => { const value = env[`LAB_BENCH_${number}_${kind}_TOKEN`]; if (!value || value.length < 32) throw new Error(`Bench ${kind} token requires 32 characters.`); return value; };
  return { number: number as 1 | 2 | 3, serviceToken: secret('SERVICE'), relayToken: secret('RELAY'), snapshotOrigin: new URL(env['LAB_SNAPSHOT_ORIGIN'] ?? 'http://field-station:7410').origin };
}
