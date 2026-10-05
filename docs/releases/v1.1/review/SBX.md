# SBX (workbench sandbox session service and HTTP surface) review findings

Summary: 1 major, 7 minor. The session layer is careful and mostly matches its contract: isolation per study, the allowlist, Origin and header checks, and the honest `seam-unavailable` state all hold up. The main defect is that a reset can destroy the lease it is meant to keep.

Repro tests were written, run against `b02b46f`, then removed; each became a regression test with its fix.

## SBX-1 Reset while an operation is in flight ends the whole lease as `slot-failed`  (major)
- Where: apps/field-station/src/sandbox/leases.ts:154-162 (`#call`), :189-198 (`operate`); apps/field-station/src/sandbox/service.ts:160-171 (`operate`), :270-275 (`dispatch` catch-all).
- What: the service checks whether a study is stale only after a call succeeds. If an in-flight call fails because reset closed its runtime, `dispatch` answers 503 with `slot-unavailable`. The field station's `#call` then finds `place.lease === lease`, which is still true because reset keeps the same lease object, and ends the lease as `slot-failed`. The answer should be `stale-study` for the old study, with the lease kept.
- Failure scenario: an active visitor has a workbench request running (for example a `traces` poll, or a slow `source-checks`) and clicks Reset. Reset closes the old runtime, and the pending call rejects with a generic Error. The service treats that as a slot failure, and the field station ends the lease. The visitor loses their slot and goes back to the end of the line. The contract (§4, §8) says reset keeps "the same slot and lease" and that late answers from the old study are discarded as `stale-study`. The same happens when a native call fails with a 5xx `INTERNAL` error after a reset, because `nativeError` maps `INTERNAL` to null.
- Evidence: reproduced. The test wraps the fixture runtime's `call` so that a call still running when its runtime closes rejects, as a real gateway would. It then starts `traces`, calls `reset`, and releases the call. Output: `reset -> resetting`, `in-flight op -> SandboxFault ... code: 'slot-unavailable'`, `after: ended slot-failed`. The existing A42 "late answer" test passes only because the fixture's held call succeeds after the runtime is closed.
- Suggested fix: in the service's `operate`, catch errors and rethrow `stale-study` when `slot.study !== study || slot.runtime !== runtime`. In the field station's `#call`/`operate`, end the lease only if `lease.studyId` still equals the ticket's study; otherwise throw `stale-study`. Add a fixture mode in which closed runtimes reject pending calls.

## SBX-2 A refused `POST /api/sandbox/session` still sets a session cookie  (minor)
- Where: apps/field-station/src/sandbox/routes.ts:42-45 (cookie minted before any check), :64-67 (the catch sends `...cors`, which includes `set-cookie`).
- What: the cookie is minted and put into the shared `cors` header object before the availability, cap, queue and body checks. Every error response then carries it. Contract §4 says that for `queue-full` and `sandbox-unavailable` no session is started.
- Failure scenario: the service is configured with the only production backend (`seam-unavailable`), or the queue is full, or the address is over its cap, or the body is not empty. The request is refused, but the response still includes `Set-Cookie: lc_session=...; Max-Age=1800`. That cookie becomes the visitor's identity for 30 minutes on the creek and Lab pages too.
- Evidence: reproduced over HTTP. `seam-unavailable join 503 sandbox-unavailable set-cookie: lc_session=eyJ...; Path=/api; HttpOnly; SameSite=Strict; Max-Age=1800`. A bad body gives `400 set-cookie: lc_session=...`, and the third join from one address gives `429 set-cookie: lc_session=...`. The test "A44/A46: the rc.3 production backend reports seam-unavailable and allocates nothing" checks the status and code but not `set-cookie`. Only the unconfigured case checks it.
- Suggested fix: mint the cookie only after `pool.join` succeeds, and attach it only to the 200 response. Assert `set-cookie === null` in the seam-unavailable test.

