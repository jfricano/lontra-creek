/**
 * Runs one bench's relay to Kafka (relay.ts) and its control API.
 *
 *   LAB_BENCH=1 node src/lab/relay-main.ts
 *
 * Environment: LAB_BENCH (the bench's number), FIELD_STATION_SERVICE_TOKEN (the
 * control API's bearer token), and optionally RELAY_LISTEN (default
 * 0.0.0.0:<the bench's relay port>), RELAY_TARGET (default kafka:<the same port>,
 * the broker's listener for this bench), and RELAY_CONTROL (default 0.0.0.0:9180).
 */
import { serviceToken } from "../identity.ts";
import { bench } from "./benches.ts";
import { relayControl, startRelay, type Endpoint } from "./relay.ts";

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);

function endpoint(name: string, fallback: string): Endpoint {
  const value = process.env[name] ?? fallback;
  const match = /^(.+):(\d+)$/.exec(value);
  if (match === null) throw new Error(`${name} must be <host>:<port>.`);
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]) };
}

const { relayPort } = bench(Number(process.env["LAB_BENCH"]));
const relay = await startRelay({
  listen: endpoint("RELAY_LISTEN", `0.0.0.0:${relayPort}`),
  target: endpoint("RELAY_TARGET", `kafka:${relayPort}`),
  log
});
const control = relayControl(relay, serviceToken());
const controlAt = endpoint("RELAY_CONTROL", "0.0.0.0:9180");
await new Promise<void>((resolve, reject) => {
  control.once("error", reject);
  control.listen(controlAt.port, controlAt.host, resolve);
});
log(`Control API on ${controlAt.host}:${controlAt.port}.`);

async function stop(signal: string): Promise<void> {
  log(`${signal}: stopping.`);
  control.close();
  control.closeAllConnections();
  await relay.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
