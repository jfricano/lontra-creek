# SBX review: workbench sandbox, its /workbench/ mount, and the sandbox overlay

Reviewer: independent (did not write this code). Trees: **main** `d6e426a` (`<main checkout>`) and **#42** `61184c1` (`<#42 checkout>`). Neither worktree was modified (`git status` is clean on both). Repros live under
`<scratch>/work-sbx/` (a `git archive` copy of `61184c1`, with `node_modules` symlinked to the #42 worktree).

**Summary: 0 blockers, 0 majors, 2 minors.** The session layer, the published-seam backend, the WHC-1 host API, the mount, and the production CSP all held up against reading and against an end-to-end run of the production topology. Both findings are narrow and self-healing. The code behind each is also on main, but nothing reaches it there because phase one runs with the sandbox off.

Prior reviews: SBX-1 to SBX-8 in `docs/releases/v1.1/review/SBX.md` are recorded as fixed. I re-checked them on #42 and none has regressed. That review also left one item open: a WHC-1 workbench might fire calls at once on mount and hit the 2-a-second operation budget. I checked it against the published `app.js` and it is now closed. #42 gives the budget a burst of 8. The real `app.js` makes 7 operation calls on mount (the run below shows config, channels, sources, dev/principals, health, sources, health), plus discovery, which does not count toward the budget. None was refused.

---

## SBX-1: Switching roles on the creek tablet orphans this browser's sandbox place (Minor; both, but nothing reaches it on main)

- **Where:** `apps/field-station/src/sessions.ts:69` (`badgeFor` gives a new subject whenever the role differs) and `apps/field-station/src/server/http.ts:200-205` (`POST /api/badge`). The sandbox pool keys places by `session.subject` (`apps/field-station/src/sandbox/leases.ts:185-187` `view`, `:206-209` `#lease`). The trigger is on the site: `apps/site/src/scripts/walkthrough.ts:147` (`switchRole("researcher")`), and `field-client.ts:215`, which starts every tablet page as `volunteer`.
- **What:** the `lc_session` cookie is both the creek tablet's gateway identity and the sandbox's (and the Lab's) place-holder identity. Any badge request with a different role mints a new subject and replaces the cookie. A sandbox place held under the old subject can then no longer be seen or used from this browser. It keeps the slot and an address-cap place until the 60 s idle limit.
- **Failure scenario:** a visitor has an active workbench session in one tab and runs the home-page walkthrough in another. The walkthrough's "switch to field biologist" step replaces the cookie. The same happens the other way round: a visitor who finished the walkthrough holds a researcher cookie, starts the sandbox, then opens the home page in a new tab, which signs the tablet in as `volunteer`. On its next heartbeat the workbench page gets `{status:"none"}` and shows "available, Start a session" with no reason given. The mounted workbench's next call gets 401 `no-lease` and shows "Session ended". The slot stays leased to nobody for up to 60 s, and the place still counts against the address's two places. The Lab, which uses the same cookie, behaves the same way (LAB area). The sandbox is off on main, so this first appears with #42.
- **Repro:** `work-sbx/w9b/apps/field-station/test/sbx-review/role-switch.test.ts`
  ```
  cd .../work-sbx/w9b && PATH=/opt/node24/bin:$PATH node --test --test-force-exit apps/field-station/test/sbx-review/role-switch.test.ts
  after the role switch: session view = none | slot = leased | WHC-1 health = 401 no-lease
  ✔ a role switch on the creek page orphans the sandbox place held by the same browser
  ```
- **Suggested minimal fix:** keep a stable holder ID in the session cookie that survives a role change. Rotate only the gateway `subject`, and key Lab and sandbox places (and `#ended`) by the holder ID. A smaller alternative: when `/api/badge` replaces a session that holds a sandbox or Lab place, end that place at once as `session-ended` and record the ended view under the new subject, so the page can say why and the slot is cleaned at once.

## SBX-2: A grant to a place whose session expired mid-poll takes a clean slot out of service for 30 s (Minor; both, but nothing reaches it on main)

- **Where:** `apps/field-station/src/sandbox/leases.ts:119-127`. `#poll`'s answer calls `this.#grant(at)` without first ending places whose session has expired; only `sweep()` does that. Then `:159` sets `expires: Math.min(now + leaseMs, place.session.exp)`, which can already be in the past. At `:163`, any non-200 lease answer marks the slot `unavailable` for `retryMs` (30 s). The service refuses a past `expiresAt` with 400 (`service.ts:134`). Main's `sweep` (`main:leases.ts:70-104`) has the same pattern: it grants with the `now` taken before an awaited poll. Main never reaches it because the sandbox is off.
- **What:** a refused offer is treated as a failed slot. The refusal is caused by the place (its session ended while the poll was in flight), not by the slot.
- **Failure scenario:** a visitor waits in a long line (up to 30 places, 10-minute leases) on a cookie minted earlier, for example in the Lab, so the 30-minute session ends while they wait. If the session ends during the status poll that would grant them the freed slot, the PUT is refused. That slot then sits clean and unused for 30 s while the next person in line waits. With `SANDBOX_SLOTS=1`, or when it was the last usable slot, `status` reports `all-slots-unavailable` and every new join gets 503 `sandbox-unavailable` for those 30 s. The window is the length of one poll round trip, so this is rare. It heals itself.
- **Repro:** `work-sbx/w9b/apps/field-station/test/sbx-review/expired-grant.test.ts` (real `SandboxService` + fixture backend, fake clock; the clock moves 5 ms while the status poll is in flight)
  ```
  lease PUT answers: [ 200, 400 ] | status: [{"slot":1,"state":"unavailable"}] | b: queued | c: queued
  29 s later: c = queued | slot = unavailable | availability = unavailable all-slots-unavailable
  ✔ a grant from a poll answer for a place whose session just expired takes the slot out for 30 s
  ```
- **Suggested minimal fix:** in `#grant`, skip (or end as `session-ended`) any place with `place.session.exp <= now + claimMs`, and take the lease end from a fresh `this.#now()`. On a 4xx answer to the lease PUT (an offer the service refused as invalid), put the slot back to `ready` instead of `unavailable`. Keep the 30 s back-off for no answer and for 5xx.

---

## Checked and found correct

**What main (phase one) does on `/workbench/` with the sandbox off**
- With no `SANDBOX_API_URL`, `configuredSandbox` returns `undefined`. `GET /api/sandbox/status` returns 200 `{availability:"unavailable", reason:"disabled"}`. `POST /api/sandbox/session` returns 503 `sandbox-unavailable` and sets no cookie. WHC-1 discovery returns `operations:["workbench"]` and only with a session. WHC-1 operations return 503 `INTERNAL` / `sandbox-unavailable`. `Caddyfile.shared` sends `/api/*` (8 KB) to the field station, so the page gets that answer cross-origin with CORS.
- The page reads it as **"The workbench sandbox is not enabled on this deployment."**, with Start disabled, and asks for the status only (no session request, no allocation). It renders "Not reported" runtime labels and points to the labeled screenshot fallback. `PUBLISHED_SEAM` is `null`, so nothing is mounted and discovery is never called. A 404 answer is treated as not enabled, and a network failure as "status unknown" with Check again. The main e2e (`e2e/workbench.spec.ts` "disabled says so…") covers this, and main's 28 sandbox unit tests pass. `demo-availability.ts` says the sandbox needs a seam that rc.3 lacks, which matches.

**Integrity of the mounted bundle (#42)**
- I downloaded `@streamotter/workbench-0.2.0-rc.1.tgz` from registry.npmjs.org. Its sha512 matches the lockfile (`sha512-Yn8gCDu…ao9A==`). Its `app.js`, `workbench-host.css`, `workbench-host.json` and `THIRD_PARTY_LICENSES.txt` are byte-identical to the installed copies.
- The sha384 of the installed `app.js` and `workbench-host.css` equals both the manifest values and `PUBLISHED_SEAM.integrity` (`sha384-GWn559…yhN`, `sha384-9cVRp8…jFU5o`). `loadWorkbenchAssets` refuses any mismatch in package, version, host contract, path or hash.
- A production build (`PUBLIC_FIELD_STATION_ORIGIN=https://demo.streamotter.dev`, in the scratch copy) ships exactly `app.js`, `workbench-host.css` and `THIRD_PARTY_LICENSES.txt` under `/workbench/assets/0.2.0-rc.1/`, byte-identical to the registry tarball, with no source map. The page links `workbench-host.css`, never `styles.css`, and sets `integrity` on both the stylesheet and the module script.
- `scripts/check-release-pins.mjs` catches `vendor/`, non-exact specs, overrides, and lockfile entries (including links and nested copies) not resolved from the registry. The PR workflow runs the base branch's copy of the script.

**CSP and framing (#42)**
- The built `/workbench/index.html` puts the meta CSP straight after `<meta charset>`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://demo.streamotter.dev wss://demo.streamotter.dev; object-src 'none'; base-uri 'none'; form-action 'self'`. The page has no inline script, no `style=` attribute and no tablet shim. `app.js` sets no `style` attributes and uses no `innerHTML`.
- `public/_headers` sends `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and `nosniff` on `/workbench/*`. `Caddyfile.local-lab` does the same for local runs. I did not run Cloudflare Pages itself, so the `_headers` match is checked by reading only.
- **End-to-end production topology** (`work-sbx/w9b/apps/field-station/sbx-xorigin.ts`). This setup is not covered by the real-stack e2e, which is same-origin. The page runs on `https://streamotter.dev` from the production build and the API on `https://demo.streamotter.dev`, both answered locally by `page.route`. Behind them are the real `publicApi`, `SandboxPool`, `SandboxService` and `publishedBackend` (0.2.0-rc.1, a real dev gateway and `createManagementHandler`), driven in Chromium with the CSP enforced. WebSockets go to the local slot gateway and every other host is blocked. Result: the boot block carries `apiOrigin` with cross-origin `credentials:"include"`. The same-site `SameSite=Strict` cookie is sent. Preflights pass with `x-streamotter-workbench`. The workbench mounts with no CSP violations. A `jobProgress` preview reaches live over `wss://…/sandbox/1/socket.io`. Reset reloads the page once and reopens the same lease without allocating. The only console error is the expected 401 from the first `GET /api/sandbox/session`.

**Isolation and authorization (#42)**
- Requests never name a slot, lease or study: the session cookie's subject → place → lease → slot. The service checks lease, study and claim again (`#current`) and the allowlist again (`status().operations`), and checks sources and channels with `Object.hasOwn`. Principals come from `runtime.principalRefs`, previews only from `study.previews`, and trace cursors are opaque per-study handles (410 across studies).
- Each study gets a fresh `createGateway` (development mode) and a fresh `createManagementHandler`. The handler listens on `127.0.0.1` on a random port behind a 32-byte random key compared in constant time; `Authorization` is ignored and no native token exists. Reset and return revoke both subjects, then close the gateway, then open a new one, so an old preview token is refused (checked in the gateway source: preview tokens live in the gateway's memory only, and in development mode `authenticate: () => null` means only preview tokens are accepted). Read models are built per runtime.
- An in-flight call that fails after reset or return is answered `stale-study` (`TRACE_CURSOR_EXPIRED` for traces) and never ends the lease. A 504 `TIMEOUT` passes through and keeps the lease. Only an unreachable service, or a 5xx `slot-unavailable`, ends it.
- `#grant`, `#reconcile` and `#return` are synchronous with versioned polls, with no lock held across calls: a stale poll is not applied, a grant whose place has left is returned, and a restart (new `bootId`) ends leases as `sandbox-restarted`. All 51 #42 sandbox and slot-project tests pass, and so do the 39 site workbench tests.
- The sandbox container's environment is an allowlist. The image's `ENV` (`NODE_ENV`, `NODE_VERSION`, `YARN_VERSION`, `PATH`), Docker's `HOSTNAME`/`HOME` and `init: true` all pass it. The sandbox has no Kafka credential, and the broker's plaintext listener is bound to loopback.

**Tokens, cookies, origins (#42)**
- `lc_session`: HttpOnly, `SameSite=Strict`, `Path=/api`, plus `Secure` in production. The HMAC is compared in constant time. A refused join sets no cookie.
- Service token: at least 32 characters on both sides, compared in constant time on the service, never forwarded to a slot, and checked for in downloads together with this study's preview tokens and the lease ID.
- Lifecycle `POST`s refuse a foreign `Origin`. WHC-1 routes refuse a foreign `Origin` on every method and need `X-StreamOtter-Workbench: 1` on `POST`. CORS uses an exact allowlist with `Vary: Origin`, and `Retry-After`/`X-Request-Id` are exposed. The production field station refuses a `SITE_ORIGIN` list, matching Caddy's literal match.

**Body limits (#42)**
- The field station reads lifecycle bodies up to 4 KB (empty or `{}` only), WHC-1 bodies up to 4 KB, and `config.*` up to 64 KB, checking `Content-Length` and then the streamed byte count. Depth is capped at 64, checked iteratively, before anything is serialized again. The service reads 72 KB, after auth. The slot handler takes 128 KB.
- In `deploy/Caddyfile`, `/api/sandbox/wb/v1/config/*` allows 72 KB and the rest of `/api/*` 8 KB. Caddy cleans the path before matching, and Node's `URL` normalizes it, so a dot-segment cannot borrow the 72 KB route for another endpoint. `Caddyfile.shared` has no sandbox routes, and the contract and OPERATIONS.md say so.

**Compose overlay and Caddy routes (#42)**
- `compose.sandbox.yaml` publishes no port and gives the sandbox only `NODE_ENV`, `SANDBOX_SERVICE_TOKEN`, `SANDBOX_SLOTS` and `SITE_ORIGIN`. Its health check requires the seam plus at least one slot able to serve.
- `deploy/Caddyfile` routes only `/sandbox/N/socket.io/*` to `sandbox:760N`, and only for the literal `SITE_ORIGIN`; every other `/sandbox/*` path returns 404. Ports match `SANDBOX_GATEWAY_PORT_BASE` (default 7600) and the gateway path `/sandbox/N/socket.io`. The slot gateways' `allowedOrigins` is that same single origin. `operations/deploy.sh` does not use the overlay.

**Contract `docs/contracts/sandbox-api.md` (#42)**
- §§2, 4, 6–10 match the code: budgets (20/3 shared, 8 burst then 2/s per lease), refusal codes and statuses, timings (3 s, 15 s, 10 s, 60 s, 30 s), the download caps and withholding answers, the private API, and configuration. The status line correctly says nothing is deployed.
