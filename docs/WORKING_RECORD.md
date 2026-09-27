# Lontra Creek delivery record

Updated 2026-09-27. Status: in progress; not deployed or release accepted.

## Contract and authority

Product contract: [PLAN.md](PLAN.md). Backlog: [TEAM_PLAN.md](TEAM_PLAN.md).
Approved design: the saved design review under the owner's main checkout,
`.local/design-team-2026-09-27/design-team/05-decisions.md`, with the latest
recorded owner choices: Figtree, the short site tagline, and named maintainer footer.
These existing decisions satisfy scope/design gates for unchanged work.

The owner instructed Codex to assemble the team and execute the remaining steps
on 2026-09-27, using Software Operating Guide v1.3. The external workflow folder
is read-only. CLAUDE.md is not Codex's instruction source.

Root acts as Delivery PM, responsible engineer, and sole integration owner.
No new costs, cloud resources, public deployment, main-branch merge, or release
acceptance are inferred from implementation authority. Existing plans record
feature-branch/PR permission; preparation continues locally first.
The pinned npm release remains the library boundary; no library-source checkout.

## Integration and ownership

Integration branch: `codex/site-completion`, worktree `docs-research-spikes`.
Base: `411381d`; integrated contract follow-up `b35d463` (PR #19), locally only.
The owner's main checkout and prior uncommitted work remain preserved.

| Actual agent | Worktree | Bounded ownership |
| --- | --- | --- |
| `/root` | docs-research-spikes | integration, record, walkthrough/demo functionality and remaining pages |
| `/root/qa_harness` | test-browser-harness | PR #14 failure and browser harness, then independent review |
| `/root/site_brand` | feat-site-brand-foundation | existing brand commits and approved homepage design |
| `/root/deployment` | feat-server-setup | setup/rollback scripts and new guarded release workflows |

Workers report actual checks and commits. Integration precedes final cross-feature
verification. File ownership changes are coordinated by root.

## Starting evidence and next actions

- Main remote verified at `411381d`, PR #17 merged. Owner checkout 30 commits behind.
- PR #19 ready; CI/Stack successful (stack container jobs intentionally skipped).
- PR #14 draft; Browser failed; other current CI/Stack/Lab spike checks successful.
- Prior accessibility matcher fix is uncommitted and retained for QA completion.
- Brand foundation: five local commits through `2804fce`, not pushed.
- Next: finish harness; integrate brand and run browser checks; implement remaining
  walkthrough/content/Lab, finish deployment preparation, independently review.
- Hosting/account checklist is not evidence that accounts or infrastructure exist.
  Staging, real-host capacity/timing, public proxy verification, and release
  acceptance remain pending until actual host access and authorization exist.

## Verification

No new implementation checks yet. Prior Claude-reported results are background
only, not new verification by this team. Results will be recorded per increment.

## Increment 1 evidence (2026-09-27)

Integrated QA harness `1fd370c`, approved brand/home `3f71be5`, deployment
preparation `46f5e5d`, and normative Lab contract `6d6cd0b` (cherry-picked).
QA fix pushed to existing PR #14 to obtain Firefox/WebKit CI evidence.

- Integrated typecheck and static build passed.
- Unit/integration suite: 110 passed before the additional idle-boundary regression.
- Chromium: 16 passed, including real fixture SDK walkthrough, stale/reconnect,
  volunteer denial, researcher identity switch, keyboard chapters, idle resume,
  labeled recording, light/dark axe on home/walkthrough/404.
- Three old accessibility exceptions and expected-failure trackers removed;
  integrated scans require zero serious/critical findings without filtering.
- Deployment orchestration/checkpoint/alarm tests: 6 passed with explicit test
  doubles for Docker. Actual container rehearsal remains unrun locally.
- Fallback recording: 29 actual SDK events captured with npm gateway/client over
  16.3 seconds, dated and labeled local fixture/no Kafka. No invented live data.
- Bricolage dependency removed after Figtree integration.

Independent review by `/root/deployment` of root UI found four material defects:
Lab token retry state, bfcache restoration, hidden/idle deadline extension, and
repeated same-role subscriptions. Accepted and repaired; affected regressions
added. New full integration run pending. Reviewer inspected recording provenance.
Root review of deployment found configuration not versioned alongside rollback
image; deployment worker is repairing it with a regression.

Public Lab risk R2 remains explicitly unresolved: unique SCRAM users do not
restrict Kafka topics without ACLs. No public exposure is authorized by this
candidate. Owner risk disposition or ACL hardening required before deployment.

## Increment 2 integration and review (2026-09-27)

Integrated content/workbench capture `0e31fff` and versioned deployment rollback
`7ed9f09`. PR #14 now passes Browser (all three engines), unit/typecheck, and
amd64/arm64 Stack and Lab-spike workflows; marked ready for review, not merged.
This CI result covers that PR, not the full current completion candidate.

Independent mobile/content checks added. First combined Chromium run: 27/30
passed; remaining failures were sitemap readiness flags and focusability of a
scrollable Lab example. Both repaired, repeat verification pending. Reviewer
also found the researcher retry guard used requested role instead of successful
switch completion; changed to an explicit completion flag.

Independent production-build performance samples (local static server, backend
unavailable, three cold-cache runs each): mobile 390x844, CPU4x, RTT150ms,
1.6Mbps down/750Kbps up: LCP616–672ms, CLS0.00115; desktop1440x900, native CPU,
RTT40ms,10Mbps down/5Mbps up: LCP172–176ms, CLS0.000371. Initial encoded response
bodies139,921 bytes. Synthetic EventTiming24–48ms is not a field INP result.
These measurements do not certify hosted capacity or real-user performance.

Native `dev:kafka` path added for reproducible chapter-six notebook testing using
existing Kafka/JDK binaries, local512MiB heap, persistent logs/checkpoints and
loopback endpoints. Independent live verification in progress. Public Lab remains
subject to R2 and release approval. Shared-host preparation is being reconciled
with the newer candidate; no cloud resources or public deployment performed.

## Candidate PR #20

[Draft candidate](https://github.com/jfricano/lontra-creek/pull/20), branch
`codex/site-completion`; main remains unchanged. Runtime `1c89a0b` integrated.
Root verified119 application/unit tests, typechecks, and6 deployment regression
tests. Independent backend review ran18 targeted tests and found no further
material issues in inspected authorization/lease/reset/redaction code. It did not
independently reproduce the native Kafka scenarios; see LAB_CHECKPOINT.md for
author-run six-scenario native evidence and the explicitly skipped Caddy/three-
bench case. Current full candidate CI is running those container boundaries.

Setup workflow commands now use immutable deployed configuration directories,
including restarts and cleanup; PR concurrency prevents overlapping rehearsals.
The integration includes PRs #14 and #19; reconcile them at human merge time.
No npm release, main merge, hosting mutation, or public launch has occurred.

Native launcher review found readiness was announced before Kafka group rebalance
completed. The launcher now waits for an IPC signal after gateway.start resolves,
and shuts down clients before the broker. Independent restart verification is
rerunning. Static local-link/asset checks are now part of the standard CI build.

First full PR20 CI:119 tests/typecheck/build and main Stack on amd64/arm64
passed. Browser91/93 passed: all Chromium and Firefox tests; two WebKit dark
Lab contrast scans failed on an unthemed secondary native button. Applied the
existing explicit theme-aware button-quiet style; no axe exclusions added.
Setup rehearsal reached a real ARM64 first deployment before a later failure;
the deployment reviewer owns diagnosis. Final current-head results pending.

## Verified integration results

At candidate `3c9a3e1`, all93 browser checks passed (Chromium, Firefox, WebKit,
including dark/light and narrow-screen accessibility). Standard CI passed119
application tests, typecheck, production build and static link/asset validation.
Both amd64 and arm64 main-stack checks passed.

ARM64 setup rehearsal [36357431368](https://github.com/jfricano/lontra-creek/actions/runs/36357431368)
passed idempotent setup with preserved secrets/CA, first deployment, external
behavior, checkpoint backup/validation/restore, deliberate failed-image rollback,
and SSH-command restrictions. Checkpoint comparison now compares equal timestamp
instants, accommodating the server's normalized ISO milliseconds. This verifies
an ephemeral Ubuntu CI host, not an Oracle account or a shared-host deployment.

Shared hosting proposals are reconciled in SHARED_HOST_READINESS.md. A private
proxy is proposed because attaching field-station directly to the ingress network
would also expose its internal listener there; an ingress network is not a
port-level firewall. Direct aliases also omit the three Lab routes. Coordination
agreement, enforced capacity budgets, disposable backup-restore hooks, and Lab
public-risk disposition remain required before shared-host deployment.

The complete `3c9a3e1` CI batch is green, including both architecture Lab jobs
[36357431298](https://github.com/jfricano/lontra-creek/actions/runs/36357431298).
Those jobs passed real three-bench scenarios and private-container environment,
management-loopback, and per-bench API credential checks. Final added HTTP
queue/FIFO/snapshot-scope checks await the next head's container run.
