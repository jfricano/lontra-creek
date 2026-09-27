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
