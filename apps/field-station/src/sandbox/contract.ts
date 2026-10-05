/**
 * Workbench sandbox types. See docs/contracts/sandbox-api.md (draft 0.2), which
 * implements StreamOtter's workbench host contract WHC-1 (revision 0.1). Type-only:
 * the site imports this module with `import type`.
 */
import type { ManagementOperations, Result } from "streamotter/contracts";

// §3 Session lifecycle (/api/sandbox/status and /api/sandbox/session*).

export type SlotId = 1 | 2 | 3;
export type SandboxMode = "synthetic-fixture";

export interface SandboxRuntime {
  /** Exact installed packages, from the running service, not the site build. */
  packages: { streamotter: string; workbench: string };
  mode: SandboxMode;
  /** The seam's contract version, once a release defines one. */
  contractVersion: string | null;
}

/** Anyone may ask; no session needed. */
export interface SandboxStatus {
  now: string;
  availability: "available" | "unavailable";
  /** Why it is unavailable. Pages show this text-for-reason; they never fall back to a simulated success. */
  reason?: "disabled" | "seam-unavailable" | "service-unavailable" | "all-slots-unavailable";
  runtime: SandboxRuntime | null;
  slots: { slot: SlotId; state: "ready" | "leased" | "resetting" | "unavailable" }[];
  queueLength: number;
  nextFreeAt: string | null;
}

export type SandboxEndReason =
  | "left" | "returned" | "expired" | "idle" | "unclaimed" | "session-ended" | "slot-failed" | "sandbox-restarted";

export type SandboxLease =
  | { status: "none"; now: string }
  | { status: "queued"; now: string; position: number; queueLength: number; joinedAt: string; nextFreeAt: string | null; sessionExpiresAt: string }
  | {
      status: "ready" | "active" | "resetting";
      now: string;
      leaseId: string;
      /** Changes on every reset; the session's requests act only on the current study. */
      studyId: string;
      slot: SlotId;
      grantedAt: string;
      expiresAt: string;
      claimBy: string | null;
      runtime: SandboxRuntime;
    }
  | { status: "ended"; now: string; reason: SandboxEndReason; endedAt: string };

export interface SandboxConnection {
  leaseId: string;
  studyId: string;
  expiresAt: string;
  /** Where the preview SDK connects, for example https://demo.streamotter.dev */
  gatewayOrigin: string;
  /** /sandbox/<slot>/socket.io */
  gatewayPath: string;
}

export type SandboxErrorCode =
  | "invalid-request"        // 400
  | "field-not-editable"     // 400: a candidate changes a server-owned or unlisted field
  | "candidate-too-large"    // 413
  | "no-session"             // 401
  | "origin-not-allowed"     // 403
  | "operation-not-allowed"  // 403: not in the allowlist, or not supported by the installed release
  | "no-lease"               // 409
  | "stale-study"            // 409: the request belongs to a study the session has since reset or ended
  | "too-many-requests"      // 429
  | "too-many-places"        // 429: this client address already holds two places across the Lab and the sandbox
  | "queue-full"             // 503
  | "sandbox-unavailable"    // 503
  | "slot-unavailable";      // 503

export interface SandboxError { error: string; code: SandboxErrorCode }

// §6 WHC-1 host API at /api/sandbox/wb/v1. Provisional: WHC-1 (rev 0.1, clarified by
// rev 0.2 §9) is not published, so these names and shapes are taken from its text and
// from the rc.3 `ManagementOperations` types until @streamotter/contracts exports its own.

/** WHC-1 rev 0.1 §4 and rev 0.2 §9: the closed operation vocabulary, `workbench` (discovery) included; `sources.retire-boundary` is deliberately absent. */
export type WorkbenchOperation =
  | "workbench" | "capabilities" | "health" | "sources" | "channels" | "config" | "config.validate" | "config.export" | "traces"
  | "source-checks" | "sources.resume" | "preview-sessions" | "dev.principals" | "dev.fixtures.advance" | "dev.disconnect"
  | "operator.status" | "failures.list" | "failures.show" | "failures.export" | "failures.evaluate" | "failures.redrive"
  | "sources.retry-current" | "sources.reassess" | "sources.reopen-circuit";

/** The operations the sandbox may serve (contract §6). Every other WHC-1 operation is 403 FORBIDDEN. */
export type SandboxOperation = Extract<WorkbenchOperation,
  | "capabilities" | "health" | "sources" | "channels" | "config" | "config.validate" | "config.export" | "traces"
  | "source-checks" | "sources.resume" | "preview-sessions" | "dev.principals" | "dev.fixtures.advance" | "dev.disconnect">;

