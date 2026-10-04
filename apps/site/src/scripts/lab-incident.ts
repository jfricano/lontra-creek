/**
 * The incident panel's view of a `LabIncidentSummary` (Lab contract section 12), with the
 * companion plan's precise labels (section 6, "Say / Do not imply").
 *
 * The page renders this only from a projection the backend actually served; on a backend
 * that doesn't serve one the panel stays in its empty, explained state. Nothing here
 * invents an incident, a disposition, a step, or an outcome.
 *
 * Every mark carries text and an icon, so no state depends on color. A note beside a
 * mark says what it does not mean.
 */
import type { LabIncidentSummary, LabIntent } from "../../../field-station/src/lab/contract.ts";

export interface Mark {
  icon: string;
  text: string;
  /** `held` and `failed` borrow the stale and failed status colors; everything else is neutral. */
  tone: "neutral" | "held" | "failed";
  /** What the mark does not imply. */
  note?: string;
}

export const EVIDENCE: Record<LabIncidentSummary["evidence"], Mark> = {
  saved: { icon: "✓", text: "Evidence saved", tone: "neutral", note: "The record isn't repaired, and the view isn't recovered by this." },
  unknown: { icon: "?", text: "Evidence status unknown", tone: "held", note: "No acknowledged quarantine write has been observed." },
  unavailable: { icon: "✕", text: "Evidence unavailable", tone: "failed", note: "Stored reprocessing will be refused." },
  "not-required": { icon: "–", text: "No evidence kept", tone: "neutral", note: "This policy holds the record in place to be retried; nothing is skipped." }
};

export const SOURCE: Record<LabIncidentSummary["source"], Mark> = {
  held: { icon: "⏸", text: "Source held at this record", tone: "held", note: "Nothing after it is processed or committed." },
  advanced: { icon: "→", text: "Source advanced past quarantined record", tone: "neutral", note: "The browser did not receive the excluded record." },
  processed: { icon: "✓", text: "Record processed on retry", tone: "neutral", note: "Nothing was skipped." },
  uncertain: { icon: "?", text: "Source position uncertain", tone: "held" }
};

export const RECOVERY: Record<LabIncidentSummary["recovery"], Mark> = {
  none: { icon: "–", text: "No recovery requirement", tone: "neutral" },
  "coverage-not-ready": { icon: "⏸", text: "Saved, but not safe to continue: snapshot coverage not ready", tone: "held", note: "Skipping the record could hide a real state change." },
  "coverage-established": { icon: "✓", text: "Snapshot coverage established", tone: "neutral", note: "The application's snapshot covers the excluded update; StreamOtter didn't prove the business data correct." },
  "view-resynchronized": { icon: "✓", text: "View resynchronized", tone: "neutral", note: "From a fresh snapshot; intermediate events were not replayed." }
};

const NO_EFFECT = "This evaluation changed no source offset, sent no state, and published no business event.";
export const EVALUATION: Record<NonNullable<LabIncidentSummary["evaluation"]>["result"], Mark> = {
  passed: { icon: "✓", text: "Evaluation passed", tone: "neutral", note: `${NO_EFFECT} Nothing has been reprocessed.` },
  failed: { icon: "✕", text: "Evaluation failed", tone: "failed", note: NO_EFFECT }
};

export const REPROCESS: Record<NonNullable<LabIncidentSummary["reprocess"]>, Mark> = {
  reprocessed: { icon: "✓", text: "Reprocessed", tone: "neutral", note: "Gateway-local reprocessing ran. That isn't proof a business action completed or that every browser rendered it." },
  superseded: { icon: "✓", text: "Superseded by a newer snapshot", tone: "neutral", note: "A safe outcome: the old state was already obsolete." },
  failed: { icon: "✕", text: "Reprocessing failed", tone: "failed" },
  unknown: { icon: "?", text: "Reprocessing outcome unknown", tone: "held", note: "The result is looked up again; the request is never repeated automatically." }
};

export const DISCARDED: Mark = { icon: "↺", text: "Study discarded and reset", tone: "neutral", note: "The held incident was not fixed." };

export const INTENT_LABELS: Record<LabIntent, string> = {
  "scenario.start": "Start this scenario",
  "scenario.restore-calibration": "Restore calibration (application action)",
  "scenario.prepare-coverage": "Make snapshot coverage ready (application action)",
  "incident.retry-current": "Retry the held record",
  "incident.reassess": "Reassess continuation",
  "incident.evaluate": "Evaluate the saved record",
  "incident.approve-reprocess": "Review and approve reprocessing"
};

