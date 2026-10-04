# SITE review findings

Summary: 1 major, 9 minor. The site code is careful overall: allocation is click-only, server text never reaches an HTML sink, and planned V1.1 material is labeled as planned. The defects are in edge-of-lifecycle handling (an expired session, dropped in-flight answers), two pieces of copy the backend's own answers contradict, and the workbench panel's live-region and focus behavior.

## SITE-1 Lab page is stranded when the session cookie lapses mid-lease: it says "Borrow a bench" with Borrow disabled  (major)
- Where: apps/site/src/scripts/lab.ts:168 (leasePoll catch), :20 (`no-session` message), :162 (status only re-enables Borrow when `lease` is none/ended); compare apps/site/src/scripts/workbench.ts:120, which handles the same 401 correctly.
- What: a 401 `no-session` from `GET /api/lab/lease` goes through the generic catch. That catch shows "Your Lab session has ended. Borrow a bench to start again." but leaves `lease` at its last `ready`/`active` value, so Borrow stays disabled, the clock keeps counting down a lease that no longer exists, and Return answers 401 each time it is pressed. Only a reload recovers.
- Failure scenario: the `lc_session` cookie lasts 30 minutes (`SESSION_SECONDS`, apps/field-station/src/sessions.ts:12). It is set once, by the visitor's first badge or Lab join, and the server ends a place when the session expires (`session-ended`, lab/leases.ts:55). The browser drops the cookie at the same moment, so the page never sees the `ended` view. It gets 401 on every poll. Example: a visitor watches the home page for 27 minutes and then borrows a bench. Three minutes into the lease the page is stuck as shown below.
- Evidence: a throwaway Playwright repro (since reverted) granted a lease, then made every `/api/lab/*` route except status answer 401 `no-session`, then waited 12 s. Output: `message: Your Lab session has ended. Borrow a bench to start again.` · `Borrow disabled: true | Return disabled: false` · `clock: 4:49 left on your lease`.
- Suggested fix: when a lease, return, or token request is refused with `no-session`, render the lease as ended or none, the way workbench.ts:120 does. That disconnects, resets the panel, and re-enables Borrow.

## SITE-2 Workbench: an answer to an in-flight Start is dropped, so the allocated place is never shown, kept alive, or returned  (minor)
- Where: apps/site/src/scripts/workbench.ts:150 (`if (g !== generation) return;` drops the POST answer), :172 ("Check again" stays enabled while busy), :186–195 (revalidate), :200–205 (pagehide only returns when `holding()`).
- What: `generation` is bumped by "Check again" and by pagehide, and either can happen while `POST /api/sandbox/session` is in flight. The server still allocates, but the page drops the lease. `holding()` stays false, so the page never sends heartbeats for that place, and pagehide never returns it.
- Failure scenario: the visitor presses Start and then "Check again" before the answer arrives. Revalidate's `GET session` goes out before the POST's `Set-Cookie` lands, so it gets 401. The page settles on `idle` with Start enabled, while the field station holds a queued place or slot for the browser. That place ages out as `idle` (60 or 90 s) and meanwhile counts against the shared two-places-per-address cap. Leaving the page right after pressing Start gives the same result.
- Evidence: a throwaway Playwright repro (since reverted) delayed the POST by 1.5 s and clicked Check again 100 ms after Start. After 12 s: `phase: idle | server holds: {"status":"queued",...}`. Requests seen: `GET status, GET session, POST session, GET status, GET session`, and no heartbeats after that.
- Suggested fix: disable Check again while `busy`. Either always apply a successful Start answer, since allocation is idempotent and the answer is authoritative, or make pagehide also return when a Start is in flight.

## SITE-3 Existing Lab scenarios say "Runs today on a leased bench" even when the backend reports they can't run  (minor)
- Where: apps/site/src/scripts/lab-catalog-model.ts:75 (`if (entry.controls !== null) return { state: "existing", … }` comes before any look at the answer).
- What: the capability summary reports Fouled sensor, relay cut, slow client, and relay restart as `available: false` ("This backend has no Lab benches.") when `lab` is `disabled`. The fixture demo has no benches either. The cards still show ▶ "Runs today on a leased bench with the … controls below", next to "The Lab is unavailable" and the backend note "(no Lab benches)".
- Failure scenario: a deployment with the Lab disabled, or `npm run dev`. Every existing-scenario card claims it runs today. This is the honest-labeling rule the new scenarios follow, not applied to the old ones.
- Evidence: a throwaway node test (since reverted) ran `scenarioAvailability` on `labCapabilities({ labEnabled: false })`. Backend: `{"id":"fouled-sensor","available":false,"reason":{"code":"lab-disabled",...}}`. Page: `{"state":"existing","text":"Runs today on a leased bench with the Fouled sensor controls below."}`, and the same for relay-cut.
- Suggested fix: for scenarios with controls, use the summary's `available` and reason when there is one. On `absent` or `unreachable`, word the line conditionally, for example "Runs on a leased bench when this backend has benches".

