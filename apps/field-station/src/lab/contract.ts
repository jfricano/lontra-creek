/** Public and private Lab API types. See docs/contracts/lab-api.md. */
import type { ErrorCode, SourceStatus, TraceStage } from "streamotter/contracts";

export type BenchId = 1 | 2 | 3;

export type LabAction =
  | "sensor.foul"      // remove LC-03's calibration table
  | "sensor.restore"   // put it back; the source stays paused
  | "source.resume"    // resume the paused source at the record it stopped on
  | "relay.cut"        // cut the bench's path to Kafka
  | "relay.restore"
  | "satellite.start"  // connect the slow client once
  | "gateway.restart"; // restart the bench's gateway

/** Anyone may ask; no session needed. */
export interface LabStatus {
  /** False when the Lab is switched off or not configured (for example `npm run dev`). */
  enabled: boolean;
  now: string;
  benches: { bench: BenchId; state: "ready" | "leased" | "resetting" | "unavailable" }[];
  queueLength: number;
  /** The earliest end of a current lease; null when a bench is ready or none is leased. */
  nextFreeAt: string | null;
}

/** What the leaseholder's bench is doing, from the bench itself. */
export interface LabBenchState {
  gateway: "running" | "restarting";
  source: { status: SourceStatus["status"]; reason?: ErrorCode };
  relay: "up" | "cut";
  calibration: "present" | "removed";
  satellite: "idle" | "connected";
  /** The bench gateway's configured receipt timeout, shown by the page for the satellite scenario. */
  receiptTimeoutMs: number;
}

export type LabEndReason =
  | "left"            // left the line
  | "returned"        // returned the bench early
  | "expired"         // the lease ran its time
  | "idle"            // no heartbeat within the idle limit
  | "unclaimed"       // no bench token fetched within the claim window
  | "session-ended"   // the visitor's session expired
  | "bench-failed"    // the bench stopped answering or lost the lease
  | "lab-restarted";  // the field station restarted and reset every bench

export type LabLease =
  | { status: "none"; now: string }
  | {
      status: "queued";
      now: string;
      /** 1 means next. */
      position: number;
      queueLength: number;
      joinedAt: string;
      nextFreeAt: string | null;
      sessionExpiresAt: string;
    }
  | {
      status: "ready" | "active";
      now: string;
      leaseId: string;
      bench: BenchId;
      grantedAt: string;
      expiresAt: string;
      /** Set while ready: fetch a bench token before this or the lease is released. */
      claimBy: string | null;
      /** When the next scenario action will be accepted. */
      nextActionAt: string;
      benchState: LabBenchState;
    }
  | { status: "ended"; now: string; reason: LabEndReason; endedAt: string; bench: BenchId | null };

export interface LabToken {
  token: string;
  /** The lease's end. The bench closes the connection then, whatever the page does. */
  expiresAt: string;
  bench: BenchId;
  /** Where the SDK connects, for example https://demo.streamotter.app */
  gatewayOrigin: string;
  /** /lab/<bench>/socket.io */
  gatewayPath: string;
}

export interface LabActionResult {
  action: LabAction;
  at: string;
  nextActionAt: string;
  benchState: LabBenchState;
}

interface FeedBase {
  id: string;
  at: string;
}

export type LabFeedItem =
  /** A StreamOtter trace, redacted (section 6). */
  | (FeedBase & {
      kind: "trace";
      stage: TraceStage;
      outcome: "ok" | "filtered" | "rejected" | "failed";
      /** Ties together the steps of one record or one synchronization. */
      group: string;
      sourceId?: string;
      channel?: string;
      errorCode?: ErrorCode;
      /** Whose subscription: the leaseholder's page or the satellite client. */
      subscriber?: "you" | "satellite";
    })
  /** The bench's source changed status, as its gateway reports it. */
  | (FeedBase & { kind: "source"; sourceId: string; status: SourceStatus["status"]; reason?: ErrorCode })
  /**
   * An LC-03 reading, so the page can show the same record failing and then retried.
   * `processed` means the bench's map handler returned for this record. It is written
   * before StreamOtter validates, delivers, or commits anything, so it is not proof of
   * acceptance or of the offset advancing; the page labels it "mapper returned".
   */
  | (FeedBase & { kind: "record"; stationId: "LC-03"; topic: string; partition: number; offset: string; outcome: "failed" | "processed" })
  /** A scenario action the bench carried out. */
  | (FeedBase & { kind: "action"; action: LabAction })
  | (FeedBase & {
      kind: "bench";
      event: "lease-started" | "satellite-connected" | "satellite-disconnected" | "gateway-stopped" | "gateway-started" | "gap";
    });

