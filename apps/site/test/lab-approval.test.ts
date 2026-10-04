import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabIncidentSummary } from "../../field-station/src/lab/contract.ts";
import { reviewFrom, reviewProblem, reviewText } from "../src/scripts/lab-approval.ts";

/** A rendering fixture for the projection: it proves the review's rules, not that any backend produces this. */
const evaluated = (rest: Partial<LabIncidentSummary> = {}): LabIncidentSummary => ({
  label: "Incident 1", scenario: "inspect-old-reading", scenarioRevision: 7, reason: "LC-03's old reading can be evaluated against the corrected mapper.",
  openedAt: "2026-10-04T00:00:10.000Z", updatedAt: "2026-10-04T00:01:00.000Z", failure: { stage: "public payload validation", class: "payload-schema" }, policy: "quarantine-resync",
  evidence: "saved", source: "advanced", recovery: "view-resynchronized",
  evaluation: { result: "passed", at: "2026-10-04T00:01:00.000Z", expiresAt: "2026-10-04T00:05:00.000Z", planToken: "pt_fixture_0123456789", summary: "The saved record maps and validates with the corrected mapper." },
  reprocess: null, discarded: false, nextIntent: "incident.approve-reprocess",
  detail: { topic: "lab-1.field.gauges", partition: 0, offset: "246", evidenceFingerprint: null, handlerIdentity: null, sourceGeneration: null }, steps: [], stepsGap: false, ...rest
});

test("a review binds the plan and revision it was opened with, and refuses once either moves or it expires", () => {
  const review = reviewFrom(evaluated())!;
  assert.deepEqual(review, { label: "Incident 1", revision: 7, planToken: "pt_fixture_0123456789", evaluatedAt: "2026-10-04T00:01:00.000Z", expiresAt: "2026-10-04T00:05:00.000Z", summary: "The saved record maps and validates with the corrected mapper." });
  assert.deepEqual(reviewText(review), {
    incident: "Incident 1, revision 7.",
    evaluation: "Evaluation passed at 00:01:00 UTC. The saved record maps and validates with the corrected mapper.",
    expiry: "This approval is good until 00:05:00 UTC, and no longer than your lease or this study."
  });
  const before = Date.parse("2026-10-04T00:04:59.000Z");
  assert.equal(reviewProblem(review, evaluated(), before), null);
  assert.match(reviewProblem(review, evaluated(), Date.parse("2026-10-04T00:05:00.000Z"))!, /^This approval expired at 00:05:00 UTC\. Cancel, then evaluate again/);
  assert.match(reviewProblem(review, evaluated({ scenarioRevision: 8 }), before)!, /changed while this review was open/);
  assert.match(reviewProblem(review, evaluated({ evaluation: { ...evaluated().evaluation!, planToken: null } }), before)!, /changed while this review was open/);
  assert.match(reviewProblem(review, null, before)!, /no longer on your bench/);
  assert.match(reviewProblem(review, evaluated({ discarded: true }), before)!, /discarded/);
  // Nothing to review without a passed evaluation that still has its plan.
  assert.equal(reviewFrom(evaluated({ evaluation: { ...evaluated().evaluation!, planToken: null } })), null);
  assert.equal(reviewFrom(evaluated({ evaluation: { ...evaluated().evaluation!, result: "failed" } })), null);
  assert.equal(reviewFrom(evaluated({ nextIntent: "incident.evaluate" })), null);
  assert.equal(reviewText({ ...review, expiresAt: null }).expiry, "This approval lasts no longer than your lease or this study.");
});
