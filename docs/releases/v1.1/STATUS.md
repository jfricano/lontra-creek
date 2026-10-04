# Lontra Creek V1.1 — Status

Updated October 4, 2026 · The live tracker for [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Every slice PR updates its row in the same PR.

**Overall:** two branches, nothing deployed, and each StreamOtter version in its own place.

- **Phase 1 (rc.3):** the slices that needed no new StreamOtter APIs are combined in draft PR #40 (`review/v1.1`; the slice PRs #29–#39 are closed with their branches kept), which passed an [independent review](REVIEW_FINDINGS.md) with every finding fixed, and #41 (`fix/streamotter-dev-domain`) renames the domain to streamotter.dev. Both pin `streamotter@0.1.0-rc.3`, which provides none of the native V1.1 capabilities ([BASELINE.md](BASELINE.md)).
- **Phase 2 (0.2.0-rc.1):** `feat/v1.1-source-failure-exercises`, stacked on #41, is the branch of the pin PR (not opened yet). It carries W8's update for 0.2.0-rc.1, W9a and W9b, built and tested against a pre-publish pack of `streamotter@0.2.0-rc.1` in `vendor/`. 0.2.0-rc.1 is not on npm yet, so `scripts/check-release-pins.mjs` keeps the Images and Deploy static site workflows from building this branch until the pack gives way to the registry pin ([SOURCE_FAILURE_EXERCISES.md](SOURCE_FAILURE_EXERCISES.md#pre-publish-packages-and-their-removal)).
- **Hosted:** in both phases the Lab benches and the workbench sandbox stay off and read as unavailable; enabling either needs Jason's separate approval with its own acceptance ([rollout plan](../0.2.0-rc.1/ROLLOUT_PLAN.md)).

## Slices

| ID | Slice | State | Branch / PR | Acceptance evidence |
| --- | --- | --- | --- | --- |
| P0 | Planning, baseline, decisions, sandbox contract | Combined in #40 | `docs/v1.1-implementation-plan` · #29 (closed) | A40 planning record |
| W1 | Lab foundation hardening | Combined in #40 | `fix/v1.1-lab-hardening` · #31 (closed) | A03, A27 (partly), A30, A37: unit and fixture |
| W2 | Sandbox session service | Combined in #40 | `feat/v1.1-sandbox-sessions` · #32 (closed) | Session layer only, unit and fixture; no sandbox runtime yet |
| W3 | `/workbench/` page shell | Combined in #40 | `feat/v1.1-workbench-page` · #34 (closed) | A35, A45; A41 and A46 partly: unit and fixture; real UI not mounted (W9a) |
| W4 | Source failures track shell | Combined in #40 | `feat/v1.1-failures-track` · #35 (closed) | A01, A04, A36 (new UI), A37: unit and fixture |
| W5 | Study identity and coverage ledger | Combined in #40 | `feat/v1.1-study-identity` · #36 (closed) | A14 (app side), A25, A26, A33: unit; Lab workflow on local Kafka |
| W6 | Local launcher (`dev:lab`) | Combined in #40 | `feat/v1.1-dev-lab` · #30 (closed) | See #30 |
| W7 | Kafka authorization (local and CI) | Combined in #40 | `feat/v1.1-kafka-acls` · #33 (closed) | A29 at local and CI level; hosted broker unchanged |
| W8 | Site content | Combined in #40; updated for 0.2.0-rc.1 on the phase 2 branch | `feat/v1.1-site-content` · #37 (closed); `w9/content`, merged into `feat/v1.1-source-failure-exercises` | A01, A02, A40: unit and fixture. On 0.2.0-rc.1 the source-failure copy describes the installed release (opt-in), tested against its validator, CLI and gateway; A34 playground presets: unit and Chromium fixture browser. Release-tag and npm links resolve only after the tag push and npm publish |
| W9a | Actual sandbox | Built on the phase 2 branch against the pre-publish 0.2.0-rc.1 (WHC-1); runs under `npm run dev:lab`; not deployed, and off on the hosted demo in both phases | `w9/sandbox-backend`, `w9/sandbox-site`, merged into `feat/v1.1-source-failure-exercises` | A41 and A46 partly: unit and fixture, stubbed browser specs; local stack: `deploy/test/sandbox.test.ts` 5 of 5 on `npm run dev:lab`, October 4 ([LOCAL_LAB.md](../../LOCAL_LAB.md#status)). real-stack browser specs (`e2e/real/`, `playwright.real.config.ts`) 8 of 8 in Chromium on `npm run dev:lab`, October 4; Firefox and WebKit not run yet |
| W9b | Source failure exercises | Built on the phase 2 branch against the pre-publish 0.2.0-rc.1 (bench failure handling, intents, operations, the incident projection, S01–S09 on `/lab/`) and proven on real Kafka (`npm run dev:lab`, quarantine profile, ACLs on); nothing deployed. The hosted default is `retry` (only S06 offered), and the hosted Lab stays off in both phases | `w9/lab-core`, `w9/lab-site`, `w9/slice-d`, merged into `feat/v1.1-source-failure-exercises` | Unit, scripted fixtures, and the installed library on a fixture source (`lab-failures.test.ts`); LC11-S01–S09 and A32 by `deploy/test/lab-source-failures.test.ts` on real Kafka, October 4; S1–S6 rerun and section 10.2 redone for 0.2.0-rc.1 (Lab contract 10.7 R4); S12 with the two new grants per bench (10.9); `VERIFIED_WITH` records that evidence for the pre-publish pack's exact packages (lockfile integrity): all eight under `quarantine`, S06 also under `retry` (rechecked with `KAFKA_AUTHORIZATION=none`). The registry release is another build, so nothing is offered on it until the suite is run again there. See [SOURCE_FAILURE_EXERCISES.md](SOURCE_FAILURE_EXERCISES.md#what-is-proven-where) |
| W10 | Verification and release review | Independent review of #40 done; cross-browser and hosted checks remain. The phase 2 branch gets a fresh full review once 0.2.0-rc.1 is published | `review/v1.1` · #40 | [REVIEW_FINDINGS.md](REVIEW_FINDINGS.md) |


## Gates

| Gate | State |
| --- | --- |
| Published workbench seam (R1–R6) | WHC-1 rev 0.3 (with R11 and R12) is in StreamOtter's combined V1.1 PR (#55) and ships in 0.2.0-rc.1; not on npm yet. The phase 2 branch uses the pre-publish pack |
| Published native failure APIs (R7–R9) | In StreamOtter's combined V1.1 PR (#55), shipping in 0.2.0-rc.1; not on npm yet. The phase 2 branch uses the pre-publish pack |
| Pin PR (phase 2) | Waits for 0.2.0-rc.1 on npm: then the registry pin, a registry lockfile, the published workbench seam's integrity, `deploy/test/lab-source-failures.test.ts` and `deploy/test/sandbox.test.ts` re-run on the registry install with the evidence re-recorded (`npm test` fails until `VERIFIED_WITH` names the new integrity), the Lab threat model's §10.2 and S1–S6 rechecked, its own review and devops reconciliation, and Jason's merge. No CI has run on the phase 2 branch yet (no pull request is open): its first CI run is also the first on arm64, and the first of the `retry` default with the failure journal under the shared host's bench limits (`compose.shared.lab.yaml`) |
| Hosted Lab benches | Off in both phases; a `lab.enabled` release needs Jason's approval and its own acceptance |
| Hosted sandbox | Off in both phases; needs a shared-host sandbox overlay with adapter tests, a capacity decision, and Jason's approval |
| Hosted Kafka authorization | Built and tested locally and in CI (#33, default `none` on the host); turning it on waits for Jason's approval (LC11-ADR-03, `deploy/OPERATIONS.md`) |
| Sandbox host capacity | Waits for local measurement, then Jason (LC11-ADR-04) |
| Site and backend deployment | Waits for Jason; two phases on the shared host, see the [rollout plan](../0.2.0-rc.1/ROLLOUT_PLAN.md) and [RELEASE_HANDOFF.md](RELEASE_HANDOFF.md) |

## Acceptance coverage

LC11-A01–A46 are defined in the [acceptance plan](LONTRA_CREEK_V1_1_ACCEPTANCE_PLAN.md). Until W10's evidence matrix fills this table, each slice row above names the IDs it advanced and at which level.

| ID | Evidence level | Where |
| --- | --- | --- |
| LC11-A12, A15 | Real Kafka, local (`npm run dev:lab`) | S08 in `deploy/test/lab-source-failures.test.ts`: the boundary and incident survive a gateway restart and a bench container restart with its volume; a new subscription goes live only through an acknowledging snapshot |
| LC11-A29 | Real Kafka, local (CI runs the same test; hosted broker unchanged) | S12 (`deploy/test/kafka-acls.test.ts`) with the quarantine grants; lab-api.md 10.9 |
| LC11-A32 | Real Kafka, local (`npm run dev:lab`) | A32 in `deploy/test/lab-source-failures.test.ts`: repeated resets leave no study or quarantine read groups, study directories, or socket files |
