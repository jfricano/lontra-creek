import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabCapabilities, LabScenarioId } from "../../field-station/src/lab/contract.ts";
import { labCapabilities } from "../../field-station/src/lab/capabilities.ts";
import { SCENARIOS, TRACKS } from "../src/lab-catalog.ts";
import { UNSUPPORTED, capabilityAnswer, capabilityNote, scenarioAvailability, selectionFromUrl, urlFor, type CapabilityAnswer } from "../src/scripts/lab-catalog-model.ts";

const NEW = TRACKS["source-failures"].filter(id => id !== "fouled-sensor");
const rc3: CapabilityAnswer = { kind: "summary", summary: labCapabilities({ labEnabled: true, now: 0, version: "0.1.0-rc.3" }) };
const url = (search: string, hash = "") => ({ search, hash });

test("the catalog covers LC11-S01 to S09 once each, with the plan's delivery labels", () => {
  const stories = TRACKS["source-failures"].map(id => SCENARIOS[id].story);
  assert.deepEqual(stories, ["LC11-S01", "LC11-S02", "LC11-S03", "LC11-S04", "LC11-S05", "LC11-S06", "LC11-S07", "LC11-S08", "LC11-S09"]);
  assert.deepEqual(TRACKS["source-failures"].map(id => SCENARIOS[id].delivery), ["public", "public", "public", "public", "advanced", "advanced", "local-ci", "local-ci", "local-ci"]);
  // Fouled sensor is the bridge: in both indexes, one implementation with the existing controls.
  assert.ok(TRACKS.connections.includes("fouled-sensor"));
  assert.equal(SCENARIOS["fouled-sensor"].controls, "control-fouled-sensor");
  assert.deepEqual(TRACKS.connections.filter(id => SCENARIOS[id].controls === null), []);
  for (const id of NEW) assert.equal(SCENARIOS[id].controls, null, id);
});

test("a deep link selects explanation only, and an unknown scenario is ignored", () => {
  assert.deepEqual(selectionFromUrl(url("")), { track: "connections", scenario: null });
  assert.deepEqual(selectionFromUrl(url("", "#source-failures")), { track: "source-failures", scenario: null });
  assert.deepEqual(selectionFromUrl(url("?scenario=bad-projection")), { track: "source-failures", scenario: "bad-projection" });
  assert.deepEqual(selectionFromUrl(url("?scenario=relay-cut")), { track: "connections", scenario: "relay-cut" });
  assert.deepEqual(selectionFromUrl(url("?scenario=fouled-sensor")), { track: "source-failures", scenario: "fouled-sensor" });
  assert.deepEqual(selectionFromUrl(url("?scenario=fouled-sensor", "#connections")), { track: "connections", scenario: "fouled-sensor" });
  // A scenario outside the named track opens its own track.
  assert.deepEqual(selectionFromUrl(url("?scenario=garbled-reading", "#connections")), { track: "source-failures", scenario: "garbled-reading" });
  for (const junk of ["?scenario=toString", "?scenario=__proto__", "?scenario=%3Cscript%3E", "?scenario="]) assert.deepEqual(selectionFromUrl(url(junk, "#source-failures")), { track: "source-failures", scenario: null }, junk);
  assert.equal(urlFor(new URL("https://streamotter.app/lab/?x=1"), { track: "source-failures", scenario: "calibration-blip" }), "/lab/?x=1&scenario=calibration-blip#source-failures");
  assert.equal(urlFor(new URL("https://streamotter.app/lab/?scenario=calibration-blip#source-failures"), { track: "connections", scenario: null }), "/lab/#connections");
});

test("against 0.1.0-rc.3 every new exercise is unavailable with the capability it lacks", () => {
  for (const id of NEW) {
    const availability = scenarioAvailability(id, rc3);
    assert.equal(availability.state, "unavailable", id);
    assert.match(availability.text, /^This backend's StreamOtter release \(0\.1\.0-rc\.3\) doesn't provide /, id);
  }
  assert.equal(scenarioAvailability("garbled-reading", rc3).text, "This backend's StreamOtter release (0.1.0-rc.3) doesn't provide quarantine.");
  for (const id of ["fouled-sensor", "relay-cut", "slow-client", "relay-restart"] as LabScenarioId[]) assert.equal(scenarioAvailability(id, rc3).state, "existing", id);
});

