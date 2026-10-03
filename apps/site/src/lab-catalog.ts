/**
 * The Failure Lab's two tracks and their scenario indexes, for `/lab/` (companion plan
 * sections 3 and 4). Each scenario has one implementation: Fouled sensor appears in both
 * indexes but has one set of controls, the existing bench actions.
 *
 * `Record<LabScenarioId, …>` keeps this list and the field station's capability summary
 * (`apps/field-station/src/lab/capabilities.ts`) on the same IDs: adding a scenario to the
 * contract fails the typecheck until it is described here.
 */
import type { LabScenarioId, LabTrack } from "../../field-station/src/lab/contract.ts";

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
}

export const DELIVERY_LABELS: Record<LabDelivery, string> = {
  public: "Public exercise",
  advanced: "Public · advanced",
  "local-ci": "Local and CI only"
};

export const TRACK_LABELS: Record<LabTrack, string> = {
  connections: "Connections and clients",
  "source-failures": "Source failures"
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
    establishes: "Only a trusted, explicitly transient mapper error gets a bounded retry. Success and exhausted retries are different outcomes."
  },
  "too-many-bad-readings": {
    id: "too-many-bad-readings", story: "LC11-S07", title: "Too many bad readings", delivery: "local-ci", controls: null,
    establishes: "Five distinct automatic continuations are permitted in the configured window; the next incident holds. Duplicate evidence doesn't count as another incident."
  },
  "restart-recovery": {
    id: "restart-recovery", story: "LC11-S08", title: "Recovery across restart and a new subscription", delivery: "local-ci", controls: null,
    establishes: "The same journal, consumer group, and source generation keep recovery obligations across a restart; a new view can't evade the barrier."
  },
  "unavailable-evidence": {
    id: "unavailable-evidence", story: "LC11-S09", title: "Unavailable evidence or quarantine", delivery: "local-ci", controls: null,
    establishes: "No advancement on an unacknowledged quarantine write; missing or expired evidence refuses stored reprocessing."
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
    id: "relay-restart", story: null, title: "Relay restart", delivery: null, controls: "control-relay-restart",
    establishes: "Restart your gateway. The SDK reconnects and takes a fresh snapshot; intermediate states are not replayed."
  }
};

/** Each track's index, in reading order. Fouled sensor is the bridge, listed in both. */
export const TRACKS: Record<LabTrack, LabScenarioId[]> = {
  connections: ["relay-cut", "slow-client", "relay-restart", "fouled-sensor"],
  "source-failures": ["fouled-sensor", "garbled-reading", "bad-projection", "inspect-old-reading", "conflicting-readings", "calibration-blip", "too-many-bad-readings", "restart-recovery", "unavailable-evidence"]
};

/** The track a scenario link opens when the URL names no track: Fouled sensor opens Source failures, where it is LC11-S01. */
export function homeTrack(id: LabScenarioId): LabTrack {
  return TRACKS["source-failures"].includes(id) ? "source-failures" : "connections";
}
