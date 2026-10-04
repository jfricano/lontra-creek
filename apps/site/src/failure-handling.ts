/**
 * StreamOtter's source-failure handling, as the installed release ships it, for
 * `/when-it-breaks/`, `/releases/`, `/docs/`, and the home page's panel.
 *
 * Everything the package exports is imported, not copied: the failure classes, the policy
 * vocabulary, the automatic-advance limit, the operator operations and which of them change
 * state, and the evaluation plan's lifetime. `Record<…>` types over those exports fail
 * `tsc -p apps/site/tsconfig.json` when the package adds or removes one. What the package
 * doesn't export (what each failure means, what each step doesn't prove, the CLI spelling
 * of each operation) is hand-written from the release's own documentation, each with a
 * source pinned to the release tag.
 *
 * Whether the installed release really has these features is asked of its own validator
 * (`INSTALLED_VALIDATOR_ON_FAILURE_HANDLING`), and test/failure-handling.test.ts holds every
 * claim here against the installed package, so pinning a release without them fails loudly.
 *
 * This file describes the library. What the demo runs is separate: the Lab and the
 * workbench read that from the backend at runtime, never from here.
 */
import {
  DEFAULT_AUTOMATIC_ADVANCE_LIMIT, OPERATOR_MUTATIONS, OPERATOR_OPERATIONS, PLAN_TTL_MS, validateProjectConfig,
  type FailureClass, type FailurePolicy, type IncidentEventName, type IncidentProgress, type IncidentQuarantine,
  type IncidentRecovery, type OperatorOperation
} from "streamotter/contracts";
import fieldConfig from "../../field-station/streamotter.json" with { type: "json" };
import { RELEASE_TAG } from "./release-facts.ts";

const BLOB = `https://github.com/jfricano/StreamOtter/blob/${RELEASE_TAG}`;
const GUIDE = `${BLOB}/docs/guides/source-failures.md`;
const API = `${BLOB}/docs/releases/v1.1/V1_1_API.md`;
const SPEC = `${BLOB}/docs/releases/v1.1/V1_1_SOURCE_FAILURE_SPEC.md`;
const ADR = `${BLOB}/docs/releases/v1.1/adr`;

/** The release's own documentation, pinned to the release tag so the links describe the installed version. */
export const FAILURE_SOURCES = {
  guide: GUIDE,
  requirements: `${GUIDE}#1-before-you-start`,
  policy: `${GUIDE}#3-choose-a-policy`,
  guard: `${GUIDE}#4-write-an-honest-recovery-guard`,
  operate: `${GUIDE}#52-act`,
  api: API,
  operator: `${API}#6-operator-service-slices-c-d`,
  spec: SPEC,
  algorithm: `${SPEC}#6-quarantine-and-source-progress-algorithm`,
  recovery: `${SPEC}#7-making-continuation-honest`,
  decisions: `https://github.com/jfricano/StreamOtter/tree/${RELEASE_TAG}/docs/releases/v1.1/adr`,
  journal: `${ADR}/ADR-15A-failure-journal-and-handoff.md`,
  barrier: `${ADR}/ADR-15B-recovery-barrier.md`,
  redrive: `${ADR}/ADR-15C-operator-authority-and-redrive.md`,
  status: `${BLOB}/docs/IMPLEMENTATION_STATUS.md#v11-source-failure-handling-020-rc1`
} as const;

/**
 * What the installed validator says about this demo's own project configuration with a
 * minimal quarantine-hold section added. Computed at build time from the real package: a
 * release without source-failure handling rejects the key, and the test that pins this
 * value fails.
 */
export const INSTALLED_VALIDATOR_ON_FAILURE_HANDLING = validateProjectConfig({
  ...fieldConfig,
  failureHandling: {
    quarantine: { topic: "field.streamotter.quarantine", capture: "full-record" },
    sources: { field: { invalidJson: "quarantine-hold", invalidPublicPayload: "quarantine-hold" } }
  }
});

// --- Policies -------------------------------------------------------------------------

export const POLICIES: Readonly<Record<FailurePolicy, string>> = {
  pause: "The default, and the only behavior without a failureHandling section: the source stops at the record without committing or skipping it. With failureHandling configured, the failure is also recorded as an incident.",
  "quarantine-hold": "Copy the original record, byte for byte, to a quarantine topic you provide, wait for Kafka to acknowledge the copy, and keep the source held at the record. The release's guide suggests starting here.",
  "quarantine-resync": "After an acknowledged copy, ask your application's recovery guard. Only a recoverable answer moves the source past the record, and from then on every snapshot on the source must acknowledge the recovery boundary before a view can be live."
};

