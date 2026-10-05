# SITE review: apps/site and e2e

Scope: `apps/site` (pages, components, browser scripts, public/, the site tests) and `e2e/`, on main at d6e426a ("main", phase one) and PR #42 at 61184c1 ("#42", phase two).

**Summary: 0 blocker, 1 major, 4 minor.** Every phase-one acceptance check passes against main's production build, and every phase-two check passes on #42 with the Lab off. The one major finding is about content. On 2026-10-05, npm moved `latest` to 0.2.0-rc.1. Main's site still tells visitors to run an unpinned `npm install streamotter`, labels everything v0.1.0-rc.3, and says V1.1 "is specified, not released". #42 already fixes the install command.

## How this was tested

Work directory: `<scratch>/work-site/`. Both worktrees were copied there (`main/`, `pr42/`); neither original was touched.

- **Production builds.** Each copy was built with `PUBLIC_FIELD_STATION_ORIGIN=https://demo.streamotter.dev npm run build -w apps/site`, the same command and env as `.github/workflows/site.yml`. The output is in `dist-main/` and `dist-pr42/`.
- **Backend stand-in.** `harness/api.ts` runs the field station's real `publicApi` (`apps/field-station/src/server/http.ts`), configured as the hosted demo: no Lab pool, no sandbox pool, `SITE_ORIGIN` = the local site. A stub stands in for the station and the notebooks. Beside it runs the repository's fixture gateway (`apps/field-station/scripts/dev.ts`). Main uses ports 5600–5602 and the site on 5621; #42 uses 5700–5702 and 5721.
- **Serving.** `harness/static.mjs` serves the built `dist/` the way Pages does: `dir/index.html`, and `404.html` for misses.
- **Routing.** Chromium (`/opt/pw-browsers/chromium`) loads the page from the local server. A Playwright route forwards every request to `https://demo.streamotter.dev/**` to the local `publicApi`, so the cross-origin production bundle runs unchanged. For "backend stopped" runs, the route aborts with `connectionrefused`.
- **Scripts.** All repro scripts are in `work-site/harness/`.

Acceptance runs (`harness/accept.mjs <repo> <site> <api|"">`):

```
main, backend up
home live states             ["live","live","live"]
revisions advance            ["r13","r1","r13"] -> ["r15","r15","r15"]
after drop states            ["stale","stale","stale"]
frozen 6s                    true
connection                   reconnecting
after restore revs           ["r15","r15","r15"] -> ["r20","r20","r20"]
note                         Back with fresh snapshots. LC-02 r15 → r19 · LO-07 r15 → r19 · LC-03 r15 → r19. ...
lab                          "The Lab is unavailable." · "Lab not enabled on this deployment." ; borrow disabled true
workbench status             "The workbench sandbox is not enabled on this deployment. ..."
main, backend stopped
home status                  unavailable ; drop disabled true ; Lab "The Lab is unavailable." ; borrow disabled true
workbench status             "The sandbox's status is unknown. The field station did not answer ..."
field-station                "Field station unavailable." + Try again ; releases "The field station didn't answer."
```

On main's `/lab/`, the eight new source-failure exercises each read "This backend's StreamOtter release (0.1.0-rc.3) doesn't provide …". Fouled sensor reads "This backend has no Lab benches.", and the track note reads "0 of 8 new exercises can run here" (`harness/lab-main-up.txt`). A 90 s drop followed by Restore also recovers to live with a fresh snapshot (`harness/longdrop.mjs`). The walkthrough's drop, restore and role switch, and the playground console, all work on the production bundle (`harness/walk.mjs`).

---

## SITE-1 Unpinned `npm install streamotter`, and "V1.1 not released" copy, now that npm `latest` is 0.2.0-rc.1 (major, main)

**Where (main)**
- `apps/site/src/pages/index.astro:16`: the quickstart's `"npm install streamotter"`.
- `apps/site/src/pages/index.astro:56-57`: the hero's copy button, `data-copy="npm install streamotter"`.
- `apps/site/src/pages/workbench.astro:73`: the "Run it locally" block.
- Copy that is now false or stale:
  - `index.astro:62`, "The API may change before 0.1.0."
  - `index.astro:165`, "StreamOtter V1.1 is specified, not released."
  - `releases.astro:23`, "StreamOtter V1.1 is planned, not installed."
  - `docs.astro:15`, "When a StreamOtter release ships them, this page links its guides."
  - `field-station.astro:46`, "planned for StreamOtter V1.1".
  - `layouts/Base.astro:50`, the og:image alt (the social card shows the same unpinned command).

**What is wrong.** npm's `latest` tag is now 0.2.0-rc.1:

