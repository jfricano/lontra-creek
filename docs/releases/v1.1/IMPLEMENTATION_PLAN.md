# Lontra Creek V1.1 — Implementation plan and work breakdown

October 3, 2026 · Revision 1.0 · Owner: Jason Fricano · Status: in progress (see [STATUS.md](STATUS.md))

This document turns the approved [companion plan](LONTRA_CREEK_V1_1_COMPANION_PLAN.md) (revision 0.4), the [acceptance plan](LONTRA_CREEK_V1_1_ACCEPTANCE_PLAN.md) (LC11-A01–A46), and the [handoff](LONTRA_CREEK_V1_1_HANDOFF.md) into an ordered set of pull requests. It does not change their scope. Where this plan and those documents disagree, they win and this plan is corrected.

Read with:

- [BASELINE.md](BASELINE.md): slice A's compatibility and exposure review of the current `main`.
- [decisions/](decisions/): the four bounded design decisions (LC11-ADR-01 to 04).
- [UPSTREAM_REQUIREMENTS.md](UPSTREAM_REQUIREMENTS.md): what this site needs from published StreamOtter packages, and the state of each request.
- [Sandbox API contract](../../contracts/sandbox-api.md): the visitor-scoped workbench sandbox interface (draft).
- [STATUS.md](STATUS.md): the live tracker of slices, pull requests, gates, and evidence.

## 1. Starting point

