/**
 * Runs one Failure Lab bench: a development-mode StreamOtter gateway (bench.ts),
 * with its management API on the container's loopback only.
 *
 *   LAB_BENCH=1 node src/lab/bench-main.ts
 *
 * Environment: LAB_BENCH (the bench's number), KAFKA_LAB_USERNAME and
 * KAFKA_LAB_PASSWORD, FIELD_STATION_SECRET, FIELD_STATION_SERVICE_TOKEN,
 * FIELD_STATION_INTERNAL_URL, and optionally BENCH_HOST and BENCH_PORT (default
 * 0.0.0.0:7400), BENCH_KAFKA_BROKERS (default: the bench's proxy), KAFKA_CA_FILE
 * (default /etc/lontra/kafka/ca.pem), and BENCH_MANAGEMENT_PORT (default 7401).
 *
 * The management API's token is made here and never printed. The bench API that
 * reads traces for the field station will run in this process and use it.
 */
import { randomBytes } from "node:crypto";
import { createGateway } from "streamotter/gateway";
import { startManagementServer } from "streamotter/gateway/management";
import { kafkaHandlerOptions } from "../kafka-handlers.ts";
import { benchConfig, benchHandlers } from "./bench.ts";

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);
const number = Number(process.env["LAB_BENCH"]);
const env = (name: string): string | undefined => process.env[name] === "" ? undefined : process.env[name];
const brokers = env("BENCH_KAFKA_BROKERS")?.split(",").map(broker => broker.trim());
const port = env("BENCH_PORT");
const host = env("BENCH_HOST");
const caFile = env("KAFKA_CA_FILE");

const config = benchConfig(number, {
  ...(host === undefined ? {} : { host }),
  ...(port === undefined ? {} : { port: Number(port) }),
  ...(brokers === undefined ? {} : { brokers }),
  ...(caFile === undefined ? {} : { caFile })
});
const gateway = createGateway({ config, handlers: benchHandlers(number, kafkaHandlerOptions()), mode: "development" });
try {
  await gateway.start();
} catch (error) {
  log(`Bench ${number} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const management = await startManagementServer({
  gateway,
  host: "127.0.0.1",
  port: Number(env("BENCH_MANAGEMENT_PORT") ?? 7401),
  token: randomBytes(32).toString("base64url"),
  workbenchDir: null
});
log(`Bench ${number} (${config.projectId}) listening on ${config.gateway.host}:${config.gateway.port}${config.gateway.path}; management API on ${management.origin} (loopback only).`);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping.`);
  await management.close();
  await gateway.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
