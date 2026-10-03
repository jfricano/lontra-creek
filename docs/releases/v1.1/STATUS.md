# Lontra Creek V1.1 — Status

Updated October 3, 2026 · The live tracker for [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Every slice PR updates its row in the same PR.

**Overall:** buildable-now slices in review or in progress; nothing deployed. No native V1.1 capability is available yet. Installed library: `streamotter@0.1.0-rc.3`, which provides none of the native V1.1 capabilities ([BASELINE.md](BASELINE.md)).

## Slices

| ID | Slice | State | Branch / PR | Acceptance evidence |
| --- | --- | --- | --- | --- |
| P0 | Planning, baseline, decisions, sandbox contract | In review | `docs/v1.1-implementation-plan` | A40 planning record |
| W1 | Lab foundation hardening | In review | `fix/v1.1-lab-hardening` · #31 | A03, A27 (partly), A30, A37: unit and fixture |
| W2 | Sandbox session service | In review | `feat/v1.1-sandbox-sessions` · #32 | Session layer only, unit and fixture; no sandbox runtime yet |
| W3 | `/workbench/` page shell | In progress | `feat/v1.1-workbench-page` | |
| W4 | Source failures track shell | In progress | `feat/v1.1-failures-track` | |
| W5 | Study identity and coverage ledger | In progress | `feat/v1.1-study-identity` | |
| W6 | Local launcher (`dev:lab`) | In review | `feat/v1.1-dev-lab` · #30 | See #30 |
| W7 | Kafka authorization (local and CI) | In review | `feat/v1.1-kafka-acls` · #33 | A29 at local and CI level; hosted broker unchanged |
| W8 | Site content | Not started | | |
| W9a | Actual sandbox | Blocked on upstream R1–R6 | | |
| W9b | Source failure exercises | Blocked on upstream R7–R9 | | |
| W10 | Verification and release review | Not started | | |

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
