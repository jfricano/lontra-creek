# LAB review findings

Summary: 2 major, 6 minor. The lease pool, study discard, and publisher gate are careful and well tested. The defects are at the edges: timing across a grant, a bench process restart, slow resets, and the not-yet-bound coverage ledger.

All repros were throwaway `node:test` files run against `b02b46f`, then removed; each became a regression test with its fix.

## LAB-1 A queued visitor whose last poll is over 30 s old loses the lease as `idle` within seconds of the grant  (major)
- Where: apps/field-station/src/lab/leases.ts:79-85 (grant), :55 (idle check), :91 (`heartbeat`)
- What: when a place in line is granted, `place.heartbeat` is not refreshed. From that moment the 30 s active idle limit is measured against the heartbeat from the queue. That heartbeat may be up to 90 s old (the queue limit, set that high because background tabs poll less often). `heartbeat()` also refuses to refresh a place whose age is already past the new 30 s limit, so even the visitor's next poll can't save the lease.
- Failure scenario: B waits in line in a background tab. Browsers throttle hidden tabs hard after about 5 minutes (chained timers run about once a minute), so B's last poll was 50 s ago. A returns the bench, and B is granted (`ready`, `claimBy` 30 s away). The next 5 s maintenance sweep ends B's lease as `idle`. If B switches back at grant + 3 s, the `visibilitychange` poll arrives with a heartbeat that is 53 s old. `heartbeat()` ignores it, and the same request's sweep ends the lease. B sees "Your lease ended: idle" instead of getting the 30 s claim window the contract promises (§2 Claim window, §4 Claiming).
- Evidence: repro R2. Grant at 12:00:50, sweep at 12:00:55 → `{"status":"ended","reason":"idle","endedAt":"2026-10-03T12:00:55.000Z"}`. The assertion that B is still `ready` fails.
- Suggested fix: set `place.heartbeat = now` when the lease is granted, or measure an unclaimed lease's idleness from `max(heartbeat, granted)`.

## LAB-2 After a bench process restart resumes a lease, the page's feed cursor gets 400 and the "gap" notice is never delivered  (major)
- Where: apps/field-station/src/lab/runtime.ts:180 (`this.#feed.reset(study.lease!.leaseId)` on resume); apps/field-station/src/lab/feed.ts:29-34 (cursor validation)
- What: on resume, the feed restarts its sequence at 0 under the same lease prefix. The page still holds a cursor like `lease-1:21` from the old process. `page()` rejects any cursor greater than the new sequence with 400 `invalid-request`. The field station passes that 400 through, and the page shows "The Lab didn't accept that request." on every 1 s feed poll. Once enough new items arrive, the old cursor becomes valid again. The page then silently skips the restarted items, including the `gap` marker the bench added for exactly this case, and the response has `gap: false`.
- Failure scenario: a visitor in an active lease has read 21 feed items. The bench container restarts (LC11-A15, "restart keeps the study") and resumes the lease. `GET /api/lab/trace?after=lease-1:21` returns 400 until the new sequence passes 21. With a held or paused source (the restart-recovery story), few items arrive, so the feed can stay broken for the rest of the lease. When it recovers, items `lease-1:1..21` (the gap notice and the first post-restart events) are never shown.
- Evidence: repro R1. `page cursor lease-1:21 | restarted bench: state leased items [["lease-1:1","gap"]]`, then `GET feed?after=lease-1:21 -> invalid-request`, then later `gap false first ids ["lease-1:22",...] gap item delivered? false`.
- Suggested fix: give each bench process (or each feed reset) its own cursor epoch, for example `lease:<epoch>.<seq>`. Answer a cursor from an older epoch as "from the start with `gap: true`" instead of 400. Alternatively, persist the sequence with the study.

