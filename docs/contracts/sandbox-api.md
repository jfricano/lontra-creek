# Workbench sandbox API contract

October 4, 2026 · **Draft 0.3** · The interface between the `/workbench/` page and the published workbench, the field station's sandbox routes, and the `sandbox` service · Owner: Jason Fricano (lead)

[LC11-ADR-04](../releases/v1.1/decisions/LC11-ADR-04-workbench-sandbox-architecture.md) owns the architecture; the [companion plan](../releases/v1.1/LONTRA_CREEK_V1_1_COMPANION_PLAN.md#workbench-sandbox-on-the-existing-route) owns what visitors get. This document fixes routes, payloads, limits, and security rules. As with the [Lab contract](lab-api.md), the types here are normative: they live in a type-only module, `apps/field-station/src/sandbox/contract.ts`, which the site imports with `import type`. A change to either goes in the same pull request.

**Seam.** The integration seam is StreamOtter's **workbench host contract, WHC-1** (StreamOtter `docs/releases/v1.1/WORKBENCH_HOST_CONTRACT.md`, [UPSTREAM_REQUIREMENTS.md](../releases/v1.1/UPSTREAM_REQUIREMENTS.md)), published in **streamotter 0.2.0-rc.1**: `@streamotter/workbench` ships `app.js`, `workbench-host.css`, and the host manifest (`@streamotter/workbench/host`, `hostContract: 1`); `@streamotter/contracts` exports the WHC-1 types; `streamotter/gateway/management` exports `createManagementHandler`. The page writes a WHC-1 boot block and loads the published `app.js`; the workbench then calls the host API in §6 with the visitor's session cookie. §6's operation names and types are the published ones (`WorkbenchOperation`, `WorkbenchDiscovery`, `ManagementOperations`), and the sandbox service answers each operation with a `createManagementHandler` mounted per study (§9). An install without a WHC-1 manifest reports `availability: "unavailable"` with reason `seam-unavailable`.

**Status of each section.** §§1–9 are implemented in code: the session layer by W2, the slot runtime on the published seam by W9a (§9). **None of it is deployed yet.** `deploy/compose.sandbox.yaml` runs the `sandbox` service and sets the field station's `SANDBOX_API_URL`, and `deploy/Caddyfile` and `deploy/Caddyfile.local-lab` carry §1's `/sandbox/N/socket.io/` routes with their Origin checks, but only `npm run dev:lab` (docs/LOCAL_LAB.md) uses them. No host deployment includes the overlay, and `Caddyfile.shared` has no sandbox route; without `SANDBOX_API_URL` the sandbox reports `disabled`.

## 1. The pieces

```
browser (/workbench/)
  ├─ published workbench (WHC-1, session mode) ──fetch, credentials──▶ /api/sandbox/wb/v1/*   Caddy ─▶ field-station:7402
  ├─ page (session lifecycle) ──fetch, credentials──────────────────▶ /api/sandbox/*          Caddy ─▶ field-station:7402
  └─ preview SDK ──WebSocket────────────────────────────────────────▶ /sandbox/N/socket.io/  Caddy (Origin check) ─▶ sandbox:760N

field-station ──service token──▶ sandbox:7620 (sandbox API, §9, Compose network only)
```

- **Runs locally, not deployed.** `npm run dev:lab` runs this topology at `https://localhost:8443` with `deploy/compose.sandbox.yaml`. Caddy routes `/sandbox/N/socket.io/*` only for the site's exact Origin (403 otherwise, ADR-04 decision 7); every other `/sandbox/*` path is 404, and the sandbox API and slot management are never routed. In `deploy/Caddyfile`, `/api/sandbox/wb/v1/config/*` accepts bodies up to 72 KB for §5's 64 KB candidates; the rest of `/api` stays at 8 KB.
- **The field station is the only thing visitors talk to about sessions.** It owns the queue and leases for sandbox slots and Lab benches (one lifecycle owner), and never lets a request name a slot.
- **The sandbox service is the only authority over its slots**: their runtimes, gateways, private management services, candidates, preview credentials, and cleanup.
- **The slot's management handler is never reachable from outside the sandbox process.** It listens on `127.0.0.1` inside the sandbox container and answers only a per-study key that never leaves the process; no native management token exists. The browser holds only its `lc_session` cookie and short-lived preview tokens for its own slot's principals.

## 2. Rules for every route

The Lab contract's §3 rules apply unchanged: CORS and exact Origin, the `lc_session` cookie (started only by `POST /api/sandbox/session`), every request with a session as a heartbeat, no slot in requests, and ISO 8601 times with `now` on every lease response. In addition:

- **Request budget.** `/api/sandbox/*` shares the per-address Lab budget (20 at once, 3 a second) with `/api/lab/*`: one bucket for both. Over budget: 429 with `Retry-After` (`too-many-requests` on lifecycle routes, `OVERLOADED` on §6 routes). The page is on another origin, so `/api/sandbox/*` answers list `Retry-After` (and, on §6 routes, `X-Request-Id`) in `Access-Control-Expose-Headers`.
- **Bodies.** JSON, at most 64 KB for `config.validate` and `config.export`, 4 KB otherwise; larger is 413. Lifecycle `POST`s take an empty body (or `{}`), so `return` can be sent with `keepalive: true` on `pagehide` without a preflight. No route takes query parameters except `traces`.
- **WHC-1 routes (§6)** refuse a foreign `Origin` on every method (403) and require `X-StreamOtter-Workbench: 1` on every `POST` (403 without it), as `createManagementHandler` does; the workbench sends it on every request in session mode. An `Authorization` header is ignored and never forwarded (the workbench never sends one in session mode). The preflight for `/api/sandbox/wb/*` allows the `x-streamotter-workbench` header; other `/api` preflights are unchanged.
- **Operation budget.** At most 2 operations a second per session, counting §6 operations and `repro` (429).

## 3. Types

Session lifecycle (verbatim in `contract.ts`):

```ts
export type SlotId = 1 | 2 | 3;
export type SandboxMode = "synthetic-fixture";

export interface SandboxRuntime {
  /** Exact installed packages, from the running service, not the site build. */
  packages: { streamotter: string; workbench: string };
  mode: SandboxMode;
  /** The seam's contract version: the installed workbench's `hostContract`, "1" for WHC-1; null only from a service that reports none. */
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
```

WHC-1 host API (`contract.ts` has the full definitions; the WHC-1 names are the published ones):

```ts
import type { ManagementOperations, Result, WorkbenchDiscovery as PublishedWorkbenchDiscovery, WorkbenchOperation as PublishedWorkbenchOperation } from "streamotter/contracts";

/** WHC-1 §4: the closed vocabulary, discovery included (sources.retire-boundary is deliberately absent). */
export type WorkbenchOperation = PublishedWorkbenchOperation;

/** The operations the sandbox may serve (§6); every other WHC-1 operation is 403 FORBIDDEN. */
export type SandboxOperation = Extract<WorkbenchOperation, "capabilities" | "health" | "sources" | "channels" | "config"
  | "config.validate" | "config.export" | "traces" | "source-checks" | "sources.resume" | "preview-sessions"
  | "dev.principals" | "dev.fixtures.advance" | "dev.disconnect">;

/** { hostContract: 1, operations, limits: { maxRequestBytes } } */
export type WorkbenchDiscovery = PublishedWorkbenchDiscovery;

/** Per operation: { method, path, request, response }, request and response taken from ManagementOperations. */
export interface SandboxOperations { /* §6 table */ }
export type SandboxResult<O extends SandboxOperation> = Result<SandboxOperations[O]["response"]>;

/** POST /api/sandbox/session/repro (§7). */
export interface SandboxReproDownload { filename: "lontra-creek-sandbox-repro.json"; content: string }
```

## 4. Session lifecycle routes

| Route | Session | Does | Answers |
| --- | --- | --- | --- |
| `GET /api/sandbox/status` | Not needed | Availability, runtime identity, pool | 200 `SandboxStatus` (unconfigured: `unavailable`, `disabled`) |
| `POST /api/sandbox/session` | Started if missing | Explicit allocation: a slot at once or a place in line. Idempotent. | 200 `SandboxLease`; 429 `too-many-places`; 503 `queue-full`, `sandbox-unavailable`. A new session's cookie is set only with the 200; no refusal starts a session. |
| `GET /api/sandbox/session` | Required | Heartbeat and state | 200 `SandboxLease`; 401 |
| `POST /api/sandbox/session/claim` | Required | Claims a `ready` lease (becomes `active`) | 200 `SandboxConnection`; 409 `no-lease`; 503 `slot-unavailable` |
| `POST /api/sandbox/session/reset` | Required | Discards this session's synthetic study (candidate, runtime state, traces, previews) and starts a new `studyId` on the same slot and lease. Idempotent while resetting. | 202 `SandboxLease` (`resetting`); 409 `no-lease`; 503 `slot-unavailable` |
| `POST /api/sandbox/session/return` | Required | Leave the line or return the slot. Empty body, `keepalive`-safe. Idempotent. | 200 `SandboxLease` |
| `POST /api/sandbox/session/repro` | Required, `active` | The reproduction bundle for the current study (§7). Lontra-only; not part of WHC-1. | 200 `SandboxReproDownload`; 409 `no-lease`, `stale-study`; 429 |

Errors carry a `SandboxError` body. Unknown `/api/sandbox/*` routes answer 404 `{ "error": "Not found." }`. With the sandbox not configured, every route but `status` answers 503 `sandbox-unavailable`.

**How the page uses these routes** (W3, `apps/site/src/scripts/workbench.ts`). On open, reload, and back-forward cache restore it asks `GET /api/sandbox/status`, then `GET /api/sandbox/session` only when the status is `available` or the page held a place before; it shows nothing as held until both have answered, and treats 401 `no-session` as no session. Only its Start button sends `POST /api/sandbox/session`. It claims at once only after its own Start or reset; a `ready` lease found any other way waits for the visitor's click within the claim window. While it holds a place it sends `GET /api/sandbox/session` every 5 s as the heartbeat, and at once when the page becomes visible again. A browser can slow a hidden tab's timers to one wake-up a minute (Chrome does after five minutes hidden), which is as long as the 60 s idle limit, so a ready or active session in a background tab can end as `idle`; the page's copy says so rather than promising that it keeps the session alive. On `pagehide` it sends the empty-body `return` with `keepalive`, also when its Start is still in flight. **Check again** is disabled while a lifecycle request is in flight, so revalidating never drops that request's answer. A 404 from `status` (a field station without these routes, such as `npm run dev`'s fixture API) is shown as not enabled. Mode and version labels come only from `runtime` in these answers.

After `claim`, and only when the site pins a published `@streamotter/workbench` with WHC-1 whose exact version and host contract the lease's `runtime` reports, whose discovery lists the shell operations (`config`, `health`, `channels`, `sources`), and whose `apiBase` is on the page's own origin (§11, R11), the page writes the WHC-1 boot block (`hostContract: 1`, `apiBase` the field station's `/api/sandbox/wb/v1`, `auth.mode: "session"`, `gateway` from `SandboxConnection`, `environment.kind: "sandbox"` with the mode label and the running package version) and loads the published workbench. After `reset`, the page waits for `active` and remounts the workbench, since the old study's state is gone.

## 5. Candidate configuration

A candidate is a full `ProjectConfig` JSON document. The sandbox service compares it with the slot's server-owned base and refuses any difference outside this allowlist, naming the first offending JSON pointer (RFC 6901, `~0` and `~1` escaped), in the base's key order and then the candidate's added keys:

| Editable | Bounds |
| --- | --- |
| `/schemas/<existing id>` (the whole schema) | Must remain a schema the published validator accepts; total candidate 64 KB |
| `/channels/<existing name>/version` | Integer 1–99 |
| `/limits/receiptTimeoutMs`, `/limits/maxSubscriptionsPerConnection`, `/limits/maxPendingFramesPerSubscription` | Integer from 1 to the slot's server maximum. Removing one is checked as its StreamOtter default. |

Everything else is server-owned: `configVersion`, `projectId`, `gateway`, `connections`, `sources`, channel `source`, `paramsSchema`, `payloadSchema` references, `handlersRef`, `delivery`, every other limit, and adding or removing channels, schemas, or sources. The published validator, `validateProjectConfig` from `streamotter/contracts`, then runs in the sandbox service. A candidate is only validated or exported; it never changes the running gateway.

How a refusal is reported:

- `config.validate`: 200 `{ valid: false, issues: [{ path, code, message }] }` with code `FIELD_NOT_EDITABLE` (outside the allowlist) or `VALUE_OUT_OF_BOUNDS` (an editable field out of its bounds), so the workbench shows it beside the field like any other issue.
- `config.export`: 400 `CONFIG_INVALID` with `details.code` `field-not-editable` (refused) or `invalid-request` (invalid), and `details.issues`, as the native export does for an invalid configuration. Details are at most 16 KB: a longer `details.issues` keeps the first issues that fit and sets `details.issuesTruncated: true` (`config.validate` returns them all).
- Over 64 KB: 413 `INVALID_REQUEST`, `details.code` `candidate-too-large`.

## 6. Operations: the WHC-1 host API

Mounted at `/api/sandbox/wb/v1` (WHC-1 `apiBase`). Every response is StreamOtter's `Result<T>` envelope, `{ ok: true, requestId, data }` or `{ ok: false, requestId, error: StreamError }`, with an `X-Request-Id` header; `requestId` is generated by the field station. Request and response types are the published `ManagementOperations` for the same native route.

| `op` | Method and path | Input (bounded) | Notes |
| --- | --- | --- | --- |
| `workbench` (discovery) | `GET /workbench` | none | `{ hostContract: 1, operations, limits: { maxRequestBytes: 65536 } }`. `operations` is `workbench` plus the allowlisted operations the running release supports, so only `workbench` while the sandbox is unavailable. Needs a session, like every route here, but no lease. |
| `capabilities`, `health`, `sources`, `channels`, `config` | `GET /<name>` | none | Reads of the slot's own gateway |
| `dev.principals` | `GET /dev/principals` | none | Lists only the slot's two synthetic principals (below) |
| `traces` | `GET /traces` | query `limit` 1–500, `cursor`, `sourceId` (a slot source), `channel` (a slot channel), `outcome` | At most 100 items a page: a larger `limit` (the workbench asks for 200 and 500) is narrowed, as WHC-1 §5 allows a host to. As natively, a page without a cursor holds the newest traces, oldest first, and a cursor returns traces recorded after it. Cursors are opaque handles bound to the study |
| `config.validate` | `POST /config/validate` | `{ config }`, candidate (§5) | Allowlist, then the published validator |
| `config.export` | `POST /config/export` | `{ config }`, candidate (§5) | `{ filename, content, fingerprint }`; content at most 256 KB (§7) |
| `source-checks` | `POST /source-checks` | `{ sourceId }`, one of the slot's sources | |
| `sources.resume` | `POST /sources/resume` | `{ sourceId }`, one of the slot's fixture sources | |
| `preview-sessions` | `POST /preview-sessions` | `{ fixturePrincipalRef }`, one of the slot's own principals | `expiresAt` is the earlier of the native lifetime and the lease's end |
| `dev.fixtures.advance` | `POST /dev/fixtures/advance` | `{ sourceId, count }`, count 1–10, a slot fixture source | |
| `dev.disconnect` | `POST /dev/disconnect` | `{ previewSessionId }`, minted in this study | |

Unknown keys, query parameters on other operations, a missing `Content-Type: application/json`, or a body over its limit are refused. Requests never name a slot, lease, or study: the field station binds the session's current lease and study and passes them to the slot itself.

**Principals.** Each slot registers two server-owned development principals, and previews are minted only for them: `creek-volunteer` (tenant `lontra-creek`, role volunteer), who may read `station`, and `developer` (tenant `local`, the init scaffold's own principal, verbatim), who may read `jobProgress`. Gateway routing includes the verified tenant, so one principal cannot preview both channels. Neither may read the other's channel.

**Check order.** After the shared budget (429) and the Origin check (403), checks run in `createManagementHandler`'s order (WHC-1 rev 0.2 §9): session (401), route (404), allowlist (403), query (400), the `POST` header (403), body size (413), then body content type and JSON (400). The input bounds and the session's lease (401) follow; the sandbox service re-checks the allowlist, bounds, lease, and study.

**Refusals.** Lontra's own code, where there is one, is `error.details.code`.

| Case | Status | `error.code` | `details.code` |
| --- | --- | --- | --- |
| A WHC-1 operation not served here (`failures.*`, `operator.status`, `sources.retry-current`, `sources.reassess`, `sources.reopen-circuit`), or one the installed release does not support | 403 | `FORBIDDEN` | `operation-not-allowed` |

(`createManagementHandler` answers 404 for an operation the installed gateway does not implement; the sandbox answers 403 for every WHC-1 operation it does not serve, which WHC-1 §5 also allows. The workbench never calls either, since discovery does not list them.)
| A path outside WHC-1 (including `sources/retire-boundary`) | 404 | `INVALID_REQUEST` | `invalid-request` |
| A `POST` without `X-StreamOtter-Workbench: 1`, or a foreign `Origin` | 403 | `FORBIDDEN` | `origin-not-allowed` |
| No session | 401 | `UNAUTHENTICATED` | `no-session` |
| No active lease (none, queued, ready, resetting, or ended) | 401 | `UNAUTHENTICATED` | `no-lease` |
| An answer or failure for a study that was reset or ended while the request was in flight | 401 | `UNAUTHENTICATED` | `stale-study` |
| A trace cursor from another study | 410 | `TRACE_CURSOR_EXPIRED` | `stale-study` |
| Over the request or operation budget | 429 | `OVERLOADED` | `too-many-requests` |
| Sandbox not configured, or the slot failed | 503 | `INTERNAL` | `sandbox-unavailable`, `slot-unavailable` |
| An error from the slot's own management service | its status | its code | none |

Failure operations are added only when a pinned release supports them and the sandbox decides to serve them (ADR-04 open question 1).

## 7. Downloads

`config.export` and `POST /api/sandbox/session/repro` return content the page saves as a file. They contain only this study's data:

- **Configuration:** canonical JSON of the validated candidate, with the server-owned bindings as they are (synthetic names only).
- **Reproduction bundle** (`SandboxReproBundle` in `contract.ts`): format and version, generation time, mode, exact packages, contract versions, the scenario by synthetic name (project, channels and versions, source IDs and kinds), the study's start and operation counts, and the study's newest traces, at most 500, oldest first, as `{ at, stage, outcome, sourceId?, channel?, errorCode? }`, without request or subscription identifiers. Native trace pages cannot reach older traces, so `gaps.tracesTruncated` is set when the 500 are a full page (the study may have had more); `gaps.tracesUnavailable` when traces could not be read.

Never cookies, tokens, lease or study IDs, host paths, credentials, other sessions, or raw production material. Each is at most 256 KB (413 `candidate-too-large` otherwise). The service withholds any download that contains its service token, a preview token minted in the study, the lease ID, or a host path (500 `INTERNAL`, `details.code` `invalid-request`).

## 8. Lifecycle, isolation, and limits

The lease state machine is the Lab's (Lab contract §4) with the sandbox's own queue and timings, plus a `resetting` state for a study reset:

| Setting | Default | Source |
| --- | --- | --- |
| Slots | 3 (`SANDBOX_SLOTS`) | ADR-04 |
| Lease | 600 s (`SANDBOX_LEASE_SECONDS`), never past the session's expiry | ADR-04 |
| Claim window | 30 s | ADR-04 |
| Idle limit, ready or active lease | 60 s without a heartbeat | ADR-04 |
| Idle limit, place in line | 90 s | Lab |
| Queue | 30 places (`SANDBOX_QUEUE_MAX`) | ADR-04 |
| Places per client address | 2, **across the Lab and the sandbox combined** | ADR-04 |
| Ended view | 60 s | Lab |
| Service poll | every 5 s; every 1 s while a slot or study is resetting | Lab |
| Service unreachable | 15 s, then every lease ends `slot-failed` and the pool is `service-unavailable` | Lab |
| Reset deadline | 60 s, then the lease ends `slot-failed` (study reset) or the slot is `unavailable` (cleanup); retried every 30 s | Lab |
| Operations | 2 a second per session; `dev.fixtures.advance` at most 10 records | ADR-04 |

- **Explicit allocation.** Only `POST /api/sandbox/session` creates a place or lease. Status, discovery, heartbeats, and page loads never do.
- **Reset and return** invalidate the study at once: the field station moves the lease to a new `studyId` before calling the slot, and the slot switches its current study before cleanup. Cleanup then revokes the study's preview connections before anything else, closes its runtime, and opens a fresh one, so preview tokens, trace cursors, preview session IDs, and late answers from the old study have no effect on the new one. Operations are refused while a study resets.
- **Late answers.** The field station holds its lock only to check the lease before an operation and to check it again after the slot answers; an answer for a study that is no longer current is discarded (`stale-study`). The slot does the same with its own study. A call that fails after its study was reset (closing the old runtime fails its pending calls) is also the old study's: it is answered `stale-study` and never ends the lease, which keeps its slot.
- **Cleanup failure** marks the slot `unavailable`; it is never handed out until a cleanup of the same runtime succeeds (retried every 30 s).
- **Restarts.** On startup the field station returns every slot before granting anything; until it has, the sandbox is `unavailable` (`service-unavailable`) and `POST /api/sandbox/session` answers 503 `sandbox-unavailable`. A sandbox service restart (a new `bootId`) ends its leases as `sandbox-restarted`.
- **Isolation:** two sessions never share a slot, a runtime, a candidate, traces, previews, or downloads (LC11-A42).

## 9. The sandbox service API (private)

`sandbox:7620`, on the Compose network only. Every route except `GET /healthz` needs `Authorization: Bearer <SANDBOX_SERVICE_TOKEN>` (at least 32 characters, compared in constant time). Bodies are JSON, at most 72 KB. Only the field station calls it; types are in `contract.ts` (`SandboxServiceStatus`, `SandboxServiceSlot`).

| Route | Body | Does | Answers |
| --- | --- | --- | --- |
| `GET /sandbox/v1/status` | | Boot ID, availability, runtime identity, supported operations, slots | 200 `SandboxServiceStatus` |
| `PUT /sandbox/v1/slots/N/lease` | `{ leaseId, studyId, expiresAt }` | Leases a `ready` slot | 200 status; 503 `slot-unavailable` |
| `POST /sandbox/v1/slots/N/claim` | `{ leaseId, studyId }` | Marks the lease claimed | 200 status; 409 `no-lease`, `stale-study` |
| `POST /sandbox/v1/slots/N/reset` | `{ leaseId, studyId }` (the new study) | New study on the same lease; cleanup follows | 202 status |
| `POST /sandbox/v1/slots/N/return` | `{ leaseId }` or `{ leaseId: null }` | Ends the lease and cleans the slot; `null` reclaims whatever is there and retries a failed cleanup | 202 status |
| `POST /sandbox/v1/slots/N/ops` | `{ leaseId, studyId, op, input }` | One §6 operation, re-checked against the allowlist and bounds | `Result`-shaped `{ ok, data }` or `{ ok: false, error }` |
| `POST /sandbox/v1/slots/N/repro` | `{ leaseId, studyId }` | The §7 bundle | 200 `SandboxReproDownload` |

The service refuses to start with production or Lab secrets in its environment (`FIELD_STATION_*`, Kafka usernames and passwords, and every Lab token, `LAB_*_TOKEN`, which covers each Lab secret `deploy/make-secrets.sh` writes). It also ends any lease past its `expiresAt` on its own.

**Slot runtimes.** The service hosts each study on a `SlotRuntime` from a `SlotBackend` (`src/sandbox/service.ts`): the slot's server-owned base `ProjectConfig`, its development principals, its editable-limit maxima, `call(op, input)`, `revoke()`, and `close()`. The only production backend, `publishedBackend()` (`src/sandbox/seam.ts`), uses only the published exports:

- **Identity.** `runtime.packages` are the installed `streamotter` and `@streamotter/workbench` versions and `contractVersion` the manifest's `hostContract` (`"1"`). It reports `seam-unavailable` and opens nothing unless the installed manifest is WHC-1's (`hostContract: 1`, package `@streamotter/workbench`) and `createManagementHandler` is exported. `operations` is the allowlist intersected with what the latest runtime's handler discovered.
- **One study.** A fresh project (`src/sandbox/slot-project.ts`: project `lontra-creek-sandbox-N`; the creek's `station` channel on a fixture of the simulation's first study day; the pinned init scaffold's `jobProgress` channel, schemas, handler, and fixture records, ported and held to the scaffold by a test; gateway `maxConnections` 4 and `maxSubscriptionsPerConnection` 8; the site origins as `allowedOrigins`) runs on its own development gateway (`createGateway`, `mode: "development"`) at `SANDBOX_GATEWAY_HOST`:`SANDBOX_GATEWAY_PORT_BASE + N`, path `/sandbox/N/socket.io`. Its `createManagementHandler`, offering only the §6 allowlist, listens on `127.0.0.1` on a system-chosen port; its `authorize` accepts only a 32-byte random key for this study, compared in constant time, sent in a private header by the service itself. `Authorization` headers are ignored and no native management token exists.
- **Calls.** Each operation is rebuilt from the service's checked input: a `GET` with a query only for `traces`, or a `POST` with a JSON body and `X-StreamOtter-Workbench: 1`. A native error passes through with its public fields.
- **Cleanup.** `revoke()` revokes both principals' subjects on the gateway; `close()` closes the management listener and stops the gateway (5 s). Preview tokens live in that gateway's memory, so none survives its study. A failed `close()` leaves the slot `failed` (§8).

A design-fixture backend exists for tests only, under `apps/field-station/test/support/`; `sandbox-main.ts` cannot select it.

## 10. Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `SANDBOX_API_URL` | field station | The service's private origin, for example `http://sandbox:7620`. Unset: the sandbox is `disabled`. |
| `SANDBOX_SERVICE_TOKEN` | both | Shared bearer token, at least 32 characters |
| `SANDBOX_SLOTS` | both | 1–3, default 3 |
| `SANDBOX_LEASE_SECONDS`, `SANDBOX_QUEUE_MAX` | field station | Default 600 and 30 |
| `SANDBOX_API_HOST`, `SANDBOX_API_PORT` | service | Default `0.0.0.0` and 7620 |
| `SITE_ORIGIN` | service | Comma-separated exact site origins the slot gateways allow. Required when `NODE_ENV=production`; default `https://localhost:8443` otherwise |
| `SANDBOX_GATEWAY_HOST`, `SANDBOX_GATEWAY_PORT_BASE` | service | Default `0.0.0.0` and 7600: slot N's gateway listens on 7600 + N. A base that puts a slot on the API port is refused |

## 11. Open points

- WHC-1 has no unmount: the page loads one workbench instance per document (§4).
- R11 (same-site API base) is met by the published WHC-1's `apiOrigin` in session mode: the site is static on `streamotter.dev` and `/api` is on `demo.streamotter.dev`, and the field station's CORS for `/api/sandbox/wb/*` already answers the page's exact origin with credentials. The page's use of it is §4's.
- Failures operations and a possible real-Kafka slot type (ADR-04 open question 1).

## Changes

- **Draft 0.3, W9a deployment (October 4, 2026).** Status and §1: `deploy/compose.sandbox.yaml` and the Caddy `/sandbox/N/socket.io/` routes exist and run under `npm run dev:lab`; nothing is deployed to a host.
- **Draft 0.3, W9a slot runtime (October 4, 2026).** The seam is the published WHC-1 in streamotter 0.2.0-rc.1: §3's `WorkbenchOperation` and `WorkbenchDiscovery` are the published types, and `contractVersion` is `"1"`. §9: the production backend mounts a `createManagementHandler` per study on a private loopback listener with a per-study key, on a development gateway per study; slot N's gateway is on port 760N (was 76N0, which put slot 2 on the API port). §6: each slot has two server-owned principals, `creek-volunteer` and the scaffold's `developer`; `traces` accepts `limit` up to 500 and serves at most 100 a page, with native paging. §7: the bundle holds the newest 500 traces, flagged as possibly truncated when that page is full. §10 adds `SITE_ORIGIN` and the gateway host and port base for the service.

- **Draft 0.2, review fixes (October 4, 2026).** §§6 and 8: a call from a study that was reset while it ran is answered `stale-study` whether it succeeded or failed, and never ends the lease. §4: a refused `POST /api/sandbox/session` sets no cookie. §8: nothing is granted, and joins are refused, until startup has returned every slot. §2: `Retry-After` and `X-Request-Id` are exposed to the cross-origin page. §5: an export refused for more issues than fit in 16 KB keeps `details.code` and a cut, flagged `details.issues`. Status, §1, and §9 say plainly that the Caddy route and the `sandbox` Compose service are not deployed yet (W9a); §9's refused secrets include every `LAB_*_TOKEN`.
- **Draft 0.2, W3 clarification (October 3, 2026).** §4 records how the page uses the lifecycle routes (no allocation on open, reload, or restore; heartbeat; `pagehide` return; 404 status as not enabled), that unconfigured lifecycle routes other than `status` answer 503 `sandbox-unavailable` (as W2 implements), and the conditions under which the page mounts the published workbench. No route, payload, or type changed.
- **Draft 0.2 (October 3, 2026, W2).** §6's single `POST /api/sandbox/ops` replaced by the WHC-1 rev 0.1 host API at `/api/sandbox/wb/v1` (discovery, WHC-1 operation names and paths, `Result<T>` envelope, StreamOtter error codes, `X-StreamOtter-Workbench` header on `POST`), aligned with rev 0.2 §9 (`workbench` in discovery, discovery behind the session check, `createManagementHandler`'s check order, `Authorization` ignored). `requestId`/`studyId` request fields removed: the study is bound to the session on the server. `repro.export` became `POST /api/sandbox/session/repro`. §3 adds the WHC-1 types; `stale-study` is now "a study the session has since reset or ended". §5 says how refusals are reported. §§7–10 add the bundle contents, the download guard, the timings table, the private service API, and configuration.
- **Draft 0.1 (October 3, 2026, P0).** First draft.
