import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabIncidentSummary } from "../../field-station/src/lab/contract.ts";
import { EVALUATION, EVIDENCE, INTENT_LABELS, INTENT_NOTES, RECOVERY, REPROCESS, SOURCE, STEPS_SHOWN, incidentView } from "../src/scripts/lab-incident.ts";

/** A rendering fixture for the projection. It proves the labels, not that any backend produces it. */
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
  assert.equal(view.nextIntent, "scenario.prepare-coverage");
  assert.equal(view.nextLabel, "Make snapshot coverage ready (application action)");
  assert.equal(view.next, "Lontra Creek's application releases its authoritative-state update and coverage evidence. StreamOtter doesn't invent it.");
  for (const text of [...Object.values(INTENT_LABELS), ...Object.values(INTENT_NOTES)]) assert.doesNotMatch(text, /can't send/);
  assert.deepEqual(view.steps.map(step => `${step.origin}: ${step.text}`), [
    "Application action: Scenario record published", "Library observation: Quarantine write acknowledged", "Browser observation: LC-03 subscription stale (SOURCE_UNAVAILABLE)"
  ]);
  assert.deepEqual(view.detail[0], ["Source coordinates", "lab-1.field.gauges · partition 0 · offset 246"]);
  assert.deepEqual(view.detail[2], ["Handler identity", "Not reported"]);
  assert.equal(view.announcement, "Incident 1: Evidence saved; Source held at this record; Saved, but not safe to continue: snapshot coverage not ready.");
});

test("later states, discarded studies, and gaps are reported as observed", () => {
  const done = incidentView(incident({ source: "advanced", recovery: "view-resynchronized", evaluation: { result: "passed", at: "2026-10-03T00:01:00.000Z", expiresAt: null, planToken: null, summary: "The saved record now maps cleanly." }, reprocess: "superseded", nextIntent: null }));
  assert.equal(done.reprocess?.text, "Superseded by a newer snapshot");
  assert.equal(done.next, "None right now."); assert.equal(done.nextLabel, null);
  assert.equal(done.evaluation?.note, "The saved record now maps cleanly. This evaluation changed no source offset, sent no state, and published no business event. Nothing has been reprocessed.");
  assert.match(done.announcement, /Evaluation passed; Superseded by a newer snapshot\.$/);
  const discarded = incidentView(incident({ discarded: true }));
  assert.equal(discarded.discarded?.text, "Study discarded and reset"); assert.match(discarded.discarded!.note!, /not fixed/);
  const many = Array.from({ length: 80 }, (_, i) => ({ at: `2026-10-03T00:00:${String(10 + (i % 50)).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, origin: "library" as const, text: `step ${i}` }));
  const bounded = incidentView(incident({ steps: many, stepsGap: true }));
  assert.equal(bounded.steps.length, STEPS_SHOWN); assert.equal(bounded.gap, true);
});

test("a pause keeps no evidence and a retried record is processed; a hold with nothing to offer says only a reset ends it", () => {
  const retried = incidentView(incident({ policy: "pause", evidence: "not-required", source: "processed", recovery: "none", nextIntent: null }));
  assert.equal(retried.evidence.text, "No evidence kept"); assert.match(retried.evidence.note!, /nothing is skipped/);
  assert.equal(retried.source.text, "Record processed on retry"); assert.equal(retried.source.tone, "neutral");
  assert.equal(retried.announcement, "Incident 1: No evidence kept; Record processed on retry.");
  assert.equal(retried.next, "None right now.");
  // LC11-S05 and S07: no Lab intent continues past this hold.
  const held = incidentView(incident({ source: "held", nextIntent: null }));
  assert.equal(held.next, "None. The source stays held at this record; returning the bench discards this study, which doesn't fix the incident.");
  assert.equal(incidentView(incident({ discarded: true, nextIntent: null })).next, "None: this study was discarded.");
  assert.equal(incidentView(incident({ nextIntent: "incident.approve-reprocess" })).next, "Opens the evaluation for review. Nothing is reprocessed until you approve it there.");
});
