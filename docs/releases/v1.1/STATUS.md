# Lontra Creek V1.1 — Status

Updated October 4, 2026 · The live tracker for [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Every slice PR updates its row in the same PR.

**Overall:** the buildable-now slices are combined in draft PR #40 (`review/v1.1`; the slice PRs #29–#39 are closed with their branches kept) and passed an [independent review](REVIEW_FINDINGS.md) with every finding fixed; nothing deployed. No native V1.1 capability is available yet. Installed library: `streamotter@0.1.0-rc.3`, which provides none of the native V1.1 capabilities ([BASELINE.md](BASELINE.md)).

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
| W8 | Site content | Combined in #40; updated for 0.2.0-rc.1 on `w9/content` | `feat/v1.1-site-content` · #37 (closed); `w9/content` | A01, A02, A40: unit and fixture. On 0.2.0-rc.1 the source-failure copy describes the installed release (opt-in), tested against its validator, CLI and gateway; A34 playground presets: unit and Chromium fixture browser. Release-tag and npm links resolve only after the tag push and npm publish |
| W9a | Actual sandbox | Blocked on upstream R1–R6 | | |
| W9b | Source failure exercises | Proven on real Kafka (`npm run dev:lab`, 0.2.0-rc.1, quarantine profile, ACLs on); nothing deployed. The hosted default is `retry` (only S06 offered) and the hosted Lab stays off | `w9/slice-d` | LC11-S01–S09 and A32 by `deploy/test/lab-source-failures.test.ts`; S1–S6 rerun and section 10.2 redone for 0.2.0-rc.1 (Lab contract 10.7 R4); S12 with the two new grants per bench (10.9); every new scenario in `VERIFIED_WITH` |
| W10 | Verification and release review | Independent review done; cross-browser and hosted checks remain | `review/v1.1` · #40 | [REVIEW_FINDINGS.md](REVIEW_FINDINGS.md) |

## Gates

| Gate | State |
| --- | --- |
| Published workbench seam (R1–R6) | WHC-1 rev 0.3 (with R11 and R12) is in StreamOtter's combined V1.1 PR (#55) and ships in 0.2.0-rc.1; not on npm yet |
| Published native failure APIs (R7–R9) | In StreamOtter's combined V1.1 PR (#55), shipping in 0.2.0-rc.1; not on npm yet |
| Hosted Kafka authorization | Built and tested locally and in CI (#33, default `none` on the host); turning it on waits for Jason's approval (LC11-ADR-03, `deploy/OPERATIONS.md`) |
| Sandbox host capacity | Waits for local measurement, then Jason (LC11-ADR-04) |
| Site deployment | Waits for Jason; see [RELEASE_HANDOFF.md](RELEASE_HANDOFF.md) |

## Acceptance coverage

LC11-A01–A46 are defined in the [acceptance plan](LONTRA_CREEK_V1_1_ACCEPTANCE_PLAN.md). This table lists only IDs with evidence recorded; an ID absent here has none yet.

| ID | Evidence level | Where |
| --- | --- | --- |
| LC11-A12, A15 | Real Kafka, local (`npm run dev:lab`) | S08 in `deploy/test/lab-source-failures.test.ts`: the boundary and incident survive a gateway restart and a bench container restart with its volume; a new subscription goes live only through an acknowledging snapshot |
| LC11-A29 | Real Kafka, local (CI runs the same test; hosted broker unchanged) | S12 (`deploy/test/kafka-acls.test.ts`) with the quarantine grants; lab-api.md 10.9 |
| LC11-A32 | Real Kafka, local (`npm run dev:lab`) | A32 in `deploy/test/lab-source-failures.test.ts`: repeated resets leave no study or quarantine read groups, study directories, or socket files |
