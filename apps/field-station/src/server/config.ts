/**
 * The field station's settings, all from environment variables so one image runs
 * anywhere. Development defaults suit a plaintext broker on this machine
 * (streamotter.json); production requires the secrets and the study's epoch.
 */
import { fieldStationSecret, serviceToken } from "../identity.ts";
import { MAX_BENCHES } from "../lab/benches.ts";
import { GATEWAY_PATH } from "../project.ts";

export interface KafkaSettings {
  brokers: string[];
  /** A CA file turns TLS on. */
  caFile: string | null;
  /** SCRAM-SHA-512 credentials, when the broker requires them. */
  sasl: { username: string; password: string } | null;
}

export interface ServerConfig {
  production: boolean;
  kafka: KafkaSettings;
  secret: string;
  serviceToken: string;
  dataDir: string;
  /** When the hosted study began: tick 0. Null outside production means "keep the checkpoint's, or now". */
  epoch: string | null;
  tickMs: number;
  generation: number;
  /** Origins allowed to call /api with credentials. */
  siteOrigins: string[];
  /** What /api/config tells the site: where browsers reach the gateway. */
  gatewayOrigin: string;
  gatewayPath: string;
  host: string;
  port: number;
  internalPort: number;
  /** How many Failure Lab benches get a copy of the creek on their own topics (lab/benches.ts). */
  labBenches: number;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer of at least ${minimum}.`);
  return value;
}

function list(value: string): string[] {
  return value.split(",").map(item => item.trim()).filter(item => item !== "");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env["NODE_ENV"] === "production";
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`${name} is required in production.`);
    return value;
  };

  const epoch = env["FIELD_EPOCH"] ?? (production ? required("FIELD_EPOCH") : null);
  if (epoch !== null && Number.isNaN(Date.parse(epoch))) throw new Error("FIELD_EPOCH must be an ISO 8601 time.");

  const username = env["KAFKA_FIELD_STATION_USERNAME"];
  const password = env["KAFKA_FIELD_STATION_PASSWORD"];
  if ((username === undefined) !== (password === undefined)) throw new Error("Set both KAFKA_FIELD_STATION_USERNAME and KAFKA_FIELD_STATION_PASSWORD, or neither.");
  const caFile = env["KAFKA_CA_FILE"] ?? null;
  if (production && (caFile === null || username === undefined)) {
    throw new Error("Production needs Kafka over TLS with SCRAM: set KAFKA_CA_FILE, KAFKA_FIELD_STATION_USERNAME, and KAFKA_FIELD_STATION_PASSWORD.");
  }

  const siteOrigins = list(env["SITE_ORIGIN"] ?? (production ? required("SITE_ORIGIN") : "http://localhost:4321,http://127.0.0.1:4321"));
  // Production runs behind Caddy, which matches SITE_ORIGIN as one literal Origin: a list there would allow what Caddy refuses.
  // Development (no Caddy) may list several, such as localhost and 127.0.0.1.
  if (production && (siteOrigins.length !== 1 || !URL.canParse(siteOrigins[0]!) || new URL(siteOrigins[0]!).origin !== siteOrigins[0])) {
    throw new Error("SITE_ORIGIN must be one exact origin in production, such as https://streamotter.dev.");
  }

  const labBenches = integer(env, "FIELD_LAB_BENCHES", 0, 0);
  if (labBenches > MAX_BENCHES) throw new RangeError(`FIELD_LAB_BENCHES must be at most ${MAX_BENCHES}.`);

  return {
    production,
    kafka: {
      brokers: list(env["KAFKA_BROKERS"] ?? "127.0.0.1:19092"),
      caFile,
      sasl: username === undefined || password === undefined ? null : { username, password }
    },
    secret: fieldStationSecret(env),
    serviceToken: serviceToken(env),
    dataDir: env["FIELD_DATA_DIR"] ?? ".data",
    epoch: epoch === null ? null : new Date(epoch).toISOString(),
    tickMs: integer(env, "FIELD_TICK_MS", 2_000, 100),
    generation: integer(env, "FIELD_GENERATION", 1, 1),
    siteOrigins,
    gatewayOrigin: env["GATEWAY_PUBLIC_ORIGIN"] ?? (production ? required("GATEWAY_PUBLIC_ORIGIN") : "http://127.0.0.1:7400"),
    gatewayPath: GATEWAY_PATH,
    host: env["FIELD_HOST"] ?? "127.0.0.1",
    port: integer(env, "FIELD_PORT", 7402, 0),
    internalPort: integer(env, "FIELD_INTERNAL_PORT", 7410, 0),
    labBenches
  };
}
