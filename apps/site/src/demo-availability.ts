/**
 * What `/releases/` keeps apart (LC11-A40): the site's own release, the exact library
 * package it installs, what the demo can run, and how far each of those has been checked.
 *
 * Nothing here is hand-typed where a real source exists: the library version is the site's
 * exact pin (`RELEASE`, which a test holds equal to the installed package and the
 * lockfile), the recording's version and date come from its `capture.json`, the count of
 * new source-failure stories comes from the Lab catalog, and whether the sandbox
 * has a published seam to mount comes from `scripts/workbench-seam.ts`. What the running
 * field station reports is read in the browser (`scripts/release-service.ts`), never assumed:
 * that includes which source-failure stories run, which depends on the deployment.
 */
import capture from "../public/recordings/workbench/capture.json" with { type: "json" };
import { NEW_SOURCE_EXERCISES } from "./lab-catalog.ts";
import { PUBLISHED_SEAM } from "./scripts/workbench-seam.ts";
import { RELEASE, SITE } from "./site.ts";

/** The recorded workbench tour's own provenance, so a later version pin can't relabel it. */
export const RECORDING = { version: capture.version, install: capture.install, capturedOn: capture.capturedAt.slice(0, 10) } as const;

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
    runs: `Fouled sensor, on the same benches, and ${NEW_SOURCE_EXERCISES.length} more stories, each only where this field station's backend reports it can run it. The Lab gives the reason for each one it can't; the report below counts how many it can.`,
    needs: `streamotter@${RELEASE} provides quarantine, the recovery guard, evaluation, and reprocessing. Each exercise also needs a bench whose backend reports it can run it; what this field station reports is below.`
  },
  {
    name: "Workbench", href: "/workbench/", state: "recorded",
    runs: `A recorded tour of the workbench: streamotter@${RECORDING.version} (${RECORDING.install}), captured ${RECORDING.capturedOn} on a local fixture project.`,
    needs: PUBLISHED_SEAM === null
      ? "An interactive sandbox needs this site to mount the workbench's published host contract, which it doesn't yet."
      : "A sandbox service on this backend; /workbench/ asks it whether one is available."
  },
  {
    name: "Playground", href: "/playground/", state: "runs",
    runs: `The real validator from streamotter@${RELEASE}, in your browser, with failure-policy presets and examples it refuses, plus a read-only connection to the field station.`,
    needs: "Nothing more for validation, which checks configuration only. Type generation in the browser needs a release that exports a browser-safe generator; use npx streamotter generate locally."
  }
];