/** `GET /api/sandbox/wb/v1/workbench`, wrapped in `Result<T>`. */
export interface WorkbenchDiscovery {
  hostContract: 1;
  /** `workbench`, plus the allowlisted operations the running release supports (none while the sandbox is unavailable). */
  operations: (SandboxOperation | "workbench")[];
  limits: { maxRequestBytes: number };
}

type M = ManagementOperations;
type Op<Method extends "GET" | "POST", Path extends string, Native extends keyof M> = { method: Method; path: Path; request: M[Native]["request"]; response: M[Native]["response"] };

/** Method, path (relative to the API base), request, and response of each sandbox operation. */
export interface SandboxOperations {
  "capabilities": Op<"GET", "/capabilities", "GET /management/v1/capabilities">;
  "health": Op<"GET", "/health", "GET /management/v1/health">;
  "sources": Op<"GET", "/sources", "GET /management/v1/sources">;
  "channels": Op<"GET", "/channels", "GET /management/v1/channels">;
  "config": Op<"GET", "/config", "GET /management/v1/config">;
  /** Candidate allowlist (§5) first; a refused field is reported as an issue with code FIELD_NOT_EDITABLE or VALUE_OUT_OF_BOUNDS. */
  "config.validate": Op<"POST", "/config/validate", "POST /management/v1/config/validate">;
  /** Candidate allowlist (§5), then 400 CONFIG_INVALID unless valid; content at most 256 KB. */
  "config.export": Op<"POST", "/config/export", "POST /management/v1/config/export">;
  /** Query parameters; `limit` at most 100; cursors are bound to the study. */
  "traces": Op<"GET", "/traces", "GET /management/v1/traces">;
  "source-checks": Op<"POST", "/source-checks", "POST /management/v1/source-checks">;
  /** Fixture sources only. */
  "sources.resume": Op<"POST", "/sources/resume", "POST /management/v1/sources/resume">;
  /** The slot's own principal only; `expiresAt` is capped at the lease's end. */
  "preview-sessions": Op<"POST", "/preview-sessions", "POST /management/v1/preview-sessions">;
  /** Lists only the slot's synthetic principal. */
  "dev.principals": Op<"GET", "/dev/principals", "GET /management/v1/dev/principals">;
  /** `count` from 1 to 10. */
  "dev.fixtures.advance": Op<"POST", "/dev/fixtures/advance", "POST /management/v1/dev/fixtures/advance">;
  /** Only a preview session minted in the current study. */
  "dev.disconnect": Op<"POST", "/dev/disconnect", "POST /management/v1/dev/disconnect">;
}
export type SandboxRequest<O extends SandboxOperation> = SandboxOperations[O]["request"];
export type SandboxResponse<O extends SandboxOperation> = SandboxOperations[O]["response"];
/** Every /api/sandbox/wb/v1 response: StreamOtter's envelope. Lontra's own code, when there is one, is `error.details.code`. */
export type SandboxResult<O extends SandboxOperation> = Result<SandboxResponse<O>>;

// §7 Lontra-only download, outside WHC-1: POST /api/sandbox/session/repro.

export interface SandboxReproDownload {
  filename: "lontra-creek-sandbox-repro.json";
  /** JSON text of a SandboxReproBundle, at most 256 KB. */
  content: string;
}

export interface SandboxReproBundle {
  format: "lontra-creek.sandbox-repro";
  formatVersion: 1;
  generatedAt: string;
  mode: SandboxMode;
  packages: SandboxRuntime["packages"];
  contractVersion: string | null;
  hostContract: 1;
  /** The slot's server-owned scenario, by synthetic name only. */
  scenario: { projectId: string; channels: { name: string; version: number }[]; sources: { sourceId: string; kind: string }[] };
  study: { startedAt: string; operations: Partial<Record<SandboxOperation, number>> };
  /** This study's traces, newest last, without request or subscription identifiers. */
  traces: { at: string; stage: string; outcome: string; sourceId?: string; channel?: string; errorCode?: string }[];
  gaps: { tracesTruncated: boolean; tracesUnavailable: boolean };
}

// Private: field station ↔ sandbox service (sandbox:7620, Compose network only, bearer token).

export interface SandboxServiceSlot {
  slot: SlotId;
  state: "starting" | "ready" | "leased" | "resetting" | "failed";
  lease: { leaseId: string; studyId: string; expiresAt: string; claimed: boolean } | null;
}

export interface SandboxServiceStatus {
  /** Changes when the service restarts, so the field station can say so. */
  bootId: string;
  availability: "available" | "unavailable";
  reason?: "seam-unavailable";
  runtime: SandboxRuntime | null;
  operations: SandboxOperation[];
  slots: SandboxServiceSlot[];
}