```
$ npm view streamotter dist-tags version
dist-tags = { latest: '0.2.0-rc.1' }
version = '0.2.0-rc.1'
$ curl -s https://registry.npmjs.org/streamotter | jq .time   # 0.2.0-rc.1: 2026-10-05T03:23:31Z
```

So the command the home page offers, and copies to the clipboard, installs 0.2.0-rc.1. Everything around it describes 0.1.0-rc.3:
- the hero badge `v0.1.0-rc.3`;
- "The API may change before 0.1.0";
- the Getting started, CHANGELOG and status links, all pinned to the `v0.1.0-rc.3` tag;
- "StreamOtter V1.1 is specified, not released", which is now false, since 0.2.0-rc.1 ships V1.1.

`docs/releases/0.2.0-rc.1/ROLLOUT_PLAN.md` (step 1) already says the `latest` move "moves every unpinned `npm install streamotter` to 0.2.0-rc.1. Two changes can refuse a config or request that rc.3 accepted." #42 fixes the install command (`site.ts:13`, ``INSTALL_COMMAND = `npm install streamotter@${RELEASE}` ``, with a comment giving exactly this reason). Phase one ships main, which doesn't have the fix.

**Failure scenario.** A visitor to https://streamotter.dev after the phase-one deploy:
1. Clicks Copy on `npm install streamotter` and follows the rc.3 getting-started guide linked beside it.
2. Gets 0.2.0-rc.1. Its CHANGELOG lists config and request refusals that rc.3 accepted.
3. Meanwhile the page says this version doesn't exist yet.

**Repro.**
- The npm commands above.
- `grep -n 'npm install streamotter' apps/site/src/pages/index.astro apps/site/src/pages/workbench.astro` on main.
- The rendered hero in `dist-main/index.html`: `<code>npm install streamotter</code>` next to `v0.1.0-rc.3`.

**Suggested minimal fix.**
- Backport #42's `INSTALL_COMMAND` (`npm install streamotter@${RELEASE}`) into `index.astro` (hero and quickstart) and `workbench.astro`.
- Reword the four "V1.1 not released / planned" lines to "not in 0.1.0-rc.3, which this site runs; released in 0.2.0-rc.1".
- Alternatively, ship phase one only together with #42.

## SITE-2 Home live panel never retries after `/api/config` fails, yet says "Still trying to reach the field station" (minor, both)

**Where.** `apps/site/src/scripts/live-creek.ts:52` sets "Still trying to reach the field station". `:60-65` catches `FieldStationUnavailableError`, calls `unavailable(...)`, and then `return`s. Nothing runs `openFieldClient()` again, and the panel has no "Try again" button. The walkthrough has one (`walkthrough.ts`, `[data-walk-retry]`), and the playground's Connect asks again. #42 leaves this code unchanged.

**What is wrong.** If the site API doesn't answer when the page loads, the home panel gives up for good. The clock line still claims the page is retrying. This is the `/api/config` twin of the 2026-10-02 review's S1, which fixed only the badge path.

**Failure scenario.** The field station restarts: the phase-one 1a activation, any later deploy, or a crash. A visitor who lands on the home page during that window sees "Field station unavailable · Still trying to reach the field station" indefinitely, even after the backend is back. Only a reload recovers.

**Repro.** `harness/home-recover.mjs` loads the production build with the API refusing, then brings the API back and waits 60 s:

```
backend down: {"status":"unavailable","clock":"Still trying to reach the field station","states":["idle","idle","idle"]}
-- backend back up --
60 s later: {"status":"unavailable","clock":"Still trying to reach the field station","states":["idle","idle","idle"]}
requests: ["down GET /api/config"]
```

**Suggested minimal fix.** Do one of these:
- Retry `openFieldClient()` with the same 1 s → 30 s backoff that `SignInRetry` uses.
- Add a "Try again" button that reloads, as the walkthrough has, and change the clock text to say the page isn't retrying.

## SITE-3 `/lab/`'s polite status region is rewritten with identical text every 10 s while the Lab is off (minor, both)

