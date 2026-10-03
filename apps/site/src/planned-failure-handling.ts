/**
 * StreamOtter V1.1's planned source-failure handling, for `/when-it-breaks/`, `/releases/`,
 * `/docs/`, and the home page's V1.1 panel.
 *
 * Everything here is PLANNED behavior from StreamOtter's approved V1.1 specification
 * (revision 1.0) and its decision records ADR-15A/B/C, read at one pinned commit. None of
 * it is in the release this site installs: `INSTALLED_VALIDATOR_ON_FAILURE_HANDLING` asks
 * the installed package's own validator, and it rejects the `failureHandling` key. Pages
 * label this material as planned and never present it as something the demo runs.
 *
 * The wording follows the specification's terms (policies `pause`, `quarantine-hold`, and
 * `quarantine-resync`; ADR-15B's failure classes; ADR-15A's `held`, `quarantine-unknown`,
 * `advance-pending`, and `advance-confirmed`; ADR-15C's redrive outcomes). When a published
 * release ships these features, its own documentation replaces this file as the source.
 */
import { validateProjectConfig } from "streamotter/contracts";
import fieldConfig from "../../field-station/streamotter.json" with { type: "json" };

/** The StreamOtter commit whose `docs/releases/v1.1/` this file describes: the reviewed planning revision the companion plan pins. */
export const V11_SPEC_COMMIT = "3c0443efcab3053111e997e4aeb7c12ede02edaf";
const ROOT = `https://github.com/jfricano/StreamOtter/blob/${V11_SPEC_COMMIT}/docs/releases/v1.1`;
const SPEC = `${ROOT}/V1_1_SOURCE_FAILURE_SPEC.md`;

export const V11_SOURCES = {
  folder: `https://github.com/jfricano/StreamOtter/tree/${V11_SPEC_COMMIT}/docs/releases/v1.1`,
  spec: SPEC,
  policy: `${SPEC}#4-failure-taxonomy-and-policy`,
  algorithm: `${SPEC}#6-quarantine-and-source-progress-algorithm`,
  recovery: `${SPEC}#7-making-continuation-honest`,
  reprocessing: `${SPEC}#8-controlled-reprocessing-not-a-retry-platform`,
  operations: `${SPEC}#local-operator-api-exposed-through-the-cli`,
  journal: `${ROOT}/adr/ADR-15A-failure-journal-and-handoff.md`,
  barrier: `${ROOT}/adr/ADR-15B-recovery-barrier.md`,
  redrive: `${ROOT}/adr/ADR-15C-operator-authority-and-redrive.md`
} as const;

/**
 * What the installed validator says about a `failureHandling` key on this demo's own
 * project configuration. Computed at build time from the real package, so a release that
 * accepts the key changes this value and fails the test that pins it.
 */
export const INSTALLED_VALIDATOR_ON_FAILURE_HANDLING = validateProjectConfig({ ...fieldConfig, failureHandling: {} });

// --- Policies -------------------------------------------------------------------------

export type PlannedPolicy = "pause" | "quarantine-hold" | "quarantine-resync";

export const POLICIES: Readonly<Record<PlannedPolicy, string>> = {
  pause: "Today's behavior, kept as the default: the source stops at the record without committing or skipping it.",
  "quarantine-hold": "Save the original record as evidence in a quarantine topic and keep the source held at it.",
  "quarantine-resync": "Save the evidence, then let the source move past the record only after your application's recovery guard shows its snapshots cover what the record would have changed."
};

/** Options the specification deliberately leaves out. */
export const NOT_OFFERED = ["ignore", "discard", "force-skip"] as const;

export interface PolicyRow {
  failure: string;
  /** ADR-15B's internal failure classes; empty for failures that are not a bad record. */
  classes: readonly string[];
  /** What happens with no policy configured. */
  byDefault: string;
  /** The most a policy may opt into. */
  optIn: string;
}

/** Specification section 4's table, with ADR-15B section 1's classes beside each row. */
export const POLICY_MATRIX: readonly PolicyRow[] = [
  { failure: "Invalid JSON in an otherwise bounded record", classes: ["invalid-json"], byDefault: "Pause", optIn: "quarantine-hold, or guarded quarantine-resync." },
  { failure: "Mapped public data violates its payload schema", classes: ["payload-schema"], byDefault: "Pause", optIn: "quarantine-hold, or guarded quarantine-resync." },
  { failure: "The mapper signals a transient dependency failure", classes: ["mapper-transient"], byDefault: "Pause", optIn: "A bounded retry of the same record (two more attempts); exhausted retries hold. Evidence may be captured." },
  { failure: "Any other mapper exception or timeout", classes: ["mapper-error", "mapper-timeout"], byDefault: "Pause", optIn: "Evidence may be captured. No automatic skipping." },
  { failure: "Invalid tenant, parameters, or revision; too many outputs; conflicting data at an equal revision", classes: ["routing-invalid", "revision-conflict"], byDefault: "Pause", optIn: "Evidence and repair only. No continuation override." },
  { failure: "Unsupported tombstone, oversized record, or unknown format", classes: ["tombstone", "oversize"], byDefault: "Pause", optIn: "Bounded evidence where possible. No automatic skipping." },
  { failure: "Broker, network, or authentication failure; lost assignment; shutdown; journal, disk, or quarantine unavailable", classes: [], byDefault: "Today's outage and hold behavior", optIn: "Bounded infrastructure recovery only. An outage is never treated as a bad record to discard." },
  { failure: "Authorization failure or a slow browser", classes: [], byDefault: "Today's access and flow-control behavior", optIn: "Not a source failure; existing isolation and overload handling apply." }
];