## SITE-4 The retried-record outcome says "After Resume" even when Resume was never pressed  (minor)
- Where: apps/site/src/scripts/lab.ts:187; apps/site/src/scripts/lab-feed.ts:118–121.
- What: the feed marks any `processed` record whose offset failed earlier as retried, whatever caused the retry. The outcome sentence then always starts "After Resume the gateway retried the same record…".
- Failure scenario: Foul sensor, then Restore calibration, then Restart gateway instead of Resume. `gateway.restart` is allowed while the source is paused (runtime.ts:294). The restarted consumer in the same group re-reads the uncommitted offset 246, and the page says "After Resume…" for something the visitor did not do. That the bench re-reads the offset after a restart is inferred from reading; the page behavior is reproduced.
- Evidence: a Playwright rendering-fixture repro (since reverted) fed: foul, failed 246, paused, restore, restart, gateway-stopped/started, processed 246. Outcome text: "After Resume the gateway retried the same record, offset 246 …".
- Suggested fix: name the most recent `source.resume` or `gateway.restart` action before the retried record, or drop the "After Resume" prefix.

## SITE-5 Workbench status region: the claim countdown re-announces every second, and the panel rewrites the region's text every second in every phase  (minor)
- Where: apps/site/src/pages/workbench.astro:25 (headline and detail inside `role="status"`); apps/site/src/scripts/workbench-model.ts:175 ("Claim it within m:ss"); apps/site/src/scripts/workbench.ts:197 (`setInterval(render, 1_000)`), :91–92.
- What: the session clock was correctly put outside the live region, but the ready-phase claim countdown is inside it, so the polite status region changes every second for up to 30 s. In every other phase, `render()` still replaces both text nodes each second with identical text.
- Failure scenario: a screen-reader user reloads with a slot waiting to be claimed, or a claim fails. The region announces "Sandbox slot 1 is yours to claim. Claim it within 0:29…" every second. The identical-text rewrites in other phases may also be re-read by some screen-reader and browser pairs; that part is inferred, not tested with a screen reader.
- Evidence: a Playwright repro (since reverted) read the region once a second: "…within 0:30", "0:30", "0:29", "0:28". A MutationObserver on `.sandbox-state` counted 8 mutations in 3 s.
- Suggested fix: move the countdown out of the status region (next to `[data-sandbox-clock]`), and only assign `textContent` when the text changes.

## SITE-6 Workbench: keyboard focus falls to `<body>` after Start, End session, and the other lifecycle buttons  (minor)
- Where: apps/site/src/scripts/workbench.ts:100 (`button.hidden = …; button.disabled = …` on every render), :146 (`act` disables every control while busy).
- What: the button that has focus is disabled and then hidden, for example Start once the visitor is queued and End session once the session has ended. Focus is not moved anywhere.
- Failure scenario: a keyboard or screen-reader user presses Enter on "Start a sandbox session". Focus is lost, and the polite region is the only clue to what happened. The same happens with "Leave the line" and "End session".
- Evidence: a Playwright repro (since reverted) printed `after Start, activeElement: <body …>` and `after Leave the line, activeElement: <body …>`.
- Suggested fix: after a lifecycle action, move focus to the button that replaces the one pressed (Return or Claim after Start, Start after End), or to the headline with `tabindex="-1"`.

## SITE-7 Lab "too-many-places" message blames the Lab when the cap is shared with the sandbox  (minor)
- Where: apps/site/src/scripts/lab.ts:27; compare apps/site/src/scripts/workbench-model.ts:38 and the shared cap in apps/field-station/src/lab/leases.ts:106 and sandbox/leases.ts:143.
- What: the Lab says "Your address already holds two places in the Lab." The cap counts Lab and sandbox places together, as the sandbox contract (§8) and the workbench copy both say.
- Failure scenario: a visitor holding one workbench sandbox place and one Lab place tries to borrow again. They are told they hold two Lab places and go looking for a second Lab tab that doesn't exist. Today's production sandbox is `seam-unavailable`, so impact is low for now.
- Evidence: inferred from reading.
- Suggested fix: reuse the workbench wording: "…two places across the Failure Lab and the workbench sandbox…".

