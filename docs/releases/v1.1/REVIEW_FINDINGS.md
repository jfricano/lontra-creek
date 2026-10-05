# Lontra Creek V1.1 independent review

**Reviewed:** `review/v1.1` at `b02b46f` (PR #40, all eleven V1.1 slices combined), October 4, 2026.
**Result:** 6 major and 26 minor findings, plus one more found while fixing them (LAB-9). All 33 were confirmed and fixed on this branch, each with a regression test that fails on `b02b46f` (documentation-only fixes excepted).

Four reviewers who did not write the code each took one area and reported findings with a concrete failure scenario and, where practical, a failing repro. The full reports, including what each reviewer checked and found correct, are in [review/](review/):

| Area | Report | Major | Minor |
| --- | --- | --- | --- |
| Lab backend (`apps/field-station/src/lab`, `lab-api.md`) | [LAB.md](review/LAB.md) | 2 | 6 (+1) |
| Sandbox session service (`apps/field-station/src/sandbox`, `sandbox-api.md`) | [SBX.md](review/SBX.md) | 1 | 7 |
| Site pages and browser code (`apps/site`, `e2e`) | [SITE.md](review/SITE.md) | 1 | 9 |
| Deploy, local tooling, CI and docs | [OPS.md](review/OPS.md) | 2 | 4 |

Contracts and docs changed with each fix are listed in its commit.

## Major findings

| ID | What was wrong | Fix |
| --- | --- | --- |
| LAB-1 | A queued visitor whose last poll was over 30 s old lost a newly granted bench as `idle` within one sweep, instead of getting the 30 s claim window. | `86bbbb6`: a grant restarts the place's idle clock. |
| LAB-2 | After a bench process restart resumed a lease, the page's feed cursor got 400 and the `gap` notice never arrived. | `033159c`: feed IDs carry a restart epoch; an older cursor is answered from the restarted feed with `gap: true`. |
| SBX-1 | A reset while a workbench call was in flight could end the whole lease as `slot-failed`, sending the visitor to the back of the line. | `105c6d1`: late failures from the old study answer `stale-study`; the lease and slot are kept. |
| SITE-1 | When the session cookie lapsed mid-lease, the Lab page said "Borrow a bench" with Borrow disabled and the clock still counting. | `2e0bf87`: a `no-session` refusal ends the lease view and re-enables Borrow. |
| OPS-1 | The hosted Kafka authorization runbook didn't name the env file; an edit to `current.env` silently reverted to `none` on the next deploy. | `31c39a8`: the runbook sets it in `stack.env` and checks both agree; `deploy.sh` refuses to lower it without a root override. |
| OPS-2 | The ACL probe tests still ran after the broker check failed, and against a non-enforcing broker would write junk into production topics and pause the creek. | `bdef04d`: probes run only after the broker is proven to enforce; the probe script also refuses on its own. |

## Minor findings

| ID | Finding | Fix |
| --- | --- | --- |
| LAB-3 | A reset taking 60–90 s was retried forever, so the bench was never granted. | `c3ff157` |
| LAB-4 | One failed poll during a gateway restart failed the bench and ended the lease. | `6bbe53b` |
| LAB-5 | The coverage ledger could roll served state back to an older revision (latent until W9b). | `6cb652f` |
| LAB-6 | The publisher gate could admit a send after `close()` reported nothing in flight (latent until W9b). | `49d8e3a` |
| LAB-7 | A retried reset wrote the study summary with `leaseId: null`. | `671390e` |
| LAB-8 | A grant was backdated to the sweep's start, shortening the claim window and lease. | `9cbc53c` |
| LAB-9 | Requests during startup could grant a bench that `initialize()` then reset (found while fixing SBX-3). | `10158c3` |
| SBX-2 | A refused `POST /api/sandbox/session` still set a 30-minute session cookie. | `c23fd96` |
| SBX-3 | Slots could be granted before startup had returned every slot. | `d8e1244` |
| SBX-4 | `constructor`, `toString` and `__proto__` passed the "one of the slot's sources" check. | `db2de77` |
| SBX-5 | `Retry-After` and `X-Request-Id` weren't exposed to the cross-origin page. | `7134a44` |
| SBX-6 | Export refusals with many issues dropped `details.code` and every issue. | `a74dfc8` |
| SBX-7 | The 1 s poll while resetting only ran when visitors sent requests. | `b86076a` |
| SBX-8 | The contract implied the sandbox deployment exists; the env denylist missed `LAB_RELAY_TOKEN`. | `4ed339e` |
| SITE-2 | The workbench dropped the answer to a Start still in flight, leaving an unseen place on the server. | `37415b5` |
| SITE-3 | Existing Lab scenarios said "Runs today" even when the backend reported no benches. | `3d6d1a5` |
| SITE-4 | The retried-record outcome said "After Resume" when the visitor had restarted the gateway instead. | `92c32fa` |
| SITE-5 | The claim countdown re-announced every second in the status live region. | `621ded6` |
| SITE-6 | Keyboard focus fell to the page after Start, Leave the line and End session. | `27dfddf`, `9a65a2a` |
| SITE-7 | The Lab's two-place message didn't say the cap is shared with the workbench sandbox. | `dc8cf05` |
| SITE-8 | Lab bench buttons were enabled for actions the bench refuses. | `114a1aa` |
| SITE-9 | Ctrl/Cmd/Shift-click on track and scenario links didn't open a new tab. | `cf448de` |
| SITE-10 | A background tab's throttled timers could miss heartbeats; the page now checks in on return and the copy no longer promises background check-ins. The server's idle limits are unchanged. | `8f189e8` |
| OPS-3 | The runbook described Kafka's `migrate` mode per operation; Kafka applies it per resource and doesn't log what it allows. | `89ed235` (docs) |
| OPS-4 | `dev:lab --dir` accepted any git-ignored directory, including one Caddy serves and dev:kafka's data. | `33999b7` |
| OPS-5 | The cross-bench group probe used a name in nobody's prefix. | `27022d4` |
| OPS-6 | LOCAL_LAB.md left out the bench study volumes from stop and discard and miscounted services. | `50af6b7` (docs) |

## Also fixed

- `a6e111b`: a Lab coverage test that failed about one run in five (it removed a directory while a background discard was still writing).
- `82962f8`: the workbench queue spec, which failed about once in a few dozen runs when the clock ticked between two timestamps in one stubbed answer.

## Known limits left as they are

- SITE-2: if the page is closed while Start is in flight, the keepalive return can reach the server before the join; that place then lasts until the idle limit (60–90 s).
- LAB-7: if a bench process crashes between a failed reset and its retry, the boot-time discard still writes `leaseId: null`; fixing that needs a new `study.json` field.
- SBX: the published WHC-1 workbench may fire several calls at once when it mounts, which the 2-a-second operation budget would partly refuse. This can only be checked once a StreamOtter release with the seam exists (W9a). Confirmed in W9a on the local stack with 0.2.0-rc.1 (five reads at once, then two more for the first view); the budget now allows a burst of 8 before its 2 a second.

## Verification after the fixes

- `npm run typecheck`, `npm test` (294/294), site build, `check:site` (345 links and assets).
- `node --test deploy/test/operations.test.ts deploy/test/kafka-acl-guard.test.ts` (10/10).
- Playwright in Chromium, full suite: 94/94. The Lab and workbench specs also passed repeated runs (195/195 at five repeats).
- CI on PR #40 runs Firefox, WebKit and the real-Kafka stack workflows.
