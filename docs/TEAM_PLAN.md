# Team plan

September 26, 2026 · How the remaining work gets built, by whom, and in what order

This is the working spec for the team of AI agents finishing Lontra Creek, agreed between the orchestrator and the executive agent. [PLAN.md](PLAN.md) owns scope, the story, pages, and launch criteria; [DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md) owns the engineering design and its pitfalls; [HOSTING.md](HOSTING.md) is the owner's account checklist. Where this plan and those disagree, those win, and this plan is corrected.

## 1. Starting point

Milestone A is on `main` (September 26): the simulation; the field station's production config, compiled Kafka handlers, wall-clock runner, site API, notebooks, and checkpoints; `deploy/` with one image, the Compose stack, and a full-stack test that CI runs on amd64 and arm64; and the home page with its live panel. What remains is workstreams 5–8 of DEPLOYMENT_PLAN.md: deployment, the Failure Lab, the other seven pages, and launch.

## 2. The team

The **orchestrator** (the Claude Code session the owner talks to) is the hub and the scrum master: it spawns and briefs agents, relays between them (agents can't message each other), keeps the board, batches pull requests for the owner, and writes the sprint-close docs PR. There is no separate scrum agent; it would only relay what the orchestrator already holds.

| Agent | Role | Owns |
| --- | --- | --- |
| `exec` | Executive | Scope, priorities, capacity, risk; signs off each sprint plan; escalations |
| `lead` | Tech lead and reviewer | Interface contracts, the shared UI component inventory, the Lab threat model, conventions; reviews every change to shared modules, `apps/field-station/src/server`, `deploy/`, and workflows, including a security review for Failure Lab and deployment work; a lighter pass on content-only changes |
| `research` | Researcher and fact checker | The typed release facts, spikes, fact checks of every public claim against the pinned release, the copy pass, library links pinned to the release tag, and watching for new StreamOtter releases |
| `fe-walk` | Frontend engineer | The shared SDK module, the `/field-station` walkthrough, idle expiry, the home page's workbench preview |
| `fe-content` | Frontend engineer and content | The page scaffold, `/docs`, `/releases`, `/when-it-breaks`, `/playground`, `/workbench`, `/lab`, the recorded fallback |
| `be-lab` | Backend engineer | The Failure Lab backend (relay-cut spike first), leases, the local Kafka dev mode |
| `devops` | DevOps engineer | Dev ports, CI hygiene, server setup and its CI rehearsal, the image, deploy, and site workflows, Compose and Caddy for the benches, monitoring, backups, staging |
| `qa` | QA engineer | The browser-test harness and dependency, end-to-end tests across lanes, the workbench capture pipeline, accessibility, performance, and load tests |

Authors write their own unit tests; `qa` owns cross-lane end-to-end, accessibility, performance, and load testing.

## 3. Process

- **Sprints** end when their stories are merged, not on a date. The orchestrator drafts each sprint with `lead`; `exec` signs it off.
- **Standups** are each agent's report when it finishes a task: done, proof, next, blocked.
- **Board:** the orchestrator's working board, outside the repository. The owner gets it as a status summary in chat.
- **Definition of done:** the story's acceptance criteria are met; typecheck and tests pass locally and in CI; new behavior has tests; the story's own docs are updated; `lead` has reviewed it (and `research` has fact-checked any public copy); `main` has been merged into the branch and CI has rerun; the pull request is marked ready. Every page story also sets its page `ready: true`, drops `noindex`, appears in the sitemap, and passes a link check.
- **Review gate:** authors open **draft** pull requests so CI runs. `lead` reviews the branch and reports to the orchestrator; reviews are not posted on GitHub, where they would appear as the owner reviewing his own pull requests. The author fixes, the orchestrator marks the pull request ready and adds it to the owner's next batch.
- **Merges:** only the owner merges to `main`. The orchestrator sends batches as sets go green, in dependency order, each pull request with a one-line note of what it unblocks, and screenshots for UI changes.

## 4. Branches and pull requests

- **Standing approval** (the owner's handoff, September 25): the team may push feature branches and open pull requests on `jfricano/lontra-creek` so CI runs. Merging to `main`, deploying, creating cloud resources, and anything that costs money need the owner.
- `main` is always green and deployable.
- Branches are short-lived, from `main`: `<type>/<area>-<slug>`, where the type is `feat`, `fix`, `docs`, `ci`, `test`, `refactor`, `chore`, or `spike`. For example: `feat/walkthrough-shell`, `spike/lab-relay-cut`, `ci/images-workflow`.
- One story per pull request. Stack a pull request on another branch only when it depends on unmerged work, and say so ("Stacked on #N").
- Keep branches current by merging `main` into them; never force-push a branch someone else builds on.
- Commits: an imperative subject of at most 72 characters and a body that says why; the owner's identity only; **no `Co-Authored-By` or any other attribution line**, in commits or pull requests.
- A pull request says what, why, how it's proven (tests, CI runs), and what's left.
- **One owner per shared file per sprint** (section 7 lists them). Plan docs: each pull request updates the docs for its own area; DEPLOYMENT_PLAN.md's "Where things stand", HOSTING.md's checkboxes, and the README's status change only in the orchestrator's sprint-close pull request.
- Workflows that need secrets check for them and skip cleanly when absent, so `main` stays green before the owner's accounts exist.

## 5. Working environment

- **Brief:** every agent reads the owner's working notes in `~/coding/lontra-creek/CLAUDE.md` (git-ignored, so absent from worktrees), then PLAN.md, DEPLOYMENT_PLAN.md (especially "Pitfalls already met"), and this plan.
- **Worktrees:** one per branch under `~/coding/lontra-creek-worktrees/<branch-with-dashes>`, with `npm ci`. Nobody edits the owner's checkout at `~/coding/lontra-creek`.
- **Ports** are shared machine resources; stop what you start.

| Agent | Ports |
| --- | --- |
| `fe-walk` | the defaults: site 4321, gateway 7400, workbench 7401, site API 7402 |
| `fe-content` | site 4331, gateway 7430, workbench 7431, site API 7432 (the site alone on 4331 until F.1 lands) |
| `qa` | tests on free ports; a dev stack on site 4341, gateway 7440, workbench 7441, site API 7442 |
| `be-lab` | Kafka 19192–19195 with a 512 MB heap, gateway 7500, field station 7502 and 7510, Caddy 8443 |
| `devops`, `lead`, `research` | none locally; CI |

- **Local tools:** there is no Docker on this Mac; containers run in GitHub Actions. `be-lab` runs a native stack with the JDK, Kafka 4.1.2, Caddy 2.11.4, and Node 24.21 already installed on this Mac, read-only, with all configuration and data under the worktree's git-ignored `.local/`. Headless browser checks use Playwright 1.63.0 with the Chromium already installed here (`PLAYWRIGHT_BROWSERS_PATH`, set locally, never committed). No committed file refers to anything outside this repository.
- **The browser pane** is the owner's window onto demos: one agent at a time, its own tab, closed after. Never type a secret or the workbench token into it.
- **StreamOtter** is used only as the npm package `streamotter@0.1.0-rc.3`: no links to, copies of, or checkouts of its repository; reading its public docs is fine. A library problem becomes an issue report for the owner, never a workaround in its code. The pinned version is frozen within a sprint; an upgrade is its own story (section 6, R.1).
- **Honest claims:** label the fiction and any recordings (with their date and where they were made); no invented numbers; timings say where they were measured.

## 6. Backlog

Stories name their lane and sprint. "AC" is acceptance criteria.

### Foundations (Sprint 0, merged before Sprint 1)

- **F.1 Dev ports and origins** (`devops`, `chore/dev-ports`). Environment variables for the site, gateway, workbench, and site API ports; the dev gateway's allowed origins and Astro's `/api` proxy follow them. The same pull request runs `node scripts/configs.ts` and regenerates the types for both apps; no other Sprint 0 pull request touches `project.ts` or generated files. AC: two dev stacks run at once on different port blocks; defaults unchanged.
- **F.2 CI hygiene** (`devops`, `ci/workflow-hygiene`). `concurrency` with cancel-in-progress on every workflow; `stack.yml` skips its container jobs for changes outside the stack (the site, docs) using a job-level condition, so the checks still report and can be required. AC: a docs-only pull request finishes without the container jobs; a stack change still runs them.
- **F.3 Shared SDK module** (`fe-walk`, `refactor/live-sdk-module`). Move the client, card, and log logic out of `apps/site/src/scripts/live-creek.ts` into a module the walkthrough can reuse, with no visible change: the home page's DOM and `data-*` hooks stay identical. AC: the home page behaves exactly as before; types check.
- **F.4 Page scaffold** (`fe-content`, `feat/page-scaffold`). One file per route replaces `pages/[section].astro`, each still a placeholder; `LINKS` point at the release tag derived from `RELEASE` (`v0.1.0-rc.3`), not `main`. AC: identical output for the placeholders; links resolve.
- **F.5 Browser-test harness** (`qa`, `test/browser-harness`). The only Sprint 0 dependency change: `@playwright/test` 1.63.0 and `@axe-core/playwright`. A `browser.yml` workflow runs Chromium, Firefox, and WebKit against `npm run dev`. Home page tests select only on `data-*` hooks: the panel goes live, "Drop my connection" makes views stale and restoring brings fresh snapshots, the 404 page, and no serious or critical axe findings. AC: green in CI; runnable locally headless.
- **F.6 Lab API contract and threat model** (`lead`, `docs/lab-api-contract`). `docs/contracts/lab-api.md`: routes, payloads, the lease lifecycle and queue, errors, rate limits, and how each bench's `authenticate` accepts only tokens bound to that bench's current lease; the threat model for exposing development-mode bench gateways (development principals unusable by visitors, no management routes, reaching another bench, expired leases). `docs/contracts/ui-components.md`: the shared UI pieces (state chip, code panel, fiction and recording labels, notices) and who owns them.
- **F.7 Release facts** (`research`, `feat/release-facts`). `apps/site/src/release-facts.ts`, typed against `streamotter/contracts` so the typecheck fails on drift: a `Record<ErrorCode, …>` with meaning, whether it retries, and the state it produces; subscription and connection states; default limits; the verified support matrix; each with its source in the pinned release's published docs. Plus `docs/research/release-facts.md` with the sources.
- **E2.0 Relay-cut spike** (`be-lab`, `spike/lab-relay-cut`, starts in Sprint 0). A per-bench path to Kafka whose cut makes the bench's source stale and whose restore brings it back live: a listener per bench advertised as that bench's proxy. Its own workflow (`.github/workflows/lab-spike.yml`); `ci.yml` and `stack.yml` untouched; `start.sh` parametrized with today's defaults and the production stack test green on both architectures. AC: in CI on amd64 and arm64, stale within 20 seconds of the cut and live within 30 seconds of the restore (StreamOtter rc.3 marks a Kafka source degraded after 12 seconds without broker activity), measured and recorded; the broker certificate has a SAN for each bench's name; it decides where the bench feed comes from (never over the path that gets cut), gives each bench its own `projectId` (V1 supports one gateway per project), and settles in PLAN.md whether benches run `streamotter dev` or `createGateway({ mode: "development" })`.

### Walkthrough, `/field-station` (`fe-walk`)

- **E1.1b Shell and navigation** (Sprint 1): chapters with next and back, deep links (`#chapter-n`), keyboard and screen-reader support, fiction label.
- **E1.1c Under-the-hood panel** (Sprint 1): each subscription's state timeline, epoch, and revisions, and the code behind the current step. Every value comes from SDK events.
- **E1.1d Creek map** (Sprint 1): SVG from `@lontra-creek/sim` geography: reaches, stations, and holts (holts only for researchers).
- **E1.2 Chapters 1–4** (Sprint 1): dawn survey (authorizing, synchronizing, snapshot, live on LC-02); the creek rises (the station with the largest flow change over the last 12 ticks, with copy for when the creek is calm); Slate Canyon (the visitor's own connection drops: stale, reconnect, fresh snapshots, a note of revisions not replayed); the protected holt (a volunteer's Holt A request gets `FORBIDDEN` and no data).
- **E1.3 Chapter 5, hand over the tablet** (Sprint 1): a researcher badge is a new subject; existing subscriptions close with `UNAUTHENTICATED`; fresh ones open, and Holt A shows its grid reference.
- **E1.6 Idle expiry** (Sprint 1): after 10 minutes hidden or idle, the page closes its client and shows a control to resume (PLAN.md, Limits and operations). AC: tested with a fake clock; home page and walkthrough.
- **E1.4 Chapter 6, log a sighting** (Sprint 2): a fixed-choice form posts to `/api/notebook/sightings` with credentials; the visitor's `notebook` subscription updates. Without Kafka it explains that sightings need the live field station. Needs E7.2a.
- **E1.7 Workbench preview on the home page** (Sprint 2): the section PLAN.md lists for `/`, from `qa`'s captures.
- **E1.5 Timed walkthrough** (Sprint 3): the median of three timed runs on staging is at most 3.5 minutes, recorded in PLAN.md; `research` does the copy pass.
- Walkthrough AC throughout: Playwright in fixture mode checks each chapter's SDK state sequence, the deep links, a keyboard-only path through every chapter, and no serious or critical axe findings.

### Content pages (`fe-content`, facts from `research`)

- **E4.2 `/docs`** (Sprint 1): a map of the guides and reference, linking out at the release tag.
- **E4.3 `/releases`** (Sprint 1): the pinned version, its verified support matrix and limits from the release facts, links to its changelog.
- **E4.1 `/when-it-breaks`** (Sprint 1): every failure mode from the release facts: the state, the `StreamError`, whether it retries, handling code, an interactive state diagram. It shows that a visitor sees `SOURCE_UNAVAILABLE` while the trace shows `HANDLER_FAILED`.
- **E3.1 `/lab`** (Sprint 2): borrowing a bench, place in line, time left, returning it, the four scenarios with their observable states and the trace feed, the busy and unavailable states, and local-run instructions (L.2). Built against the F.6 contract, mocked until the backend lands.
- **E4.4 `/playground`** (Sprint 2): edit a `streamotter.json` with `validateProjectConfig` running in the browser, at most 150 KB gzipped and loaded only on `/playground`; a labeled console that subscribes to the field station; labeled recordings of CLI sessions.
- **E4.5 `/workbench`** (Sprint 2): the tour of Connect, Define, Preview, Inspect, and Export from `qa`'s captures, and a labeled recorded session.
- **E4.6 Recorded fallback** (Sprint 2): the home page's live panel shows a labeled recording when the demo is down: a captured SDK event log replayed through the same UI, labeled with its date and where it was made (a local run first, replaced by staging in Sprint 3).

### Failure Lab backend (`be-lab`; Compose and Caddy by `devops`)

- **E7.2a Local Kafka dev mode** (`be-lab`, Sprint 1): `npm run dev:kafka` runs the field station on Kafka, the gateway with the compiled handlers, and the site, using a Kafka and Java located through `KAFKA_HOME` and `JAVA_HOME` (no downloads). A downloader, if ever wanted, is a separate owner decision.
- **E2.1 Bench runtime** (Sprint 1 design with `lead`, Sprint 2 build): a bench is a development-mode gateway (as settled by E2.0) with its own project, `lab-N.*` topics and consumer group, its management API only on its own loopback, and a redacted bench API on the Compose network (service token) for reset, scenario actions, and a trace feed without payloads. Scenarios: fouled sensor (remove LC-03's calibration table: the map throws, `HANDLER_FAILED`, the source pauses; restore and resume: the same record is processed, nothing skipped); flash flood (the E2.0 relay cut); satellite laptop (a raw Socket.IO client that never sends receipts is disconnected after the receipt timeout while the visitor's view keeps flowing); relay restart. Bench `authenticate` accepts only lease-bound tokens; development principals are unusable by visitors.
- **E2.2 Leases** (Sprint 2): three benches, one visitor each for five minutes, a queue with position, reset between leases, scenario actions at most once a second, `/api/lab/*` per the contract, bound to the session.
- **E2.3 Compose and Caddy for benches** (`devops`, Sprint 2): bench services and per-bench proxies, `/lab/N/…` routes for visitors' WebSockets, no management routes, allowed origins, certificates.
- **E2.4 Stack test** (Sprint 2): leasing, the busy state and queue, each scenario's observable outcome, cleanup, a visitor reaching another bench, an expired lease.
- **L.2 Lab local-run mechanism** (Sprint 2): how a developer runs the Lab locally; the owner chooses the approach (section 8) before E3.1's copy freezes.

### Deployment (`devops`)

- **E5.1 Server setup** (Sprint 1): `deploy/setup.sh`, idempotent: Docker, the host firewall for 443, `/srv/lontra`, root-only secrets, the Kafka CA and certificates, the origin certificate. Rehearsed in CI on a fresh `ubuntu-24.04-arm` runner: setup, Compose up, the stack test, then the rollback path.
- **E5.2 `images.yml`** (Sprint 1): on `main`, build and push `ghcr.io/jfricano/lontra-creek:<sha>` for amd64 and arm64. Guarded: it doesn't publish until the owner decides GHCR (section 8).
- **E5.3 `deploy.yml`** (Sprint 1): manual, a `production` environment with the owner as required reviewer, a restricted SSH deploy key, pin the tag, `compose up -d`, wait for health, roll back on failure. Guarded on its secrets.
- **E5.4 `site.yml`** (Sprint 1): build with `PUBLIC_FIELD_STATION_ORIGIN=https://demo.streamotter.app` and deploy to Cloudflare with a scoped token, preview first. Guarded on its secrets.
- **E5.5 Monitoring and backups** (Sprint 2): OCI alarm definitions (memory under 25%, instance down), a nightly checkpoint backup with a restore drill, and a runbook (deploy, roll back, rotate secrets and SCRAM passwords).
- **E5.6 Staging** (Sprint 3, needs HOSTING.md 1–3): deploy to the real host and verify there.

### Quality and launch (`qa` unless noted)

- **E4.5a Workbench capture pipeline** (Sprint 2): Playwright in CI captures the workbench from `npx streamotter dev` with a fixture project; the workbench token is used by the test only.
- **E6.1 End-to-end tests** (Sprints 1–2): each lane's pages and flows as they land.
- **E6.2 Accessibility and browsers** (Sprint 2): keyboard, visible focus, contrast, screen-reader labels, reduced motion, and narrow screens on every page. Supported browsers: the current and previous major versions of Chrome, Edge, Firefox, and Safari (macOS and iOS), checked with Playwright's Chromium, Firefox, and WebKit.
- **E6.3 Performance** (Sprint 3): page load and demo startup measured with Lighthouse's default mobile profile (a simulated mid-range phone on slow 4G) and its desktop profile, on staging, recorded in PLAN.md.
- **E6.5 Load and limits** (Sprint 3): SDK clients from an Actions runner against staging: 300 visitors, 12 subscriptions each, one scenario action a second; results recorded in PLAN.md.
- **E6.4 Launch checklist** (Sprint 3): PLAN.md's launch criteria on staging, time-boxed, with fixes triaged against those criteria.

### Recurring

- **R.1 Release upgrade** (`research` with `lead`): bump `streamotter` in both apps, regenerate, re-check the release facts and every claim, run all suites.

## 7. Sprints

**Sprint 0 (foundations):** F.1 and F.2 (`devops`), F.3 (`fe-walk`), F.4 (`fe-content`), F.5 (`qa`), F.6 (`lead`), F.7 (`research`), and E2.0 begins (`be-lab`). Shared-file owners: `project.ts` and generated files, `astro.config.mjs`, `scripts/dev.ts`, `scripts/dev.mjs`, `stack.yml`, `ci.yml` (`devops`); `live-creek.ts`, `LiveCreek.astro` (`fe-walk`); `pages/`, `site.ts`, `Base.astro` (`fe-content`); root `package.json` and lockfile (`qa`); `deploy/kafka/start.sh`, `deploy/make-certs.sh` (`be-lab`, defaults unchanged).

**Sprint 1:** E1.1b–d, E1.2, E1.3, E1.6 (`fe-walk`); E4.2, E4.3, E4.1 (`fe-content`); E2.0 finished, E7.2a, E2.1 design (`be-lab`); E5.1–E5.4 (`devops`); E6.1 (`qa`); spikes for the in-browser validator's size, the workbench capture method, Cloudflare's static hosting, and OCI's memory metric, plus fact checks (`research`).

**Sprint 2:** E1.4, E1.7 (`fe-walk`); E3.1, E4.4, E4.5, E4.6 (`fe-content`); E2.1, E2.2, E2.4, L.2 (`be-lab`); E2.3, E5.5 (`devops`); E4.5a, E6.1, E6.2 (`qa`); copy pass (`research`).

**Sprint 3 (needs the owner's accounts):** E5.6 staging (`devops`); E6.3, E6.5, E6.4 (`qa`); E1.5 (`fe-walk`); the staging recording (`fe-content`); the owner's content review; then workstream 8 and his go-ahead.

## 8. The owner

**Needed from him:**

- Merge each batch of ready pull requests (the orchestrator lists what each unblocks).
- Start HOSTING.md sections 1–3 now: the domain, Oracle signup, and retrying for Ampere capacity can take days, and only Sprint 3 waits on them.
- Decide GHCR: whether `images.yml` may publish `ghcr.io/jfricano/lontra-creek` on merges to `main`, as a public package with a retention policy. Needed before E5.2 publishes, and before E3.1's copy freezes in Sprint 2, since the Lab's local-run instructions depend on it.
- Decide, after reading F.6's threat model, whether development-mode bench gateways may face the public.
- Recommended: branch protection on `main` (required checks CI, Stack, Browser) and automatic deletion of merged branches, so stacked pull requests retarget themselves.
- His content review before launch, and the go-ahead.

**Defaulted by the team:** use the tools already on this Mac, no downloads; reviews stay internal; the board stays with the orchestrator; a labeled recording of a local run until staging exists; the browser list and performance profile in section 6.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| The relay cut needs a different mechanism | Spike first (E2.0); fallbacks: a rule inside the bench container, or a TCP proxy the bench is configured to use |
| Development-mode bench gateways facing the internet | F.6 threat model; lease-bound tokens; development principals unusable; stack tests for another bench and an expired lease; the owner decides |
| Per-bench listeners change the production broker | `be-lab` owns `start.sh` with today's defaults; the production stack test gates every change |
| Lanes collide on shared files | One owner per file per sprint (section 7); `lead` owns shared UI pieces |
| Workflows needing secrets turn `main` red or publish early | Guards that skip cleanly without their secrets |
| GHCR storage limits | A public package with a retention policy, the owner's call |
| Owner lead time for accounts, and Oracle reclaiming an idle instance | Start HOSTING.md now; deploy staging as soon as the host exists |
| A new StreamOtter release mid-project | Freeze within a sprint; R.1 |
| Shared Mac resources | Port blocks, a small heap for `be-lab`'s Kafka, headless verification, one agent in the browser pane |
| Agents in worktrees miss the owner's notes | Every brief includes `~/coding/lontra-creek/CLAUDE.md` |