## SITE-8 Lab bench buttons are enabled for actions the bench refuses  (minor)
- Where: apps/site/src/scripts/lab.ts:103–109 compared with apps/field-station/src/lab/runtime.ts:294.
- What: the page enables "Start slow client" whenever `satellite === "idle"`, but the server also requires a healthy source and a running gateway. The page enables "Cut relay" without checking the gateway, and "Restart gateway" without checking the relay. A click then gets 409 `not-applicable`, now shown as "That action doesn't apply to your bench's current state." The mismatch predates this PR; this PR adds the message and the scenario story around those buttons.
- Failure scenario: Foul sensor (the source pauses), then press "Start slow client". The button looks available, the request fails, and the action spends the one-a-second budget.
- Evidence: inferred from reading both predicates.
- Suggested fix: mirror the server's predicate in `benchState()`, or have the bench report the allowed actions.

## SITE-9 Track and scenario links swallow modified clicks (Ctrl/Cmd/Shift-click)  (minor)
- Where: apps/site/src/scripts/lab-tracks.ts:47 and :55 (unconditional `event.preventDefault()`).
- What: these links exist to be shareable (`?scenario=…#track`), but Ctrl/Cmd-click or Shift-click only change the current page in place. No new tab or window opens.
- Failure scenario: a visitor Cmd-clicks "Bad projection: recover from authoritative state" to open it in a new tab. The current page re-selects instead and nothing opens.
- Evidence: inferred from reading.
- Suggested fix: return early when `event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey`.

## SITE-10 A 5 s heartbeat against a 60 s idle limit can end a sandbox session in a background tab  (minor, inferred)
- Where: apps/site/src/scripts/workbench.ts:18, :182 (chained `setTimeout` heartbeat); apps/field-station/src/sandbox/leases.ts:23 (`idleMs: 60_000`). The Lab page has the same pattern against a 30 s lease idle limit (lab/leases.ts:55).
- What: Chrome's intensive throttling applies to chained timers in a page that has been hidden for 5 minutes, and limits their wake-ups to one per minute. That is right at the 60 s idle limit (`now - heartbeat >= 60_000`).
- Failure scenario: a visitor with an active 10-minute sandbox session reads the docs in another tab for more than 5 minutes. The session ends with "Your session ended because this page stopped checking in.", although the page told them "Keep this page open: it checks in for you".
- Evidence: inferred from browser policy and the timings; not reproduced.
- Suggested fix: heartbeat on `visibilitychange` to visible and tolerate one missed beat, or make the idle limit comfortably exceed a one-minute throttled timer, or state the limitation in the copy.

## Checked and found correct
- The workbench sends `POST /api/sandbox/session` only from the Start click. Opening, reloading, and bfcache restores only ask for status and the session. Auto-claim follows only this page's own Start or Reset, and pagehide clears it.
- `SignInRetry`: backoff runs 1 s, 2 s, … up to 30 s and resets on `connected`. Only the newest request decides whether a failure is transient. Retries are cancelled on `switchRole` and `restoreConnection`, and the listener is stopped on close or the `closed` state, so no timer outlives the page. 4xx refusals (the Lab's 409 `no-lease`) stay final and trigger the Lab's lease poll.
- `switchRole` falls back to the earlier role when it fails, so a scheduled retry signs the same volunteer back in. A narrow race remains if a researcher handshake completes just after the 30 s wait times out; it was not reproduced.
- No unsafe HTML in changed code. Every server string (feed, incident, sandbox errors, release-service lines) goes through `textContent`. The WHC-1 boot JSON is `textContent` of an `application/json` script. Repro downloads use a Blob.
- Lab feed: bounded (500 kept, 100 shown), cleared per lease, routine lines evicted before scenario lines, late traces inserted in time order, and slow-client OVERLOADED detected in either arrival order. Sequence guards drop stale feed and incident pages and view events after a reconnect; `connectingLeaseId` prevents a second connect while one is pending.
- The incident panel is fetched only when the backend reports `incidentProjection.available`. Updates don't move focus or close the coordinates disclosure.
- Planned V1.1 material is labeled "planned / not in 0.1.0-rc.3" on the home page, when-it-breaks, docs, and releases. The workbench screenshots carry `capture.json` provenance rather than the site's pin. A 404 or unreachable capability check leaves every new exercise unavailable, with no mock fallback.
- Timers: the Lab clears its poll and clock on pagehide and reloads on a persisted pageshow. The workbench's `stop()` and `start()` pair leaves exactly one interval after a bfcache restore.
- Creek map: label boxes measured in Chromium. None overlaps the 8-unit stroke or overflows the viewBox.
- `npm run typecheck`, `npm test` (275 pass), `npm run build -w apps/site`, and `npm run check:site` all pass. `e2e/lab.spec.ts`, `lab-source-failures.spec.ts`, and `workbench.spec.ts` pass in Chromium (41 tests). The slow-client spec passed 12 out of 12 repeats. All repro files and the local Playwright config were removed, and the worktree is clean.
