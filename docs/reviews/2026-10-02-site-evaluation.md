# Lontra Creek site evaluation

October 2, 2026 · lontra-creek `main` at e7df45e, critical finding re-checked at a09501c · streamotter@0.1.0-rc.3

## How this was tested

The hosted site was not reachable from the evaluation environment, because its network policy blocks the demo's domains. Everything below was run locally from `main`, two ways:

1. **Fixture mode** (`npm run dev`): Astro dev server plus the field station replay, no Kafka.
2. **Production stack** per `docs/LOCAL_LAB.md`: the built site behind Caddy on `https://localhost:8443`, Kafka 4.1.2 over TLS/SCRAM, the production gateway, the field station, and three Lab benches in Docker. This is the closest thing to the hosted deployment.

Driven with Playwright and Chromium: all 8 routes plus the 404 at 1366px and 390px; the six walkthrough chapters; a real sighting through Kafka; all four Failure Lab scenarios on a leased bench with a second visitor queued; the playground validator and console; the external link targets (all exist at the `v0.1.0-rc.3` tag and on npm); and the home page quickstart (`init` scaffolds the files the site names). The repo's own suite passes in Chromium: 31 of 31. Firefox and WebKit were not available here.

## Functional findings, by severity

### Critical (fixed in #23)

**1. "Drop my connection" did nothing on the production build (home hero and walkthrough chapter 3).**
*Status:* fixed by #23, which installs the WebSocket wrapper from a classic head script and adds production-bundle browser checks. I re-checked at a09501c on the local production stack: on both pages, Drop closes the sockets and the views go `stale`/`reconnecting`; Restore returns them to `connected`/`live` with the "not replayed" note. The original finding follows.

In the built site the button enables "Restore", but the WebSocket never closes. The view stays `live`, revisions keep arriving, and the header keeps saying `connected`. I reproduced this twice on the walkthrough and once on the home page. In fixture/dev mode the same button works: views go `stale` and recover with the "not replayed" note. This is the site's signature "never silently wrong" moment, and on the real deployment it would visibly fail.
- Cause: `tablet-network.ts` swaps `window.WebSocket` and has to run before Socket.IO evaluates, because engine.io captures `globalThis.WebSocket` when it loads (`R=A.WebSocket` in the built `client.*.js`). `field-client.ts` only imports the SDK dynamically. But the bundler put a shared runtime helper (`__export`, imported as `_`) inside the SDK chunk, so `field-client.*.js` statically imports `client.*.js`. The SDK therefore evaluates before `installTabletNetwork()` runs, and the wrapper never sees the sockets.
- Why tests miss it: `playwright.config.ts` runs against `npm run dev`. Vite dev serves unbundled ESM, which preserves the intended order. The stack CI test exercises the backend from Node, not the built browser bundle.
- Suggested fix: install the wrapper from its own tiny entry that is guaranteed to run first (an `is:inline` script in `<head>`, or a separate module script ahead of the page script). Alternatively, stop depending on evaluation order: cut the connection through an SDK-level hook if 0.1.0 exposes one, or force the helper out of the SDK chunk with `manualChunks`. Then add a Playwright project that runs against the built site (`astro build` plus the field station, or the local-lab Caddy origin), so bundle-only regressions get caught.

### Medium

2. **The Lab's gateway feed is a raw JSON firehose.** About 1,600 lines in 90 seconds, mostly `outcome: ok` traces, and not in time order (lease-started, then a record, then earlier traces). The two lines that prove the scenario are hard to find: `map` failing with `HANDLER_FAILED`, and the same offset being retried after Resume. Suggest a default "scenario view" that filters to non-ok traces, source state changes and the paused record's topic/partition/offset, and highlights "retried offset 246, processed" after Resume. Keep the full feed behind a toggle.
3. **The satellite scenario has no visible outcome.** The bench state flips `satellite connected`, then back to `idle`, and nothing says the slow client was disconnected after the 5 s receipt timeout while your view kept flowing. Add one line of outcome text, as the sensor and relay scenarios already have through the view state.
4. **Bench pool status lags.** A second visitor who has just been given Bench 2 still sees "Bench 2: ready". After returning a bench, the panel shows `closed · CLIENT_CLOSED` beside the last bench state. Refresh the pool on lease, and reset the panel on return.
5. **Mobile creek map is unreadable** at 390px. Reach labels are tiny and overlap (see `prod-mobile-field-station.png`). Drop the labels below a breakpoint and rely on the list below the map, or enlarge the SVG.
6. **Firefox and Safari are unverified.** The package's support matrix marks both unverified, and I couldn't run them here. The site's Playwright config already lists firefox and webkit, so run them, against the built site, before launch.

### Low

