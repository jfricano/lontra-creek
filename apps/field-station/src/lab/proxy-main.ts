/**
 * Runs one bench's proxy to Kafka (proxy.ts) and its control API.
 *
 *   LAB_BENCH=1 node src/lab/proxy-main.ts
 *
 * Environment: LAB_BENCH (the bench's number), LAB_RELAY_TOKEN (the control API's
 * own bearer token — not FIELD_STATION_SERVICE_TOKEN, which can also read every
 * notebook through the field station's internal API), and optionally PROXY_LISTEN
 * (default 0.0.0.0:<the bench's proxy port>), PROXY_TARGET (default
 * kafka:<the same port>, the broker's listener for this bench), and PROXY_CONTROL
 * (default 0.0.0.0:9180).
 */
import type { AddressInfo } from "node:net";

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
const token = process.env[`LAB_BENCH_${Number(process.env['LAB_BENCH'])}_RELAY_TOKEN`];
if (!token || token.length < 32) throw new Error('A per-bench relay token of at least 32 characters is required.');
const control = proxyControl(proxy, token);
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