/** The automatic-continuation limit the specification proposes, per source. */
export const CIRCUIT = { incidents: 5, windowSeconds: 60 } as const;

// --- Record disposition -----------------------------------------------------------------

export interface DispositionStage {
  name: string;
  /** What happens at this stage. */
  what: string;
  /** The specification's own terms for this stage: recorded states, guard answers, or identifiers. */
  terms: readonly string[];
  /** What reaching this stage does not establish. */
  notProof: string;
  source: string;
}

/** One failing record under a quarantine policy, in order (specification section 6, ADR-15A's ordering, ADR-15B). */
export const DISPOSITION_LIFECYCLE: readonly DispositionStage[] = [
  {
    name: "Held",
    what: "Every failure pauses first, as today: the source stops at the record and its views go stale. With a policy configured, the incident is written to a local failure journal before anything else. If that write fails, the source stays paused.",
    terms: ["held"],
    notProof: "Nothing has been saved, skipped, or repaired yet.",
    source: V11_SOURCES.journal
  },
  {
    name: "Evidence saved",
    what: "A quarantine policy publishes the original record to a separate quarantine topic and waits for Kafka's acknowledgment (acks=all). Only an acknowledged write counts. A timeout is recorded as unknown, never as saved, and the source stays held.",
    terms: ["quarantine-unknown"],
    notProof: "Saved evidence isn't a repaired record or a recovered view.",
    source: V11_SOURCES.algorithm
  },
  {
    name: "Hold, or ask the recovery guard",
    what: "quarantine-hold stops here: the source stays held until the integration is fixed and the same record is retried. quarantine-resync asks the application's recovery guard. A hold answer, an exception, a timeout, or a missing guard all keep the source held; a recoverable answer must name a snapshot boundary.",
    terms: ["hold", "recoverable"],
    notProof: "A recoverable answer is the application's attestation; StreamOtter checks its identity and coverage, not the business data.",
    source: V11_SOURCES.barrier
  },
  {
    name: "Source advanced",
    what: "The gateway stores the recovery boundary and its intent to advance, commits exactly the next offset, and reads the commit back. If the read-back disagrees or fails, the position is uncertain and the source stays held.",
    terms: ["advance-pending", "advance-confirmed", "uncertain"],
    notProof: "Advancing past the record doesn't mean any browser received it.",
    source: V11_SOURCES.journal
  },
  {
    name: "Views resynchronized",
    what: "Every later snapshot for that source, including for subscriptions opened after the incident, must report that it satisfies the recovery boundary. Then the normal snapshot-and-drain path makes each view live on its own.",
    terms: ["recoveryBoundaryId"],
    notProof: "A resynchronized view starts from a fresh snapshot; the excluded and intermediate events aren't replayed.",
    source: V11_SOURCES.recovery
  }
];

export interface OperatorAction {
  command: string;
  what: string;
}

/** The planned local operator commands that act on one incident (specification section 9). Local CLI only; never a browser control. */
export const OPERATOR_ACTIONS: readonly OperatorAction[] = [
  { command: "sources retry-current", what: "Retry the exact held record after a repair. It never skips the record." },
  { command: "sources reassess", what: "Ask the recovery guard again for a held, eligible incident. It can't override an integrity failure." },
  { command: "failures evaluate", what: "Dry-run one saved record against the current mapper. No offset moves, no state is sent, and the plan it issues expires." },
  { command: "failures redrive", what: "Run an approved evaluation plan through the gateway's normal revision checks. Nothing is published to a business topic and no offset moves." }
];

/** ADR-15C section 5: what a redrive records. None of these means a business action completed or every browser rendered the result. */
export const REDRIVE_OUTCOMES: Readonly<Record<"reprocessed" | "superseded" | "failed" | "unknown", string>> = {
  reprocessed: "At least one output was admitted.",
  superseded: "Every output was at or below the current state, so a newer snapshot already covers it.",
  failed: "The mapping still fails.",
  unknown: "The process stopped between intent and result; it needs a new approval and is never rerun automatically."
};
