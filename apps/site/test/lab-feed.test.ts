import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabFeedItem } from "../../field-station/src/lab/contract.ts";
import { FEED_SHOW, LabFeedModel, retriedOutcome } from "../src/scripts/lab-feed.ts";

let n = 0;
const at = (second: number) => `2026-10-03T00:00:${String(second).padStart(2, "0")}.000Z`;
const item = (second: number, rest: Record<string, unknown>) => ({ id: `lease:${++n}`, at: at(second), ...rest }) as LabFeedItem;
const record = (second: number, outcome: "failed" | "processed", offset = "246") => item(second, { kind: "record", stationId: "LC-03", topic: "lab-1.field.gauges", partition: 0, offset, outcome });
const trace = (second: number, rest: Record<string, unknown> = {}) => item(second, { kind: "trace", stage: "send", outcome: "ok", group: "g1", channel: "station", subscriber: "you", ...rest });

test("the scenario view keeps what the fouled-sensor story turns on and drops ok traces", () => {
  const model = new LabFeedModel();
  model.add([
    item(1, { kind: "bench", event: "lease-started" }),
    trace(2), trace(2, { stage: "commit" }), record(3, "processed", "245"),
    item(4, { kind: "action", action: "sensor.foul" }),
    record(5, "failed"), trace(5, { stage: "map", outcome: "failed", errorCode: "HANDLER_FAILED", subscriber: undefined }),
    item(6, { kind: "source", sourceId: "field", status: "paused", reason: "HANDLER_FAILED" })
  ]);
  assert.deepEqual(model.lines(false).map(line => line.text), [
    "Lease started",
    "You: Foul sensor",
    "LC-03 record lab-1.field.gauges · partition 0 · offset 246: map failed",
    "map failed HANDLER_FAILED · station",
    "Source field: paused (HANDLER_FAILED)"
  ]);
  assert.equal(model.lines(true).length, 8, "the full feed keeps every item");
  assert.ok(model.lines(true).some(line => line.text === "LC-03 record lab-1.field.gauges · partition 0 · offset 245: mapper returned"));
  assert.ok(model.lines(true).every(line => !/processed|committed/.test(line.text)), "a record annotation never claims more than the mapper returning");
});

test("after Resume the same offset is marked retried, not any later record", () => {
  const model = new LabFeedModel();
  model.add([record(1, "failed"), record(2, "failed")]);
  assert.match(model.lines(false)[1]!.text, /map failed again/);
  assert.equal(model.retried, null);
  model.add([item(3, { kind: "action", action: "source.resume" }), record(4, "processed"), record(5, "processed", "247")]);
  const retried = model.lines(false).filter(line => line.retried);
  assert.deepEqual(retried.map(line => line.text), ["Retried LC-03 record lab-1.field.gauges · partition 0 · offset 246: mapper returned"]);
  assert.deepEqual(model.retried, { topic: "lab-1.field.gauges", partition: 0, offset: "246", after: "source.resume" });
  assert.ok(!model.lines(false).some(line => line.text.includes("offset 247")), "an ordinary later record stays in the full feed only");
});

test("the slow client's run is known once it disconnects, whichever order its items arrive in", () => {
  const model = new LabFeedModel();
  model.add([item(1, { kind: "bench", event: "satellite-connected" })]);
  assert.deepEqual(model.satellite, { connected: true, overloaded: false, disconnected: false });
  model.add([item(7, { kind: "bench", event: "satellite-disconnected" })]);
  assert.deepEqual(model.satellite, { connected: true, overloaded: false, disconnected: true });
  // The receipt trace comes from the next management poll, after the bench's own event.
  model.add([trace(6, { stage: "receipt", outcome: "failed", errorCode: "OVERLOADED", subscriber: "satellite" })]);
  assert.equal(model.satellite?.overloaded, true);
  assert.deepEqual(model.lines(false).map(line => line.text), ["Slow client connected", "receipt failed OVERLOADED · station · slow client", "Slow client disconnected"], "lines are in time order");
});

test("the page keeps a bounded feed and clears it per lease", () => {
  const model = new LabFeedModel();
  model.add(Array.from({ length: 600 }, (_, i) => trace(i % 60)));
  assert.equal(model.lines(true).length, FEED_SHOW);
  model.gap(at(59));
  assert.equal(model.lines(false).at(-1)?.text, "Some older feed entries have expired and weren't shown.");
  model.clear();
  assert.deepEqual(model.lines(true), []);
  assert.equal(model.satellite, null);
});

test("a busy feed drops routine lines first, so the scenario view keeps its steps", async () => {
  const { FEED_KEEP } = await import("../src/scripts/lab-feed.ts");
  const model = new LabFeedModel();
  model.add([item(1, { kind: "action", action: "sensor.foul" }), record(2, "failed"), item(3, { kind: "source", sourceId: "field", status: "paused" })]);
  model.add(Array.from({ length: FEED_KEEP + 50 }, () => trace(4)));
  assert.deepEqual(model.lines(false).map(line => line.text), [
    "You: Foul sensor",
    "LC-03 record lab-1.field.gauges · partition 0 · offset 246: map failed",
    "Source field: paused"
  ]);
  assert.equal(model.lines(true).length, FEED_SHOW);
});

test("the retried record's outcome names the action that preceded it, and none when there was none", () => {
  const story = (action: string | null) => {
    const model = new LabFeedModel();
    model.add([item(1, { kind: "action", action: "sensor.foul" }), record(2, "failed"), item(3, { kind: "source", sourceId: "field", status: "paused", reason: "HANDLER_FAILED" }), item(4, { kind: "action", action: "sensor.restore" })]);
    if (action) model.add([item(5, { kind: "action", action })]);
    if (action === "gateway.restart") model.add([item(6, { kind: "bench", event: "gateway-stopped" }), item(7, { kind: "bench", event: "gateway-started" })]);
    model.add([record(8, "processed")]);
    return retriedOutcome(model.retried!);
  };
  assert.match(story("source.resume"), /^After Resume the gateway retried the same record, offset 246 on lab-1\.field\.gauges partition 0, and the mapper returned\./);
  // A restart while the source is paused re-reads the uncommitted offset: no Resume was pressed.
  assert.match(story("gateway.restart"), /^After the gateway restart, the restarted gateway read the same record again, offset 246 on lab-1\.field\.gauges partition 0, and the mapper returned\./);
  assert.match(story(null), /^The gateway retried the same record, offset 246/);
  for (const action of ["source.resume", "gateway.restart", null]) assert.match(story(action), /That isn't proof the offset was committed/);
});
