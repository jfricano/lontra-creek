# Failure Lab API contract

September 26, 2026 · The interfaces between the Failure Lab backend (`be-lab`), the `/lab` page (`fe-content`), and Compose and Caddy (`devops`), and the threat model for exposing development-mode bench gateways · Owner: `lead`

[PLAN.md](../PLAN.md#the-failure-lab-lab) owns what the Lab is for and what visitors see; [DEPLOYMENT_PLAN.md](../DEPLOYMENT_PLAN.md#6-the-failure-lab-ships-with-the-launch) workstream 6 owns the engineering order. This document fixes the interfaces those build against: routes, payloads, timings, and security rules. Where it states StreamOtter's behavior, the source is the pinned release, `streamotter@0.1.0-rc.3`, as published on npm (its `src/` is installed under `node_modules/@streamotter/*`). Changes to this contract go through `lead`; an implementation that needs a different interface says so in its pull request and updates this file in the same pull request.

Section 1 fixes the relay-cut mechanism's shape, as E2.0's spike (PR #17, `spike/lab-relay-cut`) built it. Section 9 says what the contract requires of it regardless of implementation.

## 1. The pieces

```
browser, https://streamotter.app/lab/
  ├─ fetch, credentials ──▶ https://demo.streamotter.app/api/lab/*            Caddy ─▶ field-station:7402   leases, queue, feed relay
  └─ SDK WebSocket ───────▶ https://demo.streamotter.app/lab/N/socket.io/     Caddy (Origin check) ─▶ bench-N:7400   dev-mode gateway

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
| Places per client address | 2 | Leases plus places in line, keyed by `X-Client-IP` |
| Lab request budget | 20 at once, 3 a second | Per client address, for `/api/lab/*`, instead of the general `/api` budget (30 at once, 1 a second), which a polling page would exhaust |
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

Routes on the field station's public listener, behind Caddy at `https://demo.streamotter.app/api/lab/*`. The types in this section are normative: `be-lab` lands them verbatim as a type-only module, `apps/field-station/src/lab/contract.ts`, and the site and the tests import them with `import type`.

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

// The V1.1 Source failures types (LabCapabilities and the PROPOSED intent, incident, and operation types) are in section 12.

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
| `POST /api/lab/actions` | Required | Body `{ "action": LabAction }`: one scenario action on the session's own bench. A body with `intent` is a PROPOSED `LabIntentRequest` instead (section 12): validated, then refused with 409 `unsupported-scenario` before the pool, the lease, the action budget, or any bench is touched | 200 `LabActionResult`; 400 unknown action or malformed intent; 409 `no-lease`, `not-applicable`, `unsupported-scenario` (any intent, today); 429 `too-many-actions`; 503 `bench-unavailable` (the bench failed to carry it out, for example its relay control didn't answer; the lease ends as `bench-failed`) |
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
- **Granting.** When a bench reports `ready` and someone is waiting, the field station takes the first place, tells the bench the lease (`PUT /bench/v1/lease`), and the place becomes `ready` with `claimBy` 30 seconds away. The lease's five minutes start now. If a bench is ready and nobody waits, `POST /api/lab/lease` grants at once.
- **Claiming.** The first `POST /api/lab/lease/token` makes the lease `active`. A page in the foreground polls every 2 seconds, so it claims within one poll; a lease nobody claims ends as `unclaimed`, which frees benches held by tabs that were left behind.
- **Heartbeat and idle.** Any Lab request from the session is a heartbeat. An active or ready lease without one for 30 seconds ends as `idle`; a place in line without one for 90 seconds is dropped as `idle`. The page keeps polling while hidden; if the browser throttles it past the limit, the visitor sees why their place ended.
- **Time left.** `expiresAt` is `min(grantedAt + 300 s, session expiry)`. The bench token's principal expires at the same moment, so StreamOtter itself closes the connection at the lease's end even if the field station and the bench API never act (section 7).
- **Returning early.** `POST /api/lab/lease/return` ends the lease as `returned` and starts the reset at once. Leaving the line is the same call. The page also sends it on `pagehide` with `keepalive: true`; if that is lost, the idle limit frees the bench.
- **Reset between leases.** Every end of a lease, whatever the reason, is followed by `POST /bench/v1/reset` (section 8). The bench refuses the old lease's tokens immediately, then restores itself; the next lease is granted only once the bench reports `ready`. A bench that isn't ready within 60 seconds is `unavailable` and the field station retries the reset every 30 seconds.
- **Session expiry.** Sessions last 30 minutes from sign-in and aren't extended (`src/sessions.ts`). A lease never outlasts its session; a place in line is dropped when its session ends (`session-ended`). The queued view carries `sessionExpiresAt`, so the page can warn a visitor whose session will end before their turn is likely. After it ends, the next `POST /api/lab/lease` starts a new session (a new subject) at the back of the line. The walkthrough is unaffected until it next asks for a badge, which then also gets the new subject, as it would today.
- **Bench failure.** The field station polls each bench's status every 5 seconds. A bench that doesn't answer for 15 seconds, reports another lease or none, or reports `failed`, ends its lease as `bench-failed` and is marked `unavailable` until a reset succeeds. A bench reports `failed` when a reset or gateway restart fails, or when its own polls of its gateway have failed for 15 seconds in a row (section 8). A bench API answer for the lease other than 400, 409, or 429 also ends it as `bench-failed`, and the visitor's request gets 503 `bench-unavailable`.
- **Field station restart.** Leases and the line live in the field station's memory. On startup it resets every bench before granting anything, which also disconnects any visitor still on a bench. Pages then see `none` (or 401 if their session also ended) and say that the Lab restarted.
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

**What the page shows.** By default a scenario view: the visitor's actions, traces with outcome `failed` or `rejected`, source status changes, `failed` records with their topic, partition, and offset, bench events (including `gap`), and the page's own note when it fell behind. A `processed` record at the same coordinates as an earlier `failed` one is marked **Retried**; other `processed` records and `ok` traces appear only in the full feed, behind a toggle. Items are shown in time order (`at`), since traces arrive a poll after the bench's own items. One outcome line below the bench's view states how the latest scenario ended, from feed items and the page's own observations: the retried record after Resume, or the slow client's disconnection (with `OVERLOADED` when the feed shows its `receipt` trace failing) beside the visitor's own view state and revisions.

**Delivery and rate.** Polling, not server-sent events: it fits the field station's request-and-response API and its budget, needs no long-lived connections through Cloudflare, and doubles as the heartbeat. The page polls `GET /api/lab/trace` once a second while its lease is active and stops when it ends. The bench keeps the last 500 items per lease and returns at most 100 per request; if the page falls behind, the response has `gap: true` and continues from the oldest item kept, and the page says some steps weren't shown.

## 7. Reaching the bench gateway

- **Bench gateway configuration**: its own `projectId` (for example `lontra-creek-lab-1`; V1 supports one gateway per project), `gateway.host` `0.0.0.0` on the Compose network (only Caddy publishes a port), `gateway.port` 7400, `gateway.path` `/lab/N/socket.io`, and `allowedOrigins: [SITE_ORIGIN]` (`https://streamotter.app` in production; the dev origins from F.1 locally). Kafka over TLS with SCRAM, like production. Limits: `maxConnections` 8 (a few tabs plus the satellite) and `maxSubscriptionsPerConnection` 12. The E2.0 spike's `BENCH_LIMITS` used 16; E2.1 changes it to 8 to match this contract.
- **Caddy**, one route per bench: `/lab/N/socket.io/*` goes to `bench-N:7400`, only with `Origin` exactly the site's origin; a missing or different `Origin` gets 403 before the upgrade. Everything else under `/lab/` gets 404. The bench API (7420) and the management API have no route. Illustrative only; `devops` owns the Caddyfile:

  ```caddy
  @foreignOrigin not header Origin {$SITE_ORIGIN:https://streamotter.app}

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
}
```

| Route | Body | Does | Answers |
| --- | --- | --- | --- |
| `GET /healthz` | | For the Compose health check; no token | 200 when `ready` or `leased`, else 503 |
| `GET /bench/v1/status` | | The bench's state | 200 `BenchStatus` |
| `PUT /bench/v1/lease` | `{ leaseId, expiresAt }` | Starts a lease: records it, sets the feed's starting cursor, adds `lease-started` | 200 `BenchStatus`; 409 unless `ready` |
| `POST /bench/v1/tokens` | `{ leaseId }` | Mints a token for the current lease | 200 `{ token, expiresAt }`; 409 for any other lease |
| `POST /bench/v1/actions` | `{ leaseId, action }` | One scenario action | 200 `{ at, scenario: LabBenchState }`; 409 other lease or `not-applicable`; 429 within a second of the last |
| `GET /bench/v1/feed?leaseId=&after=&limit=` | | The lease's redacted feed | 200 `LabFeedPage`; 400 malformed cursor; 409 other lease |
| `POST /bench/v1/reset` | `{ leaseId: string \| null }` | Ends the lease (or whichever is current, for `null`) and restores the bench | 202 `BenchStatus` (`resetting`) |

**Errors.** Every error body is `{ error, code }` with a `LabErrorCode`. 400 `invalid-request` is for a malformed or oversized body or an invalid parameter; 409 carries `no-lease` (another lease, or none) or `not-applicable`; 429 `too-many-actions`. Anything else that goes wrong is the bench's own failure (its management API, its relay control, a gateway call): 500 `bench-unavailable`, never 400. The field station passes the bench's 400, 409, and 429 codes through to the visitor unchanged (so a bench's `no-lease` stays `no-lease`) and treats any other answer as the bench failing (section 4).

**Background polling.** About once a second the bench polls its gateway's sources and traces, or resets once the lease's time is up. At most one such tick waits in the bench's work queue, so a reset or gateway restart that holds the queue for 30 seconds doesn't stack polls ahead of the visitor's calls. A failed poll changes nothing by itself; the bench reports `failed` only once polls have failed for 15 seconds in a row.

**Reset**, in order, until the bench reports `ready`:

1. Clear the current lease, so `authenticate` refuses its tokens from this moment, and forget its tokens.
2. `gateway.revoke({ kind: "subject", tenantId, subject: "lab-<leaseId>" })`: its connections close with `UNAUTHENTICATED`.
3. Stop the satellite client.
4. Restore the calibration table and the relay.
5. Stop the bench's gateway, then construct a new one — identical except for a fresh consumer group named for the lease that just ended (for example `streamotter-lab-N-<leaseId>`, or a name unique to this reset when no lease ended, such as on startup) and `startFrom: "latest"` — using only StreamOtter's public API (`gateway.stop()`, `createGateway`). Wait until its source reports `healthy` (after a relay cut this can take up to 30 seconds).
6. Delete the gateway's previous consumer group with a Kafka admin client the bench process keeps for this; StreamOtter has no such operation.
7. Clear the feed buffer.
8. If the new gateway's source isn't healthy within 60 seconds, report `failed`.

**Bench environment.** Its own service token; its relay token (`LAB_BENCH_N_RELAY_TOKEN`, section 7); `SITE_ORIGIN`; its Kafka credentials (preferably a SCRAM user of its own); its management token, generated at startup unless supplied, never logged. **Never** `FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`, another bench's token, or the production gateway's or field station's Kafka passwords (`KAFKA_GATEWAY_PASSWORD`, `KAFKA_FIELD_STATION_PASSWORD`). The bench's snapshots come from a restricted, per-bench source — for example, an endpoint serving only that bench's `lab-N` world views, never notebooks or holts, authenticated with bench N's own service token (not a broader one) — never the field station's internal API, which serves every notebook to anyone holding its service token. E2.1 (`be-lab`) builds it.

**Status.** The E2.0 spike (PR #17, `spike/lab-relay-cut`) proves the relay cut but does not yet meet M4 or M11 (section 10.5): its bench accepts the walkthrough's badge check in `authenticate` instead of lease-bound tokens, and its environment and snapshots come from the field station's production secrets and internal API (`FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`, `FIELD_STATION_INTERNAL_URL`). E2.1 must close both gaps before any bench faces the public. S11 (section 10.6) checks it at the stack level.

**Field station environment** (names are suggestions for `be-lab` and `devops`): `LAB_BENCH_API_URLS` (the three bench API origins; unset means `enabled: false`), `LAB_BENCH_1_SERVICE_TOKEN` to `LAB_BENCH_3_SERVICE_TOKEN` (32 characters or more, from `deploy/make-secrets.sh`), `LAB_LEASE_SECONDS` (1 to 300; the field station refuses to start with a larger value, since benches refuse longer leases), `LAB_QUEUE_MAX`. Separate from the E2.0 spike's `FIELD_LAB_BENCHES` (`deploy/compose.lab-spike.yaml`): the number of benches whose `lab-N.*` topic copies the field station publishes over its own Kafka connection, unrelated to the Lab API's lease traffic.

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
| **T7 A compromised bench reaches production** | M11 benches hold no production secrets and don't use the field station's internal API; own SCRAM user | U3, S11, review |
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

Unit tests (`npm test`): **U1** the bench's gateway options register no principals and no fixture sources; **U2** the bench refuses to start when its management API lists a principal; **U3** the bench's configuration refuses production secrets in its environment; **U4** the bench config passes production validation (M12); plus the lease state machine with a fake clock (claim, idle, expiry, session cap, reset, field station restart).

### 10.7 Residual risks

- **R1 The gateway's own attack surface.** A bug in the gateway, Socket.IO, or the handlers that an anonymous or leaseholding client can trigger is as serious on a bench as on the production gateway. Benches add three more instances of the same code; development mode adds no reachable code path beyond D2 and D3.
- **R2 No Kafka authorization.** The broker has no authorizer (`deploy/kafka/start.sh`), so any SCRAM user can read and write every topic. A compromised bench, like a compromised production gateway, could read `field.notebooks` or write into `field.*` and pause the production source. Per-bench users make rotation and attribution possible; ACLs (`lab-N.*` read-only for bench N) would contain it, at the cost of changing the production broker. Recommended after launch, for the production gateway too.
- **R3 Denial of service.** Stock Caddy has no rate limiter, so floods of WebSocket handshakes reach the benches (each rejected cheaply) as they reach the production gateway today. Queue abuse from many addresses can still fill the line. Cloudflare's free plan is the outer layer.
- **R4 A release upgrade can change any of this.** D2–D5 are implementation details of `0.1.0-rc.3`. R.1 (release upgrade) must redo section 10.2 against the new published source and rerun S1–S6.

### 10.8 Verdict

Yes, development-mode benches can face the public with these mitigations. In `0.1.0-rc.3`, development mode reaches the public Socket.IO endpoint in exactly two ways: a handshake without `Origin` is accepted, and a preview token for a development principal bypasses `authenticate`. The first is harmless, because the token is the boundary and Caddy restores production's `Origin` rule anyway. The second is closed completely by registering no development principals (M1), with the management API, the only minter, confined to each bench container's loopback and never proxied (M2, M3). Everything else a visitor can reach is the same code production runs. Lease-bound, bench-minted tokens whose principals expire with the lease (M4–M7) keep visitors on their own bench for their own five minutes, and S1–S6 prove it in CI on every stack change. What remains (R1–R3) is the exposure the production gateway already has, and R2 is worth closing for both. The one standing obligation is R4: re-verify this analysis whenever the pinned release changes.

## 11. Open points

- **E2.0** is settled by the relay-cut spike (PR #17, `spike/lab-relay-cut`): `createGateway` (section 1), the relay mechanism (a `lab-N-kafka` proxy and control API per bench, sections 1 and 9), and `FIELD_LAB_BENCHES` feeding each bench's topic copies (section 8). The spike's bench still used the field station's internal API for snapshots, a shared relay token, and the walkthrough's badge check for `authenticate`; E2.1 (and E2.3 for the relay token) replace all three (M4, M9, M11 — see the Status note in section 8).
- **E2.1** adds the bench project (its channels, `LabChannels` types for the site), the calibration table, lease-bound tokens, the per-bench snapshot source, and the per-bench relay token; generated files for the site follow the section 7 ownership of that sprint.
- **L.2** decides how the Lab runs locally; until then, with `npm run dev`, `/api/lab/status` answers 404, which the page treats as unavailable.
- **The owner** decides section 10.8.
- **V1.1 W1 (October 3, 2026)** applied the October 2 review's Lab findings ([CODE_REVIEW_2026-10-02.md](../reviews/CODE_REVIEW_2026-10-02.md) S1, L1–L8) and the site evaluation's Lab items 2–4. Observable changes: bench-side failures answer 500 `bench-unavailable` instead of 400 and end the lease (sections 4, 8); a bench's `no-lease` reaches the visitor as `no-lease`, not `not-applicable` (section 8); a failed action doesn't spend the one-a-second budget (section 5); `LAB_LEASE_SECONDS` above 300 is refused at startup (sections 2, 8); `/api` error answers carry CORS (section 3); the page retries transient token failures (section 7) and shows a scenario view of the feed with `processed` records labeled "mapper returned" (section 6). No route, payload type, or error code was added or removed.
- **V1.1 W4 (October 3, 2026)** added the Source failures track (section 12): `GET /api/lab/capabilities`, the `unsupported-scenario` error code, and the PROPOSED intent, incident, and operation interfaces. Existing routes, actions, and payloads are unchanged.

## 12. The Source failures track (V1.1)

October 3, 2026 · V1.1 slice W4 · Authority: the [companion plan](../releases/v1.1/LONTRA_CREEK_V1_1_COMPANION_PLAN.md) sections 3, 4, 6, 7, and 9, and acceptance LC11-A01, A04, A36, and A37.

`/lab/` gains a second track, **Source failures**, beside the existing scenarios, which become the **Connections and clients** track. This section fixes what the field station serves for it today and the shape of what it will serve once a published StreamOtter release supplies the native failure APIs.

**Status.** The installed `streamotter@0.1.0-rc.3` has no quarantine, recovery guard, cumulative barrier, evaluation, redrive, or operator service ([BASELINE.md section 3](../releases/v1.1/BASELINE.md#3-native-capability-availability)). So:

- **Served today:** `GET /api/lab/capabilities` (section 12.3) and the refusal of every intent with 409 `unsupported-scenario` (section 12.5).
- **PROPOSED, not served:** the intents' effects, `GET /api/lab/incident` (section 12.7), and `GET /api/lab/operations/<operationId>` (section 12.6). Both routes answer 404 today. Their types are in `contract.ts` so the page and the future bench binding are written against one shape; they are not backed by any native release, and nothing in this repository fabricates a value of them.
- **Unchanged:** every route, `LabAction`, payload, timing, and rule in sections 1–11. Fouled sensor (LC11-S01) keeps running on `sensor.foul`, `sensor.restore`, and `source.resume`.

The intent names are Lontra Creek demo intents, not StreamOtter API names. When the native APIs ship, W9b maps them to the published functions after their types exist (companion plan section 7) and amends this section.

### 12.1 Types

Normative, landed verbatim in `apps/field-station/src/lab/contract.ts`.

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
```

### 12.2 Tracks and scenario IDs

One scenario, one implementation: a scenario listed in both tracks has one set of controls. The ID is the `?scenario=` value and the key of the page's catalog (`apps/site/src/lab-catalog.ts`) and the capability summary (`apps/field-station/src/lab/capabilities.ts`); both are `Record<LabScenarioId, …>`, so a new ID fails the typecheck until both describe it.

| ID | Story | Track | Delivery | Today |
| --- | --- | --- | --- | --- |
| `fouled-sensor` | LC11-S01 Fouled sensor: fix and retry | Both | Public (existing, updated) | Runs: `sensor.*`, `source.resume` |
| `garbled-reading` | LC11-S02 Garbled reading: preserve and hold | Source failures | Public | Unavailable: quarantine |
| `bad-projection` | LC11-S03 Bad projection: recover from authoritative state | Source failures | Public, headline | Unavailable: quarantine, recovery guard |
| `inspect-old-reading` | LC11-S04 Inspect the old reading: evaluate, then reprocess | Source failures | Public | Unavailable: evaluation, controlled reprocessing |
| `conflicting-readings` | LC11-S05 Conflicting readings: stopping is correct | Source failures | Public, advanced | Unavailable: quarantine, recovery guard |
| `calibration-blip` | LC11-S06 Calibration lookup blip | Source failures | Public, advanced | Unavailable: bounded retry for transient mapper errors |
| `too-many-bad-readings` | LC11-S07 Too many bad readings | Source failures | Local and CI only | Unavailable: quarantine, continuation limit |
| `restart-recovery` | LC11-S08 Recovery across restart and a new subscription | Source failures | Local and CI only | Unavailable: durable failure journal, recovery guard |
| `unavailable-evidence` | LC11-S09 Unavailable evidence or quarantine | Source failures | Local and CI only | Unavailable: quarantine, durable failure journal |
| `relay-cut` | Flash flood takes the relay | Connections and clients | Existing | Runs: `relay.*` |
| `slow-client` | Laptop on a satellite link | Connections and clients | Existing | Runs: `satellite.start` |
| `relay-restart` | Relay restart | Connections and clients | Existing | Runs: `gateway.restart` |

"Unavailable: X" is the native capability the scenario needs (companion plan section 4), which the capability summary names in its reason.

### 12.3 `GET /api/lab/capabilities`

**A separate route, not a field on `LabStatus`.** The summary is fixed for the life of the field-station process, while `LabStatus` is pool state polled every 10 seconds; keeping them apart keeps the poll small and `LabStatus` unchanged for other slices. A separate route also gives an older backend an unambiguous answer: it has no such route, so it answers 404, and the page treats every new scenario as unsupported. The route needs no session, doesn't enter the pool's serialized queue, isn't a heartbeat, takes no query parameters (400 otherwise), and counts against the Lab request budget like every `/api/lab/*` route. It answers even when the Lab has no benches (`backend.lab: "disabled"`).

**What it reports**, and nothing else:

- `library.version`: read from the installed `streamotter/package.json` at startup (`createRequire`), never hand-typed.
- `backend.mode`: `real-kafka-synthetic`, the only mode the field station's public API runs in. The fixture demo (`npm run dev`) has no Lab API and answers 404.
- `contract`: this section's revision.
- `scenarios`: every `LabScenarioId` this backend knows, each `available` or not with a `reason`. Existing scenarios are available exactly when the Lab has benches (`lab-disabled` otherwise); the pool's live state stays in `LabStatus`.
- `features.incidentProjection` and `features.intents`: whether the PROPOSED routes in sections 12.6 and 12.7 work. Both unavailable today.

**Never**: service or gateway URLs, bench numbers, secrets or tokens, socket or file paths, management or operator routes, Kafka topics, or anything from a lease. A unit test checks the serialized summary for URLs, loopback addresses, sockets, tokens, secrets, management routes, and paths.

**Reasons.** `library-lacks-capability` only for a release whose published source was checked and found to lack the native APIs (`VERIFIED_WITHOUT_FAILURE_HANDLING`, today `0.1.0-rc.3`); its text names the release and what it lacks, for example "This backend's StreamOtter release (0.1.0-rc.3) doesn't provide quarantine." Any other installed version gets `not-integrated`, which says the Lab hasn't been verified against that release rather than claiming what it lacks. `lab-disabled` is for the existing scenarios on a deployment with no benches.

**How the page uses it.** Fetched once on load (and again on **Check again** until it succeeds). A new scenario is offered only when the summary lists it as available *and* that build of the page has an exercise for it; no build has one yet. Otherwise the page shows the summary's reason, or **This backend does not support this scenario** for a 404 or a summary that doesn't list the scenario (a newer site on an older backend), or that the capability check didn't answer for a network failure, a 5xx, or a body without the summary's shape. There is no mock fallback. When the backend's `library.version` differs from the version the site was built for, the page says so.

### 12.4 Deep links

`/lab/#source-failures`, `/lab/#connections`, and `/lab/?scenario=<id>` (optionally with a track hash) select explanatory content only: the track shown and a marked scenario card. They never borrow a bench, start a scenario, inject a record, or approve anything (LC11-A01); a visitor still chooses **Borrow a bench**, and starting a scenario will be its own explicit action. An unknown `scenario` value is ignored. A scenario outside the named track opens its own track; `fouled-sensor` alone opens Source failures. Choosing a track or scenario in the page rewrites the URL in place (`history.replaceState`), so it doesn't reload the page (which would return a lease on `pagehide`) or add history entries. The eight routes and the navigation are unchanged.

### 12.5 PROPOSED intents on `POST /api/lab/actions`

A closed set of demo intents, each resolving to a fixed, server-selected incident and action for the session's current lease and study (companion plan section 9). The body is a `LabIntentRequest` instead of `{ action }`; a body with both is 400.

| Intent | Would do | Binding |
| --- | --- | --- |
| `scenario.start` | Start a source-failures scenario on the leased bench's study; an incompatible scenario on an existing study first needs a visible reset | `requestId`, `scenario`; `expectedRevision` optional |
| `scenario.restore-calibration` | The application restores LC-03's calibration (S01) | `requestId`, `expectedRevision` |
| `scenario.prepare-coverage` | The application releases its predetermined authoritative-state update and coverage evidence (S03) | `requestId`, `expectedRevision` |
| `incident.retry-current` | Retry the exact held position | `requestId`, `expectedRevision` |
| `incident.reassess` | Ask the installed library's supported reassessment | `requestId`, `expectedRevision` |
| `incident.evaluate` | Dry-run the retained evidence against the current mapper; produces a plan token | `requestId`, `expectedRevision` |
| `incident.approve-reprocess` | Approve exactly one evaluated plan for gateway-local reprocessing | `requestId`, `expectedRevision`, `planToken` |

**Validation (served today).** Keys are exactly `intent`, `requestId`, `scenario`, `expectedRevision`, and `planToken`; anything else, including `bench`, `sourceId`, `topic`, `partition`, `offset`, an incident ID, a payload, handler code, a policy object, or `action`, is 400 `invalid-request`. `intent` is one of the seven; `requestId` is 8 to 64 of `A-Z a-z 0-9 -`; `scenario` is required for `scenario.start` (a source-failures ID) and refused otherwise; `expectedRevision` is a non-negative safe integer, required except for `scenario.start`; `planToken` is 16 to 512 of `A-Z a-z 0-9 _ -`, required for `incident.approve-reprocess` and refused otherwise. The usual Origin check (403) and session (401) come first.

**Refusal (served today).** A well-formed intent is refused with **409 `unsupported-scenario`** before the pool, the lease, the action budget, or any bench is touched, whether or not the session holds a lease and whether or not the Lab has benches. `not-applicable` was not reused: it means "valid here, but not in the bench's current state", which a page may retry after the state changes, while `unsupported-scenario` means this backend can't do it at all, which the page shows as **This backend does not support this scenario** and never retries. A test checks that no intent reaches `/bench/v1/actions`.

**When supported (W9b).** The answer becomes 202 `LabOperation`. A repeated `requestId` within the lease returns the same operation rather than running it again. A stale `expectedRevision`, an expired or foreign `planToken`, or an ended lease or study is refused; opaque references are looked up under the session, never trusted as authority. Lease heartbeats, return, and read-only routes stay responsive while an operation waits; the pool's serialized queue is not held across those waits. The action budget (section 2) applies. Approval lifetime is at most the library plan's, the remaining lease, and the current study; back-forward-cache restoration revalidates, never approves.

### 12.6 PROPOSED `GET /api/lab/operations/<operationId>`

Session required; 404 for an operation outside the session's current lease. Answers `LabOperation`. `accepted` acknowledges the demo request only, not quarantine success or business completion; the page polls this resource until the outcome is observed. `unknown` means the outcome couldn't be observed: the page looks the result up again and never repeats the request. A callback from an ended study never updates a new visitor's operation; a write completed before cancellation is recorded honestly in the old study. Not served today (404).

### 12.7 PROPOSED `GET /api/lab/incident`

Session and an active lease required (409 `no-lease` otherwise). Answers `LabIncidentView`: `none`, or the bounded current-incident projection `LabIncidentSummary` for the lease's study. The server builds it from the library's incident results and its own scenario ledger; it is never derived from the rolling feed, which drops items. Steps carry their origin (`application` or `library`); a gap stays a gap. Coordinates and fingerprints are the bench's own synthetic values. Not served today (404).

**Page binding.** The page fetches it every 2 seconds while a lease is active, and only when `features.incidentProjection.available` is true, which no backend reports today; so today the page never requests it and the panel stays in its empty, explained state.

### 12.8 The incident panel

Between **Your bench** and the gateway feed, so a narrow screen reads reading, incident, then steps. Empty unless a projection was served; the empty state says why, using the capability summary's reason. With a projection, three areas (companion plan section 6):

| Area | Shows | Source |
| --- | --- | --- |
| Application view | Connection state, the LC-03 subscription's state (the SDK's exact string, as a state chip) and reason, last value and revision; stale data kept and marked stale | The page's own SDK |
| Record disposition | Opaque label and reason first; failure class and stage, policy, evidence, source, recovery requirement, evaluation and reprocessing when present, the next supported intent; coordinates, evidence fingerprint, handler identity, source generation, and incident revision behind a disclosure | `LabIncidentSummary` |
| Observed steps | Chronological, at most 50, each labeled **Application action**, **Library observation**, or **Browser observation** (the page's own SDK state changes since the incident opened); a gap says steps are missing | `LabIncidentSummary.steps` and the page |

Labels follow the companion plan's "Say / Do not imply" table: **Evidence saved** (with "The record isn't repaired, and the view isn't recovered by this."), **Source advanced past quarantined record** ("The browser did not receive the excluded record."), **Snapshot coverage established** ("StreamOtter didn't prove the business data correct."), **View resynchronized** ("intermediate events were not replayed"), **Evaluation passed** ("This evaluation changed no source offset, sent no state, and published no business event. Nothing has been reprocessed."), **Reprocessed / Superseded by a newer snapshot / Reprocessing failed / Reprocessing outcome unknown**, and **Study discarded and reset** ("The held incident was not fixed."). Every mark has an icon and text; held and failed marks also use the stale and failed colors, never color alone.

**Accessibility (LC11-A36).** The chooser is two links with `aria-current`; scenario titles are links; both work by keyboard and keep focus where the visitor put it. Start actions are focusable buttons with `aria-disabled="true"` and `aria-describedby` pointing at the visible reason. Polling changes text inside existing nodes, so focus and the disclosure's open state survive it. Only a changed incident state is announced, through the page's existing polite region (`[data-lab-outcome]`); trace entries are not. No new motion, and a deep link's scroll is instant. Without JavaScript both tracks and all twelve scenario descriptions render as static text, with a `<noscript>` note that nothing can be checked or started.

### 12.9 Tests

- `apps/field-station/test/lab-capabilities.test.ts`: the version is the installed package's (read independently); every new scenario is unavailable on `0.1.0-rc.3` with its lacking capability; existing scenarios follow the Lab; an unverified release is `not-integrated`; the summary carries no URL, secret, path, or operator capability; intents parse only in their closed shape; the route needs no session and carries CORS; intents are refused with 409 `unsupported-scenario` after Origin and session checks and before any bench; existing actions keep their answers.
- `apps/site/test/lab-catalog.test.ts` and `lab-incident.test.ts`: the catalog covers S01–S09 with their delivery labels; deep-link selection; availability for a summary, a 404, an unreachable or malformed answer, an older and a newer backend; the precise labels and the projection's view model (a rendering fixture).
- `e2e/lab-source-failures.spec.ts`: deep links fire no `POST` (no lease, action, or token) and no incident request; rc.3 reasons and inert Start buttons; the fixture backend's 404; an older summary; chooser and scenario links by keyboard without reload or focus loss; axe in light and dark; narrow-screen order; no-JavaScript text; a mocked incident projection's labels, disclosure, announcement, and stable focus (a rendering fixture, not evidence that any backend produces it).
