import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabFeedItem } from "../../field-station/src/lab/contract.ts";
import { FEED_SHOW, LabFeedModel } from "../src/scripts/lab-feed.ts";

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
  assert.deepEqual(model.retried, { topic: "lab-1.field.gauges", partition: 0, offset: "246" });
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
