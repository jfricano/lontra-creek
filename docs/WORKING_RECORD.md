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
