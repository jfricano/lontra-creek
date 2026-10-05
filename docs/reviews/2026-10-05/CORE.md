# CORE review: field station outside the Lab and sandbox, and the simulator

Reviewed: main at `d6e426a` (`<main checkout>`, StreamOtter 0.1.0-rc.3) and PR #42 head `61184c1` (`<#42 checkout>`, StreamOtter 0.2.0-rc.1). The phase-one setup is assumed throughout: the shared host, Lab and sandbox off, `KAFKA_AUTHORIZATION=none`.

Repros are in `<scratch>/work-core/`. Each takes `WT=<worktree>` (the default is main) and is run from the worktree root with `PATH=/opt/node24/bin:$PATH`.

**Summary: 0 blockers, 3 majors, 2 minors.** Every finding is present in both main and #42. In my area, #42 changes only the StreamOtter pin and the single-origin rule for `SITE_ORIGIN` in production, and neither adds or fixes a defect here.

| ID | Sev | Where | One line |
| --- | --- | --- | --- |
| CORE-1 | Major | both | One client holds all 300 gateway connections with a single badge, and every later visitor is refused `OVERLOADED`. |
| CORE-2 | Major | both | Prior F2 is still open, and worse: one host with an IPv6 /64 fills the global cap of 5,000 open notebooks in about 7 s, which locks every visitor out of sightings for 30 min. |
| CORE-3 | Major | both | Prior F1 is still open: a failing hourly checkpoint stops every creek publish, while `/healthz` keeps saying Kafka is connected. |
| CORE-4 | Minor | both | With no usable checkpoint, catching up under the shared host's 0.18 CPU takes longer than the health check allows once the study is about 12 days old. |
| CORE-5 | Minor | both | Badge subjects carry only 32 random bits, so sessions can collide and share another visitor's notebook. |

---

## CORE-1: One badge can hold every gateway connection (Major, both)

**Where:**
- `apps/field-station/src/project.ts:166` (`HOSTED_LIMITS: { maxConnections: 300, ... }`, emitted into `streamotter.production.json` `limits`)
- `apps/field-station/src/kafka-handlers.ts:78` (`authenticate` only verifies the token)
- `deploy/Caddyfile.shared` (the `/streamotter/*` route has no per-client limit)
- Upstream behaviour: `@streamotter/gateway/src/runtime/gateway.ts:353` (rc.3). The only check is the global `sessions + pendingHandshakes >= maxConnections`. 0.2.0-rc.1 keeps the same check and adds abandoned handshakes to it.