/** What the next intent does, beside its button: who acts, and what it doesn't do. */
export const INTENT_NOTES: Record<LabIntent, string> = {
  "scenario.start": "Starts a scenario on your bench's study.",
  "scenario.restore-calibration": "Lontra Creek's application puts LC-03's calibration back. StreamOtter doesn't repair it, and the source stays held until a retry.",
  "scenario.prepare-coverage": "Lontra Creek's application releases its authoritative-state update and coverage evidence. StreamOtter doesn't invent it.",
  "incident.retry-current": "Asks the gateway to try the exact held record again. It may hold again.",
  "incident.reassess": "Asks the recovery guard again whether continuing past the saved record is safe.",
  "incident.evaluate": "A dry run of the saved record through today's mapper. It changes no source offset and sends no state.",
  "incident.approve-reprocess": "Opens the evaluation for review. Nothing is reprocessed until you approve it there."
};

export type StepOrigin = "Application action" | "Library observation" | "Browser observation";
const ORIGINS: Record<LabIncidentSummary["steps"][number]["origin"], StepOrigin> = { application: "Application action", library: "Library observation" };

/** Something the page's own SDK reported, such as a subscription state change. */
export interface BrowserStep { at: string; text: string }
export interface IncidentStep { at: string; origin: StepOrigin; text: string }

/** How many steps the panel shows; the projection is bounded too. */
export const STEPS_SHOWN = 50;

export interface IncidentView {
  label: string;
  reason: string;
  failure: string;
  policy: string;
  evidence: Mark;
  source: Mark;
  recovery: Mark;
  evaluation: Mark | null;
  reprocess: Mark | null;
  discarded: Mark | null;
  /** The intent the backend would accept next, its button label, and the line beside it (or why there is none). */
  nextIntent: LabIntent | null;
  nextLabel: string | null;
  next: string;
  /** Behind disclosure. */
  detail: [string, string][];
  steps: IncidentStep[];
  gap: boolean;
  /** A short sentence for the page's polite live region, when it changes. */
  announcement: string;
}

export function incidentView(incident: LabIncidentSummary, browser: readonly BrowserStep[] = []): IncidentView {
  // The backend's sentence about what this evaluation found comes first; the mark's fixed note still says what it didn't do.
  const evaluation = incident.evaluation ? { ...EVALUATION[incident.evaluation.result], note: `${incident.evaluation.summary} ${EVALUATION[incident.evaluation.result].note}` } : null;
  const reprocess = incident.reprocess ? REPROCESS[incident.reprocess] : null;
  const steps: IncidentStep[] = [
    ...incident.steps.map(step => ({ at: step.at, origin: ORIGINS[step.origin], text: step.text })),
    ...browser.filter(step => step.at >= incident.openedAt).map(step => ({ at: step.at, origin: "Browser observation" as const, text: step.text }))
  ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0).slice(-STEPS_SHOWN);
  const { detail } = incident;
  const state = [EVIDENCE[incident.evidence], SOURCE[incident.source], ...(incident.recovery === "none" ? [] : [RECOVERY[incident.recovery]]), ...(evaluation ? [evaluation] : []), ...(reprocess ? [reprocess] : []), ...(incident.discarded ? [DISCARDED] : [])];
  return {
    label: incident.label,
    reason: incident.reason,
    failure: `${incident.failure.class} at ${incident.failure.stage}`,
    policy: incident.policy,
    evidence: EVIDENCE[incident.evidence],
    source: SOURCE[incident.source],
    recovery: RECOVERY[incident.recovery],
    evaluation, reprocess,
    discarded: incident.discarded ? DISCARDED : null,
    nextIntent: incident.nextIntent,
    nextLabel: incident.nextIntent === null ? null : INTENT_LABELS[incident.nextIntent],
    next: incident.nextIntent !== null ? INTENT_NOTES[incident.nextIntent]
      : incident.discarded ? "None: this study was discarded."
      // No Lab intent continues past this hold (an integrity class, or an open continuation limit): only a reset ends it.
      : incident.source === "held" ? "None. The source stays held at this record; returning the bench discards this study, which doesn't fix the incident."
      : "None right now.",
    detail: [
      ["Source coordinates", `${detail.topic} · partition ${detail.partition} · offset ${detail.offset}`],
      ["Evidence fingerprint", detail.evidenceFingerprint ?? "Not reported"],
      ["Handler identity", detail.handlerIdentity ?? "Not reported"],
      ["Source generation", detail.sourceGeneration ?? "Not reported"],
      ["Incident revision", String(incident.scenarioRevision)]
    ],
    steps,
    gap: incident.stepsGap,
    announcement: `${incident.label}: ${state.map(mark => mark.text).join("; ")}.`
  };
}
