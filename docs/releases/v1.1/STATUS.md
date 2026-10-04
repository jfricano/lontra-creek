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
| W8 | Site content | Combined in #40 | `feat/v1.1-site-content` · #37 (closed) | A01, A02, A40: unit and fixture |
| W9a | Actual sandbox | Blocked on upstream R1–R6 | | |
| W9b | Source failure exercises | Blocked on upstream R7–R9 | | |
| W10 | Verification and release review | Independent review done; cross-browser and hosted checks remain | `review/v1.1` · #40 | [REVIEW_FINDINGS.md](REVIEW_FINDINGS.md) |

## Gates

| Gate | State |
| --- | --- |
| Published workbench seam (R1–R6) | Defined by StreamOtter as WHC-1 rev 0.1 (StreamOtter PR #12), not yet implemented; R11 and R12 sent back |
| Published native failure APIs (R7–R9) | Planned in StreamOtter V1.1 |
| Hosted Kafka authorization | Built and tested locally and in CI (#33, default `none` on the host); turning it on waits for Jason's approval (LC11-ADR-03, `deploy/OPERATIONS.md`) |
| Sandbox host capacity | Waits for local measurement, then Jason (LC11-ADR-04) |
| Site deployment | Waits for Jason |

## Acceptance coverage

LC11-A01–A46 are defined in the [acceptance plan](LONTRA_CREEK_V1_1_ACCEPTANCE_PLAN.md). This table lists only IDs with evidence recorded; an ID absent here has none yet.

| ID | Evidence level | Where |
| --- | --- | --- |
| — | — | — |