export interface LabFeedPage {
  items: LabFeedItem[];
  /** Pass as `after` on the next request. */
  next: string;
  /** True when items were dropped between `after` and the first item returned. */
  gap: boolean;
}

/*
 * V1.1 Source failures track (docs/contracts/lab-api.md section 12).
 *
 * `LabCapabilities` is served today. Everything marked PROPOSED describes an interface
 * that no published StreamOtter release backs yet: `0.1.0-rc.3` has no quarantine,
 * recovery guard, evaluation, or operator service. The field station refuses every
 * `LabIntentRequest` with 409 `unsupported-scenario` and serves no incident or
 * operation resource; the page shows those parts as unavailable, never simulated.
 */

/** The two tracks on /lab/. */
export type LabTrack = "connections" | "source-failures";

/** Every scenario /lab/ explains, by its stable `?scenario=` value. */
export type LabScenarioId =
  | "fouled-sensor"         // LC11-S01, the existing sensor.foul, sensor.restore, source.resume
  | "garbled-reading"       // LC11-S02
  | "bad-projection"        // LC11-S03
  | "inspect-old-reading"   // LC11-S04
  | "conflicting-readings"  // LC11-S05
  | "calibration-blip"      // LC11-S06
  | "too-many-bad-readings" // LC11-S07
  | "restart-recovery"      // LC11-S08
  | "unavailable-evidence"  // LC11-S09
  | "relay-cut"             // existing relay.cut, relay.restore
  | "slow-client"           // existing satellite.start
  | "relay-restart";        // existing gateway.restart

export type LabUnavailableCode =
  | "lab-disabled"              // this deployment has no benches
  | "library-lacks-capability"  // the installed StreamOtter release is known not to provide what the scenario needs
  | "not-integrated";           // the installed release isn't one this backend's Lab has been verified against

export interface LabAvailability {
  available: boolean;
  /** Null when available; `text` is one sentence for visitors. */
  reason: { code: LabUnavailableCode; text: string } | null;
}

/** GET /api/lab/capabilities: what this backend can run. Safe for anyone: no URLs, secrets, paths, or operator capabilities. */
export interface LabCapabilities {
  now: string;
  /** The Lab contract revision this backend implements. */
  contract: string;
  /** The StreamOtter package installed beside the field station, read from its package.json at startup. */
  library: { name: "streamotter"; version: string };
  /** The field station on Kafka with synthetic data; benches only when `lab` is `enabled`. */
  backend: { mode: "real-kafka-synthetic"; lab: "enabled" | "disabled" };
  /** Every scenario this backend knows. A scenario missing here is one this backend does not support. */
  scenarios: (LabAvailability & { id: LabScenarioId })[];
  /** The PROPOSED incident projection and intents below. */
  features: { incidentProjection: LabAvailability; intents: LabAvailability };
}

/** PROPOSED demo intents (companion plan section 9), not StreamOtter API names. Each resolves to a fixed, server-selected incident and action. */
export type LabIntent =
  | "scenario.start"               // start a source-failures scenario on the leased bench's study
  | "scenario.restore-calibration" // the application puts LC-03's calibration back
  | "scenario.prepare-coverage"    // the application releases its predetermined snapshot coverage
  | "incident.retry-current"       // retry the exact held position
  | "incident.reassess"            // ask the recovery guard again
  | "incident.evaluate"            // dry-run the retained evidence against the current mapper
  | "incident.approve-reprocess";  // approve one evaluated plan for gateway-local reprocessing

/**
 * PROPOSED body of `POST /api/lab/actions` for an intent, in place of `{ action }`.
 * Bench, source, topic, offset, incident storage IDs, payloads, handler code, and policy
 * objects are never accepted: any other key is 400.
 */
export interface LabIntentRequest {
  intent: LabIntent;
  /** Idempotency key, one per visitor decision: 8 to 64 of A-Z, a-z, 0-9, and '-'. A repeat returns the same operation. */
  requestId: string;
  /** Required for `scenario.start` and refused otherwise: a source-failures scenario. */
  scenario?: LabScenarioId;
  /** Required except for `scenario.start`: the `scenarioRevision` the page last showed. A stale one is refused. */
  expectedRevision?: number;
  /** Required for `incident.approve-reprocess` and refused otherwise: the opaque token of the evaluation the visitor reviewed. */
  planToken?: string;
}

