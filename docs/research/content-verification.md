# Content routes and product captures

September 27, 2026 · site content lane · pinned `streamotter@0.1.0-rc.3`

## Implemented

- `/docs`: four guide links verified with GitHub's contents API at `v0.1.0-rc.3`, plus the pinned API reference, status, changelog and npm version.
- `/releases`: package version, V1 boundaries, the existing sourced support matrix, Kafka modes and runtime-imported default limits. Package verification is explicitly separate from this deployment's unmeasured limits.
- `/when-it-breaks`: every error from `ERROR_FACTS`, retry caveats, browser/trace/operator visibility, an interactive explanatory state diagram and a compiled recovery example. The map failure explanation distinguishes an already-open view from a new synchronization attempt against an already-paused source.
- `/playground`: dynamically loaded published `validateProjectConfig`, JSON and configuration diagnostics, reset, a fixed LC-02 SDK console with explicit connect/disconnect and bounded output, ten-minute idle closure, and a labeled CLI transcript. Edits never configure the server. Browser type generation is unavailable because the installed CLI generator imports Node crypto/filesystem; this page directs users to the real local CLI.
- `/workbench`: genuine installed npm workbench screenshots for all five panels, a silent WebM session, text description, capture provenance, and local-run instructions. The homepage has a recorded Preview panel linking to this tour.

Only those five content routes are marked ready. This does not assert that the overall website is ready to launch.

## Capture provenance and reproduction

`apps/site/public/recordings/workbench/capture.json` records exact release, time, viewport, runtime, platform, image sizes and steps, and whether the package came from npm or from a pre-publish tarball. `scripts/capture-provenance.mjs` derives the release, the install source (from the lockfile) and the platform, for this capture and for `scripts/capture-demo.ts`'s creek recording, so neither label is typed by hand. `scripts/capture-workbench.mjs` scaffolds a temporary project with the installed npm CLI, starts its development gateway on loopback ports 7790/7791, drives the real workbench with Playwright, and closes/cleans up its own process and temporary files. The ephemeral management token is never logged or stored; the recording only sees a password input.

Run after installing the repository's QA dependencies and Playwright browsers:

```sh
node scripts/capture-workbench.mjs
```

This local run reused existing Chrome and FFmpeg installations (no downloads):

```sh
PLAYWRIGHT_BROWSERS_PATH=/Users/jasonfricano/coding/StreamOtter/.local/ms-playwright \
CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node scripts/capture-workbench.mjs
```

The local StreamOtter checkout's source was not used. Its existing browser/video binaries were reused. The captured package came from this site's installed npm dependencies.

## Verification

- `npm run typecheck`: passed, including the recovery snippet against rc.3.
- `npm test`: 107 tests passed, zero failures. Loopback permission required by server tests.
- `npm run build -w @lontra-creek/site`: passed, nine generated pages.
- `git diff --check`: passed.
- Installed Chrome, 390×844, light and dark, reduced motion: all five content routes had no horizontal document overflow and zero axe WCAG 2 A/AA or WCAG 2.1 AA violations. Keyboard-scrollability of the CLI transcript was corrected after the first scan.
- Browser validator: initial fixture valid, malformed JSON diagnosed, `{}` produces configuration issues, reset restores validity.
- Console unavailable case: explicit unavailable message and retry control. Real fixture-stack case on isolated ports 4490/7794–7796: authorizing → synchronizing → live, real snapshot payload received, Disconnect closes cleanly.
- Workbench video metadata loads in Chrome; six product screenshots and 988 KiB WebM generated. The recording includes the real snapshot and fixture advance.
- Validator route initially fetched 26,507 bytes gzipped across its route/runtime/contracts/shared chunks before the console was connected, below the 150 KB cap. The actual contracts validator chunk was 4,793 bytes gzipped. Vite shares contracts exports with the SDK chunk; the tablet network shim is installed before dynamic imports to preserve the field client's transport ordering. The contracts chunk does not load on the other content routes or homepage.
- Local screenshots are in `/tmp/lontra-content-shots/`; these are verification artifacts, not committed product assets.

## Remaining integration and launch evidence

Integrated QA should repeat content navigation, console and accessibility checks with the new walkthrough and Lab. Current Chrome checks do not establish Firefox/WebKit coverage. The field console was exercised on the local fixture stack, not hosted Kafka. Staging performance, real-host limits, walk-through timings, and the demo-down recorded fallback belong to the launch/integration work, not these content captures. The workbench tour is intentionally a local fixture capture and must never be labeled as the hosted creek.
