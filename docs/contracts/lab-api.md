# Failure Lab API contract

September 26, 2026 · The interfaces between the Failure Lab backend (`be-lab`), the `/lab` page (`fe-content`), and Compose and Caddy (`devops`), and the threat model for exposing development-mode bench gateways · Owner: `lead`

[PLAN.md](../PLAN.md#the-failure-lab-lab) owns what the Lab is for and what visitors see; [DEPLOYMENT_PLAN.md](../DEPLOYMENT_PLAN.md#6-the-failure-lab-ships-with-the-launch) workstream 6 owns the engineering order. This document fixes the interfaces those build against: routes, payloads, timings, and security rules. Where it states StreamOtter's behavior, the source is the pinned release, `streamotter@0.1.0-rc.3`, as published on npm (its `src/` is installed under `node_modules/@streamotter/*`). Changes to this contract go through `lead`; an implementation that needs a different interface says so in its pull request and updates this file in the same pull request.

The relay-cut mechanism is deliberately abstract here: the E2.0 spike proves it. Section 9 says what the contract requires of it.

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
  relay control        (E2.0)            cuts and restores this bench's path to Kafka

bench-N ──relay (cuttable)──▶ Kafka, its own lab-N.* topics and consumer group, its own projectId
```

- **The field station is the only thing visitors talk to about leases.** It keeps the queue and the leases in memory, relays tokens, actions, and the feed, and never lets a request name a bench: the bench always comes from the session's own lease.
- **Each bench is the only authority over its own gateway**: who may connect (its current lease), its scenario state, and its feed.
- **The management API stays inside the bench.** StreamOtter's traces are readable only through it (section 10.2), so the bench API, which runs in the bench's network namespace, reads them over loopback and serves a redacted feed. That is why the field station never reads a bench's management API directly, as PLAN.md's first sketch had it.
- **Recommended shape** (E2.0 settles it in PLAN.md): one Node process per bench that calls `createGateway({ mode: "development" })` and `startManagementServer({ gateway, host: "127.0.0.1", port, token, workbenchDir: null })` from `streamotter/gateway/management`, and runs the bench API, the satellite client, and the relay control. Compared with `streamotter dev`, it keeps the lease state in the same process as `authenticate`, survives a relay restart (stop the gateway, construct a new one), passes no `development` principals whatever a handler module exports, and never prints the management token. If E2.0 chooses `streamotter dev`, every requirement in sections 7–10 still applies.

## 2. Timings and limits

Configuration defaults, not measured capacity. The real values are recorded on the host with PLAN.md's other limits before launch; CI's stack test may shorten them.

| Setting | Default | Meaning |
| --- | --- | --- |
| Benches | 3 | Fixed pool |
| Lease | 300 s | From the moment it's granted, and never past the visitor's session expiry |
| Claim window | 30 s | A granted lease whose page hasn't fetched a bench token by then is released |
| Active idle limit | 30 s | A lease with no heartbeat for this long ends |
| Queue idle limit | 90 s | A place in line with no heartbeat for this long is dropped (background tabs poll less often) |
| Ended view | 60 s | How long `GET /api/lab/lease` keeps reporting an ended lease and why |
| Scenario actions | 1 per second | Per lease (field station) and per bench (bench API) |
| Reset deadline | 60 s | A bench not ready by then is unavailable; the field station retries every 30 s |
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

- **CORS and Origin** as for the rest of `/api`: the site's origin with credentials; a `POST` carrying a foreign `Origin` gets 403 `origin-not-allowed`. The preflight allows `GET, POST` today, so the Lab uses no other methods.
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
  /** An LC-03 reading during the fouled-sensor scenario, so the page can show the same record failing and then processed. */
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
  | "bench-unavailable";  // 503: the lease's bench didn't answer

export interface LabError {
  error: string;
  code: LabErrorCode;
}
```

### Routes

| Route | Session | Does | Answers |
| --- | --- | --- | --- |
| `GET /api/lab/status` | Not needed | The pool at a glance, for the busy and unavailable states | 200 `LabStatus` |
| `POST /api/lab/lease` | Started if missing | Join: a lease at once if a bench is ready and nobody is waiting, otherwise a place at the back of the line. Idempotent: a session that already has a place or lease gets it back. | 200 `LabLease` (`ready` or `queued`); 429 `too-many-places`; 503 `queue-full`, `lab-unavailable` |
| `GET /api/lab/lease` | Required | The session's place or lease; the heartbeat | 200 `LabLease`; 401 |
| `POST /api/lab/lease/return` | Required | Leave the line or return the bench early. Empty body. Idempotent. | 200 `LabLease` (`ended` with `left` or `returned`, or `none`); 401 |
| `POST /api/lab/lease/token` | Required | A bench token for the session's lease. The first one claims the lease (`ready` becomes `active`). | 200 `LabToken`; 409 `no-lease`; 503 `bench-unavailable` |
| `POST /api/lab/actions` | Required | Body `{ "action": LabAction }`: one scenario action on the session's own bench | 200 `LabActionResult`; 400 unknown action; 409 `no-lease`, `not-applicable`; 429 `too-many-actions`; 503 `bench-unavailable` |
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
- **Bench failure.** The field station polls each bench's status every 5 seconds. A bench that doesn't answer for 15 seconds, or reports another lease or none, ends its lease as `bench-failed` and is marked `unavailable` until a reset succeeds.
- **Field station restart.** Leases and the line live in the field station's memory. On startup it resets every bench before granting anything, which also disconnects any visitor still on a bench. Pages then see `none` (or 401 if their session also ended) and say that the Lab restarted.
- **What the page shows.** `none`: the scenarios, "Borrow a bench", and the pool from `GET /api/lab/status`. `queued`: position, line length, `nextFreeAt`, a way to leave, and the local-run instructions (PLAN.md). `ready`/`active`: bench number, time left from `expiresAt − now`, the scenario controls (disabled until `nextActionAt`), the views, and the feed. `ended`: why, and a way to join again. No bench ready and `enabled` true: busy. `GET /api/lab/status` failing, `enabled: false`, or every bench `unavailable`: the unavailable notice ([ui-components.md](ui-components.md#4-notices-including-the-unavailable-state)).

## 5. Scenario actions

At most one a second per lease (field station, 429 `too-many-actions` with `Retry-After: 1`) and per bench (bench API). Each action applies only to the session's own bench and only when its precondition holds; otherwise 409 `not-applicable` and nothing changes. Reset undoes all of them.

"Views" below are the page's own SDK subscriptions to its bench (the bench serves only public creek channels: no `holt`, no `notebook`). The page shows timings it measures itself, from the action's response to the state it observes, labeled as measured on this deployment just now.

| Action | Precondition | The bench | The visitor observes |
| --- | --- | --- | --- |
| `sensor.foul` | Calibration present | Removes LC-03's calibration table; the bench's `map` handler throws on the next LC-03 reading. | At the next LC-03 reading: a `record` item (`failed`, with its topic, partition, and offset), a trace `map` `failed` `HANDLER_FAILED` on the `station` channel, and the source `paused` with reason `HANDLER_FAILED`. Every view on that source goes `stale` with reason `SOURCE_UNAVAILABLE`: the public error, while `HANDLER_FAILED` appears only in the trace. Nothing after that record is processed or committed. |
| `sensor.restore` | Calibration removed | Puts the table back. | `calibration: "present"`; the source stays `paused` and the views `stale`: StreamOtter never resumes a paused source on its own. |
| `source.resume` | Source `paused` | `gateway.resumeSource()` for the bench's source. | StreamOtter retries the same record: a `record` item `processed` with the same offset, trace `map` `ok`, the source `healthy`, and every view `authorizing`, `synchronizing`, then `live` from a fresh snapshot. With the table still removed, the same record fails again and the source pauses again: nothing is skipped. |
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

**Delivery and rate.** Polling, not server-sent events: it fits the field station's request-and-response API and its budget, needs no long-lived connections through Cloudflare, and doubles as the heartbeat. The page polls `GET /api/lab/trace` once a second while its lease is active and stops when it ends. The bench keeps the last 500 items per lease and returns at most 100 per request; if the page falls behind, the response has `gap: true` and continues from the oldest item kept, and the page says some steps weren't shown.

## 7. Reaching the bench gateway

- **Bench gateway configuration**: its own `projectId` (for example `lontra-creek-lab-1`; V1 supports one gateway per project), `gateway.host` `0.0.0.0` on the Compose network (only Caddy publishes a port), `gateway.port` 7400, `gateway.path` `/lab/N/socket.io`, and `allowedOrigins: [SITE_ORIGIN]` (`https://streamotter.app` in production; the dev origins from F.1 locally). Kafka over TLS with SCRAM, like production. Limits: `maxConnections` small (a few tabs plus the satellite; suggest 8) and `maxSubscriptionsPerConnection` 12.
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

**Reset**, in order, until the bench reports `ready`:

1. Clear the current lease, so `authenticate` refuses its tokens from this moment, and forget its tokens.
2. `gateway.revoke({ kind: "subject", tenantId, subject: "lab-<leaseId>" })`: its connections close with `UNAUTHENTICATED`.
3. Stop the satellite client.
4. Restore the calibration table and the relay.
5. Resume the source if it's paused, and wait until it's `healthy` (after a relay cut this takes up to 30 seconds).
6. Clear the feed buffer.
7. If the source isn't healthy within 60 seconds, restart the gateway once; if it's still not healthy, report `failed`.

**Bench environment.** Its own service token; `SITE_ORIGIN`; its Kafka credentials (preferably a SCRAM user of its own); its management token, generated at startup unless supplied, never logged. **Never** `FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`, another bench's token, or the production gateway's or field station's Kafka passwords. The bench's snapshots come from a bench-scoped source (E2.0 decides which), never the field station's internal API, which serves every notebook to anyone holding its service token.

**Field station environment** (names are suggestions for `be-lab` and `devops`): `LAB_BENCHES` (the three bench API origins; unset means `enabled: false`), `LAB_BENCH_1_SERVICE_TOKEN` to `LAB_BENCH_3_SERVICE_TOKEN` (32 characters or more, from `deploy/make-secrets.sh`), `LAB_LEASE_SECONDS`, `LAB_QUEUE_MAX`.

## 9. What the relay cut must do

E2.0 chooses and proves the mechanism. Whatever it is, the contract requires:

- `relay.cut` makes the bench's source `stale` for visitors within **20 seconds**, and `relay.restore` brings it back to `live` within **30 seconds**, measured in CI on amd64 and arm64 and recorded with where they were measured.
- It cuts only that bench's path to Kafka: other benches, the production gateway, and the field station are unaffected.
- The bench API, the bench's feed of creek data, and its snapshots never travel over the path that gets cut.
- The bench API is its only control; visitors reach it only through `POST /api/lab/actions`.
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
| **T7 A compromised bench reaches production** | M11 benches hold no production secrets and don't use the field station's internal API; own SCRAM user | U3, review |
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
| M9 | One service token per bench API; the bench API is on the Compose network only. | `be-lab`, `devops` |
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

Unit tests (`npm test`): **U1** the bench's gateway options register no principals and no fixture sources; **U2** the bench refuses to start when its management API lists a principal; **U3** the bench's configuration refuses production secrets in its environment; **U4** the bench config passes production validation (M12); plus the lease state machine with a fake clock (claim, idle, expiry, session cap, reset, field station restart).

### 10.7 Residual risks

- **R1 The gateway's own attack surface.** A bug in the gateway, Socket.IO, or the handlers that an anonymous or leaseholding client can trigger is as serious on a bench as on the production gateway. Benches add three more instances of the same code; development mode adds no reachable code path beyond D2 and D3.
- **R2 No Kafka authorization.** The broker has no authorizer (`deploy/kafka/start.sh`), so any SCRAM user can read and write every topic. A compromised bench, like a compromised production gateway, could read `field.notebooks` or write into `field.*` and pause the production source. Per-bench users make rotation and attribution possible; ACLs (`lab-N.*` read-only for bench N) would contain it, at the cost of changing the production broker. Recommended after launch, for the production gateway too.
- **R3 Denial of service.** Stock Caddy has no rate limiter, so floods of WebSocket handshakes reach the benches (each rejected cheaply) as they reach the production gateway today. Queue abuse from many addresses can still fill the line. Cloudflare's free plan is the outer layer.
- **R4 A release upgrade can change any of this.** D2–D5 are implementation details of `0.1.0-rc.3`. R.1 (release upgrade) must redo section 10.2 against the new published source and rerun S1–S6.

### 10.8 Verdict

Yes, development-mode benches can face the public with these mitigations. In `0.1.0-rc.3`, development mode reaches the public Socket.IO endpoint in exactly two ways: a handshake without `Origin` is accepted, and a preview token for a development principal bypasses `authenticate`. The first is harmless, because the token is the boundary and Caddy restores production's `Origin` rule anyway. The second is closed completely by registering no development principals (M1), with the management API, the only minter, confined to each bench container's loopback and never proxied (M2, M3). Everything else a visitor can reach is the same code production runs. Lease-bound, bench-minted tokens whose principals expire with the lease (M4–M7) keep visitors on their own bench for their own five minutes, and S1–S6 prove it in CI on every stack change. What remains (R1–R3) is the exposure the production gateway already has, and R2 is worth closing for both. The one standing obligation is R4: re-verify this analysis whenever the pinned release changes.

## 11. Open points

- **E2.0** settles `createGateway` or `streamotter dev` in PLAN.md (section 1 recommends `createGateway`), where the bench's feed and snapshots come from, and the relay mechanism.
- **E2.1** adds the bench project (its channels, `LabChannels` types for the site) and the calibration table; generated files for the site follow the section 7 ownership of that sprint.
- **L.2** decides how the Lab runs locally; until then, with `npm run dev`, `/api/lab/status` answers 404, which the page treats as unavailable.
- **The owner** decides section 10.8.
