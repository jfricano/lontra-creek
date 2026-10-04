# W3 handoff — `/workbench/` page shell

October 3, 2026 · Branch `feat/v1.1-workbench-page`, stacked on `feat/v1.1-sandbox-sessions` (W2) · [Implementation plan](../IMPLEMENTATION_PLAN.md) row W3 · [Sandbox API contract](../../../contracts/sandbox-api.md) draft 0.2 · [LC11-ADR-04](../decisions/LC11-ADR-04-workbench-sandbox-architecture.md)

The route, its navigation entry, and the site summary in `site.ts` are unchanged. The page now has four parts: the sandbox panel, the seed explanation with an **In your app** note, the step-by-step screenshots as a labeled fallback (jason removed the recorded video on 2026-10-04: its cursor was invisible and the steps are already written out), and the existing "Run it locally" steps.

## Files

| File | What it is |
| --- | --- |
| `apps/site/src/scripts/workbench-model.ts` | View model, no DOM: availability and reason text, problems, session phases and controls, runtime labels, end reasons, and `mountDecision` (the mount gate and WHC-1 boot block) |
| `apps/site/src/scripts/workbench.ts` | Page client: requests, heartbeat, `pagehide`/`pageshow`, buttons, the mount point |
| `apps/site/src/scripts/workbench-seam.ts` | `PUBLISHED_SEAM`, the pinned workbench release with WHC-1. `null` today |
| `apps/site/src/data/workbench-seed.ts` | The `station` and `jobProgress` records and mapped states (design fixture), and the In your app terms |
| `apps/site/src/pages/workbench.astro` | The page; recording provenance now comes from `public/recordings/workbench/capture.json` |
| `apps/site/test/workbench-{model,seam,seed}.test.ts` | Unit tests |
| `e2e/workbench.spec.ts` | Browser specs with stubbed `/api/sandbox/*` answers, and axe |

## States

The panel's `data-phase` attribute names the state; the headline is a `role="status"` region.