## LAB-3 A reset that takes 60–90 s loops forever: the 30 s retry discards a bench that has already recovered  (minor)
- Where: apps/field-station/src/lab/leases.ts:59 and :72
- What: a slot marked `unavailable` is never polled before its retry. At `retryAt` the pool sends `POST /bench/v1/reset` regardless of state, so a bench that reached `ready` in the meantime is reset again. Its clean study is discarded and provisioning starts over.
- Failure scenario: each reset takes 70 s (slow broker: up to 15 s for the gate close, a 5 s quiesce, the group delete, and a gateway start that can take up to 30 s). At t=60 the slot is marked `unavailable`. At t=70 the bench is ready. At t=90 the pool resets it again, and the cycle repeats. The bench is never granted, and visitors see "unavailable".
- Evidence: repro R5. Over 10 simulated minutes: `full resets 7 | slot ever ready? false`.
- Suggested fix: when `retryAt` arrives, poll first and reset only if the bench isn't `ready` with `cleanLease`. Alternatively, keep polling `unavailable` slots and promote them when they report clean.

## LAB-4 One failed management poll during `gateway.restart` fails the bench and ends the visitor's lease  (minor)
- Where: apps/field-station/src/lab/runtime.ts:291 (`await this.#poll(true)` before the stop), and the `#poll(false)` at the end of `#startGateway` (:154)
- What: the restart job calls `#poll` outside the poll-grace logic. A single slow (3 s timeout) or failed loopback management call rejects the job, which sets `state = 'failed'`. The field station then ends the lease as `bench-failed`. This contradicts §2/§8 "one slow or failed poll changes nothing".
- Evidence: repro R4. With exactly one failing `/management/v1/sources` answer, a `gateway.restart` leaves the bench in `failed` (assertion expected `leased`).
- Suggested fix: make the pre-stop drain best-effort (catch and add a `gap`). For the post-start poll, treat a failure like a background poll failure (start the grace clock) instead of failing the restart.

## LAB-5 Coverage ledger: a later run with an earlier tick rolls served state backwards and un-acknowledges an issued barrier  (minor, latent until W9b binds)
- Where: apps/field-station/src/lab/studies.ts:210 (`#write` overwrites `study.views` unconditionally); used by `beginRun` and `prepareCoverage`
- What: the study's own write for an instance is replaced even when the new revision is lower. A repeated `prepareCoverage(run-1)` after run-2, or two runs whose mutation ticks arrive out of order, therefore moves the served snapshot to an older revision. That breaks "a snapshot is never older than anything already published". A barrier already issued for the higher revision then reports `lagging` forever, and the native barrier would keep the view out of `live`.
- Evidence: repro C1. Run-1 at tick 505 (established, assessed `recoverable`), then run-2 at tick 501: `before run-2: 1000000000505 {"acknowledged":true}`, then `after run-2: 1000000000501 {"acknowledged":false,"reason":"lagging"}`.
- Suggested fix: in `#write`, keep the higher revision per key (`if (!own || BigInt(revision) >= BigInt(own.revision))`). Make `prepareCoverage` a no-op for an entry that is already established.

## LAB-6 The publisher gate can admit a send after `close()` has returned `inFlight: 0`  (minor, latent until W9b binds)
- Where: apps/field-station/src/lab/studies.ts:214-221 (`publish`)
- What: `publish` checks `study.state === 'open'`, then `await`s `this.ledger(...)`, and only then calls `sink.send` and adds it to `inFlight`. If the ledger isn't cached yet (first use in the process, or after a failed open), `close()` can run in that gap. It sees no in-flight sends and returns, and the record then goes to Kafka after the gate reported closed. This violates ADR-02 step 3 ("refuses scenario publication ... before reset continues").
- Evidence: repro C2. Events: `[ 'close returned inFlight=0', 'kafka.send' ]`.
- Suggested fix: obtain the ledger first, then re-check `state === 'open'` and register the send in `inFlight` in the same synchronous step that starts it. Alternatively, register a placeholder in `inFlight` before the first `await`.

