/** Native development gateway: compiled handlers, real local Kafka, no fixture. */
import { readFile } from "node:fs/promises";
import { createGateway } from "streamotter/gateway";
// The parent compiles these before starting any services.
const { handlers } = await import("../dist/kafka-handlers.js");
const config = JSON.parse(await readFile(process.env["LONTRA_NATIVE_CONFIG"], "utf8"));
const gateway = createGateway({ config, handlers, mode: "development" });
await gateway.start();
console.log(`Native Kafka gateway listening on ${config.gateway.host}:${config.gateway.port}.`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (stopping) return; stopping = true;
  void gateway.stop().finally(() => process.exit(0));
});