/** Values the validator refuses as policies: StreamOtter never skips a record silently. */
export const NOT_OFFERED = ["ignore", "discard", "force-skip"] as const;

export interface PolicyRow {
  failure: string;
  /** The package's failure classes; empty for failures that are not a bad record. */
  classes: readonly FailureClass[];
  /** What happens with no policy configured. */
  byDefault: string;
  /** The most a policy may opt into. */
  optIn: string;
}

/** The release guide's class table (§3), with the package's class names beside each row. */
export const POLICY_MATRIX: readonly PolicyRow[] = [
  { failure: "The value isn't UTF-8 JSON within the nesting limit", classes: ["invalid-json"], byDefault: "Pause", optIn: "quarantine-hold or quarantine-resync, set with invalidJson." },
  { failure: "Routing passed, but the mapped data fails the channel's payload schema", classes: ["payload-schema"], byDefault: "Pause", optIn: "quarantine-hold or quarantine-resync, set with invalidPublicPayload." },
  { failure: "The map handler threw a TransientMappingError on every allowed attempt", classes: ["mapper-transient"], byDefault: "Pause", optIn: "One or two more attempts (transientMapperRetries, 250 ms then 1 s, only with replaySafeMapping), then pause." },
  { failure: "Any other map handler exception, or a map handler past handlerTimeoutMs", classes: ["mapper-error", "mapper-timeout"], byDefault: "Pause", optIn: "Pause. The incident is recorded; nothing moves past the record." },
  { failure: "The map handler returned a bad tenant, parameters, revision, shape, or count; or the same revision maps to different data", classes: ["routing-invalid", "revision-conflict"], byDefault: "Pause", optIn: "Pause; never skipped. Repair and retry the same record." },
  { failure: "A null value (tombstone), or a record over maxSourceRecordBytes", classes: ["tombstone", "oversize"], byDefault: "Pause", optIn: "Pause." },
  { failure: "Broker, network, or authentication failure; rebalance; shutdown; journal or quarantine failure", classes: [], byDefault: "Outage and hold behavior, as without failure handling", optIn: "Not a failure class: never a skippable incident." },
  { failure: "Authorization failure or a slow browser", classes: [], byDefault: "Access and flow-control behavior", optIn: "Not a source failure; existing isolation and overload handling apply." }
];

/** The automatic-continuation circuit breaker's default, per source, as the package exports it. */
export const AUTOMATIC_ADVANCE_LIMIT = DEFAULT_AUTOMATIC_ADVANCE_LIMIT;

// --- Record disposition -----------------------------------------------------------------

/** The package's own incident vocabulary, plus the snapshot handler's recovery fields. */
export type IncidentTerm = IncidentEventName | IncidentProgress | IncidentQuarantine | IncidentRecovery | "recovery" | "recoveryBoundaryId";

export interface DispositionStage {
  name: string;
  /** What happens at this stage. */
  what: string;
  /** The package's terms for this stage, as an operator reads them in `failures show`. */
  terms: readonly IncidentTerm[];
  /** What reaching this stage does not establish. */
  notProof: string;
  source: string;
}

