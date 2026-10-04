/**
 * What the `/lab/` page selects from its URL and how it describes each scenario's
 * availability, from the backend's capability summary (Lab contract section 12).
 *
 * A deep link (`#source-failures`, `?scenario=<id>`) selects explanation only: it never
 * borrows a bench, starts a scenario, or approves anything. A new source-failures
 * scenario is available only when the backend reports it, its intents, and its incident
 * projection available *and* this build of the page has an exercise for it. A missing
 * summary (404, as the fixture `npm run dev` answers), an unreachable one, or a summary
 * that doesn't list a scenario all leave it unavailable. There is no mock fallback.
 */
import type { LabCapabilities, LabScenarioId, LabTrack } from "../../../field-station/src/lab/contract.ts";
import { SCENARIOS, TRACKS, homeTrack } from "../lab-catalog.ts";

export type CapabilityAnswer =
  | { kind: "pending" }
  | { kind: "summary"; summary: LabCapabilities }
  /** 404: a backend that predates the summary, or the fixture demo. */
  | { kind: "absent" }
  /** No usable answer: a network failure, a timeout, or a 5xx. */
  | { kind: "unreachable" };

export interface Selection {
  track: LabTrack;
  scenario: LabScenarioId | null;
}

export interface Availability {
  /** `existing`: runs with the bench controls when the backend has benches; `pending`: not checked yet (and unavailable meanwhile). */
  state: "existing" | "pending" | "available" | "unavailable";
  text: string;
}

/** Shown beside the availability text, never instead of it. */
export const AVAILABILITY_ICONS: Record<Availability["state"], string> = { existing: "▶", pending: "⊘", available: "✓", unavailable: "⊘" };

/**
 * New scenarios this build of the page has an exercise for: each starts with `scenario.start`
 * and continues with the incident's next supported intent. Whether one runs here is still
 * the backend's answer; this only says the page can follow it.
 */
export const PAGE_RUNS: ReadonlySet<LabScenarioId> = new Set<LabScenarioId>(["garbled-reading", "bad-projection", "inspect-old-reading", "conflicting-readings", "calibration-blip", "too-many-bad-readings", "restart-recovery", "unavailable-evidence"]);

export const UNSUPPORTED = "This backend does not support this scenario.";

export function isScenario(value: string | null): value is LabScenarioId {
  return value !== null && Object.hasOwn(SCENARIOS, value);
}

/** Turns a capability answer's body into an answer; anything without the summary's shape is no usable answer. */
export function capabilityAnswer(body: unknown): CapabilityAnswer {
  const summary = body as Partial<LabCapabilities> | null;
  const usable = typeof summary === "object" && summary !== null && Array.isArray(summary.scenarios) && typeof summary.library?.version === "string"
    && typeof summary.backend?.lab === "string" && typeof summary.features?.incidentProjection?.available === "boolean" && typeof summary.features.intents?.available === "boolean"
    && summary.scenarios.every(scenario => typeof scenario === "object" && scenario !== null && typeof scenario.id === "string" && typeof scenario.available === "boolean");
  return usable ? { kind: "summary", summary: summary as LabCapabilities } : { kind: "unreachable" };
}

