import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createWorld, currentEmissions, step } from "@lontra-creek/sim";
import type { Json, SourceRecord } from "streamotter/contracts";
import { scaffoldFiles } from "streamotter/cli";
import { createKafkaHandlers } from "../../field-station/src/kafka-handlers.ts";
import { toRecord, topicFor } from "../../field-station/src/records.ts";
import { JOB_SEED, STATION_SEED } from "../src/data/workbench-seed.ts";

const context = { signal: new AbortController().signal, requestId: "seed-test" };
const sourceRecord = (key: string, value: unknown, position: SourceRecord["position"]): SourceRecord =>
  ({ id: "seed-1", sourceId: "seed", key, value: value as Json, receivedAt: "2026-10-03T00:00:00.000Z", position });

test("the station design fixture is the creek's LC-03 record after one tick, mapped by the field station's own Kafka handler", async () => {
  const world = createWorld({ seed: "lontra-creek" });
  step(world);
  const emission = currentEmissions(world).find(e => e.channel === "station" && e.params.stationId === "LC-03");
  assert.ok(emission);
  assert.deepEqual(STATION_SEED.record, toRecord(emission));
  assert.equal(topicFor("station"), "field.gauges");
  const handlers = createKafkaHandlers({ secret: "s".repeat(32), serviceToken: "t".repeat(32), internalOrigin: "http://127.0.0.1:1" });
  const mapped = await handlers.channels.station.map({ ...context, record: sourceRecord(STATION_SEED.record.key, STATION_SEED.record.value, { kind: "kafka", topic: "field.gauges", partition: 0, offset: "0" }) });
  assert.deepEqual(mapped, [STATION_SEED.state]);
  assert.deepEqual(STATION_SEED.params, STATION_SEED.state.params);
});

test("the jobProgress design fixture is the pinned init scaffold's first jobs record, mapped by that scaffold's handler", async () => {
  const files = new Map(scaffoldFiles("seed-check").map(file => [file.path, file.content]));
  const handlersSource = files.get("server/handlers.mjs");
  assert.ok(handlersSource, "streamotter init writes server/handlers.mjs");
  const config = JSON.parse(files.get("streamotter.json") ?? "{}") as { channels: Record<string, { source: string }> };
  assert.equal(config.channels["jobProgress"]?.source, "jobs");
  const directory = await mkdtemp(join(tmpdir(), "lontra-seed-"));
  try {
    await mkdir(join(directory, "server"));
    await writeFile(join(directory, "server", "handlers.mjs"), handlersSource);
    const scaffold = await import(pathToFileURL(join(directory, "server", "handlers.mjs")).href) as {
      handlers: { channels: { jobProgress: { map(input: { record: SourceRecord }): unknown } } };
      development: { fixtures: { jobs: { key: string; value: unknown }[] } };
    };
    assert.deepEqual(JOB_SEED.record, scaffold.development.fixtures.jobs[0]);
    const mapped = scaffold.handlers.channels.jobProgress.map({ record: sourceRecord(JOB_SEED.record.key, JOB_SEED.record.value, { kind: "fixture", index: "0" }) });
    assert.deepEqual(mapped, [JOB_SEED.state]);
    assert.deepEqual(JOB_SEED.params, JOB_SEED.state.params);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