7. Sightings and the holt line show raw slugs (`alder-spring`, `kestrel-bend`) instead of reach names. Also "1 sightings" (`walkthrough.ts:83`, `:92`, `:94`).
8. Chapter 3 is titled "Into Slate Canyon", but the view being dropped is the Kestrel Bend (LC-02) gauge.
9. The walkthrough shows full 13-digit revisions (`1000000000286`) while the home page shortens them (`r285`). Pick one. If the long form stays, say in one line why it is so big.
10. The releases page leaks internal planning references: "PLAN.md's hosted demo starts this at 300" and "see PLAN.md and the E2.0 relay-cut spike" (`release-facts.ts:505`, `:509`, `:587`). Visitors can't see PLAN.md, so rephrase these as "this demo's limit is 300".
11. The Lab page says "The Lab is unavailable." twice when it is down.
12. **Ops note: the gateway crash-loops after an unclean stop.** After the Docker daemon died under the running stack and was restarted, `streamotter start` failed repeatedly with "Sources did not become ready within the 30-second startup deadline" (and a `notebooks` consumer `KafkaJSConnectionError`). It recovered after about 90 seconds, once Kafka removed the dead consumer-group members. Each restart left the site's sockets failing with 502. If this reproduces on the host, it is worth a StreamOtter issue (startup deadline versus consumer session timeout) and a line in OPERATIONS.md.

### What worked well

Every route returned 200 with unique titles; there were no console errors or page errors apart from the expected Lab-status 404 in fixture mode; no images were broken; and nothing overflowed horizontally at 390px. Code blocks and the releases table scroll inside their own containers. On real Kafka:
- Chapter 1 went live in under 0.5 s.
- Volunteers got FORBIDDEN with no holt data.
- The identity switch closed the old subscriptions with UNAUTHENTICATED and opened the holt.
- A sighting round-tripped through Kafka to the private notebook.
- Fouled sensor went `stale · SOURCE_UNAVAILABLE`, then the source paused with `HANDLER_FAILED`, then Resume brought it back live from a fresh snapshot.
- Relay cut went stale in about 12 s and back live within 4 s of restore.
- Gateway restart came back live from a fresh snapshot.
- Queueing a second visitor handed them an isolated bench.

Fiction and recordings are labeled everywhere, and I found no invented numbers.

## Do the demos generalize to StreamOtter's audience?

FOUNDING.md targets TypeScript app developers whose team already runs Kafka and who need live operational dashboards, job progress, or order/workflow status. The demos teach the right concepts: state channels rather than topics, snapshot then ordered revisions, named stale states, per-audience access, identity change, per-user private state, and a handler failure that pauses rather than skips. The otter story is memorable, and the hero clearly shows `field instruments → Kafka → gateway → your browser`.

The gap is that the visitor has to do the translation to their own app alone, and in a few places the site makes that harder.

1. **Add an "in your app" line to each chapter and each Lab scenario.** This is the cheapest, highest-leverage change. For example:
   - Gauge going live: an order-status or service-health tile loading.
   - Creek rises: job progress ticking up.
   - Canyon drop: a laptop on train Wi-Fi.
   - Protected holt: another tenant's data, or an admin-only view.
   - Hand over the tablet: logout/login or an expired token.
   - Sighting notebook: per-user notifications, or "my orders".
   - Fouled sensor: a bad deploy of your mapping code, or an unexpected schema change upstream.
   - Satellite link: one slow client must not stall everyone.
   - Relay restart: a rolling deploy of the gateway.
2. **Show the Kafka-record-to-state step.** Readers already have topics. The `map` handler is where adoption happens, and the site never shows a raw record (topic, key, value) beside the channel state it becomes. A small "record in → state out" panel on the home page or chapter 2 would make this concrete. The Lab feed already has topic, partition and offset to draw from.
3. **Make the walkthrough code copyable.** The chapter code shows the demo's own wrapper (`field.watch`, `field.dropConnection`, `field.switchRole`), not the SDK. Show the real `client.subscribe(...)`, `on("state")`, `getToken` and `resync()` calls for the current chapter, ideally changing as the chapter changes. The home page's three-step code already does this well.
4. **Bridge the two example domains.** The home page and walkthrough use otters, while the playground, workbench tour and quickstart use `jobProgress`. That is actually the more relatable domain, but nothing connects the two. Either seed the playground with the creek's `station` channel so edits relate to what the visitor just watched, or say explicitly: "the scaffold you'll get is a job-progress channel; here's the same shape as the creek." The playground's editor and console are also unrelated (editing the config can't affect the console), and the page says so. Consider letting a valid edit drive at least a local preview with the fixture.
5. **Show how identity plugs in.** "Badges" and "field biologist" hide the part every existing app has to wire: `getToken` returning your own session or JWT, and `authorize` reading claims. One sentence plus a snippet in chapter 5 ("this is your auth token; StreamOtter never issues identities") would close that.
6. **Consider a two-tab moment.** "Open this page in a second tab: both see the same gauge, only you see your notebook" demonstrates shared public state versus private channels, which is the V1 rule developers most need to absorb.

## Screenshots

In `2026-10-02-site-evaluation/`:
- [`prod-home-after-drop-still-live.png`](2026-10-02-site-evaluation/prod-home-after-drop-still-live.png): the production build before #23, 5 s after Drop.
- [`dev-walkthrough-after-drop-stale.png`](2026-10-02-site-evaluation/dev-walkthrough-after-drop-stale.png): the same action in dev, working.
- [`prod-lab-leased-bench.png`](2026-10-02-site-evaluation/prod-lab-leased-bench.png)
- [`prod-mobile-field-station.png`](2026-10-02-site-evaluation/prod-mobile-field-station.png)