test("a missing, unreachable, or older summary leaves every new exercise unavailable, with no mock fallback", () => {
  for (const id of NEW) {
    assert.deepEqual(scenarioAvailability(id, { kind: "absent" }), { state: "unavailable", text: UNSUPPORTED });
    assert.equal(scenarioAvailability(id, { kind: "unreachable" }).state, "unavailable");
    assert.equal(scenarioAvailability(id, { kind: "pending" }).state, "pending");
  }
  // An older backend that knows only the existing scenarios.
  const older: LabCapabilities = { ...(rc3 as { summary: LabCapabilities }).summary, scenarios: (rc3 as { summary: LabCapabilities }).summary.scenarios.filter(s => SCENARIOS[s.id].controls !== null) };
  assert.equal(scenarioAvailability("bad-projection", { kind: "summary", summary: older }).text, "This backend does not support this scenario.");
  // A newer backend that offers an exercise this page can't run is still unavailable here.
  const newer: LabCapabilities = { ...older, scenarios: [...older.scenarios, { id: "garbled-reading", available: true, reason: null }] };
  assert.deepEqual(scenarioAvailability("garbled-reading", { kind: "summary", summary: newer }), { state: "unavailable", text: "This backend reports this exercise, but this version of the site can't run it yet." });
  assert.equal(scenarioAvailability("garbled-reading", { kind: "summary", summary: newer }, new Set(["garbled-reading"])).state, "available");
});

test("the backend note names the backend's version and any skew with the page's build", () => {
  assert.equal(capabilityNote(rc3, "0.1.0-rc.3"), "This backend runs StreamOtter 0.1.0-rc.3 on real Kafka with synthetic data (Lab benches enabled). 0 of 8 new exercises can run here.");
  assert.match(capabilityNote(rc3, "1.1.0"), /This page was built for StreamOtter 1\.1\.0\.$/);
  assert.match(capabilityNote({ kind: "absent" }, "0.1.0-rc.3"), /doesn't report Lab capabilities/);
});

test("only a body with the summary's shape counts as a summary", () => {
  assert.equal(capabilityAnswer((rc3 as { summary: LabCapabilities }).summary).kind, "summary");
  for (const body of [null, "ok", [], {}, { status: "queued" }, { scenarios: [], library: { version: "0.1.0-rc.3" } }, { ...(rc3 as { summary: LabCapabilities }).summary, scenarios: [{ id: 1 }] }]) assert.deepEqual(capabilityAnswer(body), { kind: "unreachable" }, JSON.stringify(body));
});

test("an existing scenario claims to run today only when the backend reports it available", () => {
  const EXISTING = ["fouled-sensor", "relay-cut", "slow-client", "relay-restart"] as LabScenarioId[];
  const disabled: CapabilityAnswer = { kind: "summary", summary: labCapabilities({ labEnabled: false, now: 0, version: "0.1.0-rc.3" }) };
  for (const id of EXISTING) {
    assert.deepEqual(scenarioAvailability(id, disabled), { state: "unavailable", text: "This backend has no Lab benches." }, id);
    assert.match(scenarioAvailability(id, rc3).text, /^Runs today on a leased bench with /, id);
    // Not checked yet (the static text), no summary, or no usable answer: say what it needs rather than that it runs.
    for (const answer of [{ kind: "pending" }, { kind: "absent" }, { kind: "unreachable" }] as CapabilityAnswer[]) {
      const availability = scenarioAvailability(id, answer);
      assert.equal(availability.state, "existing", `${id} ${answer.kind}`);
      assert.match(availability.text, /^Runs on a leased bench with .*, when this backend has benches\.$/, `${id} ${answer.kind}`);
    }
  }
  assert.equal(scenarioAvailability("fouled-sensor", rc3).text, "Runs today on a leased bench with the Fouled sensor controls below.");
  assert.equal(scenarioAvailability("fouled-sensor", { kind: "absent" }).text, "Runs on a leased bench with the Fouled sensor controls below, when this backend has benches.");
});
