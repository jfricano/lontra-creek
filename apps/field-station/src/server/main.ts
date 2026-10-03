/**
 * The field station on Kafka: the simulation on the wall clock, publishing every
 * changed view, visitors' notebooks, the site API, and the gateway's snapshot API.
 *
 *   node --disable-warning=TimeoutNegativeWarning src/server/main.ts
 *
 * Configured entirely by environment variables; see config.ts. KafkaJS 2.2.4 sets
 * negative timers on Node 24 and later, which Node warns about; the flag above
 * silences only that warning.
 */
import type { Server } from "node:http";
import { TENANT_ID } from "@lontra-creek/sim";
import { configuredLab } from "../lab/leases.ts";
import { benches } from "../lab/benches.ts";
import { LabStudies } from "../lab/studies.ts";
import { NOTEBOOK_TOPIC } from "../records.ts";
import { readConfig } from "./config.ts";
import { internalApi, publicApi } from "./http.ts";
import { connectKafka } from "./kafka.ts";
import { Notebooks } from "./notebooks.ts";
import { PublishQueue } from "./queue.ts";
import { FieldStation } from "./station.ts";

const NOTEBOOK_SWEEP_MS = 10_000;
const RETRY_MS = 5_000;

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);
const config = readConfig();
const kafka = await connectKafka(config.kafka, log, { benchPrefixes: benches(config.labBenches).map(bench => bench.topicPrefix) });
const queue = new PublishQueue(kafka.publisher, log);
const station = new FieldStation({ queue, dataDir: config.dataDir, epoch: config.epoch, tickMs: config.tickMs, generation: config.generation, log });
const notebooks = new Notebooks({ queue, tenantId: TENANT_ID, log });

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
// Each bench study's publisher gate, coverage ledger, and served state (lab/studies.ts).
// Scenario runs publish through it with kafka.scenario once W9b's scenarios exist.
const studies = new LabStudies({ dataDir: config.dataDir, world: station, log });
const lab = configuredLab(process.env, config.gatewayOrigin, studies);
const api = publicApi({ config, station, notebooks, log, lab: lab.pool });
const internal = internalApi({ serviceToken: config.serviceToken, station, notebooks, labTokens: lab.tokens, studies });
await listen(api, config.port, "Site API");
await listen(internal, config.internalPort, "Internal API");

await station.start();
await lab.pool.initialize();
const labTimer = setInterval(() => { void lab.pool.run(() => lab.pool.sweep()).catch(() => log("Lab maintenance failed; retrying.")); }, 5000);
log(`Field station running: generation ${config.generation}, epoch ${station.epoch}, a tick every ${config.tickMs} ms.`);

let stopping = false;
const timers = new Set<NodeJS.Timeout>();
function later(delayMs: number, run: () => void): void {
  if (stopping) return;
  const timer = setTimeout(() => {
    timers.delete(timer);
    run();
  }, delayMs);
  timers.add(timer);
}

function tick(): void {
  later(Math.max(0, station.nextTickAt() - Date.now()), () => {
    station.advance()
      .catch((error: unknown) => log(`Advancing failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(tick);
  });
}

/** Rebuilds notebooks from their topic, retrying until Kafka answers. */
function loadNotebooks(): void {
  kafka.readAll(NOTEBOOK_TOPIC).then(
    values => {
      notebooks.load(values);
      void queue.flush();
      sweepNotebooks();
    },
    (error: unknown) => {
      log(`Reading ${NOTEBOOK_TOPIC} failed; retrying: ${error instanceof Error ? error.message : String(error)}`);
      later(RETRY_MS, loadNotebooks);
    }
  );
}

function sweepNotebooks(): void {
  later(NOTEBOOK_SWEEP_MS, () => {
    if (notebooks.expire() > 0) void queue.flush();
    sweepNotebooks();
  });
}

// Publish the startup republish now rather than on the first tick.
void queue.flush();
tick();
loadNotebooks();

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(labTimer);
  log(`${signal}: stopping.`);
  for (const timer of timers) clearTimeout(timer);
  await Promise.all([api, internal].map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections();
  })));
  await station.stop();
  await kafka.publisher.close().catch(() => undefined);
  log("Stopped.");
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