## SBX-3 Slots can be granted before `initialize()`, which then takes them back  (minor; latent until a backend is available)
- Where: apps/field-station/src/server/main.ts:56-62 (the API listens, then `station.start()` and `lab.pool.initialize()` are awaited, and only then `sandbox?.initialize()`); apps/field-station/src/sandbox/leases.ts:53 (`initialize`); apps/field-station/src/sandbox/routes.ts:54-62 (every lifecycle request runs `sweep()`).
- What: contract §8 says "On startup the field station returns every slot before granting anything." In practice, any request in the startup window (which can be long while the station catches up) runs `sweep`. That sweep polls the service, marks ready slots `ready`, and grants them. `initialize()` then calls `return` with `leaseId: null` on every slot, and the service takes back the new lease.
- Failure scenario: a page heartbeat or Start click hits a restarting field station → the visitor gets `ready`, claims it, and becomes `active` → `initialize()` runs → on the next poll the lease ends as `slot-failed`.
- Evidence: reproduced. A pool is built without `initialize`, then `sweep` + `join` + `claim` run, then `initialize()` and a poll. Output: `early join -> ready`, `claimed -> active`, `after initialize: ended slot-failed`.
- Suggested fix: refuse `join` (with `sandbox-unavailable`) and skip the grant loop until `initialize()` has finished, or run `initialize()` before the public API listens.

## SBX-4 Prototype names get past the "one of the slot's sources" check  (minor)
- Where: apps/field-station/src/sandbox/service.ts:172-175 (`#source` uses `runtime.base.sources[sourceId]`); apps/field-station/src/sandbox/operations.ts:70 (`id()` accepts `constructor`, `toString`, `__proto__`).
- What: the service's second check on `sourceId` is a plain property lookup, so names inherited from `Object.prototype` count as sources. `source-checks` and the `traces` `sourceId` filter are then forwarded to the native management service with a source ID that is not the slot's. Channels use `Object.hasOwn` correctly.
- Failure scenario: `POST /api/sandbox/wb/v1/source-checks` with `{"sourceId":"constructor"}` (or `toString`, or `__proto__`) passes the bound and reaches `runtime.call`. The contract §6 bound, "one of the slot's sources", does not hold. The impact depends on how the native handler treats unknown IDs.
- Evidence: reproduced. `constructor forwarded+ok`, `toString forwarded+ok`, `__proto__ forwarded+ok`. The runtime recorded `[{ sourceId: 'constructor' }, { sourceId: 'toString' }, { sourceId: '__proto__' }]`.
- Suggested fix: use `Object.hasOwn(runtime.base.sources, sourceId)` before reading the source.

## SBX-5 `Retry-After` and `X-Request-Id` cannot be read by the cross-origin page  (minor)
- Where: apps/field-station/src/server/http.ts:122-125 (CORS headers; no `Access-Control-Expose-Headers`); apps/field-station/src/sandbox/routes.ts:37, 67, 79-82; apps/site/src/scripts/workbench.ts:54 (reads `retry-after`).
- What: in production the page is on `https://streamotter.app` and the API on `https://demo.streamotter.app` (`.github/workflows/site.yml:23`), so the request is cross-origin. Neither header is CORS-safelisted, and the server does not expose them. `response.headers.get("retry-after")` always returns null, so the page always shows "Try again in 1 s". The workbench cannot read the `X-Request-Id` that contract §6 promises; the `requestId` in the body still works.
- Evidence: in the HTTP repro, every sandbox response has `access-control-expose-headers: null`. That the browser hides these headers is standard CORS behaviour and was inferred from it, not run in a browser.
- Suggested fix: add `access-control-expose-headers: retry-after, x-request-id` to `/api/sandbox/*` responses (and Lab responses, if they rely on it).

## SBX-6 `config.export` refusals lose `details.code` and `details.issues` when there are many issues  (minor)
- Where: apps/field-station/src/sandbox/leases.ts:222 (`WorkbenchFailure` drops `details` entirely when it serializes to more than 16 KB).
- What: contract §5 says an invalid export is `400 CONFIG_INVALID` with `details.code` and `details.issues`. When the issues list is larger than 16 KB, the field station drops the whole `details` object, including Lontra's own `details.code`, which is the only field that tells "refused" apart from "invalid".
- Failure scenario: a 10.7 KB candidate whose editable `station` schema has 400 invalid properties gives 402 issues (82 KB). `config.validate` returns all of them. `config.export` returns `{"code":"CONFIG_INVALID","message":"The configuration is invalid and was not exported.","retryable":false}` with no details.
- Evidence: reproduced . Output: `validate issues false 402 82139` and `export error 400 {"code":"CONFIG_INVALID",...,"requestId":""}`.
- Suggested fix: cut `issues` down to a bounded number (and mark it as truncated) instead of dropping `details`, and always keep `details.code`.