| Phase | When | Controls |
| --- | --- | --- |
| `checking` | First load, **Check again**, and a back-forward cache restore, until `status` (and, when relevant, `session`) has answered. Nothing held is shown, and runtime labels read "Not reported". | None |
| `unavailable` | `status` is `unavailable` (`disabled`, `seam-unavailable`, `service-unavailable`, `all-slots-unavailable`), `status` answered 404 (no sandbox routes, shown as not enabled), or it did not answer (shown as unknown, with the network or HTTP reason) | Start disabled; Check again |
| `idle` | Available and no place held. The pool line says how many slots are free, or that all are in use and Start will queue | Start |
| `queued` | Position, line length, and the service's upper bound for the next free slot | Leave the line |
| `ready` | Slot offered; claim window countdown from `claimBy` | Claim your slot, End session |
| `active` | Lease clock from `expiresAt`; the mount note says why nothing is mounted | Open the workbench (only until this page holds the current study's connection), Start over with a fresh study, Download reproduction bundle, End session |
| `resetting` | A reset is discarding the old study | End session |
| `ended` | Each `SandboxEndReason` in its own sentence; Start only if the sandbox is still available | Start |

Refusals (`too-many-places`, `queue-full`, `sandbox-unavailable`, `slot-unavailable`, `too-many-requests` with `Retry-After`, and the rest) appear in plain words in the note line, never as raw codes. A failed heartbeat says so without dropping the held state; a 401 `no-session` after holding a place shows `session-ended`.

**Allocation is explicit.** Only Start sends `POST /api/sandbox/session`. The page claims at once only after its own Start (or reset); a `ready` lease discovered on load waits for a click. While holding a place it heartbeats with `GET /api/sandbox/session` every 5 s and refreshes `status` every 15 s. On `pagehide` it returns the place with an empty-body `keepalive` request, and on `pageshow` from the back-forward cache it revalidates and never allocates.

**Labels.** Mode, packages, and host contract come only from `runtime` in the service's answers (the lease's while one is held, the pool's otherwise). With `runtime: null`, as `seam-unavailable` reports, they read "Not reported" with a note that the page never fills them in from the site's own build. The layout's eyebrow still shows the site's installed library version, as on every reference page; it is not a sandbox label.

**Design fixture.** The seed records and states are written into the page and labeled as a design fixture in the section notice and on each block. `workbench-seed.test.ts` derives them from their sources: the creek simulation's LC-03 record after one tick and the field station's own Kafka map handler, and the first `jobs` fixture record of the pinned `streamotter init` scaffold (`scaffoldFiles` from `streamotter/cli`) and that scaffold's map handler.

**Fallback recording.** Labeled "Fallback: a recording, not a sandbox session", with date, version, Node.js version, and source read from `capture.json`, so a later version pin cannot relabel it. Image alt text and captions use the capture's version.

## Inert until W9a

`mountDecision` mounts only when all of these hold: an `active` lease; `PUBLISHED_SEAM` is set; the lease's `runtime.contractVersion` equals the seam's host contract and `runtime.packages.workbench` equals its version; `GET /api/sandbox/wb/v1/workbench` lists `config`, `health`, `channels`, and `sources`; the API is on the page's origin (WHC-1 refuses a cross-origin `apiBase`; R11); and the claim's `SandboxConnection` matches the lease and study. Then it writes `script#streamotter-workbench-host` (JSON, session mode, `apiBase` `/api/sandbox/wb/v1`, gateway from the connection, `environment.kind: "sandbox"` with the service's mode label and workbench version), `div#app`, the stylesheet, and `app.js` with SRI. Discovery is not even requested while `PUBLISHED_SEAM` is `null`.

Today `PUBLISHED_SEAM` is `null` (rc.3 ships no `workbench-host.json`), the production service answers `seam-unavailable`, and the page mounts nothing and simulates nothing. `workbench-seam.test.ts` fails once the installed `@streamotter/workbench` publishes the manifest and `PUBLISHED_SEAM` has not been filled in from it.

W9a must: pin the release; serve its `dist/` files and set `PUBLISHED_SEAM` (version, script and style paths, integrity from the manifest); settle R11 (same-origin `apiBase`) and R12 (scoped styles); add the CSP from the manifest; and confirm how to remount after a reset (the page currently reloads `app.js` under a `?study=` query, which re-runs the module but does not tear down the old instance).

**WHC-1 revision 0.3** (StreamOtter PR #14, October 3, unpublished) settles R11 and R12 and changes what W9a builds:

- **Cross-origin API.** Write `apiOrigin: "https://demo.streamotter.app"` in the boot block, with `apiBase` staying the path `/api/sandbox/wb/v1`. Drop the same-origin condition from `mountDecision`. The workbench sends `mode: "cors"`, `credentials: "include"`, `redirect: "error"` and `X-StreamOtter-Workbench: 1`, never Authorization.
- **Preflight.** The sandbox adapter answers the CORS preflight itself, before `createManagementHandler`, which adds no CORS headers and answers OPTIONS with 404. It allows exactly the page origin with `Access-Control-Allow-Credentials: true` and the `X-StreamOtter-Workbench` and `content-type` headers (WHC-1 §3.4). `lc_session` is SameSite=Strict, which works because streamotter.app and demo.streamotter.app are same-site.
- **Styles.** Link the manifest's `entry.hostStyle` (`dist/workbench-host.css`, with its sha384), never `styles.css`. Every rule is scoped under `[data-streamotter-workbench]`, which the workbench sets on the mount. The manifest's `connect-src` gains an API-origin placeholder.
- **Landmarks.** The workbench renders its own `<main>` inside the mount. Today the mount sits inside the layout's `<main id="main">` (`Base.astro`), so W9a must move it out or give this page a layout without the outer `<main>`.
- **Session end.** In session mode any 401 or UNAUTHENTICATED shows "Session ended" with Reload, and the workbench stops polling.
- **Failures tab** (StreamOtter draft PR #17). It appears when discovery lists `failures.list`. Allowlist `failures.list`, `failures.show` and `operator.status` to show it. The action operations are optional and show as not available. The routes exist only when the slot gateway has `failureHandling`, which fixture mode may not support (LC11-ADR-04 open question 1).

## How to test

```bash
npm test                                   # includes the three workbench unit tests
ASTRO_TELEMETRY_DISABLED=1 npm run build -w @lontra-creek/site && npm run check:site
npx playwright test e2e/workbench.spec.ts --project chromium  # starts npm run dev; stubs every sandbox answer
```

The specs need no sandbox service: they stub `/api/sandbox/*` with `page.route`, and one spec checks the unstubbed dev field station (which has no sandbox routes). The back-forward cache spec dispatches `pagehide`/`pageshow` with `persisted: true`, because headless Chromium does not reliably restore from the cache; a separate spec navigates away and back for real and checks that nothing allocates. Firefox and WebKit runs belong to W10.

## Acceptance evidence (fixture level)

| ID | What this slice adds |
| --- | --- |
| LC11-A41 (partial) | Route and navigation unchanged; `station` beside `jobProgress` with records, states, and an In your app note, as a labeled design fixture checked against its sources; mount point for the published UI, inert until a release provides the seam. Mounting the actual UI is W9a |
| LC11-A45 | Mode and version labels only from the service's answers ("Not reported" otherwise); fallback provenance from `capture.json`; repro download only from the session's own `POST /api/sandbox/session/repro` |
| LC11-A46 (partial) | Pool full, service unavailable, seam unavailable, network failure, reload, back navigation, back-forward cache restore, and expiry stay honest without auto-allocation; axe clean in light and dark, Chromium only. Deployed origin and three engines are W9a/W10 |
| LC11-A35 (fallback provenance) | The recording keeps its own release and mode provenance and is labeled as a fallback |
