# LAB review: main d6e426a and PR #42 head 61184c1

Reviewer: independent. Scope: `apps/field-station/src/lab/`, its tests, the bench processes, `docs/contracts/lab-api.md`, and the Lab routes in `server/http.ts`. Library behavior was checked against the installed `streamotter@0.2.0-rc.1` sources (`node_modules/@streamotter/*/src`) and, for main, `0.1.0-rc.3`.

Summary: **0 Blocker, 0 Major, 5 Minor.** All five are on **#42**. Main's Lab is clean for phase one: with the Lab off, every `/api/lab/*` route refuses cleanly and nothing internal can be reached.

Baseline test runs:
- main: `node --test --test-force-exit apps/field-station/test/lab-*.test.ts` passed 69/69.
- #42: the same command passed 134/134.

Repro files are in `scratchpad/review/work-LAB/`. They import from the #42 worktree, and `node_modules` there is a symlink to the worktree's.

---

## LAB-1: An approval token stays on offer after the library has dropped its plan (gateway restart)

- **Severity:** Minor
- **Tree:** #42
- **Where:**
  - `apps/field-station/src/lab/runtime.ts:366-373` (`gateway.restart`) and `:390-395` (`#restartGateway`)
  - `apps/field-station/src/lab/operator.ts:55-83` (`PlanTokens`) and `:221` (the token offered in the facts)

**What is wrong.** The library keeps its evaluation plans in memory only (`node_modules/@streamotter/gateway/src/operator/service.ts:91`, `#plans = new Map`), so a gateway restart loses them. The bench keeps its `BenchFailures` instance, and that instance holds the `PlanTokens` across a same-study gateway restart. The bench's incident facts therefore keep showing `evaluation.eligible: true` with a live `planToken` that no longer names a plan.

When the visitor approves:
- the redrive is refused with `plan-unknown`;
- `PlanTokens.take` has already deleted the token, so the visitor is left with nothing but a re-evaluation;
- the visitor-facing text for `plan-unknown` says the token was already used or belongs to another incident, and neither is true.

**Failure scenario.** A visitor on S04 (inspect-old-reading):
1. evaluates and gets a plan with an Approve button;
2. uses the LabAction `gateway.restart`, which the Lab offers on the same lease;
3. clicks Approve.

The approval is refused even though the incident and its revision have not changed (both are 6 before and after). The same happens if the gateway restart in `#arm` follows an evaluation. On the hosted retry profile, S04 is deployment-restricted, so today this is reachable on local and CI Labs and after the authorization migration.

**Repro.** `work-LAB/plan-after-restart.test.ts` uses the real BenchRuntime on the real library, with the `lab-failures.test.ts` harness.

```
$ PATH=/opt/node24/bin:$PATH node --test --test-force-exit plan-after-restart.test.ts
after restart: gateway "running" restarts {"gateway":2,"process":0}
facts.evaluation after restart: {...,"incidentRevision":6,"validation":"valid","eligible":true,...,"planToken":"0L6XgTPQ..."}
incident revision before/after: 6 6
{"message":"Operator operation",...,"kind":"redrive","result":"refused","outcome":"plan-unknown"}
approve after restart: {"intent":"incident.approve-reprocess","status":"refused","outcome":"plan-unknown",...}
✔ token still offered after gateway.restart; approval is refused
```