## SBX-7 The "poll every 1 s while resetting" setting never runs without traffic  (minor)
- Where: apps/field-station/src/sandbox/leases.ts:79 (`busy ? 1000 : pollMs`); apps/field-station/src/server/main.ts:63 (the maintenance `setInterval` runs every 5000 ms).
- What: the pool shortens its poll interval to 1 s while resetting, but `sweep` only runs from the 5 s timer or from visitor requests. Contract §8 ("every 1 s while a slot or study is resetting") does not hold. A returned slot waits up to about 5 s longer before going to the head of the line, unless someone happens to send a request.
- Evidence: inferred from reading.
- Suggested fix: run the timer every 1 s (the sweep already skips the poll when it is not due), or schedule an extra sweep while something is resetting.

## SBX-8 Small mismatches between the contract and what exists  (minor)
- Where: docs/contracts/sandbox-api.md:9 and §1/§9; apps/field-station/src/sandbox/service.ts:53.
- What: (a) The status line says "§§1–5 and 7–9 are implemented by W2". But §1's Caddy route `/sandbox/N/socket.io/` with an exact-Origin check (ADR-04 decision 7) does not exist in any `deploy/Caddyfile*`. There is also no Compose service for `sandbox`. An operator should not read §1 or §9 as deployable. (b) §9 says the service refuses Lab secrets. The denylist `^LAB_BENCH_\d+_(SERVICE|RELAY)_TOKEN$` does not match the `LAB_RELAY_TOKEN` that `deploy/make-secrets.sh:36` still generates, so a shared env file would pass.
- Evidence: `grep -ril sandbox deploy/` gives no matches. The denylist was checked by reading the regex.
- Suggested fix: say plainly in the contract that the deployment (Caddy route, Compose service) is not done yet. Add `LAB_RELAY_TOKEN` (or simply `^LAB_`) to the denylist.

## Checked and found correct
- Honest unavailability: `sandbox-main.ts` can build only `publishedBackend()`, which reports `seam-unavailable` and opens nothing. Without `SANDBOX_API_URL`, status is `disabled`. Discovery lists only `workbench`, and no runtime or version is claimed. No source file imports the test fixture.
- Explicit allocation: status, session GET, heartbeat and discovery never create a place. Only `POST /api/sandbox/session` does, and a second call returns the same place (idempotent).
- Queue: first come, first served, using Map insertion order. A freed slot is `resetting` until the service reports `ready`, so it is never handed out before cleanup. Someone who leaves and rejoins goes to the back.
- Per-address cap across the Lab and the sandbox: one `AddressCap` is shared through `main.ts`. Each pool's check and insert happens synchronously, so two pools cannot both admit an address over its limit. `X-Client-IP` is overwritten by Caddy (`header_up X-Client-IP {client_ip}`).
- Claim window (30 s), idle limit (60 s / 90 s), lease expiry, and the lease ending with the session all end the lease and clean the slot. The service also ends expired leases itself every 1 s.
- Isolation: two sessions never share a slot. Each reset gets a fresh runtime. Trace cursors are opaque and tied to the study; preview IDs are checked against the study; downloads are capped and checked for tokens, lease IDs and host paths. The service re-checks lease, study, claim and allowlist.
- Cookie: `HttpOnly; SameSite=Strict; Path=/api`, plus `Secure` when `NODE_ENV=production`. The HMAC is compared in constant time. A request cannot name a slot, lease or study.
- CORS and Origin: exact-match allowlist with `Vary: Origin`. Lifecycle POSTs from a foreign Origin get 403. On WHC-1 routes, a foreign Origin gets 403 on every method, and POSTs need `X-StreamOtter-Workbench: 1`; the preflight allows that header only under `/api/sandbox/wb/`. `Authorization` is ignored. Check order matches §6.
- Bodies: 4 KB for lifecycle and most operations, 64 KB for `config.*`, and 72 KB on the service; `Content-Length` is checked before reading. Query parameters are refused except on `traces`, where duplicates are refused too.
- Budgets: `/api/sandbox/*` shares the Lab bucket (20 burst, 3/s). Each lease allows 2 operations a second, counting `repro`. A visitor can trigger at most one reset per poll (reset returns early while one is running).
- Restart of the sandbox service (new `bootId`): leases end as `sandbox-restarted`, and leftover leases on slots nobody holds are taken back before those slots are reused.
- Not verified, possible risk: the published WHC-1 workbench may fire `config`, `health`, `channels` and `sources` in parallel when it mounts. With the 2-operations-a-second budget, two of them would get 429 `OVERLOADED`. This cannot be tested until a release with the seam exists.