**What's wrong:**
- The hosted gateway's only connection bound is global.
- Nothing in the chain (Cloudflare defaults, the shared edge, Caddy, the gateway, Lontra's `authenticate`) limits connections per client, per subject or per token.
- A badge token is valid for up to 10 minutes and can be presented on any number of handshakes.

**Failure scenario:**
1. An attacker makes one `POST /api/badge`, which needs no Origin and fits inside the per-IP budget.
2. They open 300 WebSocket connections to `wss://demo.streamotter.dev/streamotter/socket.io` with `Origin: https://streamotter.dev` and that one token.
3. Every real visitor's live panel, walkthrough and notebook is now refused with `OVERLOADED` ("The gateway has reached its connection limit").
4. Sessions close when the token expires, so the attacker mints another badge every 10 minutes and reconnects.

**Repro:** `work-core/conn-exhaust.ts` runs the real gateway from each worktree's pin, with Lontra's handlers, production limits and allowed origins (fixture sources, since production mode needs TLS Kafka). Output:
```
$ node .../conn-exhaust.ts                    # main, rc.3
limits {"maxConnections":300,"maxSubscriptionsPerConnection":12} origins ["https://streamotter.dev"]
attacker connections accepted: 300 with one badge, subject volunteer-307e534d
next visitor: refused (OVERLOADED)
$ WT=<#42 checkout> node .../conn-exhaust.ts   # #42, 0.2.0-rc.1
attacker connections accepted: 300 with one badge, subject volunteer-bccb6df5
next visitor: refused (OVERLOADED)
```

**Suggested minimal fix:**
- At the edge, add a Cloudflare rate-limiting rule on `/streamotter/socket.io` per client (IPv6 by /64; see CORE-2).
- In `authenticate`, cap handshakes per token `sid`, for example 3 within the token's lifetime, using a small in-memory map keyed by `sid` that is dropped at `exp`. The page fetches a fresh badge for each connection anyway.
- Together with CORE-2's per-/64 budget, 300 connections then need about 100 badges from distinct /64s instead of one request.

---

## CORE-2: One /64 fills the global notebook cap in seconds (Major, both; prior F2 still open, now one-host)

**Where:**
- `apps/field-station/src/server/notebooks.ts:31,144` (`MAX_OPEN_NOTEBOOKS = 5_000`, a global cap with no per-client share)
- `apps/field-station/src/server/http.ts:92-95,134` (the request budget is keyed by the exact `X-Client-IP` string)
- `sessions.ts:69-70` (anyone can mint a fresh session)

**What's wrong:**
- CODE_REVIEW_2026-10-02 F2 isn't fixed. There is still no per-address cap on open notebooks.
- The per-client budget (burst 30, 1/s) is per full address. Cloudflare and the shared edge pass IPv6 visitors' real /128.
- Any VPS or home connection with a /64 therefore has an unlimited number of fresh budgets. One host, not "about 6 IPs", is enough.

**Failure scenario:**
1. From addresses in one /64, the attacker repeats `POST /api/badge` then `POST /api/notebook/sightings`, opening 5,000 notebooks that each live for their 30-minute session.
2. Every real visitor's first sighting in walkthrough chapter 6 then gets 503 "The field station has too many open notebooks".
3. Repeating every 30 minutes keeps the cap full.

**Repro:** `work-core/notebook-cap-ipv6.test.ts` runs the real `publicApi`, default limiter and real `Notebooks`. It fails on both worktrees:
```
opened 5000 notebooks from one /64 in 7.1 s; open now 5000; a real visitor's first sighting: 503   (main)
opened 5000 notebooks from one /64 in 6.1 s; open now 5000; a real visitor's first sighting: 503   (#42)
```

**Suggested minimal fix:**
- In `clientAddress`, bucket IPv6 by /64 (`addr.split(":").slice(0,4)`, after expanding `::`). This also helps the Lab's per-address cap later.
- Store the creating client address on each `Book` and refuse a new notebook when that address already has, say, 3 open.
- Optionally raise `MAX_OPEN_NOTEBOOKS`; each notebook is under 2 KB.

---

## CORE-3: A failing hourly checkpoint stops every creek publish (Major, both; prior F1 still open)

**Where:** `apps/field-station/src/server/station.ts:168-174` (`advance`)

**What's wrong:**
- This is unchanged since CODE_REVIEW_2026-10-02 F1, and REVIEW_FINDINGS for v1.1 doesn't list it.
- `advance()` awaits `checkpoint()` before `flush()`.
- `#lastCheckpointAt` is set only on success, so once a checkpoint write fails, every later tick throws before flushing.

**Failure scenario:**
1. The `field-data` volume becomes unwritable: the shared host's disk fills, or a restore leaves a permission or ownership change. The world keeps advancing.
2. The internal snapshot API serves current views, but the creek's views never reach Kafka again. Live subscribers see the creek freeze.
3. Creek views go out only incidentally, when a notebook sighting or expiry triggers a flush of the shared queue.
4. `/healthz` stays 200 with `kafka: "connected"`, because no send ever failed. Only an "Advancing failed" log line every 2 s shows the problem.

**Repro:** `work-core/checkpoint-blocks-publish.test.ts` blocks `world.json.tmp` and advances past the hour. It fails on both worktrees:
```
pending 13; healthz would say kafka connected
AssertionError: expected a batch per tick; got 0, and 13 views never leave the queue
```

**Suggested minimal fix:** the patch from the prior review:
```ts
try { if (this.#now() - this.#lastCheckpointAt >= CHECKPOINT_EVERY_MS) await this.checkpoint(); }
finally { await this.flush(); }
```
Optionally, have `/healthz` report a checkpoint that is more than about 2 hours old.

---

## CORE-4: Catching up without a checkpoint outlasts the health check on the shared host (Minor, both)

**Where:**
- `apps/field-station/src/server/station.ts:153-158` (catch-up from tick 0 when the checkpoint is missing or doesn't match)
- `deploy/compose.yaml:86-90` (field-station health: `start_period: 60s`, `interval: 10s`, `retries: 6`)
- `deploy/compose.shared.yaml:17` (`cpus: 0.18`)
- `gateway.depends_on: field-station: service_healthy`

**What's wrong:**
- Catch-up runs about 23,500 ticks/s on one full core here. That is roughly 4,200 ticks/s at the shared host's 0.18 CPU (estimated from the quota; I couldn't measure under a real cgroup).
- `/healthz` is 503 until the station catches up. Docker marks the container unhealthy about 120 s after start, which allows roughly 500k ticks: an epoch about 11.6 study days old at `FIELD_TICK_MS=2000`.
- Past that age, any start without a usable checkpoint makes `up --wait` fail with the gateway never started. Such starts include:
  - the documented `FIELD_GENERATION` bump (DEPLOYMENT_PLAN.md:72,178);
  - a lost or unreadable `world.json` (it is written without fsync);
  - a first activation on the shared host that preserves `FIELD_EPOCH` but not the `field-data` volume.

  The station becomes healthy minutes later, but Compose has already given up.

**Failure scenario:** 30 days into the hosted study, the operator raises `FIELD_GENERATION` for a simulation change, as the runbook says to.
1. The station must recompute about 1.3M ticks, which takes about 5 minutes at 0.18 CPU.
2. The field station goes unhealthy at about 2 minutes, and activation reports failure with the gateway not started.

**Repro:** `node work-core/catchup-speed.ts 300000` prints `300000 ticks in 12788 ms: 23460 ticks/s`. The threshold is that rate × 0.18 × 120 s. The health-check numbers are from `compose.yaml`.

**Suggested minimal fix:**
- Raise the field-station `start_period` on the shared overlay to cover the expected catch-up, for example `start_period: 15m`; checks still pass as soon as the station is ready.
- Or report "catching up" as healthy for Docker's purposes while `/healthz` keeps telling Caddy and operators the truth.
- Document the catch-up time next to the generation-bump instructions.

---

## CORE-5: Badge subjects have only 32 random bits (Minor, both)

**Where:** `apps/field-station/src/sessions.ts:70` (`subject: \`${role}-${randomUUID().slice(0, 8)}\``). The subject is the notebook owner (`access.ts`, `notebooks.ts`).

**What's wrong:**
- Subjects are 8 hex digits. Two sessions that draw the same subject read and write one notebook. PLAN.md:191 says "Two sessions must not be able to read or affect each other's notebook."
- If the earlier session's notebook is already expired but still held for up to 2 h, the new visitor's sightings all get 410 "This notebook has closed with its session."
- By the birthday bound, 300k sessions give about 10 reused subjects.
- With realistic traffic the chance of hitting a *live* notebook is small. An attacker who can mint badges cheaply (CORE-2's per-address budget) can hunt for collisions with other visitors' notebooks.

**Repro:** `node work-core/subject-collisions.ts 300000` prints `300000 new sessions -> 9 reused subjects (expected about 10.5)`.

**Suggested minimal fix:** use the full `randomUUID()`, 36 characters, which still fits `observerId`'s maxLength of 64.

---

## Prior-review items re-checked

- **F1:** still open, reported as CORE-3.
- **F2:** still open, reported as CORE-2.
- **L6** (error answers without CORS): fixed. `cors` is hoisted and passed to the 400 (`http.ts:103,201-203`).
- **Info items still present, not re-reported:**
  - a token can outlive its session by up to 60 s;
  - the rate limiter sweeps the whole map once it holds more than 10k buckets;
  - request bodies are decoded per chunk.

---

## Checked and found correct

**StreamOtter integration, rc.3 (main) and 0.2.0-rc.1 (#42)**
- I diffed `@streamotter/{gateway,contracts,client,cli}/src` between the two versions. The changes that touch Lontra are all compatible:
  - the larger `maxControlFrameBytes` minimum (Lontra sets none);
  - production answering a schema-invalid subscribe with FORBIDDEN;
  - `withoutUndefinedProperties` on map output and snapshot data;
  - recovery boundaries, which apply only with `failureHandling` (unset);
  - `authenticate` gaining a `signal`;
  - the CLI `start` flags, all optional.
- Map, snapshot, authorize and authenticate signatures are unchanged.
- The `identityKey` is still subject-only, so a token refresh keeps views open.
- `streamotter validate` passes all three `streamotter*.json` files on both pins, with the same fingerprints.
- `node scripts/configs.ts --check` exits 0.
- `streamotter generate` on both pins differs from the committed generated files only in the deliberate `streamotter/client` import path, and the site's copy is identical.
- `npm run typecheck` is green on #42. `npm test` passes 294/294 on main and 441/441 on #42.
- `check-release-pins.mjs` passes on #42, and the lockfile resolves every `@streamotter/*` from registry.npmjs.org at 0.2.0-rc.1.

**Schemas and simulation**
- I ran 400,000 simulation ticks (about 1,390 study days) and validated every changed view against the production payload schemas: no violations.
- Observed extremes leave wide margins: stage at most 4.63 ft (limit 40), flow at most 228 cfs (limit 100,000), water temperature 7.3–14.9 °C (limits −5 to 40), turbidity at most 30.3 NTU (limit 5,000).
- The frame label fits 16 characters for 11-digit frame counts, and `day` fits 1e6 for about 18 years.
- The simulation is deterministic across checkpoint and restore: the RNG state and floats round-trip through JSON. `currentEmissions` republishes each view with the revision of its last change and identical data, so restarts and gateway resyncs can't raise `REVISION_CONFLICT`.
- Revisions are generation × 10¹² + tick. Notebook revisions are strictly increasing write times, restored from the topic.

**Auth, CORS and Origin**
- The gateway's `allowedOrigins` is exactly `https://streamotter.dev`, and production rejects a missing Origin (gateway.ts:339-343).
- The `/api` CORS allow-list comes from `SITE_ORIGIN`, with credentials.
- Foreign-Origin POSTs to `/api/badge` and `/api/notebook/sightings` get 403. `Origin: null` is refused.
- The cookie is `HttpOnly; SameSite=Strict; Path=/api; Secure`. streamotter.dev and demo.streamotter.dev are same-site, so the cookie is sent and isn't third-party.
- Session and badge HMACs use domain-separated keys and constant-time compares. Expiry is enforced.
- The notebook owner comes from the cookie, and `mayRead` limits holts to researchers and a notebook to its owner.
- Internal API: service token compared in constant time, GET only, and notebook snapshots only once loaded.
- #42's single-origin rule for `SITE_ORIGIN` in production matches every Compose file, which all default to a single origin.

**Durability and restarts**
- Checkpoints are written then renamed; mismatched or unreadable checkpoints fall back to recomputing.
- The startup republish and "write, then publish" ordering hold, so a snapshot is never older than Kafka.
- The queue keeps the latest record per key while Kafka is away and runs one batch at a time.
- The producer is idempotent, uses `acks -1`, and reconnects with `ensureTopics` after a failure, which also recreates topics after a Kafka volume reset.
- `readAll` is correct for a compacted and deleted topic: the latest record per key is never compacted away, and an all-deleted partition has low equal to high.
- Notebooks are rebuilt from the topic keeping the highest revision, and open-but-expired ones are closed on load.
- After a gateway restart, the consumer group resumes from committed offsets, `startFrom: latest`, with a fresh snapshot.
- A graceful shutdown closes listeners, flushes with a deadline and checkpoints. I tested `server.close()` against keep-alive clients; it completes within Node's 5 s keep-alive timeout under normal traffic.

**Resource limits**
- Bodies are capped at 4 KB, and Caddy caps them at 8 KB.
- Notebook entries are capped at 20 and limited to one sighting a second.
- The rate-limit bucket map is swept.
- Publish-queue size is bounded by the number of keys.
- `maxSubscriptionsPerConnection` of 12 covers the largest page, the walkthrough at 4 views.
