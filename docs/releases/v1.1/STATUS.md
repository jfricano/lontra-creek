# Lontra Creek V1.1 — Status

Updated October 3, 2026 · The live tracker for [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Every slice PR updates its row in the same PR.

**Overall:** planning. No V1.1 feature is implemented, tested, or deployed. Installed library: `streamotter@0.1.0-rc.3`, which provides none of the native V1.1 capabilities ([BASELINE.md](BASELINE.md)).

## Slices

| ID | Slice | State | Branch / PR | Acceptance evidence |
| --- | --- | --- | --- | --- |
| P0 | Planning, baseline, decisions, sandbox contract | In review | `docs/v1.1-implementation-plan` | A40 planning record |
| W1 | Lab foundation hardening | Not started | | |
| W2 | Sandbox session service | Not started | | |
| W3 | `/workbench/` page shell | Not started | | |
| W4 | Source failures track shell | Not started | | |
| W5 | Study identity and coverage ledger | Not started | | |
| W6 | Local launcher (`dev:lab`) | Not started | | |
| W7 | Kafka authorization (local and CI) | Not started | | |
| W8 | Site content | Not started | | |
| W9a | Actual sandbox | Blocked on upstream R1–R6 | | |
| W9b | Source failure exercises | Blocked on upstream R7–R9 | | |
| W10 | Verification and release review | Not started | | |

## Gates

| Gate | State |
| --- | --- |
| Published workbench seam (R1–R6) | Requested from StreamOtter V1.1, October 3 |
| Published native failure APIs (R7–R9) | Planned in StreamOtter V1.1 |
| Hosted Kafka authorization | Waits for Jason's approval (LC11-ADR-03) |
| Sandbox host capacity | Waits for local measurement, then Jason (LC11-ADR-04) |
| Site deployment | Waits for Jason |

## Acceptance coverage

LC11-A01–A46 are defined in the [acceptance plan](LONTRA_CREEK_V1_1_ACCEPTANCE_PLAN.md). This table lists only IDs with evidence recorded; an ID absent here has none yet.

| ID | Evidence level | Where |
| --- | --- | --- |
| — | — | — |