**Where.** `apps/site/src/scripts/lab.ts:168` and `:170` on main (`:179` and `:181` on #42). `status()` runs from `poll()` every 10 s and assigns `message.textContent = "The Lab is unavailable."` each time. `[data-lab-message]` is `role="status"` (`pages/lab.astro`).

**What is wrong.** Each assignment replaces the text node (a `childList` mutation) inside a live region. The page announces nothing new, but some screen-reader and browser pairs re-read a live region on any mutation. SITE-5 in the v1.1 review fixed this pattern for the workbench with a write-only-on-change `text()` helper (workbench.ts: "only a real change touches the DOM, so live regions announce changes only"). The Lab page, which phase one serves as permanently unavailable, still has the pattern.

**Failure scenario.** A screen-reader user opens `/lab/` on the hosted demo, with the Lab off as configured. Every 10 s the polite region may say "The Lab is unavailable." again, interrupting reading for as long as the tab stays open. Whether a given screen reader re-announces was not tested; the mutations were measured.

**Repro.** `harness/lab-live-region.mjs` attaches a MutationObserver to `[data-lab-message]` on the production build for 31 s:

```
main:  role: status | mutations in 31 s: 3   (t=11, 21, 31 s; text unchanged: "The Lab is unavailable.")
#42:   role: status | mutations in 31 s: 3   (same)
```

**Suggested minimal fix.** Only assign when the text differs, for example `if (message.textContent !== text) message.textContent = text`, which is the workbench's `text()` helper. Apply it to every `message.textContent =` in `lab.ts`.

## SITE-4 No site-wide security headers: every page except #42's `/workbench/` can be framed (minor, both; L9 from CODE_REVIEW_2026-10-02 still open)

**Where.**
- Main has no `apps/site/public/_headers` and no meta CSP on any page. Response headers on Pages are Cloudflare's defaults.
- #42 adds `apps/site/public/_headers` with `/workbench/*` only: `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`. It also adds a meta CSP on `/workbench/` only.
- I checked how `/workbench/*` matches, using Cloudflare's own rule engine. `@cloudflare/pages-shared` `generateRuleRegExp` turns `*` into `(?<splat>.*)`, so `/workbench/*` does match `/workbench/` itself. The #42 header policy works for the page it targets.

**What is wrong.** L9 from 2026-10-02 (no `X-Frame-Options`, `frame-ancestors`, `nosniff`, or CSP for the static site) is recorded nowhere as fixed or accepted, and it is still open on both trees. Phase one ships `/`, `/field-station/`, `/lab/` and `/playground/` without frame protection. With the Lab and sandbox off, the most a framing page can do is trick a visitor into clicks on their own session:
- Drop or Restore their connection;
- switch identity;
- post a sighting to their own notebook, via the walkthrough's "Log sighting".

Turning the Lab on later makes Borrow, Return and the bench actions clickjackable, as L9 described. That is why this is minor today and needs only a config change to matter.

**Repro.**
- `ls apps/site/public/` on main: no `_headers`.
- `grep -c 'http-equiv="Content-Security-Policy"' dist-main/*.html dist-main/*/index.html` gives 0 for every page.
- On #42, `cat apps/site/public/_headers` shows only the `/workbench/*` block.

**Suggested minimal fix.** Add a `/*` block to `public/_headers` with `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`. Keep #42's `/workbench/*` block; Pages merges matching blocks.

A site-wide script CSP would also need hashes for the Base head bootstrap (`set:html` inline script) and for the inlined module scripts on main. #42 already stops Vite inlining `.js`, so only the bootstrap hash would remain.

## SITE-5 Static copy says the Lab "Runs" on a deployment where it's off (minor, both)

**Where.**
- `apps/site/src/demo-availability.ts:59` (main) and `:54` (#42): "Failure Lab: Connections and clients", `state: "runs"`. `/releases/` renders this under the "Today" column as **Runs**, with "Cut the relay, stall a laptop, restart the gateway, or foul a sensor on a leased, isolated bench."
- `apps/site/src/pages/index.astro:178` (main): "The Failure Lab's Fouled sensor shows that on a real bench." #42's home has the same sentence in its "What this demo runs" paragraph.

**What is wrong.** Both phases deploy with the Lab off. On the same `/releases/` page, the live report under the table says "Lab benches: none on this backend", and `/lab/` says "The Lab is unavailable." The static table still says the Lab runs today. The v1.1 review's SITE-3 fixed the same over-claim on the Lab cards by reading the backend's answer; the release table and the home copy were left as they were.

**Failure scenario.** A visitor reads `/releases/` → Demo availability → "Failure Lab: Connections and clients · Today: Runs". They click through to `/lab/` and find Borrow disabled and "The Lab is unavailable."

**Repro.** Run `harness/labtext.mjs <repo> <site> <api> /releases/` against either build (`harness/rel-pr42.txt` for #42). The table row reads `Failure Lab: Connections and clients	Runs	Cut the relay, …` and the live block below it reads `Lab benches: none on this backend.`

**Suggested minimal fix.** Do one of these:
- Label the row by what it needs ("Runs where the backend has benches"; state `partial`).
- Have `release-service.ts`, which already reads `backend.lab`, mark the row unavailable when the answer is `disabled`.

Also soften the home sentence to "…shows that on a leased bench, where this demo has benches."

---

## Checked and found correct

**Phase-one acceptance, main's production build (cross-origin to a stand-in demo.streamotter.dev)**
- The home panel reaches live on all three cards, and revisions advance.
- **Drop really drops.**
  - All cards go stale, revisions stay frozen for 6 s, and the connection reads `reconnecting`.
  - Restore brings fresh snapshots with the "weren't replayed" note.
  - A 90 s drop also recovers.
  - The head bootstrap (`Base.astro` `bootstrapTabletNetwork.toString()`) serializes to a self-contained classic script that runs before every module script on every page (checked in the built HTML). The SDK's Socket.IO client is `transports: ["websocket"]` only (`@streamotter/client/dist/connection.js:21`), so no polling fallback slips past the cut.
- `/lab/`:
  - It shows "The Lab is unavailable." with "Lab not enabled on this deployment." and Borrow disabled.
  - Each of the eight new exercises names what rc.3 lacks, Fouled sensor says "This backend has no Lab benches.", and the note reads "0 of 8".
  - "Start this scenario" stays `aria-disabled` and sends nothing.
- `/workbench/` says "The workbench sandbox is not enabled on this deployment."
- Canonical URLs on all 9 pages, `/robots.txt` and `/sitemap.xml` name `https://streamotter.dev`. The sitemap lists `/` plus the 7 ready pages.
- **Backend stopped:**
  - every page loads;
  - the home panel shows unavailable, with Drop disabled;
  - the walkthrough shows unavailable with Try again;
  - `/lab/` is unavailable;
  - `/workbench/` reads "status is unknown";
  - `/releases/` reads "didn't answer";
  - the console shows only connection-refused errors.

**Phase-two wording, #42's production build against rc.1 with the Lab off**
- Every exercise, Fouled sensor included, reads "This backend has no Lab benches." The note reads "This backend runs StreamOtter 0.2.0-rc.1 … 0 of 8 new exercises can run here", and no Start button is enabled.
- `/releases/` reports "New source-failure exercises it can run: 0 of 8."
- `/workbench/`:
  - It says the sandbox is not enabled.
  - Its meta CSP is `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://demo.streamotter.dev wss://demo.streamotter.dev; object-src 'none'; base-uri 'none'; form-action 'self'`.
  - The built page has no inline script, style or `style=`.
  - No `securitypolicyviolation` fires; the menu and fonts work under the policy.
  - `workbench/assets/0.2.0-rc.1/app.js` is in `dist`.
- #42's home, drop and restore, walkthrough and playground all work on rc.1.

**Security and DOM safety**
- The only `innerHTML` sinks (`live-creek.ts:85,143,151`) interpolate constants and `shortRevision` bigints.
- Every server string reaches the DOM through `textContent`: capability reasons, lab feed and incident text, sandbox problems, release-service lines, walkthrough notebook entries, the recording player. The same holds for #42's new `lab-operation.ts`, `lab-approval.ts` and playground presets.
- The workbench boot JSON is `type="application/json"` `textContent`, and the repro download is a Blob.
- No `eval`, `new Function` or `srcdoc`, and no URL is built from server data except `script`/`hostStyle` from the pinned seam (#42), which carry SRI `integrity`.

**Accessibility**
- axe-core finds no serious or critical violations on any route, in light and dark, with the backend up and down, or on the home page after Drop, for both builds (`harness/axe.mjs`). The only result is a moderate `landmark-unique` on `/releases/` (`section[data-release-demo]`).
- Drop and Restore hand focus to each other.

**Broken links**
- `npm run check:site` passes: 345 local links and assets on main; 371 plus the `/workbench/` policy check on #42.
- All 68 distinct external `github.com/jfricano/StreamOtter/{blob,tree}/…` targets in both builds exist at their pinned tag or commit, and every `#anchor` matches a heading slug (`work-site/gh/`, fetched through raw.githubusercontent.com). Both builds are covered: v0.1.0-rc.3 and commit 3c0443e for main, v0.2.0-rc.1 for #42.

**Content checks**
- Lease length (300 s = "five minutes"), idle limits, "three tries" before `resync-required` (`LOCAL_SYNC_ATTEMPTS = 3`), and the shared two-place cap wording all match the code.
- `release-facts.ts` is held to the installed package by its tests.

**Tests**
- Main: `npm test` 294/294; `npm run typecheck` clean; the full Playwright suite in Chromium against production bundles (`LONTRA_BROWSER_MODE=production`) passes 94/94.
- #42: `npm test` 441/441; typecheck clean; Playwright production mode passes 130/130.

**Test gap (not a defect)**
- `scripts/dev.mjs --preview` builds with `PUBLIC_FIELD_STATION_ORIGIN=""`, so CI's production-bundle run never exercises the cross-origin path that streamotter.dev uses (credentials, CORS on error answers, and a Lab-off `GET /api/lab/status` answered as 200 `{enabled:false}` rather than the fixture's 404). This review's harness covered that path by hand.
