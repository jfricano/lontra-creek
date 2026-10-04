import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabIncidentSummary } from "../../field-station/src/lab/contract.ts";
import { EVALUATION, EVIDENCE, RECOVERY, REPROCESS, SOURCE, STEPS_SHOWN, incidentView } from "../src/scripts/lab-incident.ts";

/** A rendering fixture for the PROPOSED projection. It proves the labels, not that any backend produces it. */
const incident = (rest: Partial<LabIncidentSummary> = {}): LabIncidentSummary => ({
  label: "Incident 1", scenario: "bad-projection", scenarioRevision: 3,
  reason: "LC-03's projection produced a gauge value of the wrong type.",
  openedAt: "2026-10-03T00:00:10.000Z", updatedAt: "2026-10-03T00:00:20.000Z",
  failure: { stage: "public payload validation", class: "invalid public payload" }, policy: "quarantine-and-hold",
  evidence: "saved", source: "held", recovery: "coverage-not-ready", evaluation: null, reprocess: null, discarded: false, nextIntent: "scenario.prepare-coverage",
  detail: { topic: "lab-1.field.gauges", partition: 0, offset: "246", evidenceFingerprint: "sha256:abc", handlerIdentity: null, sourceGeneration: "lab-1-field-1" },
  steps: [{ at: "2026-10-03T00:00:12.000Z", origin: "library", text: "Quarantine write acknowledged" }, { at: "2026-10-03T00:00:11.000Z", origin: "application", text: "Scenario record published" }],
  stepsGap: false, ...rest
});

test("labels say what happened and the note says what it doesn't imply", () => {
  assert.equal(EVIDENCE.saved.text, "Evidence saved");
  assert.match(EVIDENCE.saved.note!, /isn't repaired.*isn't recovered/);
  assert.equal(SOURCE.advanced.text, "Source advanced past quarantined record");
  assert.match(SOURCE.advanced.note!, /did not receive the excluded record/);
  assert.equal(RECOVERY["coverage-established"].text, "Snapshot coverage established");
  assert.match(RECOVERY["coverage-established"].note!, /didn't prove the business data correct/);
  assert.match(RECOVERY["view-resynchronized"].note!, /not replayed/);
  assert.equal(EVALUATION.passed.text, "Evaluation passed");
  assert.match(EVALUATION.passed.note!, /changed no source offset, sent no state, and published no business event\. Nothing has been reprocessed\./);
  assert.deepEqual(Object.values(REPROCESS).map(mark => mark.text), ["Reprocessed", "Superseded by a newer snapshot", "Reprocessing failed", "Reprocessing outcome unknown"]);
  // Text and an icon on every mark: nothing depends on color.
  for (const mark of [...Object.values(EVIDENCE), ...Object.values(SOURCE), ...Object.values(RECOVERY), ...Object.values(EVALUATION), ...Object.values(REPROCESS)]) { assert.ok(mark.icon.length > 0); assert.ok(mark.text.length > 0); }
});

test("a projection becomes the three areas, with coordinates behind disclosure and browser steps merged in time order", () => {
  const view = incidentView(incident(), [{ at: "2026-10-03T00:00:05.000Z", text: "LC-03 subscription live" }, { at: "2026-10-03T00:00:13.000Z", text: "LC-03 subscription stale (SOURCE_UNAVAILABLE)" }]);
  assert.equal(view.failure, "invalid public payload at public payload validation");
  assert.equal(view.recovery.text, "Saved, but not safe to continue: snapshot coverage not ready");
  assert.equal(view.next, "Make snapshot coverage ready (application action). This version of the page can't send it.");
  assert.deepEqual(view.steps.map(step => `${step.origin}: ${step.text}`), [
    "Application action: Scenario record published", "Library observation: Quarantine write acknowledged", "Browser observation: LC-03 subscription stale (SOURCE_UNAVAILABLE)"
  ]);
  assert.deepEqual(view.detail[0], ["Source coordinates", "lab-1.field.gauges · partition 0 · offset 246"]);
  assert.deepEqual(view.detail[2], ["Handler identity", "Not reported"]);
  assert.equal(view.announcement, "Incident 1: Evidence saved; Source held at this record; Saved, but not safe to continue: snapshot coverage not ready.");
});

test("later states, discarded studies, and gaps are reported as observed", () => {
  const done = incidentView(incident({ source: "advanced", recovery: "view-resynchronized", evaluation: { result: "passed", at: "2026-10-03T00:01:00.000Z", expiresAt: null }, reprocess: "superseded", nextIntent: null }));
  assert.equal(done.reprocess?.text, "Superseded by a newer snapshot");
  assert.equal(done.next, "None right now.");
  assert.match(done.announcement, /Evaluation passed; Superseded by a newer snapshot\.$/);
  const discarded = incidentView(incident({ discarded: true }));
  assert.equal(discarded.discarded?.text, "Study discarded and reset"); assert.match(discarded.discarded!.note!, /not fixed/);
  const many = Array.from({ length: 80 }, (_, i) => ({ at: `2026-10-03T00:00:${String(10 + (i % 50)).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, origin: "library" as const, text: `step ${i}` }));
  const bounded = incidentView(incident({ steps: many, stepsGap: true }));
  assert.equal(bounded.steps.length, STEPS_SHOWN); assert.equal(bounded.gap, true);
});
