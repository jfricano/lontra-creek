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

export type LabErrorCode =
  | "invalid-request"     // 400
  | "no-session"          // 401
  | "origin-not-allowed"  // 403
  | "no-lease"            // 409: no ready or active lease for this session
  | "not-applicable"      // 409: the action doesn't apply to the bench's current state
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
  /**
   * `ready`: no lease, clean-lease eligible. `leased`: a lease is bound to the open
   * study, whatever its source is doing. `failed`: the last cleanup or the gateway
   * failed; the field station retries the reset. A source that isn't healthy after a
   * same-study restart is not `failed` (LC11-ADR-02).
   */
  state: "starting" | "ready" | "leased" | "resetting" | "failed";
  lease: { leaseId: string; expiresAt: string } | null;
  scenario: LabBenchState;
  /** Self-checks the stack test reads (section 10.6). */
  checks: { developmentPrincipals: number; fixtureSources: number; managementHost: string };
  /** LC11-ADR-02's three readiness facts (section 8). */
  readiness: BenchReadiness;
  /** The study the bench is running; null while starting and between discarding one study and provisioning the next. */
  study: BenchStudy | null;
}

/** Three separate facts, never folded into one (LC11-ADR-02). */
export interface BenchReadiness {
  /** The bench API and its gateway's loopback management API answer. `GET /healthz` reports this. */
  control: boolean;
  /** The bench's source is consuming (`healthy`). Shown, never a reason to fail or end a lease. */
  source: boolean;
  /** No study is open and the last cleanup succeeded. The field station grants only these benches. */
  cleanLease: boolean;
}

/** A bench study's identity. Private: the field station reads it; visitors never see it. */
export interface BenchStudy {
  /** Random and URL-safe, 16 characters. */
  studyId: string;
  /** The bench source's generation, `lab-N-<studyId>`. */
  generation: string;
  /** `streamotter-lab-N-<studyId>`. */
  consumerGroup: string;
  createdAt: string;
  /** `provisioning` until its gateway has consumed once; `clean` until a lease binds it; then `open` until discarded. */
  phase: "provisioning" | "clean" | "open";
  /** Same-study restarts actually run, by kind, so a gateway restart is never reported as process durability (LC11-A14 versus A15). */
  restarts: { gateway: number; process: number };
}

/** Bounded metadata a discarded study leaves behind on the bench's volume. Never payloads. */
export interface StudySummary {
  bench: BenchId;
  studyId: string;
  generation: string;
  consumerGroup: string;
  createdAt: string;
  closedAt: string;
  phase: BenchStudy["phase"];
  leaseId: string | null;
  restarts: BenchStudy["restarts"];
  /** Completed work, recorded honestly; late callbacks are those that arrived after the study closed. */
  counts: { actions: number; recordsProcessed: number; recordsFailed: number; lateCallbacks: number };
  lastSource: SourceStatus["status"] | null;
  /** False when pending work outlived the bounded quiesce wait. */
  quiesced: boolean;
}

// ---------------------------------------------------------------------------
// The private recovery surface (Lab contract section 8a, LC11-ADR-01).
// Field station, internal port, /lab-internal/N/..., bench N's own service token.
// Application-owned: no native guard calls these in rc.3; W9b binds them.
// ---------------------------------------------------------------------------

/** Kafka coordinates of a record. Never its bytes. */
export interface RecordCoordinates { topic: string; partition: number; offset: string }

/** `POST /lab-internal/N/recovery/assess`. */
export interface RecoveryAssessRequest {
  studyId: string;
  sourceId: string;
  /** The incident's record, when the gateway knows it. Matched against the ledger's publication coordinates. */
  record?: RecordCoordinates;
}

export type RecoveryHoldReason =
  | "coverage-withheld"   // the scenario deliberately withholds snapshot coverage ("Snapshot coverage not ready")
  | "coverage-pending"    // the authoritative update is released but the served state hasn't reached it
  | "unknown-record"      // no ledger entry was published at these coordinates: nothing can attest coverage
  | "no-coordinates"      // the incident names no record, so no ledger entry can be matched
  | "obligation-limit";   // the study already holds as many recovery obligations as it may (64): it promises no more

export type RecoveryAssessment =
  | { decision: "hold"; studyId: string; reason: RecoveryHoldReason; evidenceRef: string | null }
  | {
      decision: "recoverable";
      studyId: string;
      /** Opaque, at most 96 characters: the cumulative barrier over every obligation in the study. */
      barrier: string;
      /** Channel instance keys (`station:LC-03`) the barrier covers: the union over every obligation. */
      covers: string[];
      /** Names the ledger entries the answer rests on. */
      evidenceRef: string;
    };

/** Present on a bench snapshot only when the request named a boundary (`?boundary=`). */
export interface SnapshotBoundary {
  /** Echoes the requested barrier exactly; a caller must check it. */
  barrier: string;
  acknowledged: boolean;
  reason?: "lagging" | "unknown-barrier" | "wrong-study" | "malformed";
}

/** `GET /lab-internal/N/views/:channel/:id[?boundary=]`. */
export interface BenchSnapshot {
  revision: string;
  data: unknown;
  boundary?: SnapshotBoundary;
}

/** `POST /lab-internal/N/studies/:studyId/close`: the publisher gate is shut for the study. */
export interface StudyClosed { studyId: string; state: "closed"; inFlight: number }

/** `POST /lab-internal/N/studies/:studyId/discard`: the ledger's bounded summary, then its entries are removed. */
export interface LedgerSummary {
  bench: BenchId;
  studyId: string;
  closedAt: string;
  entries: { scenarioId: string; runId: string; status: "withheld" | "pending" | "established"; affected: string[]; published: boolean }[];
  obligations: number;
  barriers: number;
}