## LAB-7 A reset retried after a failed gate close writes the study summary with `leaseId: null`  (minor)
- Where: apps/field-station/src/lab/runtime.ts:236-239 and :252
- What: the first attempt consumes `#ended` and persists `study.lease = null` before `gate.close` fails. The retry therefore summarizes the old study with no lease. Because summaries are written once, the lease is never recorded. §8 step 5 says the summary carries the lease ID. The retry also skips the subject revoke (harmless only because the gateway is then stopped).
- Evidence: repro R6. Gate close refused once, reset retried: `summary.leaseId = null phase = open`.
- Suggested fix: keep the ended lease on the bench (or on the study descriptor, as `endedLease`) until the summary is written. Alternatively, write the summary before persisting `lease: null`.

## LAB-8 A grant is backdated to the start of the sweep, shortening the claim window and the lease  (minor)
- Where: apps/field-station/src/lab/leases.ts:51 and :79
- What: `now` is read once at the top of `sweep()`, which awaits bench calls inside the pool lock: each `/bench/v1/status` call takes up to 5 s, and so do `#reset`'s close and `POST`. A lease granted later in the same sweep uses the stale `now` for `granted`, `expires`, `claimBy`, and `nextAction`.
- Failure scenario: bench 1 hangs (5 s client timeout) while bench 2 is granted in the same sweep. The visitor's `claimBy` is 25 s away instead of 30 s, and `expiresAt` is 5 s short. With several slow calls, the loss adds up (up to about 15 s with three benches).
- Evidence: repro R7. `real time 12:00:10 | grantedAt 12:00:05 | claimBy 12:00:35`.
- Suggested fix: read `this.#now()` again at grant time, and in the status and catch branches.

## Checked and found correct
- Pool serialization: every state transition, including remote calls, runs under `LeasePool.run`. Concurrent joins grant each bench once. `#call` ends the lease only on non-4xx answers.
- Bench error mapping (`benchError`): 409 `no-lease` stays `no-lease`, other 409s become `not-applicable`, 429 and 400 pass through, and 401, 404, 5xx, and timeouts become 503 `bench-unavailable`, ending the lease (§4, §8).
- The address cap is checked and inserted synchronously across the Lab and sandbox pools. Ended places stop counting at once. An idempotent re-join doesn't count twice.
- The publisher gate closes the study the field station itself opened, never one from a polled status. A study the gate refuses is reset, and the visitor keeps their place. A closed study never reopens (64 remembered per bench).
- Reset order matches ADR-02 and §8: invalidate, revoke, gate close, quiesce, summary, relay restore, stop, group delete (GROUP_ID_NOT_FOUND counts as success; checked against the kafkajs 2.2.4 `KafkaJSDeleteGroupsError.groups` shape), directory removal, gate discard, strays, then provision. Each step is idempotent on retry, and the first summary is kept.
- Immediate invalidation over `/bench/v1/reset` while the queue is busy: a queued `gateway.restart` sees its closed scope and does nothing, and late handler and satellite callbacks are counted against the old study.
- Poll grace and tick queueing: at most one tick is in flight. Only 15 s of continuous failures fail the bench (apart from LAB-4). Actions are refused with 409 during a restart instead of queueing behind it.
- Field-station `LabStudies`: discard joins a concurrent discard. A superseded study is discarded through its own ledger instance. `#current` is deleted only if it is still that study. Paths are validated against the 16-character ID regex.
- Private routes: each bench uses only its own token (constant-time compare), assess accepts coordinates only (no record bytes), boundaries over 96 characters get 400, and all bodies are capped at 4 KB.
- Intents are validated, then refused with 409 `unsupported-scenario` after the Origin and session checks and before the pool, heartbeat, or any bench. Capabilities need no session, refuse any query parameter, and carry no URLs, secrets, or paths. The library version is read from the installed package. (Test gap only: the intent test covers a session without a lease, not one holding a lease.)
- `LAB_LEASE_SECONDS` over 300 is refused at startup. The bench refuses `expiresAt` more than 300 s ahead.
- Study and generation IDs fit rc.3's identifier and group-name rules, and per-study groups fall inside the `streamotter-lab-N-` ACL prefix (§10.9).
- Coverage guard and acknowledgment logic (apart from LAB-5): holds for withheld, pending, unknown, and no-coordinates; the barrier is cumulative; re-asking returns the current barrier; wrong-study, malformed, and unknown barriers are never acknowledged.
