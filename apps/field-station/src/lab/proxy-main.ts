/**
 * Runs one bench's proxy to Kafka (proxy.ts) and its control API.
 *
 *   LAB_BENCH=1 node src/lab/proxy-main.ts
 *
 * Environment: LAB_BENCH (the bench's number), FIELD_STATION_SERVICE_TOKEN (the
 * control API's bearer token), and optionally PROXY_LISTEN (default
 * 0.0.0.0:<the bench's proxy port>), PROXY_TARGET (default kafka:<the same port>,
 * the broker's listener for this bench), and PROXY_CONTROL (default 0.0.0.0:9180).
 */
import type { AddressInfo } from "node:net";
import { serviceToken } from "../identity.ts";
import { bench } from "./benches.ts";
import { proxyControl, startProxy, type Endpoint } from "./proxy.ts";

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);

function endpoint(name: string, fallback: string): Endpoint {
  const value = process.env[name] ?? fallback;
  const match = /^(.+):(\d+)$/.exec(value);
  if (match === null) throw new Error(`${name} must be <host>:<port>.`);
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]) };
}

const { proxyPort } = bench(Number(process.env["LAB_BENCH"]));
const proxy = await startProxy({
  listen: endpoint("PROXY_LISTEN", `0.0.0.0:${proxyPort}`),
  target: endpoint("PROXY_TARGET", `kafka:${proxyPort}`),
  log
});
const control = proxyControl(proxy, serviceToken());
const controlAt = endpoint("PROXY_CONTROL", "0.0.0.0:9180");
await new Promise<void>((resolve, reject) => {
  control.once("error", reject);
  control.listen(controlAt.port, controlAt.host, resolve);
});
log(`Control API on ${controlAt.host}:${(control.address() as AddressInfo).port}.`);

async function stop(signal: string): Promise<void> {
  log(`${signal}: stopping.`);
  control.close();
  control.closeAllConnections();
  await proxy.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
