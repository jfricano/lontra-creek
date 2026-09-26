/**
 * The field station on Kafka: the simulation on the wall clock, publishing every
 * changed view, with the site API and the gateway's snapshot API.
 *
 *   node --disable-warning=TimeoutNegativeWarning src/server/main.ts
 *
 * Configured entirely by environment variables; see config.ts. KafkaJS 2.2.4 sets
 * negative timers on Node 24 and later, which Node warns about; the flag above
 * silences only that warning.
 */
import type { Server } from "node:http";
import { readConfig } from "./config.ts";
import { internalApi, publicApi } from "./http.ts";
import { createKafkaPublisher } from "./kafka.ts";
import { FieldStation } from "./station.ts";

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);
const config = readConfig();
const publisher = await createKafkaPublisher(config.kafka, log);
const station = new FieldStation({ publisher, dataDir: config.dataDir, epoch: config.epoch, tickMs: config.tickMs, generation: config.generation, log });

function listen(server: Server, port: number, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, config.host, () => {
      log(`${name} listening on ${config.host}:${port}.`);
      resolve();
    });
  });
}

// Listen first so the health check can say "catching up" instead of timing out.
const api = publicApi({ config, station, log });
const internal = internalApi({ serviceToken: config.serviceToken, station });
await listen(api, config.port, "Site API");
await listen(internal, config.internalPort, "Internal API");

await station.start();
log(`Field station running: generation ${config.generation}, epoch ${station.epoch}, a tick every ${config.tickMs} ms.`);

let timer: NodeJS.Timeout | undefined;
let stopping = false;
function schedule(): void {
  if (stopping) return;
  timer = setTimeout(() => {
    station.advance()
      .catch((error: unknown) => log(`Advancing failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(schedule);
  }, Math.max(0, station.nextTickAt() - Date.now()));
}
// Publish the startup republish now rather than on the first tick.
void station.flush();
schedule();

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping.`);
  clearTimeout(timer);
  await Promise.all([api, internal].map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections();
  })));
  await station.stop();
  await publisher.close().catch(() => undefined);
  log("Stopped.");
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
