import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabCapabilities, LabScenarioId } from "../../field-station/src/lab/contract.ts";
import { labCapabilities } from "../../field-station/src/lab/capabilities.ts";
import { SCENARIOS, TRACKS } from "../src/lab-catalog.ts";
import { PAGE_RUNS, UNSUPPORTED, capabilityAnswer, capabilityNote, scenarioAvailability, selectionFromUrl, startState, urlFor, type CapabilityAnswer } from "../src/scripts/lab-catalog-model.ts";

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
  assert.equal(urlFor(new URL("https://streamotter.dev/lab/?x=1"), { track: "source-failures", scenario: "calibration-blip" }), "/lab/?x=1&scenario=calibration-blip#source-failures");
  assert.equal(urlFor(new URL("https://streamotter.dev/lab/?scenario=calibration-blip#source-failures"), { track: "connections", scenario: null }), "/lab/#connections");
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
  // A backend that offers an exercise this page has none for is still unavailable here.
  const free = { available: true, reason: null };
  const newer: LabCapabilities = { ...older, scenarios: [...older.scenarios, { id: "garbled-reading", ...free }], features: { incidentProjection: free, intents: free } };
  assert.deepEqual(scenarioAvailability("garbled-reading", { kind: "summary", summary: newer }, new Set()), { state: "unavailable", text: "This backend reports this exercise, but this version of the site can't run it yet." });
  assert.equal(scenarioAvailability("garbled-reading", { kind: "summary", summary: newer }).state, "available");
});

/** A summary as a 0.2.0-rc.1 backend could answer it: a fixture, not the field station's own output. */
function offered(scenarios: Partial<Record<LabScenarioId, LabCapabilities["scenarios"][number]["reason"]>>, features: Partial<LabCapabilities["features"]> = {}): CapabilityAnswer {
  const free = { available: true, reason: null };
  const base = (rc3 as { summary: LabCapabilities }).summary;
  return { kind: "summary", summary: { ...base, library: { name: "streamotter", version: "0.2.0-rc.1" },
    scenarios: base.scenarios.map(s => s.id in scenarios ? { id: s.id, available: scenarios[s.id] === null, reason: scenarios[s.id] ?? null } : SCENARIOS[s.id].controls === null ? { id: s.id, available: false, reason: { code: "not-integrated", text: "Not verified." } } : s),
    features: { incidentProjection: free, intents: free, ...features } } };
}

test("this page runs every new exercise, each only where the backend reports it, its intents, and its projection available", () => {
  assert.deepEqual([...PAGE_RUNS].sort(), [...NEW].sort());
  const restricted = { code: "deployment-restricted" as const, text: "This deployment's failure handling (retry) doesn't provide what this exercise needs, so it doesn't run it." };
  const answer = offered({ "calibration-blip": null, "garbled-reading": restricted });
  assert.deepEqual(scenarioAvailability("calibration-blip", answer), { state: "available", text: "Available on a leased bench." });
  assert.deepEqual(scenarioAvailability("garbled-reading", answer), { state: "unavailable", text: restricted.text });
  assert.deepEqual(scenarioAvailability("bad-projection", answer), { state: "unavailable", text: "Not verified." });
  assert.match(capabilityNote(answer, "0.2.0-rc.1"), /1 of 8 new exercises can run here\.$/);
  // Listed as available, but without intents or the projection the page can't start or follow it.
  const noIntents = offered({ "calibration-blip": null }, { intents: { available: false, reason: { code: "lab-disabled", text: "This backend has no Lab benches." } } });
  assert.deepEqual(scenarioAvailability("calibration-blip", noIntents), { state: "unavailable", text: "This backend has no Lab benches." });
  const noProjection = offered({ "calibration-blip": null }, { incidentProjection: { available: false, reason: null } });
  assert.deepEqual(scenarioAvailability("calibration-blip", noProjection), { state: "unavailable", text: UNSUPPORTED });
  // A summary without the intents flag isn't one this page can read.
  const { intents: _, ...partial } = (answer as { summary: LabCapabilities }).summary.features;
  assert.equal(capabilityAnswer({ ...(answer as { summary: LabCapabilities }).summary, features: partial }).kind, "unreachable");
});

test("Start sends only on a borrowed bench with nothing waiting, and its line says why otherwise", () => {
  const available = { state: "available" as const, text: "Available on a leased bench." };
  assert.deepEqual(startState(available, { leased: false, busy: false }), { enabled: false, text: "Available on a leased bench. Borrow a bench below, then start it here." });
  assert.deepEqual(startState(available, { leased: true, busy: false }), { enabled: true, text: "Available on your bench." });
  assert.deepEqual(startState(available, { leased: true, busy: true }), { enabled: false, text: "Available on your bench once its current request finishes; follow it in Current incident below." });
  for (const state of ["existing", "pending", "unavailable"] as const) assert.deepEqual(startState({ state, text: "Why." }, { leased: true, busy: false }), { enabled: false, text: "Why." }, state);
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
