/**
 * A Failure Lab bench's StreamOtter project and handlers: the field station's creek
 * channels (no notebooks) on the bench's own copy of the creek topics, read through
 * the bench's relay, with a project, consumer group, and source generation of its
 * own. Snapshots come from the field station's internal API, like the demo host's
 * gateway, since the bench's topics carry the same records and revisions.
 *
 * Benches run the gateway in development mode, with createGateway (bench-main.ts)
 * rather than `streamotter dev`; docs/PLAN.md (The Failure Lab) says why.
 */
import type { KafkaConnection, Limits, ProjectConfig } from "streamotter/contracts";
import type { HandlerRegistry } from "streamotter/gateway";
import type { AppChannels } from "../generated/streamotter.generated.ts";
import { createKafkaHandlers, type KafkaHandlerOptions } from "../kafka-handlers.ts";
import { projectConfig } from "../project.ts";
import { bench } from "./benches.ts";

export type BenchChannels = Omit<AppChannels, "notebook">;

export interface BenchOptions {
  /** Where the bench's gateway listens; 0.0.0.0:7400 in its container. */
  host?: string;
  port?: number;
  /** The bench's way to Kafka; its relay by default. */
  brokers?: readonly string[];
  /** The Kafka CA; the demo host's path by default. */
  caFile?: string;
}

/** One visitor's page or two, and the satellite laptop scenario's client. */
const BENCH_LIMITS: Partial<Limits> = { maxConnections: 16, maxSubscriptionsPerConnection: 12 };

export function benchConfig(number: number, options: BenchOptions = {}): ProjectConfig<BenchChannels> {
  const { projectId, relayHost, relayPort, topics, consumerGroup, gatewayPath } = bench(number);
  const production = projectConfig("production");
  const field = production.connections["field"];
  const source = production.sources["field"];
  if (field === undefined || field.tls === false || source?.kind !== "kafka") throw new Error("The production project has no Kafka source over TLS.");
  const connection: KafkaConnection = {
    brokers: [...(options.brokers ?? [`${relayHost}:${relayPort}`])],
    tls: { caFile: options.caFile ?? field.tls.caFile ?? "/etc/lontra/kafka/ca.pem" },
    // The benches' own SCRAM user (deploy/kafka/start.sh), not the demo host gateway's.
    sasl: { mechanism: "scram-sha-512", username: { env: "KAFKA_LAB_USERNAME" }, password: { env: "KAFKA_LAB_PASSWORD" } }
  };
  const { notebook: _notebook, ...channels } = production.channels;
  return {
    configVersion: 1,
    projectId,
    gateway: { host: options.host ?? "0.0.0.0", port: options.port ?? 7400, path: gatewayPath, allowedOrigins: production.gateway.allowedOrigins },
    connections: { field: connection },
    sources: { field: { ...source, generation: `lab-${number}-field-1`, topics: [...topics], consumerGroup } },
    schemas: production.schemas,
    channels,
    limits: BENCH_LIMITS
  };
}

export function benchHandlers(number: number, options: Omit<KafkaHandlerOptions, "topicPrefix">): HandlerRegistry<BenchChannels> {
  const { authenticate, channels } = createKafkaHandlers({ ...options, topicPrefix: bench(number).topicPrefix });
  const { notebook: _notebook, ...creek } = channels;
  return { authenticate, channels: creek };
}