/** The track and scenario a URL selects. An unknown scenario is ignored; a scenario outside the named track opens its own. */
export function selectionFromUrl(url: { search: string; hash: string }): Selection {
  const id = new URLSearchParams(url.search).get("scenario");
  const scenario = isScenario(id) ? id : null;
  const hash = url.hash.replace(/^#/, "");
  const named = hash === "connections" || hash === "source-failures" ? hash : null;
  if (scenario === null) return { track: named ?? "connections", scenario };
  return { track: named !== null && TRACKS[named].includes(scenario) ? named : homeTrack(scenario), scenario };
}

/** The URL for a selection, keeping the page's path and any unrelated query. */
export function urlFor(current: URL, selection: Selection): string {
  const url = new URL(current.href);
  if (selection.scenario === null) url.searchParams.delete("scenario"); else url.searchParams.set("scenario", selection.scenario);
  url.hash = selection.track;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function scenarioAvailability(id: LabScenarioId, answer: CapabilityAnswer, pageRuns: ReadonlySet<LabScenarioId> = PAGE_RUNS): Availability {
  const entry = SCENARIOS[id];
  if (entry.controls !== null) {
    const controls = id === "fouled-sensor" ? "the Fouled sensor controls below" : "the controls below";
    const reported = answer.kind === "summary" ? answer.summary.scenarios.find(scenario => scenario.id === id) : undefined;
    // A backend with no benches says so (`lab-disabled`); without its answer, say what the scenario needs rather than that it runs.
    if (reported?.available === false) return { state: "unavailable", text: reported.reason?.text ?? UNSUPPORTED };
    if (reported?.available === true) return { state: "existing", text: `Runs today on a leased bench with ${controls}.` };
    return { state: "existing", text: `Runs on a leased bench with ${controls}, when this backend has benches.` };
  }
  // Also the static text: true with or without JavaScript, before the backend answers.
  if (answer.kind === "pending") return { state: "pending", text: "Unavailable until this backend reports support for it." };
  if (answer.kind === "unreachable") return { state: "unavailable", text: "This backend didn't answer its capability check, so this exercise is unavailable." };
  if (answer.kind === "absent") return { state: "unavailable", text: UNSUPPORTED };
  const reported = answer.summary.scenarios.find(scenario => scenario.id === id);
  if (reported === undefined) return { state: "unavailable", text: UNSUPPORTED };
  if (!reported.available) return { state: "unavailable", text: reported.reason?.text ?? UNSUPPORTED };
  if (!pageRuns.has(id)) return { state: "unavailable", text: "This backend reports this exercise, but this version of the site can't run it yet." };
  // The exercise needs both: intents to start and continue it, and the incident projection to follow it.
  const missing = [answer.summary.features.intents, answer.summary.features.incidentProjection].find(feature => !feature.available);
  if (missing) return { state: "unavailable", text: missing.reason?.text ?? UNSUPPORTED };
  return { state: "available", text: "Available on a leased bench." };
}

/** What the visitor's own bench allows for an available exercise. */
export interface BenchContext {
  /** A ready or active lease. */
  leased: boolean;
  /** An intent of this page is still waiting for the bench. */
  busy: boolean;
}

export interface StartState {
  /** False keeps the button focusable with `aria-disabled="true"`; a press sends nothing. */
  enabled: boolean;
  /** Replaces the availability text while the exercise is available. */
  text: string;
}

/** Whether Start can send `scenario.start` now, and the line that says why or why not. */
export function startState(availability: Availability, bench: BenchContext): StartState {
  if (availability.state !== "available") return { enabled: false, text: availability.text };
  if (!bench.leased) return { enabled: false, text: "Available on a leased bench. Borrow a bench below, then start it here." };
  if (bench.busy) return { enabled: false, text: "Available on your bench once its current request finishes; follow it in Current incident below." };
  return { enabled: true, text: "Available on your bench." };
}

/** One line about the backend, for the Source failures track. `builtWith` is the StreamOtter version this page was built against. */
export function capabilityNote(answer: CapabilityAnswer, builtWith: string): string {
  switch (answer.kind) {
    case "pending": return "Checking which exercises this backend can run…";
    case "absent": return "This backend doesn't report Lab capabilities (the fixture demo from npm run dev doesn't, nor does a backend older than this page), so every new exercise is unavailable.";
    case "unreachable": return "This backend's capability check didn't answer, so every new exercise is unavailable. The rest of the page still works.";
    case "summary": {
      const { summary } = answer;
      const fresh = TRACKS["source-failures"].filter(id => SCENARIOS[id].controls === null);
      const runnable = fresh.filter(id => scenarioAvailability(id, answer).state === "available").length;
      const lab = summary.backend.lab === "enabled" ? "Lab benches enabled" : "no Lab benches";
      const skew = summary.library.version === builtWith ? "" : ` This page was built for StreamOtter ${builtWith}.`;
      return `This backend runs StreamOtter ${summary.library.version} on real Kafka with synthetic data (${lab}). ${runnable} of ${fresh.length} new exercises can run here.${skew}`;
    }
  }
}
