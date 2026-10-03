# Workbench sandbox API contract

October 3, 2026 · **Draft 0.1** · The interface between the `/workbench/` page and its host adapter, the field station's sandbox routes, and the `sandbox` service · Owner: Jason Fricano (lead)

[LC11-ADR-04](../releases/v1.1/decisions/LC11-ADR-04-workbench-sandbox-architecture.md) owns the architecture; the [companion plan](../releases/v1.1/LONTRA_CREEK_V1_1_COMPANION_PLAN.md#workbench-sandbox-on-the-existing-route) owns what visitors get. This document fixes routes, payloads, limits, and security rules. As with the [Lab contract](lab-api.md), the types here are normative: W2 lands them as a type-only module, `apps/field-station/src/sandbox/contract.ts`, and the site imports them with `import type`. A change to either goes in the same pull request.

**Draft status.** Sections 1–5 and 7–8 are buildable now. Section 6's operations mirror the management operations of `streamotter@0.1.0-rc.3`; their final input and result types are taken from the published seam's exported types (UPSTREAM_REQUIREMENTS.md R2) when a release provides them, and this document is revised then. Until then the sandbox reports `availability: "unavailable"` with reason `seam-unavailable`.

## 1. The pieces

```
browser (/workbench/)
  ├─ host adapter ──fetch, credentials──▶ /api/sandbox/*           Caddy ─▶ field-station:7402
  └─ preview SDK ──WebSocket──────────────▶ /sandbox/N/socket.io/    Caddy (Origin check) ─▶ sandbox:76N0

field-station ──service token──▶ sandbox:7620 (sandbox API, Compose network only)
```

- **The field station is the only thing visitors talk to about sessions.** It owns the queue and leases for sandbox slots and Lab benches (one lifecycle owner), and never lets a request name a slot.
- **The sandbox service is the only authority over its slots**: their gateways, private management services, candidates, preview credentials, and cleanup.
- **The native management service is never reachable from outside the sandbox process.** The browser holds only its `lc_session` cookie and short-lived preview tokens for its own slot.

## 2. Rules for every route

The Lab contract's §3 rules apply unchanged: CORS and exact Origin, the `lc_session` cookie (started only by `POST /api/sandbox/session`), the Lab request budget, every request as a heartbeat, no slot in requests, JSON bodies (here up to 64 KB for `config.validate` and `config.export`, 4 KB otherwise), and ISO 8601 times with `now` on every lease response.

## 3. Types

```ts
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
      /** Changes on every reset; requests carrying an older one are refused. */
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
  /** Where the preview SDK connects, for example https://demo.streamotter.app */
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
  | "stale-study"            // 409: the request's studyId is not the lease's current one
  | "too-many-requests"      // 429
  | "too-many-places"        // 429: this client address already holds two places across the Lab and the sandbox
  | "queue-full"             // 503
  | "sandbox-unavailable"    // 503
  | "slot-unavailable";      // 503

export interface SandboxError { error: string; code: SandboxErrorCode }
```

## 4. Routes

| Route | Session | Does | Answers |
| --- | --- | --- | --- |
| `GET /api/sandbox/status` | Not needed | Availability, runtime identity, pool | 200 `SandboxStatus` |
| `POST /api/sandbox/session` | Started if missing | Explicit allocation: a slot at once or a place in line. Idempotent. | 200 `SandboxLease`; 429 `too-many-places`; 503 `queue-full`, `sandbox-unavailable` |
| `GET /api/sandbox/session` | Required | Heartbeat and state | 200 `SandboxLease`; 401 |
| `POST /api/sandbox/session/claim` | Required | Claims a `ready` lease (becomes `active`) | 200 `SandboxConnection`; 409 `no-lease` |
| `POST /api/sandbox/session/reset` | Required | Discards this session's synthetic study (candidate, runtime state, traces, previews) and starts a new `studyId` on the same slot and lease | 202 `SandboxLease` (`resetting`); 409 `no-lease` |
| `POST /api/sandbox/session/return` | Required | Leave the line or return the slot. Empty body, `keepalive`-safe. | 200 `SandboxLease` |
| `POST /api/sandbox/ops` | Required, `active` | One allowlisted operation (§6) on the session's own slot | 200 `{ op, requestId, result }`; 400; 403 `operation-not-allowed`; 409 `no-lease`, `stale-study`; 413; 429 |

## 5. Candidate configuration

A candidate is a full `ProjectConfig` JSON document. The sandbox service compares it with the slot's server-owned base and refuses (`field-not-editable`, naming the first offending JSON pointer) any difference outside this allowlist:

| Editable | Bounds |
| --- | --- |
| `/schemas/<existing id>` | Must remain a schema the published validator accepts; total candidate 64 KB |
| `/channels/<existing name>/version` | Integer 1–99 |
| `/limits/receiptTimeoutMs`, `/limits/maxSubscriptionsPerConnection`, `/limits/maxPendingFramesPerSubscription` | Within the slot's server maxima |

Everything else is server-owned: `configVersion`, `projectId`, `gateway`, `connections`, `sources`, channel `source`, `paramsSchema`, `payloadSchema` references, `handlersRef`, `delivery`, and adding or removing channels, schemas, or sources. Validation then runs the published validator inside the sandbox service. A candidate never changes the running gateway.

## 6. Operations

The request body is `{ "op": SandboxOperation, "requestId": string, "studyId": string, "input": … }`. `requestId` makes retries idempotent within a study; `studyId` must match the lease's current study.

| `op` | Input (bounded) | Maps to the slot's management operation | Notes |
| --- | --- | --- | --- |
| `health`, `capabilities`, `sources`, `channels`, `config`, `principals` | none | the read of the same name | `principals` lists only the slot's synthetic principal |
| `sources.check` | `{ sourceId }`, one of the slot's sources | source check | |
| `sources.resume` | `{ sourceId }`, one of the slot's sources | resume source | Fixture sources only |
| `config.validate` | `{ config }`, candidate (§5) | validate | Allowlist enforced before validation |
| `config.export` | `{ config }`, candidate (§5) | export | Returns content for a browser download; size-capped |
| `preview.session` | `{ principalRef }`, the slot's own principal | preview session | Token expires at the earlier of the native lifetime and the lease end |
| `preview.disconnect` | `{ previewSessionId }`, minted in this study | disconnect | |
| `fixtures.advance` | `{ sourceId, count }`, count 1–10 | fixture advance | |
| `traces` | `{ limit ≤ 100, cursor?, sourceId?, channel?, outcome? }` | traces | Cursor bound to the study |
| `repro.export` | none | site-built | Sanitized metadata bundle for this study (§7) |

Any other `op`, or one the installed release does not support, is `operation-not-allowed`, and the UI shows it disabled with that reason. Failures operations are added here only when a pinned release supports them.

## 7. Downloads

`config.export` and `repro.export` return content the page saves as a file. They contain only this study's data: canonical configuration with server-owned bindings as they are (synthetic names only), or metadata (scenario, package identity, mode, trace summaries, gap flags). Never cookies, tokens, host paths, credentials, other sessions, or raw production material. Each is at most 256 KB.

## 8. Lifecycle, isolation, and limits

- Defaults are in [LC11-ADR-04](../releases/v1.1/decisions/LC11-ADR-04-workbench-sandbox-architecture.md#defaults-configuration-not-measured-capacity). The lease state machine is the Lab's (Lab contract §4) with the sandbox's own timings.
- **Reset and return** invalidate the study at once: preview tokens, traces cursors, request IDs, and late callbacks from the old study have no effect on the new one. The slot's gateway revokes the old study's connections before anything else.
- **Cleanup failure** marks the slot `unavailable`; it is never handed out until a cleanup succeeds.
- **Isolation:** two sessions never share a slot, a gateway, a candidate, traces, previews, or downloads (LC11-A42).

## 9. Open points

- Final operation types follow the published seam (UPSTREAM_REQUIREMENTS.md R2).
- Failures operations and a possible real-Kafka slot type (ADR-04 open question 1).
