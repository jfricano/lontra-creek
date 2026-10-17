import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabBenchState } from "../../field-station/src/lab/contract.ts";
import { benchChips, positionText, staleNote } from "../src/scripts/lab-bench.ts";
import { ACTION_SENT, ACTION_SLOT, retriedSlot, scenarioSlot } from "../src/scripts/lab-outcomes.ts";

const healthy: LabBenchState = { gateway: "running", source: { status: "healthy" }, relay: "up", calibration: "present", satellite: "idle", receiptTimeoutMs: 5000 };

test("the bench strip shows one chip per part, toned by whether it is as it should be", () => {
  const chips = benchChips(healthy, { state: "live", reason: undefined, revision: "r1" });
  assert.deepEqual(chips.map(chip => [chip.label, chip.text, chip.state]), [
    ["Gateway", "running", "live"], ["Source", "healthy", "live"], ["Relay", "up", "live"], ["Calibration", "present", "live"], ["Slow client", "idle", "idle"], ["Your view", "live", "live"]
  ]);
  const fouled = benchChips({ ...healthy, source: { status: "paused", reason: "HANDLER_FAILED" }, calibration: "removed" }, { state: "stale", reason: "SOURCE_UNAVAILABLE", revision: "r2" });
  assert.deepEqual(fouled.map(chip => [chip.text, chip.state]).slice(1), [["paused · HANDLER_FAILED", "failed"], ["up", "live"], ["removed", "failed"], ["idle", "idle"], ["stale · SOURCE_UNAVAILABLE", "stale"]]);
  const cut = benchChips({ ...healthy, source: { status: "degraded" }, relay: "cut", gateway: "restarting", satellite: "connected" }, { state: "idle", reason: undefined, revision: undefined });
  assert.deepEqual(cut.map(chip => chip.state), ["synchronizing", "stale", "failed", "live", "synchronizing", "idle"]);
  // Not leased: every bench chip is a dash, and the view chip is the SDK's own state.
  assert.deepEqual(benchChips(undefined, { state: "idle", reason: undefined, revision: undefined }).map(chip => chip.text), ["—", "—", "—", "—", "—", "idle"]);
});

test("the stale note names the revision kept on screen, and only while the view is stale", () => {
  assert.equal(staleNote({ state: "stale", reason: undefined, revision: "r160" }), "Stale: revision r160 is the last value your SDK received, kept on screen, not current data.");
  assert.equal(staleNote({ state: "live", reason: undefined, revision: "r160" }), "");
  assert.equal(staleNote({ state: "stale", reason: undefined, revision: undefined }), "");
});

test("the Kafka position names the held record first, else the last mapped one", () => {
  const held = { topic: "lab-1.field.gauges", partition: 2, offset: "282" };
  const last = { topic: "lab-1.field.gauges", partition: 2, offset: "398" };
  assert.equal(positionText({ held, last }), "Held at lab-1.field.gauges · partition 2 · offset 282");
  assert.equal(positionText({ held: null, last }), "Last mapped lab-1.field.gauges · partition 2 · offset 398");
  assert.equal(positionText({ held: null, last: null }), "");
});

test("every bench action has a sentence and a slot under its own buttons", () => {
  for (const action of Object.keys(ACTION_SENT) as (keyof typeof ACTION_SENT)[]) {
    assert.ok(ACTION_SENT[action].length > 20, action);
    assert.ok(ACTION_SLOT[action], action);
    // Written at click time, so it says what to watch for, never that the gateway already did it.
    assert.doesNotMatch(ACTION_SENT[action], /committed|is now live|succeeded/);
  }
  assert.equal(ACTION_SLOT["source.resume"], "sensor");
  assert.equal(scenarioSlot("fouled-sensor"), "sensor");
  assert.equal(scenarioSlot("calibration-blip"), "blip");
  assert.equal(scenarioSlot("bad-projection"), "scenario:bad-projection");
  assert.equal(retriedSlot("gateway.restart"), "gateway");
  assert.equal(retriedSlot("source.resume"), "sensor");
  assert.equal(retriedSlot(null), "sensor");
});
