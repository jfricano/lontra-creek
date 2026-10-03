# W8 handoff: site content

October 3, 2026 · Branch `feat/v1.1-site-content`, stacked on `feat/v1.1-failures-track` (W4), which is stacked on `fix/v1.1-lab-hardening` (W1) · [Implementation plan](../IMPLEMENTATION_PLAN.md) row W8 · Companion plan §3 change matrix

The route set and navigation are unchanged. The six-chapter walkthrough and the live hero are unchanged. Every V1.1 statement is labeled as planned and names the installed version it isn't in (`streamotter@0.1.0-rc.3`). No page says a native V1.1 capability works.

## What each page says now

| Page | Change | How it avoids overclaiming |
| --- | --- | --- |
| `/` | A V1.1 panel below the state chips: preserve, continue under control, see each outcome, then **What runs today** and **Try source failures** (`/lab/#source-failures`) | The eyebrow reads "Planned for StreamOtter V1.1 · not in 0.1.0-rc.3"; the lede says "specified, not released". The **What runs today** paragraph describes only rc.3's pause and `resumeSource()` retry, and says the other exercises can't run yet |
| `/field-station/` | An "After the walkthrough" card with **Next: handle a bad reading** (`/lab/?scenario=fouled-sensor#source-failures`) and the installed version | Points at Fouled sensor, which runs today; says quarantine and guarded continuation aren't in this release. No seventh chapter, no injection into the shared creek |
| `/when-it-breaks/` | "Planned: source-failure policies in StreamOtter V1.1": the policy vocabulary, the failure-policy matrix with ADR-15B classes, the five-step record-disposition lifecycle, what the browser sees, planned operator commands, and redrive outcomes | A "Not in 0.1.0-rc.3" notice that quotes the installed validator's `UNKNOWN_KEY` for `failureHandling`, computed at build time. Each step says what it doesn't prove. Sources link to StreamOtter at the pinned commit `3c0443e`, never to `main` or the release tag. The installed release's reference above it is unchanged |
| `/releases/` | Title "Releases and availability". Four sections: Site release (pre-launch candidate; site milestone V1.1 in development; site and library milestones independent), Library package (exact pin; V1.1 planned, not installed), Demo availability (five surfaces, plus a live "What this field station reports" block), Verified operating boundary (the library's V1 boundaries, now including the pause-on-bad-record rule; support matrix; default limits) | Versions come from `apps/site/package.json` and the installed package, the recording's from `capture.json`, the count of waiting exercises from the Lab catalog, the playground's answer from the installed validator. The live block reports only what `/api/config` and `/api/lab/capabilities` answer, and says the field station didn't answer instead of filling in from the build |
| `/docs/` | "Source-failure handling (planned)": no guide exists in rc.3; links to the V1.1 specification (labeled planned), the policies summary, and the local Lab instructions | States that rc.3 has no source-failure guide |
| `site.ts` | `SITE.milestone` (`V1.1`, `in development`). Summaries for the Lab (two tracks; quarantine exercises wait for V1.1), When it breaks (adds planned V1.1 policies), and Releases (the four separations) | The workbench summary is left to W3 |

"Four controlled failures" no longer appears anywhere (W4 renamed the heading to "Bench controls"); no existing test asserted the old string. A unit test now fails if any `.astro` or `.ts` source under `apps/site/src` says it again.

## Files

| File | What it is |
| --- | --- |
| `apps/site/src/planned-failure-handling.ts` | Planned V1.1 facts: policies, matrix, lifecycle, operator actions, redrive outcomes, pinned sources, and the installed validator's answer to `failureHandling` |
| `apps/site/src/demo-availability.ts` | Site release facts and the demo surfaces table, derived from real sources |
| `apps/site/src/scripts/release-service.ts` | `/releases/` client: reads `/api/config` and `/api/lab/capabilities`; `serviceLines` is pure and unit-tested |
| `apps/site/src/pages/{index,field-station,when-it-breaks,releases,docs}.astro`, `apps/site/src/site.ts` | Page changes above |
| `apps/site/test/site-content.test.ts` | Unit tests |
| `e2e/home.spec.ts`, `e2e/content.spec.ts`, `e2e/accessibility.spec.ts` | Browser specs; axe now also covers `/when-it-breaks/`, `/releases/`, and `/docs/` in light and dark |
| `docs/contracts/ui-components.md` | New `data-*` hooks |

## Acceptance evidence

| ID | Evidence | Level |
| --- | --- | --- |
| LC11-A01 | Route list in `site.ts` unchanged (unit); the home **Try source failures** link and the field station **Next** link open the Source failures track with the right selection and send no non-GET Lab request (browser, dev and production bundles) | Unit, fixture browser |
| LC11-A02 | Walkthrough still has six chapters; the home live cards still reach `live` and the drop/restore spec passes; the next-step link is optional and outside the chapters | Fixture browser |
| LC11-A40 | One library version across the site pin, the field station pin, the lockfile, and the installed package (unit); every `streamotter@…` and "not in …" on seven pages equals the pin, and the Lab's count of waiting exercises equals the releases page's (browser); the releases page keeps site release, library, demo availability, and verified boundary in separate sections; the planned copy is tied to the installed validator rejecting `failureHandling` (unit), so a release that accepts it fails the test | Unit, fixture browser |

Not covered here: hosted status (nothing deployed), Firefox and WebKit (W10), and the content of `/workbench/` (W3).

## Notes for the lead

- On the fixture stack (`npm run dev` and the production preview), `/api/lab/capabilities` answers 404, so the releases page says the field station "doesn't report Lab capabilities". On a Lab stack it reports the version and the 0-of-8 count.
- W4's capability summary reports `backend.mode: "real-kafka-synthetic"` regardless of mode. The releases page takes the mode from `/api/config` instead, so a fixture backend is never described as real Kafka there.
- Expected conflicts: `apps/site/src/site.ts` (W3 if it edits the workbench summary), `docs/contracts/ui-components.md` §6 (any slice adding hooks), and `e2e/content.spec.ts` (W3 changes the workbench page that its last original test checks).

## How to test

```bash
npm test
ASTRO_TELEMETRY_DISABLED=1 npm run build -w @lontra-creek/site && npm run check:site
npx playwright test --project chromium
LONTRA_BROWSER_MODE=production npx playwright test --project chromium
```