| Fact | Value | Evidence |
| --- | --- | --- |
| Site baseline for this plan | `main` at `aa9c236` (October 3, 2026) | `git log`; 28 commits after the companion plan's inspected baseline `2397e2c` |
| Installed library | `streamotter@0.1.0-rc.3` (exact pin, lockfile) | `apps/*/package.json`, `package-lock.json` |
| Native V1.1 capabilities installed | None. No failure policy, quarantine, recovery guard, operator service, or embeddable workbench in rc.3 | [BASELINE.md §3](BASELINE.md#3-native-capability-availability) |
| Baseline verification | `npm run typecheck`, `npm test` (119/119), site build, `check:site` (311 links) all pass on Node 24.21.0 | Run October 3, 2026 in a clean clone |

## 2. What can be built now, and what waits

The companion plan's §13 dependency table governs. In short:

| Work | Prerequisite | Buildable now? |
| --- | --- | --- |
| Planning, contracts, decision records, threat-model deltas | None | Yes |
| Lab hardening that V1.1 builds on (lease, page, and bench reliability findings from the [October 2 code review](../../reviews/CODE_REVIEW_2026-10-02.md)) | None | Yes |
| Sandbox session service: allocation, queue, leases, reset/expiry cleanup, capacity, restricted candidate editor, bounded export, operation allowlist | None for the session layer; the runtime binding needs a published seam | Session layer yes; runtime binding against the seam spec, enabled only after a release |
| `/workbench/` page shell, honest unavailable states, seed explanation, **In your app** note, labeled fallback recordings | None | Yes |
| Mounting the actual published workbench UI | Published frontend/integration seam ([UPSTREAM_REQUIREMENTS.md](UPSTREAM_REQUIREMENTS.md) R1–R6) | No: waits on a StreamOtter release |
| Source failures track shell in `/lab/`: chooser, catalog, deep links, capability summary, incident panel bound to typed projections | None | Yes, every new action shown unavailable with its reason |
| Application coverage ledger and study identity (restart vs reset) | None for the app-owned parts | Yes; the native guard binding waits on published types |
| Quarantine, guarded continuation, evaluation, redrive scenarios (S01–S09 upgrades) | Published native failure APIs (R7–R9) | No |
| `npm run dev:lab` local launcher | None | Yes |
| Kafka topic/group authorization for benches, publisher, and quarantine | None for local and CI; hosted change needs Jason's go | Yes locally; hosted waits |
| Playground failure-policy presets | Published validator with `failureHandling` | No |
| Site deployment, hosted infrastructure, npm publication | Jason's explicit approval | Never without it |

An unavailable mandatory feature is never reported as complete (LC11-A40). Each pull request states which acceptance IDs it advances and at which evidence level.

## 3. Work breakdown

Each row is one reviewable pull request unless noted. IDs are stable; STATUS.md tracks them.

| ID | Pull request | Contents | Acceptance IDs advanced | Depends on |
| --- | --- | --- | --- | --- |
| P0 | Planning (this PR) | This plan, baseline review, LC11-ADR-01–04, sandbox API draft, upstream requirements, status tracker, links from PLAN.md and the Lab contract | A40 (planning record) | — |
| W1 | Lab foundation hardening | Fixes from the October 2 review that sit on code V1.1 extends: S1 (auth-required recovery in `lab.ts`), L1 (one failed poll ends a lease), L2 (lease length validation), L3/L4 (bench errors and codes), L5 (reset queue growth), L6 (CORS on errors), L7 (status-before-parse), L8 (concurrent connects and stale feed pages); plus the site evaluation's Lab items 2–4 (scenario-focused feed, satellite outcome, pool status lag) | A03, A27, A30, A37 | P0 |
| W2 | Sandbox session service | `apps/field-station/src/sandbox/`: contract module, slot pool and FIFO queue under the existing lease owner, explicit allocation, heartbeat, reset, return, expiry, cleanup-failure quarantine of a slot, restricted candidate editor (allowlist plus size limits plus published validator), bounded export, operation allowlist, and `/api/sandbox/*` routes; runtime adapter interface with a design-fixture implementation for tests only | A42, A43, A44, A45 (server side) | P0 (ADR-04, sandbox API) |
| W3 | `/workbench/` page shell | Explicit allocation UI, queue and unavailable states, mode/version labels, `station` beside `jobProgress` seed explanation and **In your app** note, recordings kept as labeled fallback with their own provenance (no global `RELEASE` interpolation), mount point for the published UI | A41 (partial), A45, A46 (partial), A35 (fallback provenance) | W2 contract |
| W4 | Source failures track shell | Track chooser on `/lab/`, `#source-failures` and `?scenario=` deep links that select explanation only, scenario catalog S01–S09 with delivery labels, `GET /api/lab/capabilities`, incident panel components bound to typed projections, all new actions unavailable with accurate reasons; contract amendment (proposed intents, current-incident projection, operation status) | A01, A04, A36 (new UI), A37 | W1 |
| W5 | Study identity and coverage ledger | ADR-01 and ADR-02: persistent study/run identity, source generation per study, application scenario ledger (separate from any library journal), coverage evidence API, distinct bench readiness (control available, source ready, clean-lease eligible), reset as explicit study discard with quiescing; unit tests with a fake clock and an independent expected-state ledger | A14 (app side), A25, A26, A33 | W1 |
| W6 | Local launcher | `npm run dev:lab` wrapping `docs/LOCAL_LAB.md`: prerequisite checks, git-ignored local project, loopback HTTPS, printed URLs, persistent stop, separately confirmed discard | A38 | — |
| W7 | Kafka authorization | ADR-03: broker authorizer and least-privilege ACLs for each bench, the scenario publisher, and per-bench quarantine topics in local and CI stacks; stack tests proving a bench cannot read or write another bench, the shared creek, holts, or notebooks | A29 (local/CI) | P0 |
| W8 | Site content | Home V1.1 panel and **Try source failures** link, field-station "Next" link, `/when-it-breaks/` policy matrix and record-disposition lifecycle, `/releases/` separation of site release, library package, demo availability, and verified boundary, `site.ts` summaries, "four controlled failures" tests | A01, A02, A40 | W4 |
| W9a | Actual sandbox (gated) | Pin the first published release with the seam; mount the real UI through the W2 adapter; preview sockets through Caddy; three-engine checks | A41, A46 | Upstream R1–R6 release |
| W9b | Source failure exercises (gated) | Pin the first release with the native failure APIs; S02 quarantine-and-hold on one bench first, then S03–S06, S07–S09 local/CI; private operator adapter; evaluation/approval; reproduction downloads | A05–A24, A28, A31, A32 | Upstream R7–R9 release, W5, W7 |
| W10 | Verification and release review | Built-site browser project (the October 2 evaluation's gap), Firefox and WebKit runs, LC11 evidence matrix, hosted-readiness disposition | A36, A39, A40, A46 | All |

W1, W6, and W7 are independent and run in parallel after P0. W2 and W4 follow P0; W3 follows W2's contract; W5 follows W1 because both touch the bench runtime.

## 4. Branching, commits, and reviews

- **Branches** are short-lived and cut from the latest `main`: `docs/v1.1-<topic>`, `feat/v1.1-<slice>`, `fix/v1.1-<topic>`. One slice per branch. Nothing is pushed to `main`; Jason merges every pull request.
- **Stacking** only when a slice cannot be reviewed without its predecessor. A stacked PR names its base in the first line of its description and is retargeted to `main` after the base merges.
- **Commits** use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(sandbox): …`, `fix(lab): …`, `docs(v1.1): …`, `test(…)`, `chore(…)`), each one buildable. Authored and committed as Jason Fricano. Commits are currently unsigned at Jason's direction (October 3, 2026); signing is added once he provides a key.
- **Pull requests** start as drafts, carry Before/After, the acceptance IDs and evidence level, the docs they update, and the commands run. CI (`CI`, `Browser`, and the `Stack` or `Shared host adapter` workflows when a change touches them) must be green before review is requested.
- **Contracts move with code.** A PR that changes an interface updates its contract document (`docs/contracts/*.md`) and the matching TypeScript module in the same PR, as the Lab contract already requires.

## 5. Team and coordination

- **Lead (this thread):** owns this plan, the contracts, the single lifecycle/capacity owner (ADR-04), integration, and every merge-ready review. Keeps STATUS.md and the handoff current.
- **Parallel workers:** each takes one slice on its own branch or worktree with a disjoint set of files, receives this plan, the relevant ADRs and contract sections, and the repo conventions, and returns a pushed branch with tests. The lead reviews and opens or updates the PR.
- **Verifier:** an independent reviewer challenges incident, source, and view observations and the expected-state logic before W5 and W9b merge (handoff: "a separate verifier should challenge…").
- **StreamOtter V1.1 thread:** owns every StreamOtter change, including the seam. Requirements go through [UPSTREAM_REQUIREMENTS.md](UPSTREAM_REQUIREMENTS.md); Lontra Creek never links the sibling checkout, imports internals, or patches the installed package.

## 6. Definition of done for a slice

1. Code, tests, and contract documents agree, and the slice's acceptance IDs list their evidence level (fixture, local Kafka, CI stack, hosted).
2. `npm run typecheck`, `npm test`, the site build, `check:site`, and the browser suite pass locally on Node 24 and in CI.
3. Existing behavior covered by LC11-A01–A03 still holds.
4. STATUS.md and, where a decision changed, the ADR are updated in the same PR.
5. No claim on a public page exceeds what the installed package and the deployed stack actually do.

## 7. Decisions that need Jason

| Decision | Default until he answers | Recorded in |
| --- | --- | --- |
| Hosted Kafka authorization change (broker authorizer and ACLs on the production broker) | Local and CI only; hosted waits | ADR-03 |
| Sandbox capacity on the host (number of concurrent sandbox slots) | 3 slots, measured locally before any hosted proposal | ADR-04 |
| Any deployment, hosted infrastructure change, or cost | Not done | This plan |
| Commit signing key | Unsigned, authored as Jason | §4 |
