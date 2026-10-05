# SEC: attacker's-eye security review

Scope: main at `d6e426a` (`<main checkout>`, phase one: StreamOtter 0.1.0-rc.3, shared-host adapter, Lab and sandbox off, `KAFKA_AUTHORIZATION=none`), and PR #42 at `61184c1` (`<#42 checkout>`, phase two: 0.2.0-rc.1, Lab and sandbox still off).

**Summary:** 0 blockers, 2 major, 4 minor. Nothing on either revision exposes the Lab, a bench, the operator IPC, the sandbox, the field station's internal API or its health check on the public edge while they are meant to be off. The weak point is availability. One client can lock every other visitor out of the live demo, either through the gateway's global connection cap (SEC-1) or the global notebook cap (SEC-2). Neither has a per-client bound that an attacker can't trivially get around.

Repros are in `<scratch>/work-sec/`.

## Externally reachable routes (Lab and sandbox off)

Phase one and phase two use the same `deploy/Caddyfile.shared`, because #42 doesn't change it. The router answers only the trusted edge peer with `Host: demo.streamotter.dev`. Any other peer gets 403 and any other host gets 404.

| Route | Main | #42 | Auth |
| --- | --- | --- | --- |
| `/streamotter/*` → gateway:7400 | Socket.IO, WebSocket only; anything else 404 | same (0.2.0-rc.1; `start` runs without `--operator-socket`/`--health`) | Origin allowlist (browser-only), HMAC badge token |
| `/api/config`, `/api/status` (GET) | public | same | none (rate limited) |
| `/api/badge` (POST) | mints session cookie and badge | same | Origin refused if foreign; no Origin allowed |
| `/api/notebook/sightings` (POST) | owner from cookie | same | session cookie |
| `/api/lab/status`, `/api/lab/capabilities` | `enabled:false` / static summary | same; `/api/lab/incident` and `/api/lab/operations/*` answer 404 while `intents` is unavailable, which it is with no benches | none |
| other `/api/lab/*` | 401 without a session, else 503 `lab-unavailable` | same | session |
| `/api/sandbox/status` | `disabled` | same | none |
| other `/api/sandbox/*`, `/api/sandbox/wb/v1/*` | 503 `sandbox-unavailable` / WHC discovery stub | same | session, Origin, `X-StreamOtter-Workbench` |
| `/lab/*` | 404 (`@labDisabled`, `LONTRA_LAB_ENABLED=0`) | same | — |
| `/sandbox/*`, `/healthz`, `/internal/*`, `/lab-internal/*`, management | 404 (catch-all) | same (the `/sandbox/N` routes #42 adds are only in the non-shared `deploy/Caddyfile`) | — |

---

## SEC-1 (Major, both): one client fills the gateway's global connection cap and every other visitor is refused

- **Where:**
  - `apps/field-station/streamotter.production.json:99` (`"maxConnections": 300`), from `apps/field-station/src/project.ts:166` `HOSTED_LIMITS`.
  - The gateway's only admission check is global: rc.3 `node_modules/@streamotter/gateway/dist/runtime/gateway.js:309`, and rc.1 `.../runtime/gateway.js:429`.
  - `deploy/Caddyfile.shared:43-48` routes `/streamotter/*` with no per-client bound.
  - `apps/field-station/src/sessions.ts:155-174` mints badges.
  - Same line numbers on #42.
- **What is wrong:**
  - The demo gateway admits at most 300 connections in total. There is no per-client bound at any layer: not in the gateway, not in the authenticate handler (`kafka-handlers.ts:266`, which checks only the HMAC), not in Caddy and not in the field station.
  - A badge token isn't single-use. It is valid for up to 10 minutes and can open any number of sockets.
  - The gateway's Origin check stops only browsers. A script sets `Origin: https://streamotter.dev` itself.
- **Failure scenario:**
  1. An attacker sends one `POST https://demo.streamotter.dev/api/badge` with no cookie and no Origin. This is allowed and costs one token from the per-IP budget.
  2. They open 300 WebSockets to `/streamotter/socket.io/` with that token and a forged `Origin`.
  3. Every real visitor's connect then fails with `OVERLOADED` ("The gateway has reached its connection limit"). The home page, the walkthrough and `/field-station/` show no live creek.
  4. Sessions end when the token expires (at most 10 minutes), so the attacker keeps this up with one badge request every few minutes, from one IP.
- **Repro:** `work-sec/gateway-exhaust.ts`. It runs the real gateway on the fixture source with the hosted limit of 300, the app's real `authenticate`/`badgeFor`, and `socket.io-client`.
  ```
  cd <main checkout>/apps/field-station && PATH=/opt/node24/bin:$PATH node <scratch>/work-sec/gateway-exhaust.ts
  attacker sockets opened with one badge token: 300/300
  legitimate visitor connect -> OVERLOADED
  cd <#42 checkout>/apps/field-station && FS_ROOT=$PWD PATH=/opt/node24/bin:$PATH node <scratch>/work-sec/gateway-exhaust.ts
  attacker sockets opened with one badge token: 300/300
  legitimate visitor connect -> OVERLOADED
  ```
- **Suggested minimal fix:**
  1. Bound connections per client inside the repo:
     - `badgeFor` puts the requesting client's address, normalized to a /64 for IPv6 (see SEC-2), into the token claims.
     - The gateway's `authenticate` handler (`createKafkaHandlers`) keeps an in-memory count of admissions per address claim and per token `sid` over the token TTL window, and refuses past a small number (for example 8 per address and 4 per `sid`). It returns `null`, or throws so the client sees `HANDLER_FAILED`.
     - Since a session can't outlive its token, this bounds concurrent sockets per address.
  2. Add an edge rule limiting WebSocket upgrades per IP on `/streamotter/socket.io/` (the shared edge, or Cloudflare).

## SEC-2 (Major, both): the per-client budget keys on the full address, so one IPv6 host fills the 5,000-notebook cap in seconds (prior F2, still open)

- **Where:**
  - `apps/field-station/src/server/http.ts:92-95` (`clientAddress` = the raw `X-Client-IP`) and `:134` (`limiter.take(clientAddress(request))`).
  - `apps/field-station/src/server/notebooks.ts:31,144` (`MAX_OPEN_NOTEBOOKS = 5_000`, global, with no per-address bound).
  - `deploy/Caddyfile.shared:79` passes the verified visitor address through verbatim.
  - The shared `AddressCap` (`places.ts`) uses the same key.
  - Identical on #42.
- **What is wrong:**
  - The 2026-10-02 review's F2 (a handful of IPs exhausts the notebook cap) was left open. The cap is still global and the limiter is per exact address.
  - Behind Cloudflare and the shared edge, an IPv6 visitor's address reaches `X-Client-IP` unchanged. Any host with an IPv6 /64, which is any cheap VPS, has 2^64 addresses, so each request can get a fresh, full 30-token bucket.
  - So the budget doesn't bound a single host at all. One host opens 5,000 notebooks, and keeps them open for the 30-minute session life.
  - Side effect: once more than 10,000 buckets are live, `RateLimiter.take` sweeps the whole map on every request (`http.ts:78,86-89`). That is about 0.6 ms of CPU per request at 40k live buckets, on a container capped at 0.18 CPU whose event loop also advances the creek and publishes to Kafka. Address rotation therefore also amplifies a request flood into a stall of the live creek.
- **Failure scenario:**
  1. From one IPv6 host, for 5,000 addresses in its /64, the attacker sends `POST /api/badge` (no Origin) and then one `POST /api/notebook/sightings` with that cookie.
  2. That takes about 10,000 requests and a few seconds.
  3. Every real visitor's first sighting (walkthrough chapter 6) is then refused with 503 "The field station has too many open notebooks". This lasts 30 minutes and is renewed by repeating the attack, which averages about 3 requests a second.
  4. With IPv4 only, the original F2 arithmetic still holds: about 6 addresses.
- **Repro:** `work-sec/notebook-cap.test.ts`. It uses the real `publicApi` with its default limiter. It first shows that one address does get 429s, then rotates addresses within `2001:db8:1:2::/64`.
  ```
  cd <main checkout> && PATH=/opt/node24/bin:$PATH node --test --test-force-exit <scratch>/work-sec/notebook-cap.test.ts
  notebooks opened from one /64: 5000; openCount=5000
  visitor sighting -> 503 {"error":"The field station has too many open notebooks; try again later."}
  ✖ one IPv6 /64 fills the global notebook cap and locks every visitor out of sightings
  ```
  It fails the same way on #42 (`FS_ROOT=<#42 checkout>/apps/field-station`).

  `work-sec/limiter-sweep.ts` measures the sweep cost:
  ```
  10000 live buckets: 0.138 ms CPU per request
  20000 live buckets: 0.355 ms CPU per request
  40000 live buckets: 0.596 ms CPU per request
  ```
- **Suggested minimal fix:**
  - In `clientAddress`, normalize IPv6 to its /64, and IPv4-mapped addresses to IPv4, before using it as the limiter or `AddressCap` key.
  - Add a per-address open-notebook bound (store the address with the book; for example 3 per /64), and raise `MAX_OPEN_NOTEBOOKS`. Books are under 2 KB.
  - Make the limiter's eviction incremental, for example by insertion order, deleting only expired heads, rather than a full scan per request.

## SEC-3 (Minor, both): clickjacking. The site still sends no framing protection except, on #42, under `/workbench/*` (prior L9, still open)

- **Where:**
  - Main has no `apps/site/public/_headers`.
  - #42 adds `apps/site/public/_headers:3-6`, which covers only `/workbench/*`.
  - No page carries `frame-ancestors`. A meta CSP can't carry it.
- **What is wrong:** any site can frame `https://streamotter.dev/field-station/`, `/`, `/lab/` or `/playground/` and trick a visitor into clicking Drop connection or Sign in as field biologist. With the Lab off, the impact is limited to the visitor's own session view.
- **Failure scenario:** a page at `evil.example` embeds `<iframe src="https://streamotter.dev/field-station/">` under a decoy button. The click switches the visitor's role, which closes their notebook view, or cuts their connection. It is narrow and self-healing.
- **Repro:** `ls <main checkout>/apps/site/public/_headers` reports no such file. `cat <#42 checkout>/apps/site/public/_headers` shows only a `/workbench/*` block.
- **Suggested minimal fix:** add a `/*` block with `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`, and keep #42's stricter `/workbench/*` block.

## SEC-4 (Minor, #42): the release-pin guard can be bypassed by an npm alias, and its "can't loosen the guard" claim doesn't hold

- **Where:**
  - `scripts/check-release-pins.mjs:35-36`: a lockfile entry is identified by `entry.name ?? <path>`.
  - `scripts/check-release-pins.mjs:24-27`: the override check matches only the bare key.
  - `.github/workflows/release-pins.yml:10-11, 13-15`.
- **What is wrong:**
  - **Aliases.** npm writes `name` into a lockfile entry only for aliased installs. A lockfile that installs some other registry package at `node_modules/@streamotter/gateway` (`"name": "some-other-gateway"`, registry `resolved`) is skipped entirely, because `isStreamOtter("some-other-gateway")` is false. That is the case the guard most needs to catch.
  - **Override keys.** An override keyed `streamotter@0.2.0-rc.1`, or nested under a non-StreamOtter key, isn't flagged by the manifest check.
  - **The workflow file.** The workflow says "a pull request can't loosen the guard it is checked by". It runs on `pull_request`, though, so it executes the PR's own copy of `release-pins.yml`, and a PR can edit that step. `images.yml` and `site.yml` then run whatever `scripts/check-release-pins.mjs` was merged.
- **Failure scenario:** a branch tests a hand-packed gateway published under another registry name (or a lockfile is edited to point there). The guard reports "StreamOtter is pinned to registry releases" and the image ships a non-StreamOtter gateway. The capability summary would fail closed (its integrity set would differ), but the gateway image itself is not stopped.
- **Repro:** `work-sec/release-pins-alias.test.mjs`
  ```
  cd <#42 checkout> && PATH=/opt/node24/bin:$PATH node --test <scratch>/work-sec/release-pins-alias.test.mjs
  problems: []
  ✖ an aliased (non-StreamOtter) package installed at a StreamOtter path is refused
  ```
- **Suggested minimal fix:**
  - Treat an entry as StreamOtter when either its install path's package name or its `name` is StreamOtter, and require both to agree.
  - Flag any override key whose package part (before `@version`) is StreamOtter, recursing into nested override objects.
  - Reword the workflow comment, or make the check a required status that runs from the base ref (for example a `pull_request_target` job that only reads files and never executes PR code).

## SEC-5 (Minor, both): the Cloudflare Pages deploy token is exported to every step of the site deploy, including `npm ci` install scripts and `npm test`

- **Where:**
  - `.github/workflows/site.yml:24` (job-level `env: CLOUDFLARE_API_TOKEN`), then `:40` `npm ci` (runs esbuild's install script), `:42` `npm test` and `:43` the build.
  - On #42 the same lines are 24, 42, 44 and 45.
  - `cloudflare/wrangler-action@v3` is pinned only by a mutable tag.
- **What is wrong:**
  - The token is needed only by the wrangler step, which already receives it through `with: apiToken`. Exporting it at job level hands it to every dependency's install script, to every test, and to the Astro and Vite build.
  - The Docker image build uses `--ignore-scripts`; this job doesn't.
- **Failure scenario:** a compromised version of any dev dependency reaches the lockfile, for example through a routine bump. When the next production site deploy runs, its install script or test-time code reads `process.env.CLOUDFLARE_API_TOKEN` and can then deploy arbitrary content to `https://streamotter.dev`. This needs an upstream compromise first, so it is Minor.
- **Repro:** `grep -n "CLOUDFLARE_API_TOKEN\|npm ci\|npm test" .github/workflows/site.yml` gives `24: CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}` (under the job's `env:`), `40: - run: npm ci` and `42: - run: npm test`. The only other use is `33: test -n "$CLOUDFLARE_API_TOKEN"`.
- **Suggested minimal fix:**
  - Drop the token from job `env`. For the presence check, pass it only to that step, or check `secrets.CLOUDFLARE_API_TOKEN != ''` in an `if`.
  - Run `npm ci --ignore-scripts` in this job.
  - Pin `cloudflare/wrangler-action` to a commit SHA.

## SEC-6 (Minor, both): session subjects carry only 32 random bits

- **Where:** `apps/field-station/src/sessions.ts:70` (`${role}-${randomUUID().slice(0, 8)}`). The subject is the notebook owner (`access.ts:186`, `notebooks.add`) and the Lab and sandbox place key.
- **What is wrong:**
  - A subject is 8 hex characters.
  - Two sessions with the same subject share a notebook: each can subscribe to and append to the other's. If the shared book has already expired (expired books are kept for 2 hours), the newcomer gets 410 "This notebook has closed".
  - With the Lab or sandbox on, colliding sessions would share one place.
- **Failure scenario:** the odds are low at demo traffic, about 1 in 860,000 per new visitor while 5,000 books are held. An attacker minting sessions through SEC-2's address rotation reaches a collision with some open notebook after about 860k mints, but can't choose whose. The data is fictional, so this is integrity hygiene, not a data-exposure path.
- **Repro:** by reading `sessions.ts:70` and `access.ts:186`. No test was written.
- **Suggested minimal fix:** use the full `randomUUID()` (or 128 bits of base64url). `NotebookParams.observerId` allows up to 64 characters.

---

## Checked and found correct

**Edge, shared host (`Caddyfile.shared`, `start-caddy-shared.sh`, `compose.shared.yaml`)**
- The peer check uses `remote_ip`, the socket peer, not the computed client IP, before any proxying. Only `LONTRA_TRUSTED_EDGE_IP` is trusted, as an exact single IPv4 address.
- The wrapper refuses empty values, CIDRs, lists, leading zeros and anything over 255. Compose's `${…-default}` passes an empty value through to that refusal, so it fails closed.
- `trusted_proxies_strict` with `X-Forwarded-For` picks the rightmost untrusted address.
- `CF-Connecting-IP`, `Forwarded` and `X-Real-IP` are stripped on every hop. `X-Client-IP` is stripped toward the gateway and Lab, and overwritten with `{client_ip}` toward the API. So a client can't choose its rate-limit identity past the edge; IPv6 rotation (SEC-2) is the gap.
- A wrong `Host` gets 404.
- `/lab/*` gets 404 unless `LONTRA_LAB_ENABLED=1` (only `compose.shared.lab.yaml` sets it). Caddy's path matcher cleans and lower-cases before matching, so `//lab/`, `/LAB/` and `%2e%2e` variants can't slip past it, and an `/api/%2e%2e/healthz` reaches no `/api/*` handler.
- The catch-all is 404, so `/sandbox/*`, `/healthz`, `/internal/*`, `/lab-internal/*` and management routes aren't reachable.
- The Caddy admin API is on container loopback only. No host ports are published. Only Caddy joins `edge-lontra`.
- #42 doesn't touch `Caddyfile.shared` or the shared overlays.

**Gateway (rc.3 and rc.1)**
- `streamotter start` is run without `--operator-socket` or `--health`. With rc.1 it prints "No management or development endpoints are exposed".
- The gateway's HTTP server answers 404 to every non-Socket.IO path, and the transport is WebSocket-only.
- Production refuses a missing or foreign `Origin`. Tokens travel in the Socket.IO `auth` payload, not cookies, so cross-site WebSocket hijacking doesn't apply.
- The bench operator API (`lab/operator.ts`, `getGatewayOperator`) is in-process only, and only in bench processes. None run with the Lab off.

**Authentication and sessions**
- Badges and cookies are HMAC-SHA256 under domain-separated keys (`secret` and `secret:session`), compared with `timingSafeEqual` after a length check. Claims are type-checked and expiry is enforced.
- Production refuses secrets shorter than 32 characters.
- The cookie is `HttpOnly; SameSite=Strict; Path=/api; Secure`.
- Notebook owner and authorization come from the cookie or token subject, never from the body or params.
- `viewPath` URL-encodes params.

**CORS and CSRF**
- The allowlist is exact, with `Vary: Origin` and `no-store`.
- Foreign-Origin POSTs get 403 on `/api/badge`, `/api/notebook/sightings`, `/api/lab/*` and `/api/sandbox/*`. `Origin: null` is refused.
- Error answers carry CORS (L6 was fixed).
- #42 makes production refuse a multi-origin `SITE_ORIGIN`, so the field station and Caddy agree.

**Bodies and parsing**
- Caddy caps bodies at 8 KB and the API at 4 KB.
- JSON bodies are checked for an exact key set on Lab routes. `__proto__` is an own key from `JSON.parse`, so it is refused as an unknown key.
- `Object.fromEntries` and spreads create own properties only. No user JSON is merged into shared objects, so there is no prototype pollution.
- #42 intent parsing (`parseIntent`) is an exact-shape allowlist. The sandbox candidate depth check is iterative.
- `JSON.parse` error text doesn't echo input into logs.

**Information leaks**
- Public error bodies are generic. Internal errors are logged without tokens; bench calls log the path without its query, which holds the `leaseId`.
- `/api/lab/capabilities` discloses only the library version and availability reasons, by contract.

**Lab and sandbox off**
- With no `LAB_BENCH_API_URLS`, the pool has zero benches. `join` throws `lab-unavailable` and nothing contacts a bench.
- On #42, `GET /api/lab/incident` and `/api/lab/operations/*` are 404, and intents are refused with 409 before the pool.
- With no `SANDBOX_API_URL`, `configuredSandbox` returns `undefined`. Status is `disabled`, everything else is `sandbox-unavailable`, and no cookie is set on refusal (SBX-2 is fixed).
- `compose.sandbox.yaml` (#42) publishes no port, and its service environment is an allowlist.

**Kafka with `KAFKA_AUTHORIZATION=none`**
- Only `gateway` and `field-station` SCRAM users exist in phase one; no bench users are created without `KAFKA_LAB_N_PASSWORD`.
- The broker is reachable only on the project network over SASL_SSL.
- With no authorizer, either service account can do anything on the broker. That is the documented, owner-accepted interim state. A compromised gateway already holds `FIELD_STATION_SECRET` and the service token, so ACLs add only defense in depth here. `deploy.sh` refuses to lower authorization (OPS-1 is fixed).

**Secrets**
- No keys or tokens are in the tree or the git history: I grepped for private-key headers and long values assigned to secret variable names.
- `.local/`, `.env*` and `deploy/secrets/` are git-ignored.
- The image's final stage copies only `src`, the production config and the compiled `dist`; `.data`, `.local` and `node_modules` are excluded from the build context.
- Dependencies are installed with `--ignore-scripts` in the image. Containers run as `node`.
- The deploy SSH command accepts only `deploy <40-hex>`, with no eval. The deploy workflow pins the host key.

**Supply chain**
- In both lockfiles, every non-workspace entry resolves from `https://registry.npmjs.org/` with an `integrity` hash.
- The only install scripts are `esbuild` and `fsevents`.
- No workflow uses `pull_request_target`. Secrets appear only in `workflow_dispatch` or main-only jobs.
- #42's site build serves exactly three hashed workbench files and fails the build on any hash mismatch.

**Site**
- No user-controlled `innerHTML`: `live-creek.ts` interpolates only constants and `shortRevision(bigint)`.
- The only `set:html` is the build-time bootstrap function.
- URL inputs (`?scenario=`, `#chapter-N`) are allowlisted. `sessionStorage` holds only a lease ID.
