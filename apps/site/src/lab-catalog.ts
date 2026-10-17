/**
 * The Failure Lab's scenarios, for `/lab/` (companion plan sections 3 and 4). The ones with
 * `controls` run with the bench's own actions and are described there, beside their buttons;
 * the rest are the source-failure exercises the page lists as cards, each with a Start button.
 *
 * `Record<LabScenarioId, …>` keeps this list and the field station's capability summary
 * (`apps/field-station/src/lab/capabilities.ts`) on the same IDs: adding a scenario to the
 * contract fails the typecheck until it is described here.
 */
import type { LabScenarioId } from "../../field-station/src/lab/contract.ts";

/** Where a story is delivered: on the public site, as a public advanced exercise, or in local and CI stacks only. */
export type LabDelivery = "public" | "advanced" | "local-ci";

export interface LabScenarioEntry {
  id: LabScenarioId;
  /** The acceptance plan's story ID, for source failures. */
  story: `LC11-S0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | null;
  title: string;
  /** What the story establishes, in one or two sentences. */
  establishes: string;
  /** Null for the existing connection scenarios, which predate the V1.1 catalog. */
  delivery: LabDelivery | null;
  /** True when today's bench runs it with the existing controls, whose anchor this is. */
  controls: `control-${string}` | null;
  /** A short qualifier shown beside the delivery label. */
  note?: string;
  /** What starting it on this page shows, where that differs from what the story establishes; shown after "On this page:". */
  onPage?: string;
}

export const DELIVERY_LABELS: Record<LabDelivery, string> = {
  public: "Public exercise",
  advanced: "Public · advanced",
  "local-ci": "Local and CI only"
};

export const SCENARIOS: Record<LabScenarioId, LabScenarioEntry> = {
  "fouled-sensor": {
    id: "fouled-sensor", story: "LC11-S01", title: "Fouled sensor: fix and retry", delivery: "public", controls: "control-fouled-sensor", note: "existing scenario",
    establishes: "The default pause still works: restore calibration, retry the exact held record, then watch a fresh synchronization. It is an ordinary mapper exception, not quarantine."
  },
  "garbled-reading": {
    id: "garbled-reading", story: "LC11-S02", title: "Garbled reading: preserve and hold", delivery: "public", controls: null,
    establishes: "Real invalid JSON is captured in quarantine and the source does not advance. Saving malformed bytes doesn't make them repairable."
  },
  "bad-projection": {
    id: "bad-projection", story: "LC11-S03", title: "Bad projection: recover from authoritative state", delivery: "public", controls: null, note: "headline path",
    establishes: "Valid source JSON produces an invalid public payload. Quarantine succeeds, a guard first refuses to continue, and verified snapshot coverage later permits it."
  },
  "inspect-old-reading": {
    id: "inspect-old-reading", story: "LC11-S04", title: "Inspect the old reading: evaluate, then reprocess", delivery: "public", controls: null,
    establishes: "A dry-run evaluation has no delivery effect; an exact approval permits gateway-local reprocessing; a newer snapshot can correctly supersede the old state."
  },
  "conflicting-readings": {
    id: "conflicting-readings", story: "LC11-S05", title: "Conflicting readings: stopping is correct", delivery: "advanced", controls: null,
    establishes: "An equal revision with conflicting state stays held. There is no force-skip."
  },
  "calibration-blip": {
    id: "calibration-blip", story: "LC11-S06", title: "Calibration lookup blip", delivery: "advanced", controls: null,
    establishes: "Only a trusted, explicitly transient mapper error gets a bounded retry. Success and exhausted retries are different outcomes.",
    onPage: "start it once for a blip that one retry absorbs: nothing is held. Start it again in the same lease for lookups that keep timing out past the retries, and the record is held. The calibration table is still present; Restore calibration ends the timeouts, and a retry then processes the record."
  },
  "too-many-bad-readings": {
    id: "too-many-bad-readings", story: "LC11-S07", title: "Too many bad readings", delivery: "local-ci", controls: null,
    establishes: "Five distinct automatic continuations are permitted in the configured window; the next incident holds. Duplicate evidence doesn't count as another incident."
  },
  "restart-recovery": {
    id: "restart-recovery", story: "LC11-S08", title: "Recovery across restart and a new subscription", delivery: "local-ci", controls: null,
    establishes: "The same journal, consumer group, and source generation keep recovery obligations across a restart; a new view can't evade the barrier.",
    onPage: "it plays like Bad projection, with two records: quarantine, advance, resynchronize. The restart itself isn't shown here: the repository's local test suite restarts the bench's gateway and its container and checks that the barrier holds (deploy/test/lab-source-failures.test.ts)."
  },
  "unavailable-evidence": {
    id: "unavailable-evidence", story: "LC11-S09", title: "Unavailable evidence or quarantine", delivery: "local-ci", controls: null,
    establishes: "No advancement on an unacknowledged quarantine write; missing or expired evidence refuses stored reprocessing.",
    onPage: "it plays like Bad projection: the copy is saved, and nothing here deletes it or fails the write. The repository's local test suite deletes the quarantine copy and checks that stored reprocessing is refused (deploy/test/lab-source-failures.test.ts)."
  },
  "relay-cut": {
    id: "relay-cut", story: null, title: "Flash flood takes the relay", delivery: null, controls: "control-relay-cut",
    establishes: "Cut only this bench's Kafka path. Views go stale while your connection stays up, then recover after restoration."
  },
  "slow-client": {
    id: "slow-client", story: null, title: "Laptop on a satellite link", delivery: null, controls: "control-slow-client",
    establishes: "A separate client stops acknowledging frames. Its receipt timeout disconnects it; your own view keeps flowing."
  },
  "relay-restart": {
    id: "relay-restart", story: null, title: "Gateway restart", delivery: null, controls: "control-relay-restart",
    establishes: "Restart your gateway. The SDK reconnects and takes a fresh snapshot; intermediate states are not replayed."
  }
};

/** The source-failure stories LC11-S01 to S09, in reading order. Fouled sensor (S01) runs with the bench controls. */
export const SOURCE_FAILURES: readonly LabScenarioId[] = ["fouled-sensor", "garbled-reading", "bad-projection", "inspect-old-reading", "conflicting-readings", "calibration-blip", "too-many-bad-readings", "restart-recovery", "unavailable-evidence"];

/**
 * The source-failure stories beyond Fouled sensor: the new scenarios the field station's
 * capability summary reports on, and the page's cards. Whether each one runs is that summary's answer, never this list's.
 */
export const NEW_SOURCE_EXERCISES: readonly LabScenarioId[] = SOURCE_FAILURES.filter(id => SCENARIOS[id].controls === null);