**Fix.** Call `this.#failures?.tokens.clear()` (and drop the cached evaluation's token) in `#restartGateway`, before the new gateway starts. The facts then show the plan as gone, and the projection's next action becomes `incident.evaluate` again.

---

## LAB-2: The recovery guard can ask about a record before the field station has recorded where it was published

- **Severity:** Minor
- **Tree:** #42
- **Where:**
  - `apps/field-station/src/lab/studies.ts:237-242`: the coordinates are recorded only after `sink.send` resolves.
  - `apps/field-station/src/lab/coverage.ts:216-218`: `assess` answers `hold unknown-record`.
  - Library: `@streamotter/gateway/src/failures/service.ts:539-541`. A `hold` sets recovery to `denied` and is not re-run on its own.

**What is wrong.** `LabStudies.publish` records the run's coordinates (`ledger.published`) only after the Kafka producer's acknowledgment has been processed in the field station. On Kafka, the bench's consumer can fetch the record as soon as the high watermark moves. The bench can then do all of the following before the field station's ack callback runs:
- map the record and fail;
- write the quarantine copy;
- call `/lab-internal/N/recovery/assess`.

In that case the ledger has no entry with those coordinates and answers `hold unknown-record`. The library treats that as a guard decision (`recovery: denied`) and does not ask again.

**Failure scenario.** inspect-old-reading publishes its projection-v2 record and then waits `ADVANCE_WAIT_MS` (30 s) for the incident to reach `advanced`. If the guard lost the race, the incident stays held and denied. The intent then fails with `advance-timeout` ("StreamOtter didn't advance past the bad-projection record in time", `intents.ts:429`), even though coverage was established before publication.

The same applies to any `pending`-coverage run the guard is expected to pass. Recovery takes a manual `incident.reassess`.

The window is narrow: the bench needs one extra produce round trip plus an HTTP call, while the field station only needs its event loop. It is most likely on the CPU-starved shared host. I could not measure the probability without Docker.

**Repro.** `work-LAB/ledger-race.test.ts` uses the real `LabStudies` and `FileCoverageLedger`. Its sink calls the guard's assessment while the send is in flight, which models the consumer seeing the record before the producer ack is handled.

```
assess while send in flight: {"decision":"hold","studyId":"studyAAAAAAAAAAA","reason":"unknown-record","evidenceRef":null}
assess after publish():       {"decision":"recoverable",...,"barrier":"lcb1.studyAAAAAAAAAAA.1",...}
✔ assessment of a record the bench already consumed answers unknown-record until publish() returns
```

**Fix.** Either of these is minimal:
- Record a "publishing" marker for the run before `sink.send`. When `assess` finds an unknown record while a send for that study is in flight (`study.inFlight.size > 0`), wait for the in-flight sends to settle, then match again.
- In `#start`, when the wait for `advanced` sees `recovery: denied` with reason `unknown-record`, issue one `incident.reassess` before giving up.

---

## LAB-3: The `deployment-restricted` check never looks at Kafka authorization, though its text and the contract say it does

- **Severity:** Minor
- **Tree:** #42
- **Where:**
  - `apps/field-station/src/lab/capabilities.ts:149`
  - `apps/field-station/src/lab/leases.ts:175-178` (`capabilityOptions`)
  - `docs/contracts/lab-api.md:826` and `:1006`
  - `deploy/kafka/start.sh:204-207`

**What is wrong.** The capability summary decides `deployment-restricted` only from `LAB_FAILURE_HANDLING` (`runsUnder(id)`). No field-station code reads `KAFKA_AUTHORIZATION` (`grep -rn KAFKA_AUTHORIZATION apps/field-station/src` finds only the evidence string). The reason text still says "This deployment's Kafka authorization isn't verified for this exercise". This causes two problems:
- **Quarantine profile on a broker with authorization `none`.** Five exercises are reported `available`, though the evidence records them only under `acl`. Under `none`, `start.sh` execs the broker before the bootstrap, so no `lab-N.quarantine` topic is ever created (`auto.create.topics.enable=false`). The summary therefore advertises exercises that no bench can serve.
- **Retry profile on a broker with `acl`.** The text blames Kafka authorization, which is in fact verified. The cause is the profile, so an operator is sent to the wrong setting.

**Repro.** `work-LAB/caps.mjs`:

```
{"LAB_FAILURE_HANDLING":"quarantine","KAFKA_AUTHORIZATION":"none"} -> garbled-reading:available bad-projection:available inspect-old-reading:available conflicting-readings:available calibration-blip:available too-many-bad-readings:deployment-restricted ...
{"LAB_FAILURE_HANDLING":"retry","KAFKA_AUTHORIZATION":"acl"} -> garbled-reading:deployment-restricted ... calibration-blip:available ...
   reason text: This deployment's Kafka authorization isn't verified for this exercise, so its failure handling doesn't run it.
```

**Fix.** Either:
- pass `KAFKA_AUTHORIZATION` to the field station and refuse `LAB_FAILURE_HANDLING=quarantine` unless it is `acl` (fail at startup in `capabilityOptions`); or
- reword the reason and contract section 12.3 item 4 to name the failure-handling profile, and document that quarantine requires `acl`.

---

## LAB-4: A profile mismatch between the field station and its benches resets every bench every 30 s, forever, without a log line

- **Severity:** Minor (ops only)
- **Tree:** #42
- **Where:** `apps/field-station/src/lab/leases.ts:61-64` (`#eligible`), `:85` and `:101`

**What is wrong.** A ready bench whose reported `failures.profile` differs from the field station's `LAB_FAILURE_HANDLING`, or a quarantine bench that is not durable, is treated as "its last cleanup didn't finish". It is marked unavailable and reset again 30 s later. A reset can never change the bench's profile, so the loop never ends. Each reset:
- discards the study;
- deletes the consumer group and journal;
- runs `streamotter init --failures`;
- restarts the gateway.

That is steady churn on the shared host. Neither the pool nor the HTTP client logs anything, because the bench answers 200 throughout. The Lab simply reports every bench `unavailable`. Compose sets both sides from one variable, but setting `LAB_FAILURE_HANDLING` on only one service, or a partial rollout, reaches this state.

**Repro.** `work-LAB/profile-mismatch.test.ts` uses the real `LeasePool`, a scripted bench client, and a clock advanced 10 minutes.

```
10 minutes: 20 bench resets (new study, new journal each), 0 log lines; pool status: {"enabled":true,...,"benches":[{"bench":1,"state":"unavailable"}],...}
```

**Fix.**
- Separate "wrong profile" from "not clean": when `status.failures.profile !== this.#profile`, log once per bench (`Lab bench N reports failure handling X; this field station requires Y`) and mark the bench unavailable without resetting it.
- Optionally surface the mismatch in the field station's health check.

---

## LAB-5: The contract still says the 0.2.0-rc.1 evidence and install come from the pre-publish `vendor/` pack

- **Severity:** Minor (docs that mislead an operator)
- **Tree:** #42
- **Where:**
  - `docs/contracts/lab-api.md:5`: "installs from a pre-publish pack until it is on npm".
  - `docs/contracts/lab-api.md:1004`: "For `0.2.0-rc.1` (the pre-publish pack in `vendor/`) the evidence is ... October 4, 2026".

**What is wrong.** `ddba0c3` removed `vendor/` and pinned the registry release. `VERIFIED_WITH` (`capabilities.ts:94-110`) now records the registry integrity values and the October 5 rerun, and `lab-api.md:781` and `SOURCE_FAILURE_EXERCISES.md:87` say so. Section 12.3, the normative description of what `VERIFIED_WITH` holds, still names the vendor pack and the October 4 run. An operator checking why a scenario is or isn't offered would compare against the wrong build and date. The commit message says "docs: rewrite what described the pre-publish pack as current", but these two places were missed.

**Repro.**

```
$ grep -n "pre-publish pack\|vendor/" docs/contracts/lab-api.md
5:  ... section 12 is served against `streamotter@0.2.0-rc.1`, which the phase 2 branch installs from a pre-publish pack until it is on npm ...
1004: ... For `0.2.0-rc.1` (the pre-publish pack in `vendor/`) the evidence is ... October 4, 2026 ...
$ ls vendor
ls: cannot access 'vendor': No such file or directory
```

**Fix.**
- Line 5: say the branch installs `0.2.0-rc.1` from npm.
- Line 1004: name the registry lockfile and the October 5 run, matching `VERIFIED_WITH.evidence`, and keep October 4 only as history.

---

## Checked and found correct

### main (d6e426a)

- **LeasePool** (`leases.ts`):
  - every mutation is serialized through `run()`;
  - FIFO queue; each bench is granted once;
  - `AddressCap` is 2 places per address across the Lab and the sandbox;
  - idle limits (30 s leased, 90 s queued), claim window 30 s, ended view kept 60 s;
  - session expiry caps the lease end;
  - a lease is granted only after `PUT /bench/v1/lease` and the publisher gate `studies.open`, and a refused gate resets the bench;
  - `benchError` mapping, and a 5xx ends the lease as `bench-failed`.
- **Lab off** (`LAB_BENCH_API_URLS` empty), checked in `http.ts:132-181`:
  - `GET /api/lab/status` answers `{enabled:false}`.
  - `POST /api/lab/lease` answers 503 `lab-unavailable`. The session cookie on that 503 is intended and asserted by `lab-http.test.ts`.
  - token, trace and action routes answer 409 `no-lease`.
  - `/lab-internal/*` with no tokens answers 401 on every route.
  - `deploy/Caddyfile.shared` answers 404 for `/lab/*` unless `LONTRA_LAB_ENABLED=1`, and sets `X-Client-IP` from `{client_ip}`, not from a client header.
- **Feed** (`feed.ts`): cursors are `<leaseId>:<epoch>.<seq>`; a cursor from another lease or epoch is refused `invalid-request`; the `gap` event follows a restart.
- **Tokens:**
  - the per-lease cap of 128 returns an existing token instead of growing;
  - `authenticate` checks lease expiry and token membership;
  - `#invalidate` clears every token before reset.
- **Reset and discard order** (`runtime.ts`): invalidate, revoke, gate close, quiesce, summary, relay restore, stop, delete group, remove directory, gate discard, provision.
- **Other main checks:**
  - the proxy's control-token check (`proxy.ts`, `proxy-main.ts`);
  - poll grace of 15 s for a restarting bench;
  - `docs/contracts/lab-api.md` matches the routes and codes above.
- Prior findings LAB-1..9 in `docs/releases/v1.1/review/LAB.md` are fixed, and none has regressed. The known limits (LAB-7's boot-time `leaseId:null`, SITE-2) are unchanged and documented.

### #42 (61184c1)

- **Intents** (`intents.ts`):
  - field validation (`parseIntent`) happens before the pool is touched;
  - idempotency via `byRequest` plus the request fingerprint, so a reused `requestId` with a different body is refused;
  - one intent at a time per lease;
  - `expectedRevision` is checked against a freshly composed projection;
  - every library `store.update` adds an event, so `scenarioRevision` (the `compose()` digest) moves on every incident change;
  - the `targets` map takes a projection revision to the library failureId and revision;
  - `ended()` cancels unfinished operations;
  - the `#bench` re-send loop ends (one re-send, a 60 s deadline, and `BenchNotFound` reported as bench-restarted);
  - the projection carries no native ID, path or studyId.
- **Operator use** (`operator.ts`, checked against `@streamotter/gateway/src/operator/service.ts`):
  - operation ids `lab<N>.<studyId>.<lop_id>` stay within `validateOperatorRequest`'s 128 limit, so a reused id replays;
  - `listFailures` limit 200 equals `MAX_FAILURE_PAGE`;
  - evaluate's `request`-stage refusals (not-found, stale-revision, generation-changed), `evidence`-stage refusals and `OVERLOADED` are each mapped to a distinct outcome;
  - `redrive` uses the plan's own revision and fingerprint, and the library claims the plan before acting;
  - plan tokens are bound to lease, study, failureId and revision, are single use, and never outlive the lease;
  - `resumeSource`'s `details.status: 409` becomes `not-applicable`.
- **Durability and profiles:**
  - `#startGateway` requires the library to report a `sqlite` and durable store under retry and quarantine;
  - a study without a journal is discarded at boot;
  - the journal is created only by `runCli(['init','--failures',...])`, refuses an existing journal, and has directory 0700 and files 0600;
  - `FailureService.stop` awaits `settled()` before closing the store;
  - `#discard` also deletes quarantine-read groups;
  - pool eligibility requires the same profile, plus durable unless the profile is `off`.
- **Coverage ledger and snapshot acknowledgment:**
  - matching by coordinates, never by bytes;
  - `withheld`, `pending` and `established` states;
  - a cumulative barrier `lcb1.<studyId>.<seq>`, with the obligation limit;
  - the bench echoes `recoveryBoundaryId` only when the ledger acknowledges;
  - `barrierCovers` refuses a barrier from another study;
  - a late publication into a discarded study's ledger writes nothing.
- **"Verified" claims:**
  - `VERIFIED_WITH`'s six integrity values equal `package-lock.json`'s registry entries;
  - `INSTALLED_INTEGRITY` is read from the lockfile beside the loaded `streamotter`, and the Docker image ships that lockfile;
  - `lab-capabilities.test.ts` independently re-reads the lockfile, so a new build cannot pass `npm test` without re-recording;
  - a different build of the same version is `not-integrated`;
  - with the hosted defaults (retry profile, `LAB_LOCAL_EXERCISES=0`), only `calibration-blip` is offered among the new scenarios, which matches the recorded retry evidence.
  - Apart from LAB-3's text, I found no path that reports an exercise as verified or available when it is not.
- **Bench environment:** the `CREDENTIAL` allowlist regex does not trip on the Compose bench environment or the node image's environment.
- **Trace types:** unchanged between 0.1.0-rc.3 and 0.2.0-rc.1.
- **HTTP:** the incident and operations routes are 404 unless the summary offers them, and intents answer 202.
