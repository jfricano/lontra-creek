/**
 * What `/releases/` keeps apart (LC11-A40): the site's own release, the exact library
 * package it installs, what the demo can run, and how far each of those has been checked.
 *
 * Nothing here is hand-typed where a real source exists: the library version is the site's
 * exact pin (`RELEASE`, which a test holds equal to the installed package and the
 * lockfile), the recording's version and date come from its `capture.json`, the count of
 * unavailable source-failure exercises comes from the Lab catalog, and the playground's
 * `failureHandling` answer comes from the installed validator. What the running field
 * station reports is read in the browser (`scripts/release-service.ts`), never assumed.
 */
import capture from "../public/recordings/workbench/capture.json" with { type: "json" };
import { SCENARIOS, TRACKS } from "./lab-catalog.ts";
import { INSTALLED_VALIDATOR_ON_FAILURE_HANDLING } from "./planned-failure-handling.ts";
import { RELEASE, SITE } from "./site.ts";

/** The recorded workbench tour's own provenance, so a later version pin can't relabel it. */
export const RECORDING = { version: capture.version, capturedOn: capture.capturedAt.slice(0, 10) } as const;

/** Source-failure stories the Lab lists but the current bench can't run (every one except Fouled sensor). */
export const WAITING_EXERCISES = TRACKS["source-failures"].filter(id => SCENARIOS[id].controls === null);

/** The playground's answer to a V1.1 configuration, from the installed validator. */
const failureHandlingIssue = INSTALLED_VALIDATOR_ON_FAILURE_HANDLING.issues[0]?.code ?? "no issue";

export const SITE_RELEASE = {
  name: "streamotter.dev: StreamOtter's home site and the fictional Lontra Creek demo",
  launch: SITE.launched ? "Launched." : "Pre-launch. This build is a candidate; no public release of the site or its hosted demo has been accepted.",
  milestone: `${SITE.milestone.name}, ${SITE.milestone.state}.`,
  versioning: `The site's milestones are its own. Site ${SITE.milestone.name} is a different milestone from StreamOtter V1.1, and neither one is npm version 1.1.0. Each ships on its own schedule.`
} as const;

export type SurfaceState = "runs" | "partial" | "recorded" | "unavailable";

export const SURFACE_LABELS: Record<SurfaceState, string> = {
  runs: "Runs",
  partial: "Partly",
  recorded: "Recorded",
  unavailable: "Not yet"
};

export interface Surface {
  name: string;
  href: string;
  state: SurfaceState;
  /** What a visitor can do there with this build. */
  runs: string;
  /** What it needs, or what it waits for. */
  needs: string;
}

export const SURFACES: readonly Surface[] = [
  {
    name: "Live creek and walkthrough", href: "/field-station/", state: "runs",
    runs: `Real subscriptions from your browser through the gateway, with streamotter@${RELEASE}.`,
    needs: "The field station. npm run dev replays fixture data without Kafka; the production stack runs real Kafka."
  },
  {
    name: "Failure Lab: Connections and clients", href: "/lab/#connections", state: "runs",
    runs: "Cut the relay, stall a laptop, restart the gateway, or foul a sensor on a leased, isolated bench.",
    needs: "The Lab stack: real Kafka and three benches (see the repository's local Lab instructions). npm run dev has no benches."
  },
  {
    name: "Failure Lab: Source failures", href: "/lab/#source-failures", state: "partial",
    runs: `Fouled sensor, on the same benches. The other ${WAITING_EXERCISES.length} stories are listed with the reason each one can't run.`,
    needs: `Quarantine, a recovery guard, evaluation, and reprocessing from a published StreamOtter release. streamotter@${RELEASE} has none of them.`
  },
  {
    name: "Workbench", href: "/workbench/", state: "recorded",
    runs: `A recorded tour of the published workbench: streamotter@${RECORDING.version}, captured ${RECORDING.capturedOn} on a local fixture project.`,
    needs: `An interactive sandbox needs a published workbench integration seam. streamotter@${RELEASE} doesn't have one.`
  },
  {
    name: "Playground", href: "/playground/", state: "runs",
    runs: `The real validator from streamotter@${RELEASE}, in your browser, plus a read-only connection to the field station.`,
    needs: `Failure-policy presets wait for a validator that accepts a failureHandling section. This one rejects it (${failureHandlingIssue}).`
  }
];