/** PROPOSED: the answer to an intent (202) and `GET /api/lab/operations/<operationId>`. */
export interface LabOperation {
  /** Opaque and scoped to the lease and study; looked up under the session, never trusted as authority. */
  operationId: string;
  intent: LabIntent;
  requestId: string;
  /**
   * `accepted` acknowledges the demo request only: not quarantine success, not business completion.
   * `unknown` means the outcome couldn't be observed; the page looks it up again and never repeats the request.
   */
  status: "accepted" | "running" | "succeeded" | "refused" | "failed" | "unknown" | "cancelled";
  acceptedAt: string;
  updatedAt: string;
  /** The incident revision the outcome produced, once known. */
  scenarioRevision: number | null;
  /** One sentence for `refused`, `failed`, `unknown`, and `cancelled`; null otherwise. */
  detail: string | null;
}

/**
 * PROPOSED: the bounded, lease-scoped current-incident projection. The browser gets this
 * summary, not the server's internal state, and never derives it from the rolling feed.
 */
export interface LabIncidentSummary {
  /** Opaque display label such as "Incident 1"; not a journal or storage ID. */
  label: string;
  scenario: LabScenarioId;
  /** Increments whenever the incident or its study changes; intents echo it as `expectedRevision`. */
  scenarioRevision: number;
  /** One human-readable sentence, shown first. */
  reason: string;
  openedAt: string;
  updatedAt: string;
  /** As the installed library reported them, never inferred from the button the visitor pressed. */
  failure: { stage: string; class: string };
  /** The policy preset the study started with, by its library name. */
  policy: string;
  /** `saved` only after a positively acknowledged quarantine write. */
  evidence: "saved" | "unknown" | "unavailable";
  source: "held" | "advanced" | "uncertain";
  recovery: "none" | "coverage-not-ready" | "coverage-established" | "view-resynchronized";
  /** The latest dry-run evaluation of the retained evidence, if any. */
  evaluation: { result: "passed" | "failed"; at: string; expiresAt: string | null } | null;
  /** The controlled reprocessing's observed outcome, once there is one. */
  reprocess: "reprocessed" | "superseded" | "failed" | "unknown" | null;
  /** True once a reset discarded this study; the incident was not fixed by it. */
  discarded: boolean;
  /** The intent the backend would accept next, or null. */
  nextIntent: LabIntent | null;
  /** Shown behind disclosure: the bench's own synthetic coordinates and identities. */
  detail: { topic: string; partition: number; offset: string; evidenceFingerprint: string | null; handlerIdentity: string | null; sourceGeneration: string | null };
  /** Chronological and bounded; the browser adds its own observations beside them. */
  steps: { at: string; origin: "application" | "library"; text: string }[];
  /** True when older steps were dropped: some steps are missing, not reconstructable. */
  stepsGap: boolean;
}

/** PROPOSED: `GET /api/lab/incident`. */
export type LabIncidentView =
  | { status: "none"; now: string }
  | { status: "open"; now: string; incident: LabIncidentSummary };

export type LabErrorCode =
  | "invalid-request"     // 400
  | "no-session"          // 401
  | "origin-not-allowed"  // 403
  | "no-lease"            // 409: no ready or active lease for this session
  | "not-applicable"      // 409: the action doesn't apply to the bench's current state
  | "unsupported-scenario" // 409: a proposed intent (section 12) this backend doesn't support
  | "too-many-requests"   // 429: the Lab request budget
  | "too-many-actions"    // 429: more than one action a second
  | "too-many-places"     // 429: this client address already holds two places
  | "queue-full"          // 503
  | "lab-unavailable"     // 503: the Lab is off, or no bench is working
  | "bench-unavailable";  // 503: the lease's bench didn't answer, or answered that it failed; the lease ends as bench-failed

export interface LabError {
  error: string;
  code: LabErrorCode;
}

export interface BenchStatus {
  bench: BenchId;
  state: "starting" | "ready" | "leased" | "resetting" | "failed";
  lease: { leaseId: string; expiresAt: string } | null;
  scenario: LabBenchState;
  /** Self-checks the stack test reads (section 10.6). */
  checks: { developmentPrincipals: number; fixtureSources: number; managementHost: string };
}
