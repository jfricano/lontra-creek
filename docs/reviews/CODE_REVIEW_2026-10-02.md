# Lontra Creek code review: security and logic

Date: 2026-10-02 · Repo: `jfricano/lontra-creek` at `main` (e7df45e, after PR #22)
Scope: `apps/field-station` (site API, internal API, sessions, identity, access, notebooks, station, Kafka, gateway handlers, generated config and client), `apps/field-station/src/lab` (Failure Lab), and `apps/site` (Astro site and its scripts). The `deploy/` edge config (Caddy, compose, secrets scripts) was read wherever it affects those.

This is a report only. No branch, PR, or code change was made.

## Bottom line

- **I found no critical or high-severity vulnerabilities.**
  - Authentication is sound. Session cookies and gateway badges are HMAC-signed with domain-separated keys, compared in constant time, and expire on time. Lab bench tokens carry 256 random bits and are bound to a lease.
  - Authorization is sound. Den sites are restricted to researchers, and notebooks to their owner. Internal APIs require a service token, and the Lab gets its own per-bench tokens that cannot read notebooks.
  - The edge is sound. CORS is an allowlist with credentials, foreign-Origin POSTs are refused, cookies are `SameSite=Strict`, Caddy overwrites `X-Client-IP`, and no internal port is published.
  - I found no XSS. Every server-supplied value reaches the DOM through `textContent`.
- **The main risks are reliability bugs.** Two of them can quietly stop the live demo:
  - One failed badge request freezes a visitor's page for good (S1).
  - A failing checkpoint write stops all Kafka publishing (F1).
- Baseline is green: `npm test` passes 119/119 and `npm run typecheck` passes.

Severity scale: **Medium** means visitors notice it, or one user can cause it for everyone. **Low** means narrow, self-healing, or ops-only. **Info** means no action strictly needed.

---

## Findings, ranked

### Medium

#### S1. A single failed badge request stops the live demo on that page permanently, and the banner says the opposite
**Where:**
- `apps/site/src/scripts/field-client.ts:150-161` (`getToken` → `requestBadge`)
- `live-creek.ts:70-80`
- `walkthrough.ts:118-125`
- `lab.ts:51-52`
- No code in `apps/site` handles `auth-required`.

**What happens:**
1. `getToken` throws on any non-2xx response or network error from `POST /api/badge`.
2. The StreamOtter client treats a `getToken` rejection as `auth-required`, which suspends automatic retries until `reconnect()` is called. The site's own `release-facts.ts:83,484` documents this.
3. No page ever calls `reconnect()` from that state.

**Scenario:**
- A 429 from the 1/s per-IP limiter can trigger it, for example a shared NAT, or many tabs reconnecting after a gateway restart. So can a single 502 while the field station restarts.
- The home cards stay stale forever. The "Still trying to reach the field station" copy is wrong, because nothing is retrying. The Lab view stays dead.

**Recommendation:**
- In `PageFieldClient`, listen for the connection state `auth-required`. Call `client.reconnect()` with bounded backoff, starting at 1 s and doubling to 30 s, and reset the backoff on `connected`.
- Do the same in `lab.ts`.
- Optionally, in `getToken`, treat network errors, 429 and 5xx as transient, so that a real "not allowed" answer is still final.

#### F1. A failing checkpoint write stops every creek update from reaching Kafka
**Where:** `apps/field-station/src/server/station.ts:160-166` (`advance`)

**What happens:**
- `advance()` first writes the tick's views and then, once an hour, `await this.checkpoint()`, before `await this.flush()`.
- If the checkpoint write throws (disk full, a permissions change on the volume), `flush()` is skipped.
- `#lastCheckpointAt` is only set on success, so every later tick retries the checkpoint, throws again, and skips the flush again.

**Scenario:**
- The world keeps advancing, and the internal snapshot API serves current views.
- Nothing new is published, so live subscribers see the creek freeze.
- `/healthz` still reports Kafka "connected", because the queue never attempted a failing send.
- The only visible sign is an "Advancing failed" log line every tick.

**Verified:** a test that blocks the checkpoint's temp file fails on `main` and passes with the patch below.

**Recommendation:** always flush, and let the checkpoint error still reach the caller:
```ts
for (const emission of advanceTo(world, this.targetTick())) this.#write(emission);
try {
  if (this.#now() - this.#lastCheckpointAt >= CHECKPOINT_EVERY_MS) await this.checkpoint();
} finally {
  await this.flush();
}
```
Also consider having `/healthz` report a checkpoint that hasn't succeeded for more than 2 hours.

#### F2. A handful of IPs can exhaust the global notebook cap and lock everyone out of sightings for about 30 minutes
**Where:**
- `apps/field-station/src/server/notebooks.ts:31,143-146` (`MAX_OPEN_NOTEBOOKS = 5_000`)
- `http.ts:174-198`
- `sessions.ts:69-70`

**What happens:**
- Any client can mint a fresh session with `POST /api/badge` and no cookie. Requests without an Origin header are allowed.
- One sighting from that session opens a notebook that stays open for the 30-minute session.
- The per-IP limiter (burst 30, 1/s) is shared by the badge and sighting calls, so one IP sustains about 0.5 new notebooks per second, or roughly 900 per 30 minutes.

**Scenario:** about 6 IPs, or a small botnet, keep 5,000 notebooks open. Every real visitor's first sighting then gets 503 "too many open notebooks".

**Recommendation (judgment call):** pick one or more of these.
- Add a per-client-address cap on open notebooks, for example 3–5, by storing the address with the book.
- Require the session to be older than a few seconds before its first sighting.
- Raise the cap. Each notebook is under 2 KB, so 50k is cheap.

#### S2. A failed role switch leaves the page signed in as the wrong role, and a later reconnect closes every view
**Where:**
- `apps/site/src/scripts/field-client.ts:214-217` (`switchRole` sets `#role` before `reconnect()` and never restores it)
- `walkthrough.ts:144-153`

**Scenario:**
1. In chapter 3 the visitor clicks Drop. The role-switch button stays enabled.
2. In chapter 5 they click "Sign in as field biologist". It times out after 30 s with "Could not switch identity".
3. They click Restore. The client connects with a researcher badge, which is a new subject, so the SDK closes the gauge, overview, notebook and holt views with `UNAUTHENTICATED`.
4. Nothing re-watches those views, and the page still says "Signed in as a volunteer".

The same thing happens without Drop if the gateway takes longer than 30 s.

**Recommendation:**
- In `switchRole`, keep the previous role and restore it in `.catch` before rethrowing.
- Disable `[data-role-switch]` while the connection is dropped.

### Low

#### L1. One failed background poll fails the bench and ends the visitor's Lab lease
**Where:** `apps/field-station/src/lab/runtime.ts:74`
- The bench polls every second, and any error marks it `failed`: a single non-OK response or a 3 s timeout from its loopback management API.
- Nothing sets the state back after a later poll succeeds.
- The field station's next status poll (`leases.ts:53`) then ends the lease as `bench-failed` and resets the bench.

**Recommendation:** mark the bench failed only after about 15 s with no successful poll, or restore the previous state when a poll succeeds.

#### L2. `LAB_LEASE_SECONDS` above 300 silently makes the whole Lab unusable
**Where:**
- `lab/runtime.ts:82`: the bench rejects `expiresAt > now + 300 s` with 400.
- `lab/leases.ts:97-99`: the pool turns that into `unavailable`.
- `configuredLab` accepts any positive value.

**Scenario:** with `LAB_LEASE_SECONDS=600`, every lease grant fails, the slot cycles between unavailable and retry every 30 s, and nothing is logged.

**Recommendation:** cap the value at 300 in `configuredLab`, or pass the maximum to the bench.

#### L3. Bench-side failures reach visitors as 400 `invalid-request`, and the lease continues on a broken bench
**Where:**
- `lab/runtime.ts:168`: every error that isn't a `LabError` becomes 400.
- `lab/leases.ts:88,98`: anything below 500 is rethrown rather than treated as bench failure.

**Scenario:**
- The relay proxy is down and the visitor sends `relay.cut`. They get "invalid request" instead of `bench-unavailable`.
- The action's 1 s budget is spent, because `#nextAction` is set before the call that fails.

**Recommendation:**
- Answer 500 for errors that aren't a `LabError` or a parse error.
- Set `#nextAction` only after the action succeeds.

#### L4. Wrong Lab error code compared with the contract
**Where:** `lab/leases.ts:98`
- Every 409 from a bench is mapped to `not-applicable`.
- When the bench says `no-lease`, the visitor should get `no-lease`, as `docs/contracts/lab-api.md` §3 and §7 require.

**Recommendation:** read the bench's `code` from the response body and pass it through.

#### L5. The bench's work queue keeps growing during long resets
**Where:** `lab/runtime.ts:74` with `run()` at `:37`
- The 1 s timer adds a poll to the queue whether or not the previous one has finished.
- A reset or `gateway.restart` that holds the queue for 30 s or more stacks up dozens of polls, and visitor calls wait behind them.

**Recommendation:** skip the tick while one is already in flight.

#### L6. API error answers carry no CORS headers, so the page sees a network error instead of the message
**Where:** `apps/field-station/src/server/http.ts:200-203`
- The outer `catch` sends 400 without `cors`.
- Malformed JSON, a body over 4 KB, or an unexpected throw on `/api/badge` or `/api/notebook/sightings` therefore reaches the site as an opaque fetch failure.

**Recommendation:** hoist `cors` above the `try` and pass it to the 400. See the patch in the appendix.

#### L7. The Lab page parses JSON before checking the status, so errors show up garbled
**Where:** `apps/site/src/scripts/lab.ts:29`, with `String(error)` at lines 89, 103, 105 and 111.
- A 502 with an empty body shows "SyntaxError: Unexpected end of JSON input".
- A timeout shows "TimeoutError: signal timed out".

**Recommendation:**
- Use `response.json().catch(() => ({}))`.
- Show `error.message`, with a friendly fallback.

#### L8. The Lab page can start several connects at once, and a stale feed page can land after a reset
**Where:** `apps/site/src/scripts/lab.ts:44-53, 72, 92-98`
- `leaseId` is set only after the token request and SDK import finish. Until then, every poll or visibility change starts another `connect()`, which mints another bench token and spends the 3/s lab budget.
- `feed()` checks only `leaseId`. A reconnect to the same lease while a trace request is in flight can set the cursor back, so entries are skipped.

**Recommendation:**
- Track a `connectingLeaseId` and skip `connect()` while one is pending.
- Capture a sequence number in `feed()` and drop stale pages.

#### L9. The static site sends no security headers, so its pages can be framed (clickjacking)
**Where:** `apps/site` deploys to Cloudflare Pages (`.github/workflows/site.yml`) with no `public/_headers` file. Caddy's headers cover only `demo.streamotter.app`.

**Impact:** any site can frame `/lab/` or `/field-station/` and trick a visitor into clicking Borrow, Return, Cut relay or Drop. The damage is limited to that visitor's own bench and session, and there is no CSP as defense in depth.

**Recommendation:** add `apps/site/public/_headers` for `/*` with:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- A CSP along the lines of `default-src 'self'; connect-src 'self' https://demo.streamotter.app wss://demo.streamotter.app; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.

Check the built output for inline `<script>` blocks first. If there are any, they need hashes in the CSP.

#### L10. The origin server accepts HTTPS from anywhere, bypassing Cloudflare
**Where:** `deploy/compose.yaml:110` (`"443:443"`) and `deploy/setup.sh:26`.
- Anyone who finds the origin IP skips Cloudflare's DDoS and WAF protection, which the threat model relies on.
- Client IPs still can't be spoofed, because `trusted_proxies` falls back to the socket address.

**Recommendation:** firewall 443 to Cloudflare's ranges, or enable Authenticated Origin Pulls (`client_auth` in Caddy).

#### L11. Stale shared relay-token instructions
**Where:**
- `deploy/make-secrets.sh:8-14,36` still generates `LAB_RELAY_TOKEN` and tells operators to restart `lab-1-kafka` with it.
- `lab/proxy-main.ts` reads `LAB_BENCH_N_RELAY_TOKEN`, and its header comment still names the old variable.
- `identity.ts:54` keeps a `relayToken()` that nothing uses, with a hard-coded development fallback.

**Impact:** setup fails closed, because Compose's `:?` stops startup, but the recovery steps are wrong.

**Recommendation:** update the comments and the heredoc, and delete `relayToken()`.

### Info (no action strictly needed)

- **Session and token lifetimes:** `sessions.ts:82` gives a gateway token at least 60 s even when the session has only seconds left, so a token can outlive its session by up to a minute.
- **Rate limiter cost:** `http.ts:72` sweeps the whole bucket map on every request once it holds more than 10k clients. Behind Cloudflare that needs a very wide attack, so it's acceptable.
- **Body decoding:** `http.ts:40` decodes each chunk as a string, so a multi-byte character split across chunks would be garbled. Bodies are at most 4 KB and normally arrive in one chunk.
- **`innerHTML` use:** `apps/site/src/scripts/live-creek.ts:85,143,151` interpolates only constants and revision numbers today. Prefer `createElement`, so that a future server label can't become XSS.
- **Unreachable routes:** `lab/runtime.ts:160-165` duplicates routes already handled earlier at 132-154. Remove them so the copies can't drift apart.
- **Token reuse past the cap:** `lab/runtime.ts:84` hands back the oldest existing token after 128 tokens. This is harmless, since the set is per lease.
- **Key file permissions:** `deploy/make-certs.sh:81` leaves `broker-keystore.pem` at mode 644. It is covered in practice by `secrets/` being mode 700. Separately, `make-secrets.sh` has a small race between checking that the file exists and writing it; `set -o noclobber` would close it.
- **HSTS:** the demo host's HSTS header has no `includeSubDomains`.
- **Preview builds:** Pages preview builds point at the production demo origin, so the live demo is always "unavailable" on previews (CORS and SameSite).
- **`renderAge`:** `field-cards.ts` shows "stale since…" for `stale` but not for `resync-required`.
- **Canvas animation:** `creek-canvas.ts:57` keeps animating off-screen after a tab switch. This costs CPU only.

---

## What was checked and found sound

**Sessions and badges** (`sessions.ts`, `identity.ts`)
- HMAC-SHA256 with domain-separated keys (`secret` for badges, `secret:session` for cookies).
- `timingSafeEqual` with a length check.
- Claims are type-checked and expiry is enforced.
- Production refuses secrets shorter than 32 characters.
- The cookie is `HttpOnly; SameSite=Strict; Path=/api`, and `Secure` in production.

**Authorization** (`access.ts`, used by both handler sets)
- Holts are for researchers only.
- A notebook is readable only when `observerId === principal.subject`.
- The notebook owner comes from the cookie, never from the request body.

**Site API** (`http.ts`)
- CORS is an allowlist with credentials.
- POSTs with a foreign Origin get 403.
- Bodies are capped at 4 KB.
- Unknown keys and query parameters on Lab routes get 400.
- Rate limits are per client, with separate Lab and site budgets.
- Sightings accept only values from fixed lists.

**Internal API**
- The service token is compared in constant time.
- Lab benches get their own per-bench tokens, limited to `station`, `otter`, `reach` and `creekOverview`. They cannot read notebooks or holts.

**Kafka**
- Production requires TLS and SCRAM.
- The producer is idempotent and waits for all in-sync replicas (`acks -1`).
- Topics are pre-created, with auto-creation off.
- Notebooks are compacted and also deleted on retention, with no tombstones, matching StreamOtter V1.
- Bench copies of the creek topics never include notebooks.

**Gateway handlers and generated files**
- `map` refuses records from the wrong topic.
- Snapshots go to the internal API with the service token.
- The generated types in `apps/site` and `apps/field-station` are identical.
- `node scripts/configs.ts --check` reports all three `streamotter*.json` files up to date.
- `contract-check.ts` pins the simulation's views to the generated types.

**Lab**
- Lease tokens carry 256 random bits and are bound to the current lease.
- Tokens are cleared on every reset.
- Each session holds one place and each address at most two, and the queue is capped.
- The bench always comes from the session, never from the request.
- Every field-station-to-bench call has a 5 s timeout.
- The management API listens on loopback only.
- Benches refuse development principals.
- The relay proxy is plain TCP, so it has no HTTP request-smuggling surface.

**Edge**
- Caddy overwrites `X-Client-IP` and trusts only Cloudflare's ranges, or only the strict edge peer on the shared host.
- Only `/api/*`, the gateway and `/lab/N/socket.io/*` are routed.
- No internal port is published.
- Containers run as `node`.
- Secrets are written with `umask 077`.

**Site**
- No `set:html`, `is:inline` or `define:vars`.
- No localStorage.
- Tokens stay in memory and go through Socket.IO `auth`, never in a URL.
- Revision guards stop out-of-order updates from overwriting newer snapshots.
- Timers and listeners are cleaned up on `pagehide`.

**Tests:** `npm test` passed 119/119, `npm run typecheck` passed, the Lab tests passed 18/18 and the site tests 27/27.

---

## Appendix: patch for F1 and L6

I tested these patches locally and then discarded them, since this review is report only. The new tests fail on `main` and pass with the change.

```diff
--- a/apps/field-station/src/server/station.ts
+++ b/apps/field-station/src/server/station.ts
@@ advance()
     for (const emission of advanceTo(world, this.targetTick())) this.#write(emission);
-    if (this.#now() - this.#lastCheckpointAt >= CHECKPOINT_EVERY_MS) await this.checkpoint();
-    await this.flush();
+    // Publish even when the checkpoint fails (a full disk, say): its error still reaches the caller.
+    try {
+      if (this.#now() - this.#lastCheckpointAt >= CHECKPOINT_EVERY_MS) await this.checkpoint();
+    } finally {
+      await this.flush();
+    }

--- a/apps/field-station/src/server/http.ts
+++ b/apps/field-station/src/server/http.ts
@@ publicApi
     const url = new URL(request.url ?? "/", "http://field-station.invalid");
+    // Set once the request is under /api/, so an error answer still carries CORS and the page can read it.
+    let cors: Headers = {};
     try {
@@
-      const cors: Headers = { vary: "Origin" };
+      cors = { vary: "Origin" };
@@
-      if (!response.headersSent) send(response, 400, { error: "Bad request." });
+      if (!response.headersSent) send(response, 400, { error: "Bad request." }, cors);
```

Tests to add, in `apps/field-station/test/server.test.ts` (add `mkdir` to the `node:fs/promises` import):

```ts
test("a failing checkpoint doesn't stop publishing", async () => {
  const dir = await dataDir();
  const publisher = new FakePublisher();
  const time = clock(0);
  const field = await station({ dir, publisher, now: time.now });
  await field.flush();
  await mkdir(join(dir, "world.json.tmp")); // every checkpoint write now fails
  time.to(1_801);
  await assert.rejects(field.advance());
  assert.equal(publisher.batches.length, 2, "the hour's views were published anyway");
  assert.equal(field.pendingCount, 0);
});

test("a malformed request from the site's origin gets a 400 the page can read", async () => {
  const response = await fetch(`${apiOrigin}/api/badge`, { method: "POST", headers: { origin: "https://streamotter.app", "content-type": "application/json", "x-client-ip": "198.51.100.40" }, body: "{not json" });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://streamotter.app");
});
```
