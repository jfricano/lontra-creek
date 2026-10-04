# Failure Lab API contract

September 26, 2026 · The interfaces between the Failure Lab backend (`be-lab`), the `/lab` page (`fe-content`), and Compose and Caddy (`devops`), and the threat model for exposing development-mode bench gateways · Owner: `lead`

[PLAN.md](../PLAN.md#the-failure-lab-lab) owns what the Lab is for and what visitors see; [DEPLOYMENT_PLAN.md](../DEPLOYMENT_PLAN.md#6-the-failure-lab-ships-with-the-launch) workstream 6 owns the engineering order. This document fixes the interfaces those build against: routes, payloads, timings, and security rules. Where it states StreamOtter's behavior, the source is the pinned release, `streamotter@0.1.0-rc.3`, as published on npm (its `src/` is installed under `node_modules/@streamotter/*`). Changes to this contract go through `lead`; an implementation that needs a different interface says so in its pull request and updates this file in the same pull request.

V1.1 amends this contract additively (source-failure intents, current-incident projection, operation status, capabilities, and study restart versus reset); see the [V1.1 implementation plan](../releases/v1.1/IMPLEMENTATION_PLAN.md) and its decisions. The workbench sandbox has its own [contract](sandbox-api.md).

Section 1 fixes the relay-cut mechanism's shape, as E2.0's spike (PR #17, `spike/lab-relay-cut`) built it. Section 9 says what the contract requires of it regardless of implementation.

## 1. The pieces

```
browser, https://streamotter.dev/lab/
  ├─ fetch, credentials ──▶ https://demo.streamotter.dev/api/lab/*            Caddy ─▶ field-station:7402   leases, queue, feed relay
  └─ SDK WebSocket ───────▶ https://demo.streamotter.dev/lab/N/socket.io/     Caddy (Origin check) ─▶ bench-N:7400   dev-mode gateway

field-station ──service token N──▶ bench-N:7420   bench API, Compose network only

bench-N (one container per bench, N = 1, 2, 3)
  gateway              :7400             createGateway({ mode: "development" }), path /lab/N/socket.io
  management API       127.0.0.1:7401   the bench's own loopback; never proxied, never on the Compose network
  bench API            :7420             lease, tokens, scenario actions, redacted feed, reset
  satellite client     in-process        the slow client for the satellite-laptop scenario

lab-N-kafka (a separate container per bench: the relay control, as E2.0's spike built it)
  TCP proxy            :910N             the address Kafka advertises to bench N; forwards to the broker's listener for it
  control API          :9180             POST /cut, POST /restore, GET /state; Compose network only, never routed by Caddy

bench-N's bench API ──relay token N──▶ lab-N-kafka:9180   the proxy's only caller
bench-N ──through lab-N-kafka (cuttable)──▶ Kafka, its own lab-N.* topics and consumer group, its own projectId
```

- **The field station is the only thing visitors talk to about leases.** It keeps the queue and the leases in memory, relays tokens, actions, and the feed, and never lets a request name a bench: the bench always comes from the session's own lease.
- **Each bench is the only authority over its own gateway**: who may connect (its current lease), its scenario state, and its feed.
- **The field station calls only bench N's API; bench N's API calls bench N's proxy control.** Neither the field station nor any other bench ever reaches a proxy's control API directly; the flash-flood scenario action (`relay.cut`/`relay.restore`, section 5) is the only path to it.
- **The management API stays inside the bench.** StreamOtter's traces are readable only through it (section 10.2), so the bench API, which runs in the bench's network namespace, reads them over loopback and serves a redacted feed. That is why the field station never reads a bench's management API directly, as PLAN.md's first sketch had it.
- **Recommended shape**, settled by E2.0's spike (PR #17, `spike/lab-relay-cut`): two Node processes per bench, run as separate Compose services. `bench-main.ts` calls `createGateway({ mode: "development" })` and `startManagementServer({ gateway, host: "127.0.0.1", port, token, workbenchDir: null })` from `streamotter/gateway/management`, and runs (or, for E2.1, will run) the bench API, the satellite client, and the lease and token logic. Compared with `streamotter dev`, it keeps the lease state in the same process as `authenticate`, survives a gateway restart (stop the gateway, construct a new one), passes no `development` principals whatever a handler module exports, and never prints the management token. `proxy-main.ts` runs the `lab-N-kafka` service: the TCP proxy and its control API, holding only that bench's own relay token (section 8). Every requirement in sections 7–10 applies to both processes.

## 2. Timings and limits

Configuration defaults, not measured capacity. The real values are recorded on the host with PLAN.md's other limits before launch; CI's stack test may shorten them.

| Setting | Default | Meaning |
| --- | --- | --- |
| Benches | 3 | Fixed pool |
| Lease | 300 s | From the moment it's granted, and never past the visitor's session expiry. `LAB_LEASE_SECONDS` can shorten it but not lengthen it: benches refuse a lease over 300 s, so the field station refuses a larger value at startup |
| Claim window | 30 s | A granted lease whose page hasn't fetched a bench token by then is released |
| Active idle limit | 30 s | A lease with no heartbeat for this long ends |
| Queue idle limit | 90 s | A place in line with no heartbeat for this long is dropped (background tabs poll less often) |
| Ended view | 60 s | How long `GET /api/lab/lease` keeps reporting an ended lease and why |
| Scenario actions | 1 per second | Per lease (field station) and per bench (bench API); an action that fails doesn't count |
| Reset deadline | 60 s | A bench not ready by then is unavailable; the field station retries every 30 s |
| Bench poll grace | 15 s | A bench reports `failed` only after its background polls of its own gateway have failed for this long; one slow or failed poll changes nothing |
| Queue | 50 places | Then `queue-full` |
| Places per client address | 2 | Leases plus places in line, keyed by `X-Client-IP`, counted across the Lab and the workbench sandbox together ([sandbox contract](sandbox-api.md) §8) |
| Lab request budget | 20 at once, 3 a second | Per client address, for `/api/lab/*` and `/api/sandbox/*` together, instead of the general `/api` budget (30 at once, 1 a second), which a polling page would exhaust |
| Page polling | lease every 2 s; feed every 1 s while active; status every 10 s | Also on `visibilitychange` to visible |
| Feed | 500 items kept per lease; at most 100 per response | Older items fall off; the page is told (`gap`) |

StreamOtter timings the Lab relies on, from `0.1.0-rc.3`:

| Behavior | Value | Where |
| --- | --- | --- |
| A Kafka source with no fetch or heartbeat activity is marked degraded (`SOURCE_UNAVAILABLE`) | after 12 s | `@streamotter/gateway` `src/sources/kafka.ts`, `WATCHDOG_MS` |
| A client that doesn't confirm a frame is disconnected with `OVERLOADED` | `receiptTimeoutMs`, default 5 s | `@streamotter/contracts` `src/limits.ts`; `src/runtime/subscription.ts` |
| A starting gateway gives its sources this long to join | 30 s | `STARTUP_DEADLINE_MS`, `src/runtime/gateway.ts` |
| The SDK asks for a new token before `authExpiresAt` | 30 s before | `TOKEN_REFRESH_LEAD_MS`, `@streamotter/client` `src/client.ts` |
| SDK reconnect backoff | random delay up to 0.5 s, doubling to a 30 s cap | `RECONNECT_BASE_MS`, `RECONNECT_CAP_MS` |
| A development preview token lives | 5 min | `PREVIEW_TOKEN_TTL_MS` |

## 3. The public Lab API

Routes on the field station's public listener, behind Caddy at `https://demo.streamotter.dev/api/lab/*`. The types in this section are normative: `be-lab` lands them verbatim as a type-only module, `apps/field-station/src/lab/contract.ts`, and the site and the tests import them with `import type`.

### Rules for every route

- **CORS and Origin** as for the rest of `/api`: the site's origin with credentials; a `POST` carrying a foreign `Origin` gets 403 `origin-not-allowed`. The preflight allows `GET, POST` today, so the Lab uses no other methods. Error answers carry the same CORS headers as successes, including a 400 for a malformed or oversized body anywhere under `/api`, so the page can read them.
- **Session**: the `lc_session` cookie (`HttpOnly; SameSite=Strict; Path=/api`, 30 minutes, `src/sessions.ts`). Only `POST /api/lab/lease` starts one when there is none, exactly as `POST /api/badge` does (a volunteer session via `badgeFor`), so the Lab needs no separate sign-in. Every other route that needs a session answers 401 `no-session` without one.
- **Budget**: the Lab budget in section 2, plus 429s with `Retry-After`.
- **Heartbeat**: every request with a valid session that has a place or lease counts as its heartbeat.
- **No bench in requests**: the bench, the lease, and the feed come from the session. A client can't choose them.
- **Bodies** are JSON (at most 4 KB, as today), except `POST /api/lab/lease/return`, which takes an empty body so a page can send it with `keepalive: true` on `pagehide` without a preflight.
- **Times** are ISO 8601 UTC strings. Every lease response carries `now`, the server's time, so the page computes time left without trusting the visitor's clock.

### Types

```ts
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
  /** Where the SDK connects, for example https://demo.streamotter.dev */
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

// The V1.1 Source failures types (LabCapabilities and the intent, incident, and operation types) are in section 12.

export type LabErrorCode =
  | "invalid-request"     // 400
  | "no-session"          // 401
  | "origin-not-allowed"  // 403
  | "no-lease"            // 409: no ready or active lease for this session
  | "not-applicable"      // 409: the action doesn't apply to the bench's current state
  | "unsupported-scenario" // 409: an intent or scenario (section 12) this backend or deployment doesn't support
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
```

### Routes

| Route | Session | Does | Answers |
| --- | --- | --- | --- |
| `GET /api/lab/status` | Not needed | The pool at a glance, for the busy and unavailable states | 200 `LabStatus` |
| `GET /api/lab/capabilities` | Not needed | What this backend can run: the installed StreamOtter version, the backend mode, and each scenario's availability (section 12). Doesn't touch the pool; not a heartbeat. | 200 `LabCapabilities`; 400 any query parameter |
| `POST /api/lab/lease` | Started if missing | Join: a lease at once if a bench is ready and nobody is waiting, otherwise a place at the back of the line. Idempotent: a session that already has a place or lease gets it back. | 200 `LabLease` (`ready` or `queued`); 429 `too-many-places`; 503 `queue-full`, `lab-unavailable` |
| `GET /api/lab/lease` | Required | The session's place or lease; the heartbeat | 200 `LabLease`; 401 |
| `POST /api/lab/lease/return` | Required | Leave the line or return the bench early. Empty body. Idempotent. | 200 `LabLease` (`ended` with `left` or `returned`, or `none`); 401 |
| `POST /api/lab/lease/token` | Required | A bench token for the session's lease. The first one claims the lease (`ready` becomes `active`). | 200 `LabToken`; 409 `no-lease`; 503 `bench-unavailable` |
| `POST /api/lab/actions` | Required | Body `{ "action": LabAction }`: one scenario action on the session's own bench. A body with `intent` is a `LabIntentRequest` instead (section 12.5): validated, then refused with 409 `unsupported-scenario` before the pool, the lease, the action budget, or any bench is touched when the capability summary doesn't offer it, otherwise accepted as an operation | 200 `LabActionResult`; 202 `LabOperation` for an intent; 400 unknown action or malformed intent; 409 `no-lease`, `not-applicable`, `unsupported-scenario`; 429 `too-many-actions`; 503 `bench-unavailable` (the bench failed to carry it out, for example its relay control didn't answer; the lease ends as `bench-failed`) |
| `GET /api/lab/operations/<operationId>` | Required | An intent's operation (section 12.6). Served only while `features.intents` is available | 200 `LabOperation`; 404 outside the session's current lease (or the one that ended in the last 60 s), or when not served |
| `GET /api/lab/incident` | Required | The lease's current-incident projection (section 12.7). Served only while `features.incidentProjection` is available | 200 `LabIncidentView`; 409 `no-lease`; 404 when not served |
| `GET /api/lab/trace?after=<next>` | Required | The redacted feed for the session's active lease; without `after`, from the start of the lease | 200 `LabFeedPage`; 400 malformed `after`; 409 `no-lease` |

Errors carry a `LabError` body. Unknown `/api/lab/*` routes answer 404 `{ "error": "Not found." }` like the rest of `/api`.

## 4. Leases and the queue

```
          POST /api/lab/lease
none ───────────────────────────▶ queued ──(a bench is ready, first in line)──▶ ready ──(first token)──▶ active
  ▲                                  │                                           │                        │
  └──── ended (kept 60 s) ◀──────────┴── left, idle, session-ended ◀─────────────┴── unclaimed, ...  ◀─────┴── returned, expired, idle,
                                                                                                             session-ended, bench-failed
```

- **One place per session.** A session holds at most one place in line or one lease; a client address at most two. The line is first come, first served. After a lease ends, the visitor may join again at the back.
- **Granting.** When a bench reports `ready` with `readiness.cleanLease` true (section 8) and someone is waiting, the field station takes the first place, tells the bench the lease (`PUT /bench/v1/lease`), and the place becomes `ready` with `claimBy` 30 seconds away. The lease's five minutes start now, and the field station opens the bench's study for scenario publication (section 8a). A study the gate refuses to open (one it already closed, or a bench answer that names no study) is never granted: the field station resets the bench instead, and the visitor keeps their place in line. If a bench is ready and nobody waits, `POST /api/lab/lease` grants at once. A bench that reports `ready` without being clean-lease eligible is never granted; it is marked `unavailable` and reset again on the 30-second schedule.
- **Claiming.** The first `POST /api/lab/lease/token` makes the lease `active`. A page in the foreground polls every 2 seconds, so it claims within one poll; a lease nobody claims ends as `unclaimed`, which frees benches held by tabs that were left behind.
- **Heartbeat and idle.** Any Lab request from the session is a heartbeat. An active or ready lease without one for 30 seconds ends as `idle`, counted from the grant at the earliest, so a place granted after a slow poll in line keeps its whole claim window; a place in line without one for 90 seconds is dropped as `idle`. The page keeps polling while hidden; if the browser throttles it past the limit, the visitor sees why their place ended.
- **Time left.** `expiresAt` is `min(grantedAt + 300 s, session expiry)`. The bench token's principal expires at the same moment, so StreamOtter itself closes the connection at the lease's end even if the field station and the bench API never act (section 7).
- **Returning early.** `POST /api/lab/lease/return` ends the lease as `returned` and starts the reset at once. Leaving the line is the same call. The page also sends it on `pagehide` with `keepalive: true`; if that is lost, the idle limit frees the bench.
- **Reset between leases.** Every end of a lease, whatever the reason, first shuts the field station's publisher gate on the study the field station itself opened for that bench (section 8a), never on a study named only by a polled bench status, which may be one the bench is still provisioning, then is followed by `POST /bench/v1/reset` (section 8). Reset discards the study; the page must call this **Study discarded**, never repair. The bench refuses the old lease's tokens immediately, then provisions a new study; the next lease is granted only once the bench reports `ready`. A bench that isn't ready within 60 seconds is `unavailable` and the field station retries the reset every 30 seconds; each retry first asks the bench's status, and a bench whose slow reset has finished meanwhile (`ready`, clean-lease eligible) is ready, not reset again.
- **Session expiry.** Sessions last 30 minutes from sign-in and aren't extended (`src/sessions.ts`). A lease never outlasts its session; a place in line is dropped when its session ends (`session-ended`). The queued view carries `sessionExpiresAt`, so the page can warn a visitor whose session will end before their turn is likely. After it ends, the next `POST /api/lab/lease` starts a new session (a new subject) at the back of the line. The walkthrough is unaffected until it next asks for a badge, which then also gets the new subject, as it would today.
- **Bench failure.** The field station polls each bench's status every 5 seconds. A bench that doesn't answer for 15 seconds, reports another lease or none, or reports `failed`, ends its lease as `bench-failed`. A leased bench that reports `starting` (its process restarted and hasn't read its study back yet) counts as not answering, so it has the same 15 seconds to report the lease again (section 8); otherwise the lease ends `bench-failed` and is marked `unavailable` until a reset succeeds. A bench reports `failed` when a reset (any cleanup step) or gateway restart fails, or when its own polls of its gateway have failed for 15 seconds in a row (section 8). The polls a gateway restart makes itself (the old gateway's last trace drain, the new one's first poll) count like background polls: one failing changes nothing. A source that comes back held or paused after a same-study restart is not a failure: the bench stays `leased`, its control stays available, and the lease continues (LC11-ADR-02, LC11-A33). A bench API answer for the lease other than 400, 409, or 429 also ends it as `bench-failed`, and the visitor's request gets 503 `bench-unavailable`.
- **Field station restart.** Leases and the line live in the field station's memory. On startup it resets every bench before granting anything (until then every bench is `unavailable` and a join gets 503 `lab-unavailable`), which also disconnects any visitor still on a bench and discards every open study. Pages then see `none` (or 401 if their session also ended) and say that the Lab restarted.
- **What the page shows.** `none`: the scenarios, "Borrow a bench", and the pool from `GET /api/lab/status`. `queued`: position, line length, `nextFreeAt`, a way to leave, and the local-run instructions (PLAN.md). `ready`/`active`: bench number, time left from `expiresAt − now`, the scenario controls (disabled until `nextActionAt`), the views, and the feed. `ended`: why, and a way to join again. No bench ready and `enabled` true: busy. `GET /api/lab/status` failing, `enabled: false`, or every bench `unavailable`: the unavailable notice ([ui-components.md](ui-components.md#4-notices-including-the-unavailable-state)).

## 5. Scenario actions

At most one a second per lease (field station, 429 `too-many-actions` with `Retry-After: 1`) and per bench (bench API); an action that fails doesn't spend the second. Each action applies only to the session's own bench and only when its precondition holds; otherwise 409 `not-applicable` and nothing changes. Reset undoes all of them.

"Views" below are the page's own SDK subscriptions to its bench (the bench serves only public creek channels: no `holt`, no `notebook`). The page shows timings it measures itself, from the action's response to the state it observes, labeled as measured on this deployment just now.

| Action | Precondition | The bench | The visitor observes |
| --- | --- | --- | --- |
| `sensor.foul` | Calibration present | Removes LC-03's calibration table; the bench's `map` handler throws on the next LC-03 reading. | At the next LC-03 reading: a `record` item (`failed`, with its topic, partition, and offset), a trace `map` `failed` `HANDLER_FAILED` on the `station` channel, and the source `paused` with reason `HANDLER_FAILED`. Every view that was live on that source goes `stale` with reason `SOURCE_UNAVAILABLE`, while the trace shows `HANDLER_FAILED`. A view that starts or resynchronizes while the source is paused goes `stale` with the source's own reason, `HANDLER_FAILED` (`src/runtime/subscription.ts`), so the page shows whichever reason the SDK gives. Nothing after that record is processed or committed. |
| `sensor.restore` | Calibration removed | Puts the table back. | `calibration: "present"`; the source stays `paused` and the views `stale`: StreamOtter never resumes a paused source on its own. |
| `source.resume` | Source `paused` | `gateway.resumeSource()` for the bench's source. If StreamOtter refuses because the source left `paused` since the bench's last poll, 409 `not-applicable`. | StreamOtter retries the same record: a `record` item `processed` (the mapper returned; section 6) with the same offset, trace `map` `ok`, the source `healthy`, and every view `authorizing`, `synchronizing`, then `live` from a fresh snapshot. With the table still removed, the same record fails again and the source pauses again: nothing is skipped. |
| `relay.cut` | Relay up, gateway running | Cuts the bench's path to Kafka (section 9). | Within 20 seconds (StreamOtter marks the source degraded after 12 s without broker activity): the source `degraded` with `SOURCE_UNAVAILABLE`, and every view `stale` with `SOURCE_UNAVAILABLE`. The page's own connection stays `connected`: only the source is down, unlike walkthrough chapter 3, where the visitor's connection drops. |
| `relay.restore` | Relay cut | Restores the path. | Within 30 seconds: the source `healthy`, and every view `synchronizing`, then `live` from a fresh snapshot. |
| `satellite.start` | Satellite idle, source healthy, gateway running | Connects a raw Socket.IO client to its own gateway, subscribes to one station, and never sends a receipt. It runs once per action. | The feed shows the satellite's subscription (`subscriber: "satellite"`): `authorize` `ok`, `snapshot` `ok`, `send` `ok`, then after `receiptTimeoutMs`, `receipt` `failed` `OVERLOADED` and `satellite-disconnected`. Meanwhile the visitor's views stay `live` with new revisions, and `commit` `ok` items keep arriving: the source never waits for a slow client. |
| `gateway.restart` | Gateway running, relay up | Stops the gateway (connections close) and starts a new one with the same lease state. Refused while the relay is cut, since a gateway can't start without its source joining within 30 s. | The connection goes `reconnecting` and the views `stale`; then `connected`, and every view `authorizing`, `synchronizing`, `live` from fresh snapshots. The feed shows `gateway-stopped`, `gateway-started`, and `gap` (a new gateway's trace buffer starts empty). With the source paused by a fouled sensor, the new gateway stops at the same record: a restart doesn't skip it either. |

## 6. The trace feed

**Where it comes from.** The bench API polls its gateway's `GET /management/v1/traces` (cursor-paged; StreamOtter keeps at most 10,000 entries or 8 MiB by default) and `GET /management/v1/sources` over loopback about once a second, and merges three kinds of item into a per-lease buffer: redacted StreamOtter traces, source status changes, and its own `record`, `action`, and `bench` items.

**What StreamOtter's traces contain.** `id`, `requestId`, `at`, `stage`, `outcome`, and optionally `sourceId`, `channel`, `subscriptionId`, and `errorCode` (`Trace` in `@streamotter/contracts`). `TraceBuffer` never stores payloads or credentials (`src/runtime/traces.ts`).

**Redaction** (the bench applies it; the field station passes items through unchanged):

1. **Only this lease.** Items recorded before the lease began are never served: the bench sets a trace cursor when the lease starts and clears its buffer at reset. The field station passes the lease ID from the session, never from the request, and the bench refuses a cursor from another lease.
2. **No handshakes.** Traces with stage `authorize` and no `subscriptionId` are connection handshakes. They can't be attributed to the leaseholder and include anyone's failed attempts to connect to this bench, so they are dropped. The page shows its own connection states from the SDK instead.
3. **No noise.** `map` traces with outcome `filtered` (a record meant for another channel) are dropped. `queue` traces with outcome `filtered` stay: they show a duplicate or older revision being dropped for a subscription.
4. **No identifiers.** `subscriptionId` becomes `subscriber` (`"satellite"` for the satellite client's subscriptions, `"you"` for every other, which can only be the leaseholder's); `requestId` becomes `group`.
5. **No payloads or secrets.** Only the fields in `LabFeedItem` are served. Record values, snapshot data, tokens, the management token, and configuration never enter the feed. `record` items carry only the bench's own topic, partition, and offset.

**What `record` items mean.** The bench writes a `record` item from its `map` handler: `failed` just before it throws, `processed` just before it returns. Neither says anything about what StreamOtter did next. `processed` is not proof that the record passed validation, reached a browser, or that its offset was committed, so the page shows it as **mapper returned** and takes stronger facts (source status, view states) from their own items.

**What the page shows.** By default a scenario view: the visitor's actions, traces with outcome `failed` or `rejected`, source status changes, `failed` records with their topic, partition, and offset, bench events (including `gap`), and the page's own note when it fell behind. A `processed` record at the same coordinates as an earlier `failed` one is marked **Retried**; other `processed` records and `ok` traces appear only in the full feed, behind a toggle. Items are shown in time order (`at`), since traces arrive a poll after the bench's own items. One outcome line below the bench's view states how the latest scenario ended, from feed items and the page's own observations: the retried record, naming the Resume or gateway restart the feed shows before it (or neither, when it shows none), or the slow client's disconnection (with `OVERLOADED` when the feed shows its `receipt` trace failing) beside the visitor's own view state and revisions.

**Delivery and rate.** Polling, not server-sent events: it fits the field station's request-and-response API and its budget, needs no long-lived connections through Cloudflare, and doubles as the heartbeat. The page polls `GET /api/lab/trace` once a second while its lease is active and stops when it ends. The bench keeps the last 500 items per lease and returns at most 100 per request; if the page falls behind, the response has `gap: true` and continues from the oldest item kept, and the page says some steps weren't shown. Item IDs, and so `next`, are `<leaseId>:<epoch>.<n>`, where the epoch is the study's process restart count: a bench process that resumes a lease (section 8) starts a new epoch, with its own `gap` item first. A cursor from an earlier epoch is never refused; it is answered from the start of the current epoch with `gap: true`, so the page keeps polling and sees what the restart lost. A cursor the bench never issued (another lease, a later epoch, or past the newest item) is 400 `invalid-request`.

## 7. Reaching the bench gateway

- **Bench gateway configuration**: its own `projectId` (for example `lontra-creek-lab-1`; V1 supports one gateway per project), `gateway.host` `0.0.0.0` on the Compose network (only Caddy publishes a port), `gateway.port` 7400, `gateway.path` `/lab/N/socket.io`, and `allowedOrigins: [SITE_ORIGIN]` (`https://streamotter.dev` in production; the dev origins from F.1 locally). Kafka over TLS with SCRAM, like production. Limits: `maxConnections` 8 (a few tabs plus the satellite) and `maxSubscriptionsPerConnection` 12. The E2.0 spike's `BENCH_LIMITS` used 16; E2.1 changes it to 8 to match this contract.
- **Caddy**, one route per bench: `/lab/N/socket.io/*` goes to `bench-N:7400`, only with `Origin` exactly the site's origin; a missing or different `Origin` gets 403 before the upgrade. Everything else under `/lab/` gets 404. The bench API (7420) and the management API have no route. Illustrative only; `devops` owns the Caddyfile:

  ```caddy
  @foreignOrigin not header Origin {$SITE_ORIGIN:https://streamotter.dev}

  handle /lab/1/socket.io/* {
  	respond @foreignOrigin 403
  	reverse_proxy {$BENCH_1_UPSTREAM:bench-1:7400}
  }
  # …the same for 2 and 3…
  handle /lab/* {
  	respond 404
  }
  ```

- **Bench tokens.** The bench mints them (`POST /bench/v1/tokens`) and is the only one that can verify them: opaque, at least 128 bits of randomness (for example `lab1_` and 32 random bytes in base64url), held in the bench's memory with the lease they belong to, and discarded at reset. The field station only relays them. A bench's `authenticate` returns a principal only when the token belongs to that bench's **current** lease and the lease hasn't ended; otherwise `null` (`UNAUTHENTICATED`). It never accepts badge tokens (it has no `FIELD_STATION_SECRET`), and the production gateway never accepts bench tokens.
- **Relay tokens.** Each bench has its own, `LAB_BENCH_N_RELAY_TOKEN`, held only by that bench's API (which calls the control API) and that bench's own `lab-N-kafka` proxy (which verifies the call) — no other bench, the field station, or any other process holds it, consistent with M9's per-bench isolation (section 10.5). The E2.0 spike used one token, `LAB_RELAY_TOKEN`, shared by every proxy; E2.1 and E2.3 replace it with this per-bench form.
- **The principal**: `subject` `lab-<leaseId>`, `sessionId` the lease ID, `tenantId` the study's tenant, `expiresAt` the lease's end, and `claims` `{ role: "volunteer", bench: N }`. StreamOtter closes a connection when its principal expires (`ClientSession`, `src/runtime/session.ts`), so a lease's connections end on time even if nothing else does. Each lease is a new subject, so nothing carries over between visitors.
- **Ending a lease on the socket.** Reset clears the current lease (new handshakes fail), then calls `gateway.revoke({ kind: "subject", … })`, which closes the old lease's connections with a non-retryable `UNAUTHENTICATED`. The SDK then reports connection `auth-required` and its views `stale` with `UNAUTHENTICATED`; the page closes its client and shows why the lease ended. At natural expiry the gateway closes the connection first; the SDK asks for a token, the page's `getToken` fails with 409 `no-lease`, and the client ends in the same state.
- **On the page**: a client for the bench, separate from any other on the page, whose `getToken` asks the field station for a bench token. The SDK asks again 30 seconds before `expiresAt` and after a relay restart; while the lease is current it gets a token for the same lease.

  ```ts
  const lab = await labToken(); // POST /api/lab/lease/token
  const client = createClient<LabChannels>({
    origin: lab.gatewayOrigin,
    path: lab.gatewayPath,
    getToken: async ({ signal }) => (await labToken(signal)).token // throws once the lease has ended
  });
  ```

  `LabChannels` are the bench project's generated types (E2.1 adds the bench project and its generation).

  The SDK reports `auth-required` after any `getToken` rejection and then waits for `reconnect()`. The page therefore treats a token failure with no HTTP answer (network failure, timeout), a 429, or a 5xx as transient and calls `reconnect()` after 1 s, doubling to 30 s, starting again from 1 s once connected. Any other answer, in particular 409 `no-lease` once the lease has ended, is final: the page polls its lease at once and shows why. An `auth-required` the gateway causes itself (a revoked lease) is final too. The home page and walkthrough recover from a failed `POST /api/badge` the same way (`apps/site/src/scripts/sign-in-retry.ts`). The page also starts at most one connect per lease at a time, so a slow token request isn't repeated by every poll.

## 8. The bench API

On each bench, port 7420, reachable only on the Compose network (no published port, no Caddy route). Every route except `/healthz` requires `Authorization: Bearer <that bench's service token>`, compared in constant time; 401 otherwise. Each bench has its own service token; the field station holds all three.

```ts
export interface BenchStatus {
  bench: BenchId;
  state: "starting" | "ready" | "leased" | "resetting" | "failed";
  lease: { leaseId: string; expiresAt: string } | null;
  scenario: LabBenchState;
  /** Self-checks the stack test reads (section 10.6). */
  checks: { developmentPrincipals: number; fixtureSources: number; managementHost: string };
  /** LC11-ADR-02's three readiness facts. */
  readiness: { control: boolean; source: boolean; cleanLease: boolean };
  /** The study the bench is running; null while starting and between discarding one study and provisioning the next. */
  study: {
    studyId: string;            // random, URL-safe, 16 characters
    generation: string;         // lab-N-<studyId>
    consumerGroup: string;      // streamotter-lab-N-<studyId>
    createdAt: string;
    phase: "provisioning" | "clean" | "open";
    restarts: { gateway: number; process: number };
  } | null;
  /** The bench's failure handling (section 8b); absent from an older bench, which runs as "off". */
  failures?: { profile: "off" | "retry" | "quarantine"; durable: boolean; handlerBuildId: string | null };
}
```

The study is private: the field station reads it, visitors never see it. `src/lab/contract.ts` is the source of these types, with `StudySummary` and the section 8a types.

**Study identity** (LC11-ADR-02). Every lease runs in a **study**: `studyId`, the source generation `lab-N-<studyId>`, the consumer group `streamotter-lab-N-<studyId>`, and a study directory on the bench's volume. The bench persists the descriptor as `study.json` (`$LAB_STATE_DIR/lab-N/study.json`; `LAB_STATE_DIR` defaults to `/var/lib/lontra` in production and `.data` elsewhere; Compose mounts a `lab-N-state` volume there). A study is `provisioning` until its new gateway has consumed once, `clean` until a lease is bound to it, then `open` until a reset discards it. The lease (never its tokens) and the calibration state are persisted with an open study. StreamOtter 0.1.0-rc.3 has no journal; the study directory (`lab-N/studies/<studyId>/`) is created and removed with the study so the native journal can be bound to it later (W9b).

**Restart keeps the study.** `gateway.restart`, a bench process restart, and a container restart with its volume intact resume the same study: same group, generation, directory, and field station ledger. `study.restarts` counts which kind actually ran, so a gateway restart in the same process is never reported as process durability (LC11-A14 versus A15). After a process restart, the lease continues if it hasn't expired; its old tokens are gone and the page fetches new ones. Its feed starts a new epoch with a `gap` item, and the page's old cursor is answered from there (section 6). The bench API listens before the bench boots, so as soon as it has read `study.json` back, a bench resuming an open study with an unexpired lease reports `leased` with that lease, `readiness.control` false until its gateway is up; the field station keeps the lease meanwhile (section 4). On boot, a study that is `provisioning`, unreadable, or `open` with its lease ended is discarded (the reset steps below) and a new one provisioned. Every study directory on the volume that isn't the current study (one a crash mid-reset left, or one an unreadable `study.json` no longer names) is discarded by its ID with the same steps: gate close, delete `streamotter-lab-N-<studyId>`, remove the directory, gate discard. A boot that fails leaves the bench `failed` for the field station to reset; the process doesn't exit, so a held source can't cause a restart loop.

**Deploy benches and the field station together.** Study identity changes both sides of the bench–field station interface, so they ship in one deployment, never one side first. A new bench with an old field station gets 401 from `POST /lab-internal/N/studies/<studyId>/close` (the old field station has no section 8a routes), so every reset fails and the bench stays `failed`. An old bench with a new field station reports no `readiness`, so it is never clean-lease eligible and never granted.

**Three readiness facts, not one.**

| Fact | Meaning | Used for |
| --- | --- | --- |
| `control` | The bench's gateway and its loopback management API are running and answering, and the bench is `ready` or `leased` | `GET /healthz`; explaining state to the leaseholder |
| `source` | The bench's source is `healthy` | The Lab's data-readiness display; never a reason to fail the bench or end the lease |
| `cleanLease` | `ready`, the study is `clean`, and the last cleanup completed | The only benches the field station grants |

A held or paused source after a same-study restart is control-available and not source-ready: the bench stays `leased` (LC11-A33). Only a new study's source must consume before the bench is `ready`, because a fresh group on a working broker always can.

| Route | Body | Does | Answers |
| --- | --- | --- | --- |
| `GET /healthz` | | For the Compose health check; no token | 200 when `readiness.control`, else 503; body `{ state, readiness }` |
| `GET /bench/v1/status` | | The bench's state | 200 `BenchStatus` |
| `PUT /bench/v1/lease` | `{ leaseId, expiresAt }` | Starts a lease: binds it to the clean study (now `open`) and persists it, sets the feed's starting cursor, adds `lease-started` | 200 `BenchStatus`; 409 unless `ready` and clean-lease eligible |
| `POST /bench/v1/tokens` | `{ leaseId }` | Mints a token for the current lease | 200 `{ token, expiresAt }`; 409 for any other lease |
| `POST /bench/v1/actions` | `{ leaseId, action }` | One scenario action | 200 `{ at, scenario: LabBenchState }`; 409 other lease or `not-applicable`; 429 within a second of the last |
| `GET /bench/v1/feed?leaseId=&after=&limit=` | | The lease's redacted feed; a cursor from before a process restart is answered from the restarted feed with `gap: true` (section 6) | 200 `LabFeedPage`; 400 malformed or never-issued cursor; 409 other lease |
| `POST /bench/v1/reset` | `{ leaseId: string \| null }` | Ends the lease (or whichever is current, for `null`) and discards the study | 202 `BenchStatus` (`resetting`) |

**Errors.** A request without the right service token gets 401 and an unknown route gets 404, each with `{ error }` only; the field station treats either as the bench failing. Every other error body is `{ error, code }` with a `LabErrorCode`. 400 `invalid-request` is for a malformed or oversized body or an invalid parameter; 409 carries `no-lease` (another lease, or none) or `not-applicable`; 429 `too-many-actions`. Anything else that goes wrong is the bench's own failure (its management API, its relay control, a gateway call): 500 `bench-unavailable`, never 400. The field station passes the bench's 400, 409, and 429 codes through to the visitor unchanged (so a bench's `no-lease` stays `no-lease`) and treats any other answer as the bench failing (section 4).

**Background polling.** About once a second the bench polls its gateway's sources and traces, or resets once the lease's time is up. At most one such tick waits in the bench's work queue, so a reset or gateway restart that holds the queue for 30 seconds doesn't stack polls ahead of the visitor's calls. A failed poll changes nothing by itself; the bench reports `failed` only once polls have failed for 15 seconds in a row.

**Reset is study discard** (LC11-ADR-02), in order, until the bench reports `ready`:

1. Invalidate: clear the current lease, so `authenticate` refuses its tokens from this moment, forget its tokens, and close the study's scope, so the old gateway's handlers, the satellite's socket, and any queued gateway restart write nothing more. Persist the study without its lease.
2. `gateway.revoke({ kind: "subject", tenantId, subject: "lab-<leaseId>" })`: its connections close with `UNAUTHENTICATED`.
3. Gate the publisher: `POST /lab-internal/N/studies/<studyId>/close` on the field station (section 8a). The reset doesn't continue unless the field station confirms.
4. Quiesce: stop the satellite client and wait, at most 5 seconds, for the study's pending work (the API's immediate revocation). Callbacks that arrive after step 1 are counted as late against the old study and dropped.
5. Write the old study's bounded summary to `lab-N/summaries/<studyId>.json` (`StudySummary`: identity, lease ID, restart counts, counts of actions, processed and failed LC-03 records, and late callbacks, last source status, whether quiescing finished; never payloads). The newest 20 are kept. A summary is written once: a retried reset, or a reboot that finishes a crashed one, keeps the first.
6. Restore the relay: the bench's Kafka admin client reaches the broker through its `lab-N-kafka` proxy (`BENCH_KAFKA_BROKERS`), so a lease that ended with the relay cut could not delete its group otherwise. Stop the gateway; delete the old consumer group with the bench's Kafka admin client (StreamOtter has no such operation; a group that doesn't exist counts as deleted); remove the old study directory; `POST /lab-internal/N/studies/<studyId>/discard` so the field station summarizes and removes the study's ledger.
7. Provision a new study (new ID, generation, group, and directory, `startFrom: "latest"`; the group is `streamotter-lab-N-<studyId>` on startup too, since the broker's ACLs let bench N's user read and delete only groups prefixed `streamotter-lab-N-`, section 10.9), restore the calibration table and the relay, start the gateway with StreamOtter's public API only, and wait for its source to report `healthy`. Clear the feed buffer; the study is `clean`; the bench reports `ready`.

Any failure leaves the bench `failed` and not clean-lease eligible; the field station retries the reset every 30 seconds, and every step is idempotent, so a retry finishes what a failed attempt began. Completed writes from the old study are recorded in its summary, never described as not having happened. The `lab-N.*` topics are reused across studies: the new group joins after the gate is shut, so no old-study scenario record can reach the new study.

**Bench environment.** Its own service token; its relay token (`LAB_BENCH_N_RELAY_TOKEN`, section 7); `SITE_ORIGIN`; `LAB_STATE_DIR` (its study volume); its Kafka credentials (preferably a SCRAM user of its own); its management token, generated at startup unless supplied, never logged. **Never** `FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`, another bench's token, or the production gateway's or field station's Kafka passwords (`KAFKA_GATEWAY_PASSWORD`, `KAFKA_FIELD_STATION_PASSWORD`). The bench's snapshots come from a restricted, per-bench source — for example, an endpoint serving only that bench's `lab-N` world views, never notebooks or holts, authenticated with bench N's own service token (not a broader one) — never the field station's internal API, which serves every notebook to anyone holding its service token. E2.1 (`be-lab`) builds it.

**Status.** The E2.0 spike (PR #17, `spike/lab-relay-cut`) proves the relay cut but does not yet meet M4 or M11 (section 10.5): its bench accepts the walkthrough's badge check in `authenticate` instead of lease-bound tokens, and its environment and snapshots come from the field station's production secrets and internal API (`FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`, `FIELD_STATION_INTERNAL_URL`). E2.1 must close both gaps before any bench faces the public. S11 (section 10.6) checks it at the stack level.

**Field station environment** (names are suggestions for `be-lab` and `devops`): `LAB_BENCH_API_URLS` (the three bench API origins; unset means `enabled: false`), `LAB_BENCH_1_SERVICE_TOKEN` to `LAB_BENCH_3_SERVICE_TOKEN` (32 characters or more, from `deploy/make-secrets.sh`), `LAB_LEASE_SECONDS` (1 to 300; the field station refuses to start with a larger value, since benches refuse longer leases), `LAB_QUEUE_MAX`. Separate from the E2.0 spike's `FIELD_LAB_BENCHES` (`deploy/compose.lab-spike.yaml`): the number of benches whose `lab-N.*` topic copies the field station publishes over its own Kafka connection, unrelated to the Lab API's lease traffic.

## 8a. The private study and recovery surface

LC11-ADR-01 and LC11-ADR-02, application side. On the field station's internal port (7410), under each bench's existing `/lab-internal/N/` prefix, authenticated with **bench N's own service token** only (the production service token and other benches' tokens get 401). Compose network only; never routed by Caddy. Types are in `src/lab/contract.ts`; the implementation is `src/lab/studies.ts` (registry, gate, served state) and `src/lab/coverage.ts` (ledger, guard, acknowledgment).

**Status: ready for binding, not bound.** StreamOtter 0.1.0-rc.3 has no recovery guard, barrier, journal, or quarantine. Nothing calls `recovery/assess` or passes `?boundary=` today, and nothing here emulates native behavior. W9b adds the thin adapter from the native guard and snapshot-acknowledgment types to these routes once a published release exports them; no name here is assumed to be a native API name.

| Route | Body | Does | Answers |
| --- | --- | --- | --- |
| `POST /lab-internal/N/studies/:studyId/close` | | Shuts the publisher gate for the study (reset step 3), waiting at most 5 s for its in-flight scenario publications. Idempotent; fine for a study never opened | 200 `StudyClosed` `{ studyId, state: "closed", inFlight }` |
| `POST /lab-internal/N/studies/:studyId/discard` | | Writes the ledger's bounded summary (`LedgerSummary`: run IDs, statuses, affected instances, whether published, counts; no payloads) to `<FIELD_DATA_DIR>/lab/lab-N/summaries/`, keeping 20, then removes the study's ledger directory. The summary is written once: a repeated discard answers the first summary and never replaces it (with an empty one once the ledger is gone). An unreadable ledger doesn't stop the discard | 200 `LedgerSummary`; 409 `study-closed` while the study is still open |
| `POST /lab-internal/N/recovery/assess` | `RecoveryAssessRequest` `{ studyId, sourceId: "field", record?: { topic, partition, offset } }` | The recovery guard, answered from the study's ledger | 200 `RecoveryAssessment`; 400 for any other field (record bytes are never accepted) or malformed coordinates; 409 `study-closed` unless `studyId` is bench N's open study |
| `GET /lab-internal/N/views/:channel/:id[?boundary=<barrier>]` | | Bench N's snapshot (section 8), from its served state; with `boundary`, the acknowledgment | 200 `BenchSnapshot` `{ revision, data, boundary? }`; 400 for a boundary over 96 characters |

**Publisher gate.** A bench's study is open for scenario publication from the moment the field station grants a lease on it until the lease pool (before every `POST /bench/v1/reset`) or the bench (reset step 3) closes it. A closed study never reopens. Scenario records go only to the bench's own copy of a creek topic (`lab-N.field.*`, `lab-N.creek.*`), one at a time with their coordinates recorded; the shared creek copies the field station publishes for `FIELD_LAB_BENCHES` are not scenario records and are not gated. A publication that completes after its study closed is recorded only in that study's ledger, and dropped once the ledger is discarded. Opening a bench's new study closes and discards any study still open for that bench through that study's own ledger, so its in-flight publications see it discarded and never recreate its directory.

**Coverage ledger.** One per bench study, persisted at `<FIELD_DATA_DIR>/lab/lab-N/studies/<studyId>/ledger.json`, separate from any library journal. It outlives a bench gateway, process, or container restart within the study, and is discarded with the study. Each scenario run records: scenario and run IDs; the predetermined domain mutation (for example an LC-03 reading at a stated tick); the potentially affected channel instances, derived by applying the mutation to a copy of the world and comparing every view the simulation derives (`allViews`), never from record bytes; the mutation's revision; the authoritative watermark (the served state's tick and each affected instance's revision) once coverage is established; the publication coordinates; and a status: `withheld` → (`scenario.prepare-coverage` releases the predetermined update) → `pending` → (the served state reaches the mutation for every affected instance) → `established`. Normally a run is written before it is published and is established at once; S03 starts `withheld`, shown as **Snapshot coverage not ready**. At most 32 runs and 64 obligations per study.

Derivation facts worth knowing: an LC-03 flow reading affects `station:LC-03` and `creekOverview:lontra`; a reading the overview doesn't show (temperature, stage) affects only `station:LC-03`. Slate Canyon has no camera trap, so there is no `reach` instance for LC-03's reach.

**Served state.** A bench snapshot of an instance is the shared creek's view or the open study's own authoritative write for it, whichever has the higher revision (full-state channels supersede by revision). Another bench never sees it.

**Guard.** The incident's record is matched to a ledger entry by its publication coordinates. The answer is `hold` (`coverage-withheld`, `coverage-pending`, `unknown-record`, or `no-coordinates`) unless that entry is `established` for every affected instance at or past the mutation's revision. A study that already holds 64 obligations answers a new incident `hold` with `obligation-limit` (with at most 32 runs, each published once, only a ledger file written elsewhere can get there). A `recoverable` answer records an obligation and returns `barrier` (opaque, at most 96 characters), the **cumulative** maximum over every obligation in the study so far, so a second incident never drops the first one's requirement; `covers`, the instances it spans; and `evidenceRef`, naming the ledger entries. Asking again about a recorded incident returns the current barrier, never an older one.

**Acknowledgment.** A snapshot acknowledges a barrier only when the barrier was issued by bench N's open study and the served state is at or past it: the state's tick at or past the barrier's, and for an instance the barrier covers, its revision at or past the barrier's. Otherwise `acknowledged: false` with `lagging`, `unknown-barrier`, `wrong-study`, or `malformed`. Without `?boundary=`, the snapshot carries no `boundary` at all. The bench side counts an acknowledgment only when `boundary.barrier` echoes exactly the barrier it required and `acknowledged` is true (`snapshotAcknowledges` in `src/lab/bench.ts`).

**Integrators.** The reference page must say plainly that an integrator's guard is only as true as their own ledger: this one answers for a demo whose every mutation is predetermined.

## 8b. The private intent surface

V1.1 W9b. On each bench's API (port 7420, section 8), with the same service token, Compose network only. The field station is the only caller; it reaches these routes only for the session's own lease, after the checks in section 12.5. Native identifiers (the library's failure IDs) cross this surface server to server; the field station never forwards them to a browser (section 12.7).

| Route | Body | Does | Answers |
| --- | --- | --- | --- |
| `POST /bench/v1/intents` | `BenchIntentRequest` | Records the intent for the current lease and carries it out in the background: `scenario.start` arms the bench's handlers (section 12.5), `scenario.restore-calibration` restores LC-03's calibration and disarms a blip, and `incident.*` call the running gateway's in-process operator API (`getGatewayOperator` from `streamotter/gateway/operator`). A repeated `operationId` within the lease answers the recorded operation | 202 `BenchOperation`; 400 malformed; 409 `no-lease` for another lease, `not-applicable` when it can't apply (no failure handling, nothing to restore, a stale incident) |
| `GET /bench/v1/operations/:operationId?leaseId=` | | The recorded operation | 200 `BenchOperation`; 404 unknown; 409 `no-lease` |
| `GET /bench/v1/incident?leaseId=` | | The facts the field station composes the incident projection from | 200 `BenchIncidentFacts`; 409 `no-lease` |

Operations and plan tokens live in the bench's memory, scoped to the study: a reset (section 8, step 1) cancels unfinished operations and forgets every token. The bench runs no operator socket and no health listener: the gateway's `operatorSocket` and `health` options stay unset (ADR-03, in-process only).

```ts
/**
 * `LAB_FAILURE_HANDLING`, set alike on the field station and every bench. `off`: no failure
 * handling (V1 pause only). `retry`: bounded transient-mapper retries, every class pauses.
 * `quarantine`: quarantine-hold and quarantine-resync with the recovery guard; needs the
 * bench's quarantine topic and its Kafka grants (section 10.9), so only where authorization is on.
 */
export type BenchFailureProfile = "off" | "retry" | "quarantine";

/** The intents a bench carries out. `scenario.prepare-coverage` is the field station's alone (section 8a). */
export type BenchIntent = Exclude<LabIntent, "scenario.prepare-coverage">;

/** `POST /bench/v1/intents`: 202 `BenchOperation`. */
export interface BenchIntentRequest {
  leaseId: string;
  /** The field station's `LabOperation.operationId`, which is also the bench's idempotency key within the lease. */
  operationId: string;
  intent: BenchIntent;
  /** `scenario.start` only: what the bench arms for it (calibration removed, a calibration blip, or the corrected projection and a same-study restart). Records are published by the field station. */
  scenario?: LabScenarioId;
  /** `incident.*` only: the incident and revision the visitor's `expectedRevision` named, as the bench reported them in `BenchIncidentFacts`. */
  incident?: { failureId: string; revision: number };
  /** `incident.approve-reprocess` only. */
  planToken?: string;
}

/** The bench's record of one intent: the 202 answer and `GET /bench/v1/operations/:operationId?leaseId=`. */
export interface BenchOperation {
  operationId: string;
  intent: BenchIntent;
  status: LabOperation["status"];
  /**
   * The library's outcome word (`OperationResult.outcome`, for example `retried`, `held`,
   * `advanced`, `stale-revision`, `circuit-open`, `superseded`), `evaluated` for an
   * evaluation, or the bench's own (`armed`, `restored`, `not-applicable`, `plan-unknown`,
   * `unexpected-error`). Never the library's message.
   */
  outcome: string | null;
  /** The incident revision the outcome produced, as the library reported it. */
  incidentRevision: number | null;
  acceptedAt: string;
  updatedAt: string;
}

/** One incident as the installed library reports it, trimmed to what the projection needs. Event details are dropped: they may name native IDs. */
export interface BenchIncident {
  /** `f1:…`. Private: stays between the bench and the field station. */
  failureId: string;
  revision: number;
  /** 1-based, in order of first observation within the study. */
  ordinal: number;
  failureClass: FailureClass;
  stage: IncidentSummary["stage"];
  errorCode: ErrorCode;
  policy: FailurePolicy;
  state: IncidentSummary["state"];
  progress: IncidentProgress;
  recovery: IncidentRecovery;
  quarantine: IncidentQuarantine;
  nextAction: IncidentNextAction;
  evidence: { location: IncidentSummary["evidence"]["location"]; completeness: IncidentSummary["evidence"]["completeness"]; hash: string };
  /** The bench's own synthetic coordinates; null for a non-Kafka position. */
  position: RecordCoordinates | null;
  generation: string;
  handlerBuildId: string;
  firstObservedAt: string;
  lastObservedAt: string;
  guard: { decision: "hold" | "recoverable" | "error" | "timeout"; reason: string | null } | null;
  boundary: "in-force" | "superseded" | "retired" | null;
  /** Newest last, at most 50 (the library's bound). */
  history: { at: string; event: IncidentEventName }[];
}

/** `GET /bench/v1/incident?leaseId=`: what the field station composes `LabIncidentSummary` from. */
export interface BenchIncidentFacts {
  profile: BenchFailureProfile;
  studyId: string;
  /** Application state the bench's handlers read. `blips`: S06 starts in this study. */
  app: { calibration: "present" | "removed"; mapping: "broken" | "corrected"; blips: number };
  /** The source's held incident, else the study's newest by first observation; null with no operator service (`off`) or no incident. */
  incident: BenchIncident | null;
  /** The source's automatic-continuation circuit; null without failure handling. */
  circuit: { state: "closed" | "open"; recentIncidents: number; limit: number } | null;
  /** The latest evaluation of `incident`, held by the bench. */
  evaluation: {
    at: string;
    incidentRevision: number;
    validation: "valid" | "invalid";
    eligible: boolean;
    ineligibleReason: string | null;
    /** The first error's failure class when invalid. */
    errorClass: FailureClass | null;
    outputs: number;
    expiresAt: string | null;
    /** The bench's single-use token for the plan, while it may still be approved. */
    planToken: string | null;
  } | null;
  /** The latest redrive of `incident`: the library's result and outcome. */
  reprocess: { at: string; result: "completed" | "refused" | "failed" | "unknown"; outcome: string } | null;
  /** When the bench first saw the leaseholder's snapshot succeed after `incident` advanced; null otherwise. */
  resynchronizedAt: string | null;
  /** Application actions the bench took in this study, newest last, bounded. */
  steps: { at: string; text: string }[];
}
```

## 9. What the relay cut must do

E2.0's spike proves the mechanism in section 1: a `lab-N-kafka` proxy per bench. Whatever refinements follow, the contract requires:

- `relay.cut` makes the bench's source `stale` for visitors within **20 seconds**, and `relay.restore` brings it back to `live` within **30 seconds**, measured in CI on amd64 and arm64 and recorded with where they were measured.
- It cuts only that bench's path to Kafka: other benches, the production gateway, and the field station are unaffected.
- The bench API, the bench's feed of creek data, and its snapshots never travel over the path that gets cut.
- The bench API is its only control, calling that bench's own proxy with that bench's own relay token (section 7); visitors reach it only through `POST /api/lab/actions`.
- Reset always restores it, and a restored relay needs no gateway restart.

## 10. Threat model

The question for the owner (TEAM_PLAN.md section 8): may development-mode StreamOtter gateways, the benches, face the public internet? Every claim below about StreamOtter comes from the published source of `0.1.0-rc.3` in `node_modules`, chiefly `@streamotter/gateway` `src/runtime/gateway.ts`, `src/runtime/session.ts`, `src/transport/socketio.ts`, `src/management/index.ts`, and `@streamotter/cli` `src/cli.ts`.

### 10.1 Scope

- **Exposed**: three bench gateways' Socket.IO endpoints through Caddy at `/lab/N/socket.io/`, and the Lab routes of the field station's `/api`.
- **Assets**: the production gateway and field station (their availability and secrets: `FIELD_STATION_SECRET`, the service token, SCRAM passwords); visitors' sessions and notebooks; the other benches; the host's memory and CPU.
- **Attackers**: anyone on the internet, including non-browser clients that set any header (an `Origin` check stops browsers, not scripts); a visitor who holds a lease and wants more (another bench, a longer lease, the management API, others' data); a web page on another site that a leaseholder visits.

### 10.2 What development mode changes

Everything the gateway does differently in development mode, found by reading every `mode` and `development` branch in the published source:

| # | Difference | Where | Reachable from the bench's public endpoint? |
| --- | --- | --- | --- |
| D1 | Construction skips the production checks, so fixture sources, plaintext Kafka, and a `development` option (principals and fixtures) are accepted. | `validateProduction`, `validateDevelopment` | No, but they decide what D3 can do. |
| D2 | A handshake with no `Origin` is accepted; production answers `FORBIDDEN`. A present `Origin` must be allowed in both modes. | `authenticateHandshake` | Yes, for clients that send no `Origin`. |
| D3 | A preview token (`sop_` and 32 random bytes) minted by the management API for a registered development principal is accepted on the **Socket.IO endpoint**, looked up before, and instead of, the application's `authenticate`. It lives 5 minutes or until the principal expires. | `authenticateHandshake`, `createPreviewSession` | Yes, if anyone can mint one. |
| D4 | The management API may run. It refuses production gateways, requires a per-run bearer token, grants no CORS, and refuses requests whose `Origin` isn't its own. It binds to `127.0.0.1` **by default, but accepts any `host`**. Its routes: capabilities, health, sources, channels, config, traces, development principals, source checks, config validation and export, source resume, preview sessions, fixture advance, disconnecting a preview session, and the workbench's static files. On start it adds its own origin (`http://127.0.0.1:<port>`) to the gateway's allowed origins. | `startManagementServer`, `allowDevelopmentOrigin` | Only if its port is reachable. |
| D5 | `streamotter dev` loads the handler module's `development` export (principals and fixtures) automatically, starts the management API on loopback with no option to change the host, prints its token to standard output (so it lands in container logs), and serves the workbench. | `@streamotter/cli` `commandDev`, `loadHandlers` | No. |

**The same in both modes** (no `mode` check anywhere in the session, subscription, source, or transport code): the Socket.IO surface is `so:subscribe`, `so:unsubscribe`, `so:resync`, and `so:receipt`, and anything else gets `UNSUPPORTED_CAPABILITY`; WebSocket only; every other HTTP request to the gateway's port gets 404; limits and their enforcement; schema validation; `authorize` per subscription; receipts and their timeout; revocation; principal expiry; and the trace buffer, which exists in production too but can be read only through the management API (or the unstable `@streamotter/gateway/internals`, which the Lab won't use).

### 10.3 The four checks

1. **Development principals and fixtures.** Principals are validated at construction, listed by the management API, and used only to mint preview tokens (D3). Fixtures feed fixture sources only and are advanced only through the management API. A Kafka-sourced bench with no registered principals has no use for either. The field station's own `fixture-handlers.ts` exports two principals, one of them a researcher (Holt A access) that expires in 2099; `streamotter dev` would register them if a bench loaded that module. Benches must not.
2. **Development paths on the Socket.IO endpoint.** Exactly two: the missing-`Origin` allowance (D2) and preview tokens (D3). No management operation is reachable over Socket.IO. D3 is the serious one: a preview token bypasses `authenticate`, so lease-bound tokens alone don't stop it; only registering no principals, and keeping the management API unreachable, do.
3. **Origin checks.** Confirmed: production requires an `Origin`; development accepts none, though a present one must be allowed, and the management API adds its loopback origin to the allowed set. For browsers this changes nothing, since they always send `Origin` on a WebSocket; for scripts it changes nothing either, since they can send any `Origin`. The token is the real boundary. Caddy's per-bench `Origin` rule restores production's behavior at the edge anyway, so nothing depends on D2.
4. **The management API's loopback binding** is a default, not enforced: `startManagementServer({ host })` accepts any address, and only the CLI pins it to loopback. Inside a container, loopback is that container's own network namespace, so a management API on `127.0.0.1` can't be reached from Caddy, the field station, or another bench.

### 10.4 Threats and mitigations

| Threat | Mitigations | Proof |
| --- | --- | --- |
| **T1 A visitor reaches another bench** (its Socket.IO endpoint or its scenario actions) | M4 bench-scoped tokens (a bench recognizes only tokens it minted for its current lease); M5 requests never name a bench; M9 per-bench service tokens | S1, S10 |
| **T2 An expired or returned lease is reused** | M4 current-lease check in `authenticate`; M6 principal expiry equals lease end; M7 reset revokes the lease's connections | S2 |
| **T3 A visitor becomes a development principal** | M1 no development principals, no fixture sources; M2 management API on the bench's loopback only; M3 no management routes in Caddy | S3, S4, U1, U2 |
| **T4 A visitor reaches management routes** | M2, M3; the management token never leaves the bench | S4 |
| **T5 Another site's page drives a leaseholder's bench** | The bench token is in the page's memory, not a cookie; M8 Caddy's `Origin` rule; `SameSite=Strict` session cookie and the `Origin` check on `POST /api/lab/*` | S5 |
| **T6 The feed leaks others' data or secrets** | M10 redaction (section 6); benches serve no `holt` or `notebook` channels; StreamOtter traces hold no payloads or credentials | S6 |
| **T7 A compromised bench reaches production** | M11 benches hold no production secrets and don't use the field station's internal API; own SCRAM user; M13 Kafka ACLs confine that user to its own topics and groups | U3, S11, S12, review |
| **T10 A compromised bench writes Kafka evidence it shouldn't** (V1.1's quarantine writer: forged records in another bench's quarantine, its own source topics, or the shared creek) | M13: bench N may write only `lab-N.quarantine`, which the broker's bootstrap creates small and short-lived; no topic creation, no writes to its own sources | S12 |
| **T8 Denial of service** (queue flooding, action spam, handshake floods) | Places per address and queue cap; the Lab budget; one action a second per lease and per bench; small `maxConnections` per bench; Cloudflare in front | S7, S9 |
| **T9 A leaseholder shares their bench token** | Harmless within the lease: it grants the same bench until the lease ends, capped by `maxConnections` | None needed |

### 10.5 Required mitigations

| # | Mitigation | Owner |
| --- | --- | --- |
| M1 | Benches register **no development principals** (`development` omitted, or `principals: {}`) and **no fixture sources**. A bench refuses to start otherwise, checking its own management API (`GET /management/v1/dev/principals` returns no items). Never reuse `fixture-handlers.ts`'s `development` export. | `be-lab` |
| M2 | The management API binds `127.0.0.1` explicitly, inside the bench's container, with `workbenchDir: null` and a token that is never logged or returned by any API. | `be-lab` |
| M3 | Caddy routes only `/lab/N/socket.io/*` to bench N's port 7400; all else under `/lab/` is 404. No route to ports 7401 or 7420. | `devops` |
| M4 | Bench `authenticate` accepts only a token that bench minted for its current lease; `null` otherwise, including between leases. Badge tokens are never accepted (the bench has no badge secret). | `be-lab` |
| M5 | `/api/lab/*` takes the bench, lease, and feed from the session, never from the request. | `be-lab` |
| M6 | A bench principal's `expiresAt` is the lease's end. | `be-lab` |
| M7 | Every lease end runs the reset: clear the lease, then revoke its subject. | `be-lab` |
| M8 | Caddy answers 403 to `/lab/N/socket.io/*` unless `Origin` is exactly the site's origin; the bench's `allowedOrigins` is the site's origin too. | `devops` |
| M9 | One service token per bench API and one relay token (`LAB_BENCH_N_RELAY_TOKEN`) per bench proxy, held only by that bench's own pair; the bench API and the proxy's control API are on the Compose network only. | `be-lab`, `devops` |
| M10 | The feed's redaction rules (section 6), applied by the bench. | `be-lab` |
| M11 | Bench environments hold no production secrets (section 8); bench snapshots don't come from the field station's internal API; each bench has its own Kafka user. | `be-lab`, `devops` |
| M12 | Bench configs pass production validation: constructing the bench gateway with `mode: "production"` and no `development` option succeeds (no fixtures, no plaintext Kafka). | `be-lab` |
| M13 | The broker runs KRaft's `StandardAuthorizer` with `allow.everyone.if.no.acl.found=false`, and each application user has only the ACLs in section 10.9 (`deploy/kafka/start.sh`, `KAFKA_AUTHORIZATION=acl`). Local and CI stacks only until the hosted migration is approved (section 10.7, R2). | `devops` |

### 10.6 Tests that prove them

Stack tests (E2.4, containers in CI, through Caddy like `deploy/test/stack.test.ts`; checks inside the Compose network run through a shell hook such as the existing `STACK_RESTART_*` commands):

| # | Test | Proves |
| --- | --- | --- |
| S1 | **Another bench.** With a lease on bench A, connect to every other bench with bench A's token: connect error `UNAUTHENTICATED`, no data. The same token on `/streamotter/` (production) and a walkthrough badge on bench A: `UNAUTHENTICATED`. | T1, M4 |
| S2 | **An expired lease.** Return a lease: its open connection closes with `UNAUTHENTICATED` and reconnecting with the same token fails. Let a lease run out (the test shortens `LAB_LEASE_SECONDS`): the gateway closes the connection at `expiresAt`, and the token is refused afterwards, including once the bench has a new lease. | T2, M4, M6, M7 |
| S3 | **Development principals.** Each bench's `checks` report `developmentPrincipals: 0` and `fixtureSources: 0`; a `sop_` token of the right shape is refused with `UNAUTHENTICATED` on every bench. | T3, M1 |
| S4 | **Management routes.** Through Caddy, `/lab/N/management/v1/health`, `/lab/N/`, `/lab/N/bench/v1/status`, and `/lab/` answer 404. From the field station's container, `bench-N:7401` refuses the connection, and each bench's `checks.managementHost` is `127.0.0.1`. | T4, M2, M3 |
| S5 | **Origin.** A WebSocket to `/lab/N/socket.io/` with a foreign `Origin`, or none, gets 403 from Caddy. | T5, M8 |
| S6 | **Feed redaction.** No item has fields beyond `LabFeedItem`; no item contains the bench token or `sop_`; no `authorize` item lacks `subscriber`; a second lease on the same bench sees nothing from the first. | T6, M10 |
| S7 | **Busy state and queue.** Four visitors: three leases and one queued at position 1; one returns, and the queued visitor becomes `ready`. A third place from one client address gets `too-many-places`. | Leases, T8 |
| S8 | **Each scenario's observable outcome**, as in section 5, with the relay cut's timings measured. | Section 5 |
| S9 | **Action rate.** Two actions within a second: the second gets 429 `too-many-actions`. | T8 |
| S10 | **Cross-session.** Visitor B's return, token, action, and feed requests don't touch A's lease (409 `no-lease` or B's own view). | T1, M5 |
| S11 | **No production secrets on a bench.** From `docker compose exec` on a running bench container, its environment contains none of `FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`, `KAFKA_GATEWAY_PASSWORD`, or `KAFKA_FIELD_STATION_PASSWORD`. | T7, M11 |
| S12 | **Kafka authorization** (`deploy/test/kafka-acls.test.ts`, probes in `deploy/test/kafka-acl-probes.mjs`). The broker's ACL listing equals section 10.9's table exactly, and the quarantine topics exist with their bounds. From each bench's own container, with its own user: it lists only `lab-N.*` topics, reads its sources and its quarantine topic in `streamotter-lab-N-` groups and deletes those groups, and writes its quarantine topic (plain and idempotent producers); it is refused (`TOPIC_`/`GROUP_`/`CLUSTER_AUTHORIZATION_FAILED`) reading, writing, or describing `field.*`, `creek.overview`, `field.holts`, and `field.notebooks`, reading or writing another bench's sources or quarantine topic, writing its own sources, joining another bench's or the production gateway's group, deleting another bench's or the production group, creating a topic, and deleting its quarantine topic. From the gateway's and field station's containers, each is refused everything outside its row. The production gateway and field station keep working end to end with the authorizer on (S1–S11 and `deploy/test/stack.test.ts` with `KAFKA_AUTHORIZATION=acl`). | T7, T10, M13 |

Unit tests (`npm test`): **U1** the bench's gateway options register no principals and no fixture sources; **U2** the bench refuses to start when its management API lists a principal; **U3** the bench's configuration refuses production secrets in its environment; **U4** the bench config passes production validation (M12); plus the lease state machine with a fake clock (claim, idle, expiry, session cap, reset, field station restart).

### 10.7 Residual risks

- **R1 The gateway's own attack surface.** A bug in the gateway, Socket.IO, or the handlers that an anonymous or leaseholding client can trigger is as serious on a bench as on the production gateway. Benches add three more instances of the same code; development mode adds no reachable code path beyond D2 and D3.
- **R2 Kafka authorization. Closed for local and CI stacks; open on the hosted broker** until its owner approves the migration (LC11-ADR-03). Without an authorizer any SCRAM user can read and write every topic: a compromised bench, like a compromised production gateway, could read `field.notebooks` or write into `field.*` and pause the production source. With `KAFKA_AUTHORIZATION=acl`, `deploy/kafka/start.sh` enables KRaft's `StandardAuthorizer`, denies whatever no ACL allows, and grants each user only its row in section 10.9 (M13). Evidence: S12 in the CI `Stack` workflow (gateway and field station) and the `Lab spike` workflow's three-bench stack (every bench), and the October 3, 2026 local runs recorded in section 10.9. The hosted broker keeps `KAFKA_AUTHORIZATION` at its default, `none`, so R2 stays open there, and hosted quarantine exercises stay unavailable, until the one-time migration in `deploy/OPERATIONS.md` (Kafka authorization) is approved and run with its verification.
- **R3 Denial of service.** Stock Caddy has no rate limiter, so floods of WebSocket handshakes reach the benches (each rejected cheaply) as they reach the production gateway today. Queue abuse from many addresses can still fill the line. Cloudflare's free plan is the outer layer.
- **R4 A release upgrade can change any of this.** D2–D5 are implementation details of `0.1.0-rc.3`. R.1 (release upgrade) must redo section 10.2 against the new published source and rerun S1–S6.

### 10.8 Verdict

Yes, development-mode benches can face the public with these mitigations. In `0.1.0-rc.3`, development mode reaches the public Socket.IO endpoint in exactly two ways: a handshake without `Origin` is accepted, and a preview token for a development principal bypasses `authenticate`. The first is harmless, because the token is the boundary and Caddy restores production's `Origin` rule anyway. The second is closed completely by registering no development principals (M1), with the management API, the only minter, confined to each bench container's loopback and never proxied (M2, M3). Everything else a visitor can reach is the same code production runs. Lease-bound, bench-minted tokens whose principals expire with the lease (M4–M7) keep visitors on their own bench for their own five minutes, and S1–S6 prove it in CI on every stack change. What remains (R1–R3) is the exposure the production gateway already has; R2 is closed for both in local and CI stacks (M13, S12) and waits for the hosted migration's approval. The one standing obligation is R4: re-verify this analysis whenever the pinned release changes.

### 10.9 Kafka authorization (M13)

LC11-ADR-03 decides least privilege per Kafka user; this section is the authoritative table, derived from the code that uses each name. `deploy/kafka/start.sh` grants it and `deploy/test/kafka-acls.test.ts` (S12) requires the broker's ACL listing to equal it.

**Topics and groups in use**

| Name | Kind | Written by | Read by | Source in code |
| --- | --- | --- | --- | --- |
| `field.gauges`, `field.telemetry`, `field.cameras`, `field.holts`, `creek.overview` | topics, 6 h retention | field station | production gateway (`field` source) | `TOPICS` in `packages/creek-sim/src/views.ts`; created by `apps/field-station/src/server/kafka.ts` |
| `field.notebooks` | topic, compact+delete | field station | production gateway (`notebooks` source); field station on start (rebuild) | `NOTEBOOK_TOPIC` in `apps/field-station/src/records.ts`; `readAll` in `server/kafka.ts` |
| `lab-N.field.gauges`, `lab-N.field.telemetry`, `lab-N.field.cameras`, `lab-N.creek.overview` (no holts) | topics, 1 h retention, one set per bench up to `FIELD_LAB_BENCHES` | field station (copies of the creek) | bench N's gateway | `CREEK_TOPICS` and `bench()` in `apps/field-station/src/lab/benches.ts`; `withBenchCopies` in `server/kafka.ts` |
| `lab-N.quarantine` | topic, created by the broker's bootstrap: 1 partition, `retention.ms` 3600000, `retention.bytes` 8388608, 1 MiB/10 min segments | bench N (V1.1's quarantine writer, W9b) | bench N | `deploy/kafka/start.sh` |
| `streamotter-lontra-creek-field`, `streamotter-lontra-creek-notebooks` | consumer groups | | production gateway | `apps/field-station/src/project.ts` |
| `lontra-field-station-read-<UUID>` | throwaway group, deleted after use | | field station | `readAll` in `server/kafka.ts` |
| `streamotter-lab-N-<studyId>` (and the static default `streamotter-lab-N-field`) | one group per study, kept across restarts, deleted when a reset discards the study (section 8) | | bench N | `consumerGroupPrefix` in `lab/benches.ts`; `consumerGroupFor` in `lab/study.ts` |

**Grants** (all `ALLOW`, host `*`; nothing else is allowed to an application user)

| User | Pattern | Resources | Operations |
| --- | --- | --- | --- |
| `gateway` | prefixed | topics `field.`, `creek.`; group `streamotter-lontra-creek-` | Read, Describe |
| `field-station` | prefixed | topics `field.`, `creek.`, and for each bench whose user the broker has, `lab-N.field.` and `lab-N.creek.` | Create, Write, Describe |
| `field-station` | literal | topic `field.notebooks` | Read |
| `field-station` | prefixed | group `lontra-field-station-read-` | Read, Delete |
| `lab-N` | prefixed | topic `lab-N.` (its sources and its quarantine topic) | Read, Describe |
| `lab-N` | literal | topic `lab-N.quarantine` | Write |
| `lab-N` | prefixed | group `streamotter-lab-N-` | Read, Delete |

- **Super user:** `User:ANONYMOUS` only, the principal of the broker's plaintext `INTERNAL` (127.0.0.1:9092) and `CONTROLLER` listeners, which bind to the Kafka container's own loopback: inter-broker traffic, the health check, and admin tools run there. The SASL_SSL listeners never yield it, and `start.sh` refuses a SCRAM user named `ANONYMOUS`.
- **Not granted to anyone:** cluster operations (`Create` on the cluster, `Alter`, `AlterConfigs`, `DescribeConfigs`), topic `Delete`, `Alter`, and `AlterConfigs`, transactional IDs, and any `Deny` entry. The idempotent producers (the field station's, and a bench's quarantine writer) need only `Write` on a topic (KIP-679).
- **Consequences:** a bench sees only `lab-N.*` in metadata, cannot write its own source topics, cannot create topics, and cannot touch the production groups. The field station writes the creek but cannot read it (only `field.notebooks`), and cannot write any quarantine topic. The gateway cannot write anything.
- **Bootstrap:** on every start with `KAFKA_AUTHORIZATION=acl` or `migrate`, once the broker answers, `start.sh` lists the ACLs and topics, adds whatever grant or quarantine topic is missing (it never removes an ACL or changes an existing topic's settings), and then writes the ready file the Compose health check waits for. A failed bootstrap is retried, then stops the broker. Benches are those with `KAFKA_LAB_N_USERNAME` set (N = 1–3); the older shared `KAFKA_LAB_USERNAME` user is created but granted nothing, so the CI-only spike overlay now uses `lab-1`.
- **Modes:** `acl` (enforced), `migrate` (the same grants with `allow.everyone.if.no.acl.found=true`: only the first step of migrating an existing broker), `none` (no authorizer). Kafka applies `allow.everyone.if.no.acl.found` per resource, so `migrate` enforces exactly as `acl` on every topic and group that has any grant, and leaves open, without logging above DEBUG, only resources nobody is granted: the cluster (and with it creating and deleting any topic) and names outside every granted prefix. `deploy/compose.yaml` defaults to `none` so the hosted broker is unchanged; CI workflows and `deploy/compose.local-lab.yaml` set `acl`.

**Evidence, October 3, 2026** (local Docker, linux/amd64, `apache/kafka:4.1.2`, the image from `deploy/Dockerfile`; CI runs the same tests on amd64 and arm64 on every stack change):

- The `Stack` workflow's steps with `KAFKA_AUTHORIZATION=acl`: `deploy/test/stack.test.ts` 10/10, including both restarts and a notebook through Kafka; no authorizer denial during that traffic; S12 for the gateway (22 probes) and field station (15) passed.
- The `Lab spike` workflow's steps with `acl`: `deploy/test/lab-spike.test.ts` 4/4 (relay cuts, bench user `lab-1`); the three-bench stack's `lab-private-checks.mjs` (benches 1–3 and the field station's leases, FIFO promotion, and resets, which delete bench groups) and `deploy/test/lab.test.ts` 7/7; no authorizer denial during that traffic; S12 for the gateway (22), field station (21), and each bench (45) passed, and the ACL listing equaled this table.
- A standalone broker on one volume moved `none` → `migrate` → `acl` → `none`, as `deploy/OPERATIONS.md` describes: under `none` bench 1 failed 42 of its 45 probes (no confinement); under `acl` every principal passed; `migrate` enforced the grants on granted topics and groups but let creating and deleting topics through, because Kafka allows both to a user with `Create` or `Delete` on the cluster, which has no ACL; the return to `none` removed enforcement and kept the stored ACLs. A new volume's bootstrap took about 4 minutes at the shared host's 0.35 CPU (56 s on a restart, which adds nothing).
- Not run here: the `Shared host adapter` rehearsal (it needs a disposable systemd-cgroup CI host).

**Corrections to LC11-ADR-03's sketch** (the ADR's own table should be amended to match):

1. The creek is not all under `field.`: the overview is `creek.overview`, so the gateway and field station also need the `creek.` prefix, and bench copies include `lab-N.creek.overview`.
2. The production gateway consumes `field.notebooks` (its `notebooks` source) and `field.holts`; nothing is excluded. Its groups are `streamotter-lontra-creek-field` and `-notebooks`; StreamOtter 0.1.0-rc.3 uses `consumerGroup` verbatim.
3. Bench groups use the ADR's `streamotter-lab-N-` prefix, which the code did not: groups were `lab-<UUID>` (first start, no bench number), then `lab-N-<UUID>`, and the static default `lontra-creek-lab-N-field`. `Bench.consumerGroupPrefix` in `lab/benches.ts` now names the prefix, and every bench group is built from it (W5's per-study groups, `streamotter-lab-N-<studyId>`, fit it).
4. The field station reads only `field.notebooks` (not "what its consumers read" in general) and needs `Create`, since it creates its topics; its read groups are `lontra-field-station-read-`.
5. The field station's `lab-` write is narrowed to each bench's `lab-N.field.` and `lab-N.creek.` copies, so it cannot write quarantine evidence either.
6. Bench `Describe` on groups is implied by `Read`/`Delete`; benches get no topic `Describe` beyond their own prefix.

## 11. Open points

- **E2.0** is settled by the relay-cut spike (PR #17, `spike/lab-relay-cut`): `createGateway` (section 1), the relay mechanism (a `lab-N-kafka` proxy and control API per bench, sections 1 and 9), and `FIELD_LAB_BENCHES` feeding each bench's topic copies (section 8). The spike's bench still used the field station's internal API for snapshots, a shared relay token, and the walkthrough's badge check for `authenticate`; E2.1 (and E2.3 for the relay token) replace all three (M4, M9, M11 — see the Status note in section 8).
- **E2.1** adds the bench project (its channels, `LabChannels` types for the site), the calibration table, lease-bound tokens, the per-bench snapshot source, and the per-bench relay token; generated files for the site follow the section 7 ownership of that sprint.
- **L.2** decides how the Lab runs locally; until then, with `npm run dev`, `/api/lab/status` answers 404, which the page treats as unavailable.
- **The owner** decides section 10.8.
- **V1.1 study identity (October 3, 2026)** adds study identity and discard (section 8) and the private study and recovery surface (section 8a). Benches and the field station must be deployed together (section 8).
- **V1.1 W1 (October 3, 2026)** applied the October 2 review's Lab findings ([CODE_REVIEW_2026-10-02.md](../reviews/CODE_REVIEW_2026-10-02.md) S1, L1–L8) and the site evaluation's Lab items 2–4. Observable changes: bench-side failures answer 500 `bench-unavailable` instead of 400 and end the lease (sections 4, 8); a bench's `no-lease` reaches the visitor as `no-lease`, not `not-applicable` (section 8); a failed action doesn't spend the one-a-second budget (section 5); `LAB_LEASE_SECONDS` above 300 is refused at startup (sections 2, 8); `/api` error answers carry CORS (section 3); the page retries transient token failures (section 7) and shows a scenario view of the feed with `processed` records labeled "mapper returned" (section 6). No route, payload type, or error code was added or removed.
- **V1.1 W4 (October 3, 2026)** added the Source failures track (section 12): `GET /api/lab/capabilities`, the `unsupported-scenario` error code, and the then-proposed intent, incident, and operation interfaces. Existing routes, actions, and payloads are unchanged.
- **V1.1 W9b (October 4, 2026)** serves section 12 against StreamOtter 0.2.0-rc.1: intents answer 202 `LabOperation`, `GET /api/lab/operations/<operationId>` and `GET /api/lab/incident` are served while the capability summary offers them, the private intent surface (section 8b) joins the bench API, and `deployment-restricted`, evidence `not-required`, source `processed`, and `evaluation.planToken` and `summary` are added. Nothing is offered until a scenario's real-Kafka test passes (section 12.3).
- **V1.1 W9b amendment (October 4, 2026)**, from the bench's real-library tests: an evaluation the library refuses at the request stage is `refused`, not `succeeded`; a garbled record's evaluation is `still-fails`; `calibration-blip`'s later starts fail every lookup until calibration is restored; `BenchIncidentFacts.incident` falls back to the newest incident by first observation.

## 12. The Source failures track (V1.1)

October 3, 2026 · V1.1 slice W4; served against StreamOtter 0.2.0-rc.1 by W9b, October 4, 2026 · Authority: the [companion plan](../releases/v1.1/LONTRA_CREEK_V1_1_COMPANION_PLAN.md) sections 3, 4, 6, 7, and 9, and acceptance LC11-A01, A04, A36, and A37.

`/lab/` has a second track, **Source failures**, beside the existing scenarios, which form the **Connections and clients** track. This section fixes what the field station serves for it.

**Status.** StreamOtter 0.2.0-rc.1 publishes the native failure APIs the exercises need: failure policies, quarantine, the recovery guard and cumulative boundary, transient-mapper retries, the automatic-continuation limit, the durable failure journal, and the in-process operator service (`streamotter/gateway/operator`). The field station and the benches serve every interface in this section (benches: section 8b), **gated per scenario** by the capability summary (section 12.3):

- A scenario is offered only when the installed release is one this backend was verified against **for that scenario** (`VERIFIED_WITH` in `src/lab/capabilities.ts`: a scenario is added only after its real-Kafka test on `npm run dev:lab` passes) and this deployment's failure-handling profile supports it.
- Where nothing is available, every intent is refused with 409 `unsupported-scenario`, and `GET /api/lab/incident` and `GET /api/lab/operations/<operationId>` answer 404, exactly as before 0.2.0-rc.1. Nothing is simulated: every incident fact comes from the installed library through its published operator API, and every application fact from the coverage ledger (section 8a).
- **Unchanged:** every route, `LabAction`, payload, timing, and rule in sections 1–11. Fouled sensor (LC11-S01) keeps running on `sensor.foul`, `sensor.restore`, and `source.resume`, and can also be started as an intent.

The intent names are Lontra Creek demo intents, not StreamOtter API names; section 12.5 maps each to the published function it calls.

### 12.1 Types

Normative, landed verbatim in `apps/field-station/src/lab/contract.ts`. The private types the field station and the benches exchange are in section 8b.

```ts
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
  | "not-integrated"            // the installed release isn't one this backend's Lab has been verified against for the scenario
  | "deployment-restricted";    // this deployment's Kafka authorization or failure-handling profile isn't verified for it (LC11-ADR-03), or it is a local and CI exercise

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
  /** Whether `GET /api/lab/incident` and the intents below are served. */
  features: { incidentProjection: LabAvailability; intents: LabAvailability };
}

/** Demo intents (companion plan section 9), not StreamOtter API names. Each resolves to a fixed, server-selected incident and action. */
export type LabIntent =
  | "scenario.start"               // start a source-failures scenario on the leased bench's study
  | "scenario.restore-calibration" // the application puts LC-03's calibration back
  | "scenario.prepare-coverage"    // the application releases its predetermined snapshot coverage
  | "incident.retry-current"       // retry the exact held position
  | "incident.reassess"            // ask the recovery guard again
  | "incident.evaluate"            // dry-run the retained evidence against the current mapper
  | "incident.approve-reprocess";  // approve one evaluated plan for gateway-local reprocessing

/**
 * The body of `POST /api/lab/actions` for an intent, in place of `{ action }`.
 * Bench, source, topic, offset, incident storage IDs, payloads, handler code, and policy
 * objects are never accepted: any other key is 400.
 */
export interface LabIntentRequest {
  intent: LabIntent;
  /** Idempotency key, one per visitor decision: 8 to 64 of A-Z, a-z, 0-9, and '-'. A repeat returns the same operation. */
  requestId: string;
  /** Required for `scenario.start` and refused otherwise: a source-failures scenario. */
  scenario?: LabScenarioId;
  /** Required except for `scenario.start` (where it is optional): the `scenarioRevision` the page last showed. A stale one is refused. */
  expectedRevision?: number;
  /** Required for `incident.approve-reprocess` and refused otherwise: `evaluation.planToken` from the projection the visitor reviewed. */
  planToken?: string;
}

/** The answer to an intent (202) and `GET /api/lab/operations/<operationId>`. */
export interface LabOperation {
  /** `lop_` and 22 base64url characters. Opaque and scoped to the lease and study; looked up under the session, never trusted as authority. */
  operationId: string;
  intent: LabIntent;
  requestId: string;
  /**
   * `accepted` acknowledges the demo request only: not quarantine success, not business completion.
   * `running`: the bench or the field station is carrying it out.
   * `succeeded`: carried out; what it led to is in the projection (a retry that holds again still succeeded).
   * `refused`: the installed library or the application refused it; nothing changed.
   * `failed`: it was attempted and failed. `cancelled`: the lease ended first.
   * `unknown` means the outcome couldn't be observed; the page looks it up again and never repeats the request.
   * Only `accepted` and `running` change; every other status is final.
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
 * The bounded, lease-scoped current-incident projection. The browser gets this
 * summary, not the server's internal state, and never derives it from the rolling feed.
 * It never carries a native failure, boundary, operation, or plan ID, or a path.
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
  /**
   * `saved` only after a positively acknowledged quarantine write; `not-required` when the
   * policy keeps no evidence (`pause`: the record is retried in place, never skipped).
   */
  evidence: "saved" | "unknown" | "unavailable" | "not-required";
  /** `processed`: the held record was retried and processed normally; nothing was skipped. */
  source: "held" | "advanced" | "processed" | "uncertain";
  recovery: "none" | "coverage-not-ready" | "coverage-established" | "view-resynchronized";
  /** The latest dry-run evaluation of the retained evidence, if any. */
  evaluation: {
    /** `passed`: the saved record maps and validates with the current handlers. */
    result: "passed" | "failed";
    at: string;
    /** When `planToken` stops being accepted: the library plan's expiry or the lease's end, whichever is first. */
    expiresAt: string | null;
    /**
     * Opaque and single use, bound to this lease, study, incident revision, and plan. Present
     * only while `incident.approve-reprocess` may be sent with it; null once used or expired,
     * or when the evaluation issued no plan.
     */
    planToken: string | null;
    /** One sentence: what the evaluation found, and why it can't be reprocessed when it can't. */
    summary: string;
  } | null;
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

/** `GET /api/lab/incident`. */
export type LabIncidentView =
  | { status: "none"; now: string }
  | { status: "open"; now: string; incident: LabIncidentSummary };
```

### 12.2 Tracks and scenario IDs

One scenario, one implementation: a scenario listed in both tracks has one set of controls. The ID is the `?scenario=` value and the key of the page's catalog (`apps/site/src/lab-catalog.ts`) and the capability summary (`apps/field-station/src/lab/capabilities.ts`); both are `Record<LabScenarioId, …>`, so a new ID fails the typecheck until both describe it.

| ID | Story | Track | Delivery | Needs (profile) |
| --- | --- | --- | --- | --- |
| `fouled-sensor` | LC11-S01 Fouled sensor: fix and retry | Both | Public (existing, updated) | Runs on `sensor.*`, `source.resume` everywhere; as an intent, any profile but `off` |
| `garbled-reading` | LC11-S02 Garbled reading: preserve and hold | Source failures | Public | Quarantine (`quarantine`) |
| `bad-projection` | LC11-S03 Bad projection: recover from authoritative state | Source failures | Public, headline | Quarantine, recovery guard (`quarantine`) |
| `inspect-old-reading` | LC11-S04 Inspect the old reading: evaluate, then reprocess | Source failures | Public | Evaluation, controlled reprocessing (`quarantine`) |
| `conflicting-readings` | LC11-S05 Conflicting readings: stopping is correct | Source failures | Public, advanced | Quarantine, recovery guard (`quarantine`) |
| `calibration-blip` | LC11-S06 Calibration lookup blip | Source failures | Public, advanced | Bounded retry for transient mapper errors (`retry` or `quarantine`) |
| `too-many-bad-readings` | LC11-S07 Too many bad readings | Source failures | Local and CI only | Quarantine, continuation limit (`quarantine`, `LAB_LOCAL_EXERCISES`) |
| `restart-recovery` | LC11-S08 Recovery across restart and a new subscription | Source failures | Local and CI only | Durable failure journal, recovery guard (`quarantine`, `LAB_LOCAL_EXERCISES`) |
| `unavailable-evidence` | LC11-S09 Unavailable evidence | Source failures | Local and CI only | Quarantine, durable failure journal (`quarantine`, `LAB_LOCAL_EXERCISES`) |
| `relay-cut` | Flash flood takes the relay | Connections and clients | Existing | Runs: `relay.*` |
| `slow-client` | Laptop on a satellite link | Connections and clients | Existing | Runs: `satellite.start` |
| `relay-restart` | Relay restart | Connections and clients | Existing | Runs: `gateway.restart` |

The native capability is what the capability summary names in a `library-lacks-capability` reason (companion plan section 4); the profile is what a `deployment-restricted` reason refers to. The hosted broker runs without Kafka authorization today, so hosted benches use profile `retry` and offer only `calibration-blip` among the new scenarios; local `npm run dev:lab` and CI use `quarantine` with `LAB_LOCAL_EXERCISES=1`. Offering the rest on the hosted Lab needs the owner-approved authorization migration (section 10.7, R2).

### 12.3 `GET /api/lab/capabilities`

**A separate route, not a field on `LabStatus`.** The summary is fixed for the life of the field-station process, while `LabStatus` is pool state polled every 10 seconds; keeping them apart keeps the poll small and `LabStatus` unchanged for other slices. A separate route also gives an older backend an unambiguous answer: it has no such route, so it answers 404, and the page treats every new scenario as unsupported. The route needs no session, doesn't enter the pool's serialized queue, isn't a heartbeat, takes no query parameters (400 otherwise), and counts against the Lab request budget like every `/api/lab/*` route. It answers even when the Lab has no benches (`backend.lab: "disabled"`).

**What it reports**, and nothing else:

- `library.version`: read from the installed `streamotter/package.json` at startup (`createRequire`), never hand-typed.
- `backend.mode`: `real-kafka-synthetic`, the only mode the field station's public API runs in. The fixture demo (`npm run dev`) has no Lab API and answers 404.
- `contract`: this section's revision.
- `scenarios`: every `LabScenarioId` this backend knows, each `available` or not with a `reason`. Existing scenarios are available exactly when the Lab has benches (`lab-disabled` otherwise); the pool's live state stays in `LabStatus`.
- `features.incidentProjection` and `features.intents`: whether `GET /api/lab/incident` (section 12.7) and the intents and their operations (sections 12.5 and 12.6) are served. Both are available exactly when the Lab has benches, the installed release is verified for at least one scenario, and the profile isn't `off`; otherwise both carry the same kind of reason as a scenario.

**Never**: service or gateway URLs, bench numbers, secrets or tokens, socket or file paths, management or operator routes, Kafka topics, or anything from a lease. A unit test checks the serialized summary for URLs, loopback addresses, sockets, tokens, secrets, management routes, and paths.

**Reasons**, the first that applies, for a new scenario:

1. `library-lacks-capability`: the installed release's published source was checked and found to lack the native APIs (`VERIFIED_WITHOUT_FAILURE_HANDLING`, `0.1.0-rc.3`). The text names the release and what it lacks, for example "This backend's StreamOtter release (0.1.0-rc.3) doesn't provide quarantine."
2. `not-integrated`: the installed release isn't one this backend's Lab has been verified against for this scenario (`VERIFIED_WITH`, a set of scenarios per release, each added only after its real-Kafka test passes). It says the Lab hasn't been verified rather than claiming what the release lacks. For `0.2.0-rc.1` the set starts empty.
3. `lab-disabled`: the deployment has no benches.
4. `deployment-restricted`: this deployment's failure-handling profile (`LAB_FAILURE_HANDLING`, section 8b) doesn't provide what the scenario needs (section 12.2), or the scenario is a local and CI exercise and `LAB_LOCAL_EXERCISES` isn't set. The text says the deployment's Kafka authorization isn't verified for it (LC11-ADR-03) or that it runs only locally and in CI.

Existing scenarios are available exactly when the Lab has benches (`lab-disabled` otherwise).

**How the page uses it.** Fetched once on load (and again on **Check again** until it succeeds). A new scenario is offered only when the summary lists it as available *and* that build of the page has an exercise for it. Otherwise the page shows the summary's reason, or **This backend does not support this scenario** for a 404 or a summary that doesn't list the scenario (a newer site on an older backend), or that the capability check didn't answer for a network failure, a 5xx, or a body without the summary's shape. There is no mock fallback. An existing scenario says it runs today only when the summary lists it as available; with `lab-disabled` the page shows that reason, and without a usable summary it says the scenario runs on a leased bench when the backend has benches. When the backend's `library.version` differs from the version the site was built for, the page says so.

### 12.4 Deep links

`/lab/#source-failures`, `/lab/#connections`, and `/lab/?scenario=<id>` (optionally with a track hash) select explanatory content only: the track shown and a marked scenario card. They never borrow a bench, start a scenario, inject a record, or approve anything (LC11-A01); a visitor still chooses **Borrow a bench**, and starting a scenario will be its own explicit action. An unknown `scenario` value is ignored. A scenario outside the named track opens its own track; `fouled-sensor` alone opens Source failures. Choosing a track or scenario in the page rewrites the URL in place (`history.replaceState`), so it doesn't reload the page (which would return a lease on `pagehide`) or add history entries. The eight routes and the navigation are unchanged.

### 12.5 Intents on `POST /api/lab/actions`

A closed set of demo intents, each resolving to a fixed, server-selected incident and action for the session's current lease and study (companion plan section 9). The body is a `LabIntentRequest` instead of `{ action }`; a body with both is 400. The incident is never named by the browser: `expectedRevision` names the projection the visitor saw, and the field station looks up the incident and its library revision it recorded for that projection.

| Intent | Does | Carried out by | Binding |
| --- | --- | --- | --- |
| `scenario.start` | Starts a source-failures scenario on the leased bench's study (table below) | The bench arms its handlers; the field station publishes the scenario's records through the publisher gate and records each run in the coverage ledger (section 8a) | `requestId`, `scenario`; `expectedRevision` optional |
| `scenario.restore-calibration` | Puts LC-03's calibration back and disarms a calibration blip. The source stays held until a retry: StreamOtter never resumes on its own | Bench (application state) | `requestId`, `expectedRevision` |
| `scenario.prepare-coverage` | Releases the predetermined authoritative update of the study's withheld run; coverage is established once the bench's served state reflects it (S03) | Field station, `LabStudies.prepareCoverage` | `requestId`, `expectedRevision` |
| `incident.retry-current` | `OperatorApi.retryCurrent({ sourceId: "field", failureId, expectedRevision, reason: "Lab visitor" })`: retry the exact held position | Bench, in-process operator API | `requestId`, `expectedRevision` |
| `incident.reassess` | `OperatorApi.reassess({ sourceId: "field", failureId, expectedRevision })`: a fresh quarantine copy, then the recovery guard again | Bench | `requestId`, `expectedRevision` |
| `incident.evaluate` | `OperatorApi.evaluate({ failureId, expectedRevision })`: a dry run of the saved bytes through today's handlers. When the library issues a plan, the bench mints the projection's `planToken` | Bench | `requestId`, `expectedRevision` |
| `incident.approve-reprocess` | `OperatorApi.redrive({ failureId, planId, planFingerprint, expectedRevision, operationId: "lab<N>.<studyId>.<operationId>" })` for the plan the token names; the token is spent | Bench | `requestId`, `expectedRevision`, `planToken` |

**Starting a scenario.** Every scenario record goes to the bench's own `lab-N.field.gauges` with key `station:LC-03` (the creek copies' partition, so order holds) and the revision of the field station's current tick. Its reading differs from the current one, and the ledger derives what it affects (section 8a). A study may hold several runs; a scenario can't start while the study's current incident is open (409 `not-applicable`: the visitor returns the bench to discard the study).

| Scenario | The bench arms | The field station publishes | Coverage |
| --- | --- | --- | --- |
| `fouled-sensor` | Removes the calibration table (as `sensor.foul`) | Nothing: the next live LC-03 reading fails | |
| `garbled-reading` | | A truncated LC-03 record that isn't JSON | `withheld`, for bookkeeping only |
| `bad-projection` | | A valid LC-03 reading marked for the `lab-projection-v2` mapping, whose broken projection writes `flowCfs` as a string | `withheld` |
| `inspect-old-reading` | Switches to the corrected projection and restarts its gateway in the same study, so the incident's handler identity is honest | First, when the study has no advanced `bad-projection` incident, the `bad-projection` record with coverage `pending`, waiting (at most 30 s) until StreamOtter advances past it | `pending` |
| `conflicting-readings` | | One `lab-reading-batch` record whose two LC-03 readings differ at the same revision | `pending` |
| `calibration-blip` | A transient calibration-lookup failure on the next live LC-03 reading: one attempt on the study's first start (the retry succeeds and no incident opens); on later starts every attempt fails until `scenario.restore-calibration`, so retries run out and a retry before restoring holds again | Nothing | |
| `too-many-bad-readings` | | Six `lab-projection-v2` readings back to back | `pending` |
| `restart-recovery` | | Two `lab-projection-v2` readings: LC-03 flow and LC-01 water temperature, for a cumulative barrier; the visitor then restarts the gateway | `pending` |
| `unavailable-evidence` | | One `lab-projection-v2` reading; the CI harness then deletes its quarantine copy | `pending` |

**Validation.** Keys are exactly `intent`, `requestId`, `scenario`, `expectedRevision`, and `planToken`; anything else, including `bench`, `sourceId`, `topic`, `partition`, `offset`, an incident ID, a payload, handler code, a policy object, or `action`, is 400 `invalid-request`. `intent` is one of the seven; `requestId` is 8 to 64 of `A-Z a-z 0-9 -`; `scenario` is required for `scenario.start` (a source-failures ID) and refused otherwise; `expectedRevision` is a non-negative safe integer, required except for `scenario.start`; `planToken` is 16 to 512 of `A-Z a-z 0-9 _ -`, required for `incident.approve-reprocess` and refused otherwise.

**Answers, in order.**

| Answer | When |
| --- | --- |
| 400 `invalid-request` | A malformed body (above) |
| 403 `origin-not-allowed`, 401 `no-session` | As for every route |
| 409 `unsupported-scenario` | `features.intents` is unavailable, or `scenario.start` names a scenario the capability summary doesn't list as available. Checked before the pool, the lease, the action budget, or any bench; the page shows **This backend does not support this scenario** and never retries |
| 409 `no-lease` | No active lease for the session |
| 202 `LabOperation` (the existing one) | The `requestId` was already used in this lease with the same body: the same operation, at its current status. Nothing runs again and no budget is spent |
| 409 `not-applicable` | The `requestId` was already used in this lease with a different body; `expectedRevision` isn't the current `scenarioRevision`; `planToken` isn't the current projection's; or the intent's precondition is false (no current incident for `incident.*`, nothing to restore, no withheld run to prepare, a start while an incident is open). The page may retry once the state changes |
| 429 `too-many-actions` | Within a second of the lease's last accepted action or intent (section 2) |
| 202 `LabOperation`, `accepted` | Recorded. The work runs outside the pool's serialized queue, so heartbeats, return, and reads stay responsive while it waits |
| 503 `bench-unavailable` | As for actions |

**Outcomes.** The operation becomes `running`, then final. A library `OperationResult` maps by its `result`: `completed` → `succeeded` (a retry that holds again still succeeded: the projection shows where the record is), `refused` → `refused`, `failed` → `failed`, `unknown` → `unknown`. An evaluation that returns is `succeeded`, whatever it found, except one the library refuses at the request stage (`stale-revision`, `not-found`, `generation-changed`), which is `refused` and records no evaluation; one that throws is `failed`. Evaluating a record that still fails reports `still-fails` before anything else, so a garbled record's evaluation is `still-fails`, not `not-advanced`. A redrive's `reprocessed` or `superseded` is `succeeded`; a spent, expired, or foreign token is `refused`. `detail` is the application's own sentence for the outcome (for example `stale-revision`, `integrity-class`, `policy-not-resync`, `circuit-open`, `not-held`, `plan-expired`, `evidence-expired`); the library's message is never passed through. Re-sending a redrive's `operationId` to the library returns its recorded result. A bench that doesn't answer leaves the operation `unknown`. Approval lifetime is at most the library plan's (5 minutes), the remaining lease, and the current study: a token is single use and dies with the lease; back-forward-cache restoration revalidates, never approves.

### 12.6 `GET /api/lab/operations/<operationId>`

Served while `features.intents` is available; 404 otherwise. Session required (401). Answers `LabOperation` for an operation of the session's current lease, or of the lease that ended within the last 60 seconds (as `GET /api/lab/lease` keeps reporting `ended`); 404 for any other. `accepted` acknowledges the demo request only, not quarantine success or business completion; the page polls this resource every second until the status is final. `unknown` means the outcome couldn't be observed: the page looks the result up again and never repeats the request (a lost answer to the intent itself is re-sent with the **same** `requestId`). When a lease ends, its unfinished operations become `cancelled`. A result that arrives after that is recorded only in the old study's summary and never updates a new visitor's operation. Not a heartbeat target of its own: like every Lab request it counts as one.

### 12.7 `GET /api/lab/incident`

Served while `features.incidentProjection` is available; 404 otherwise. Session and an active lease required (409 `no-lease` otherwise), except that a session whose lease ended within the last 60 seconds gets its last projection again with `discarded: true`: the study was discarded, the incident not fixed. Answers `LabIncidentView`: `none` until the study has an incident, then `open` with the bounded projection `LabIncidentSummary` for the lease's study.

The field station composes it from the bench's facts (`BenchIncidentFacts`, section 8b: the installed library's incident as its operator API reports it, and the bench's application state) and its own coverage ledger. It is never derived from the rolling feed, which drops items.

| Field | From |
| --- | --- |
| `label` | "Incident N", N its order of first observation in the study |
| `scenario` | The scenario the visitor last started in this lease |
| `scenarioRevision` | Starts at 1 for the lease and increments whenever any other field changes. The field station records, for each revision, the library failure ID and incident revision it showed |
| `reason` | The application's sentence for the failure class |
| `failure` | The library's `{ stage, class: failureClass }` |
| `policy` | The library's policy for the incident |
| `evidence` | `quarantine` `acknowledged` → `saved`; `pending` or `unknown` → `unknown`; `failed`, or evidence `expired` or `unavailable` → `unavailable`; `not-required` → `not-required` |
| `source` | `progress` `held`, `retrying`, or `advance-pending` → `held`; `advanced` → `advanced`; `processed` → `processed`; `uncertain` → `uncertain` |
| `recovery` | `none` for an incident with no recovery guard; otherwise the ledger's run for the record: `withheld` → `coverage-not-ready`; `established` → `coverage-established`, and `view-resynchronized` once the bench saw the leaseholder's snapshot succeed after the advance |
| `evaluation` | The bench's latest evaluation of this incident revision: `passed` when the saved record validates and maps now, with `planToken` while the plan may be approved |
| `reprocess` | The latest redrive: `reprocessed`, `superseded`, `failed`, or `unknown` |
| `nextIntent` | From the library's `nextAction` and the application's state: `repair-and-retry` → `scenario.restore-calibration` while calibration is removed or a blip armed, else `incident.retry-current`; `reassess` → `scenario.prepare-coverage` while the run is withheld, else `incident.reassess`; `evaluate` → `incident.approve-reprocess` while a plan token is live, else `incident.evaluate` once the projection is corrected, else none; `reopen-circuit` (no Lab intent: a reset ends it) and `none` → null |
| `detail` | The record's coordinates, `evidence.hash`, the handler build ID, and the source generation |
| `steps` | Application steps (records published, coverage released, the bench's own actions) and the library's incident history, at most 50; `stepsGap` when the library's bounded history no longer starts at `detected` |

The serialized projection never contains a native failure ID (`f1:`), boundary ID (`rb1:`), operation ID (`op1:`), plan ID, or a path; a test checks it.

**Page binding.** The page fetches it every 2 seconds while a lease is active, and only when `features.incidentProjection.available` is true.

### 12.8 The incident panel

Between **Your bench** and the gateway feed, so a narrow screen reads reading, incident, then steps. Empty unless a projection was served; the empty state says why, using the capability summary's reason. With a projection, three areas (companion plan section 6):

| Area | Shows | Source |
| --- | --- | --- |
| Application view | Connection state, the LC-03 subscription's state (the SDK's exact string, as a state chip) and reason, last value and revision; stale data kept and marked stale | The page's own SDK |
| Record disposition | Opaque label and reason first; failure class and stage, policy, evidence, source, recovery requirement, evaluation and reprocessing when present, the next supported intent; coordinates, evidence fingerprint, handler identity, source generation, and incident revision behind a disclosure | `LabIncidentSummary` |
| Observed steps | Chronological, at most 50, each labeled **Application action**, **Library observation**, or **Browser observation** (the page's own SDK state changes since the incident opened); a gap says steps are missing | `LabIncidentSummary.steps` and the page |

Labels follow the companion plan's "Say / Do not imply" table: **Evidence saved** (with "The record isn't repaired, and the view isn't recovered by this."), **Source advanced past quarantined record** ("The browser did not receive the excluded record."), **Record processed on retry** ("Nothing was skipped."), **No evidence kept** (a `pause` policy holds the record in place to be retried), **Snapshot coverage established** ("StreamOtter didn't prove the business data correct."), **View resynchronized** ("intermediate events were not replayed"), **Evaluation passed** ("This evaluation changed no source offset, sent no state, and published no business event. Nothing has been reprocessed."), **Reprocessed / Superseded by a newer snapshot / Reprocessing failed / Reprocessing outcome unknown**, and **Study discarded and reset** ("The held incident was not fixed."). Every mark has an icon and text; held and failed marks also use the stale and failed colors, never color alone.

**Accessibility (LC11-A36).** The chooser is two links with `aria-current`; scenario titles are links; both work by keyboard and keep focus where the visitor put it. Start actions are focusable buttons with `aria-disabled="true"` and `aria-describedby` pointing at the visible reason. Polling changes text inside existing nodes, so focus and the disclosure's open state survive it. Only a changed incident state is announced, through the page's existing polite region (`[data-lab-outcome]`); trace entries are not. No new motion, and a deep link's scroll is instant. Without JavaScript both tracks and all twelve scenario descriptions render as static text, with a `<noscript>` note that nothing can be checked or started.

### 12.9 Tests

- `apps/field-station/test/lab-capabilities.test.ts`: the version is the installed package's (read independently); every new scenario is unavailable on `0.1.0-rc.3` with its lacking capability; existing scenarios follow the Lab; an unverified release is `not-integrated`; the summary carries no URL, secret, path, or operator capability; intents parse only in their closed shape; the route needs no session and carries CORS; intents are refused with 409 `unsupported-scenario` after Origin and session checks and before any bench; existing actions keep their answers.
- `apps/site/test/lab-catalog.test.ts` and `lab-incident.test.ts`: the catalog covers S01–S09 with their delivery labels; deep-link selection; availability for a summary, a 404, an unreachable or malformed answer, an older and a newer backend; the precise labels and the projection's view model (a rendering fixture).
- `e2e/lab-source-failures.spec.ts`: deep links fire no `POST` (no lease, action, or token) and no incident request; rc.3 reasons and inert Start buttons; the fixture backend's 404; an older summary; chooser and scenario links by keyboard without reload or focus loss; axe in light and dark; narrow-screen order; no-JavaScript text; a mocked incident projection's labels, disclosure, announcement, and stable focus (a rendering fixture, not evidence that any backend produces it).