/** One failing record under a quarantine policy, in order (specification §6, ADR-15A's ordering, ADR-15B). */
export const DISPOSITION_LIFECYCLE: readonly DispositionStage[] = [
  {
    name: "Held",
    what: "Every failure pauses first. With failureHandling configured, the gateway records an incident with a stable ID in its journal, a SQLite file under its state directory (in memory only under streamotter dev without one). If it can't record the incident, the source stays paused.",
    terms: ["detected", "held"],
    notProof: "Nothing has been saved, skipped, or repaired yet.",
    source: FAILURE_SOURCES.journal
  },
  {
    name: "Evidence saved",
    what: "A quarantine policy writes the original key, value, and headers to the quarantine topic and waits for Kafka's acknowledgment (acks=all). Only an acknowledged write counts. A timeout is recorded as unknown, never as saved, and the source stays held. A fixture source keeps its evidence locally, labeled as fixture evidence.",
    terms: ["quarantine-unknown", "quarantined"],
    notProof: "Saved evidence isn't a repaired record or a recovered view.",
    source: FAILURE_SOURCES.algorithm
  },
  {
    name: "Hold, or ask the recovery guard",
    what: "quarantine-hold stops here: the source stays held until the cause is fixed and the same record is retried. quarantine-resync asks the source's recovery guard, one call at a time with a 10-second limit. A hold answer, a throw, a timeout, or an invalid answer keeps the source held, and the gateway refuses to start a quarantine-resync source without a guard.",
    terms: ["guard-pending", "denied", "boundary-in-force"],
    notProof: "A recoverable answer is the application's attestation; StreamOtter checks the boundary's identity and lifecycle, not the business data.",
    source: FAILURE_SOURCES.barrier
  },
  {
    name: "Source advanced",
    what: "The gateway journals the recovery boundary and its intent to advance, commits exactly the next offset, and reads the commit back. If the read-back fails or disagrees, the advance is uncertain and the whole source holds until a restart reconciles it.",
    terms: ["advance-pending", "advance-confirmed", "uncertain"],
    notProof: "Advancing past the record doesn't mean any browser received it.",
    source: FAILURE_SOURCES.journal
  },
  {
    name: "Views resynchronized",
    what: "From then on every snapshot on the source, for new subscriptions and after restarts too, receives recovery and must return the same recoveryBoundaryId before a view can be live. A snapshot that doesn't keeps its view stale and is retried.",
    terms: ["recovery", "recoveryBoundaryId"],
    notProof: "A resynchronized view starts from a fresh snapshot; the excluded and intermediate events aren't replayed.",
    source: FAILURE_SOURCES.recovery
  }
];

// --- Operator actions -----------------------------------------------------------------

export interface OperatorAction {
  /** The CLI spelling, after `streamotter`. */
  command: string;
  what: string;
}

/**
 * Every operation of the package's operator service, as the local CLI spells it. Local only:
 * the CLI reaches the gateway through its operator socket, never through a browser.
 */
export const OPERATOR_ACTIONS: Readonly<Record<OperatorOperation, OperatorAction>> = {
  status: { command: "status", what: "Whether anything is held, whether the journal is healthy, and whether a circuit is open." },
  listFailures: { command: "failures list", what: "Open incidents, oldest first; filter by source or state." },
  showFailure: { command: "failures show", what: "One incident: evidence, quarantine, source position, and recovery kept separate, with the supported next step." },
  exportFailure: { command: "failures export", what: "A reproduction bundle for a bug report. Original bytes only when explicitly requested." },
  retryCurrent: { command: "sources retry-current", what: "Process the held record again after a repair. It never skips the record." },
  reassess: { command: "sources reassess", what: "Ask the recovery guard again for an eligible quarantine-resync incident. It can't override an integrity failure." },
  reopenCircuit: { command: "sources reopen-circuit", what: "Close a tripped circuit breaker after a fix. It approves no record." },
  retireBoundary: { command: "sources retire-boundary", what: "Retire a recovery boundary by hand, only in operator retirement mode. The unsafe option: it asserts every later snapshot already reflects the record." },
  evaluate: { command: "failures evaluate", what: `Run the current mapping on the saved record without delivering, tracing, or committing. When a redrive is allowed, it issues a single-use plan that expires after ${PLAN_TTL_MS / 60_000} minutes.` },
  redrive: { command: "failures redrive", what: "Run an approved plan through the gateway's normal revision checks. Nothing is published to Kafka and no offset moves." }
};

/** The operator actions in the package's own order, each marked when it changes state. */
export const OPERATOR_TABLE = OPERATOR_OPERATIONS.map(operation => ({ operation, ...OPERATOR_ACTIONS[operation], mutates: OPERATOR_MUTATIONS.includes(operation) }));

/** What a redrive records (ADR-15C §5). None of these means a business action completed or every browser rendered the result. */
export const REDRIVE_OUTCOMES: Readonly<Record<"reprocessed" | "superseded" | "failed" | "unknown", string>> = {
  reprocessed: "At least one subscription took the result.",
  superseded: "Current state was already newer, so nothing older overwrote it.",
  failed: "The record still doesn't map cleanly, for example to a conflicting revision. Nothing is admitted.",
  unknown: "The process stopped between intent and result. It's reported after restart, needs a new approval, and is never rerun automatically."
};
