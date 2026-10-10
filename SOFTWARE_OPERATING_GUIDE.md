# Software Operating Guide

Version 3.0 | October 9, 2026

Practical delivery policy for Claude and Codex. Replaces v2.3's blanket independent-review requirement. The aim is useful, reliable software delivered with little coordination overhead. Verification is mandatory; a second agent is not mandatory for every change. Matching AGENTS.md and CLAUDE.md are the short entry points; PR_WORKFLOW.md supplies the delivery details.

## 1. Ownership and authority

One delivery owner carries a project or increment from the request through implementation, verification and the handoff. On a small task the owner also implements, documents and checks the work. Departments are specialists to consult when their actual systems are affected, not mandatory approval layers.

Jason owns product direction, material UX/scope choices, spending, reserved risk and release acceptance. Reuse approvals already given. Ask only for a missing consequential decision or authority, with a concrete recommendation and what it blocks. Routine engineering choices, author checks, documentation and reversible investigation do not need repeated approval.

Keep existing authorization boundaries for publication, messages, deployment, access and spending. A workflow document grants none of those by itself. The normal merge workflow remains Jason's merge; a specific explicit instruction can authorize a named agent merge without creating standing merge authority. A recorded standing project permission also applies within its exact repository/action scope; do not expand it to other projects. Do not enable auto-merge or bypass repository protections. Explain if merging already triggers production deployment.

## 2. The default delivery loop

1. Read the current working record and relevant code. Establish the actual branch/worktree, dirty state and source revision; consult the brief and applicable decisions. Read further only as needed. Do not relearn an entire project for a small change.
2. Define the smallest useful outcome and how to check it. A short task description is enough for a bounded fix. For a new product or substantial change, agree on users, required behavior, exclusions and meaningful UX before a broad build. Investigate a difficult external integration early with a small end-to-end slice.
3. Implement in an owned branch/worktree. Keep one coherent PR for the outcome; split only for independent delivery, real dependencies or excessive review size. Do not create a PR for every review observation or small documentation update.
4. Verify the affected behavior, classify review need using section 3, and repair failures. Update affected docs and the working record once the increment has meaningful new state.
5. Present one merge brief with the result, checks, gaps and next action. After the actual merge, record the merge revision and perform only authorized release actions. Verify the target outcome before saying shipped.

Do not restart discovery, scope approval or architecture design for a bounded fix to an approved product. Avoid speculative features, infrastructure and future-proofing. Prefer simple existing tools, a modular design and a suitable free option. New charges require existing budget authority or a decision before adoption.

## 3. Review based on consequence

The delivery owner records one short review decision in the PR or working record: author verification sufficient, focused independent review required, or required review unavailable. Judge actual behavior and failure consequences, not file extension or how many lines changed. A tiny authorization change can be high risk; a large generated documentation update can be routine.

| Change | Required evidence | Second reviewer |
| --- | --- | --- |
| Routine, reversible work: copy/layout, ordinary docs, standard CRUD/UI within existing access controls, bounded bug fixes, mechanical cleanup | Author diff inspection and relevant checks; exercise changed user behavior where applicable | Not required by default |
| High-consequence work: authentication/authorization, secrets or privileged access, payments, destructive migrations, backup/restore/deletion/retention, sensitive-data boundaries, isolation between users/tenants, production exposure or recovery-critical rollout changes | Author checks plus focused failure-path evidence | Required for the risky behavior before affected release/use |
| Concrete uncertainty: consequential unfamiliar integration, disputed correctness, repeated failed fixes or contradictory evidence | Small reproduction or integration probe first | Consult one relevant specialist/reviewer if uncertainty remains; stop when the question is answered |

A bug fix that changes a high-risk control remains high risk. Security/privacy claims and rights questions require factual support and owner decisions where applicable; wording changes alone do not automatically need a second engineering review. Cosmetic public-site work does not become high risk merely because the site is public.

Independent review is a fresh context that did not author the work. Give it the exact candidate, requirements, risk and existing evidence. Ask it to check the risky paths and coverage gaps, not repeat the whole build. It inspects relevant code and chooses targeted independent checks where they add confidence. Author tests can be reused with provenance; do not mislabel reuse as an independent rerun. If the same model family is used, do not claim model diversity.

Review once when the meaningful risky slice is ready, rather than after every intermediate commit. Findings need a reproducible defect, a requirement violation or a concrete consequential gap. Separate blockers, material issues and optional improvements. The implementer fixes issues in the existing PR. Recheck changed risky areas and affected dependencies; retain valid evidence for unchanged areas. Later pushes require a delta assessment, not an automatic full restart. A new real defect still blocks affected use; a review budget never overrides correctness.

If required independent review is unavailable, keep the affected high-risk use/release blocked and report the precise gap. Continue unrelated work. An optional review should not hold up otherwise verified routine work. Repository-required CI/review rules remain in effect; do not bypass or change them to fit this policy.

## 4. Verification that earns its cost

Author verification is part of implementation, not a separate exhaustive self-review, report or subagent. For a typo, inspect the edit; for UI, exercise the affected rendered flow; for a bug, reproduce it and run relevant regressions. A full suite or fresh context is not the default.

Check observable behavior and likely failure modes. Prefer an existing focused test, build/typecheck or direct reproducible check. Add regression tests for important bugs, durable rules and consequential edge cases. Do not add tests that mirror implementation, ceremonial screenshots, or a full suite for a typo. Broaden checks when the dependency surface or a failure justifies it.

For meaningful UI, exercise the changed flow and inspect the result at relevant sizes. For an external dependency, mocks validate local behavior but not the provider contract. Obtain a small actual integration proof when needed and authorized; synthetic data and disposable resources first. A static/docs-only edit needs no database rehearsal.

Reuse evidence for the same revision/configuration/environment when it still applies. Record enough provenance to assess reuse. Source, integration/provider and deployed acceptance are different claims; require only the applicable stages. A source-review PR can be complete while launch remains blocked on runtime acceptance. Health checks alone do not prove auth, persistence or recovery.

After two unsuccessful attempts at the same issue, stop guessing. Summarize the reproduction and evidence, narrow the cause, and seek targeted expertise if needed. This is a diagnostic checkpoint, not a fixed cap on necessary repairs or permission to ship a defect. Do not keep repeating unchanged tests without a new hypothesis or changed state.

## 5. Git without shared-root chaos

Keep shared main a clean reading baseline. Each active task owns an isolated branch/worktree; no concurrent editing of one checkout or file. Reuse a suitable owned checkout instead of making extra ones. Before creating a candidate, use an appropriate current base or record its dependency on unmerged work.

Commit only the task's files and use configured signing. If signing fails, report it and continue unaffected work; do not disable signing, change identity or substitute keys without applicable explicit authorization. No agent co-author trailers or generated-by/session attribution. Never misstate the authenticated actor or a GitHub approval.

Fetch/check status where authorized; advance tracked main fast-forward-only when clean and reserved for that update. Do not pull every historical/release worktree, reset/stash/rebase/force-push, delete branches or resolve Git problems as incidental housekeeping. Preserve local edits and report divergence. Broader repair needs a specifically authorized task.

After merge, the owner or repository manager updates the baseline once when safe. Do not have every department independently synchronize the shared root. Retain/archive work and evidence according to owner instructions; cleanliness is not permission to delete. Temporary artifacts alone are not durable delivery or backups.

## 6. Deployment considered early, verified at the right point

For backend/stateful work, agree on the relevant parts of docs/DEVOPS.md before building around hosting assumptions: platform/runtime, persistent stores, auth/origins, resource/cost limits, release triggers and recovery expectations. Unknowns remain unknown. Static or small personal projects fill only applicable items; use N/A with a reason.

Build the smallest deployable vertical slice early. Validate the actual provider/storage/auth boundary before expanding around it. Add complexity only for a real requirement. Capacity, backups, off-provider recovery and paid entitlements are not implied by a platform name or local tests.

Before changing production, name the candidate and target, relevant acceptance checks, failure/abort criteria and recovery method. Reuse established release procedures. Repeat full recovery/capacity drills only after changes affecting those guarantees or on the agreed periodic cadence; ordinary copy/code changes do not trigger them.

A successful merge, package build, provider authorization, object operation, app recovery and Oracle installation are separate events. State exactly which passed. Do not keep a whole project blocked on an unrelated gate, and do not declare launch accepted from a narrower result. Use synthetic/disposable checks; never overwrite live data for a test. Secrets/customer data stay out of code, logs, chat and reports.

## 7. Small coordination and documentation footprint

One owner sends the human one actionable summary per useful milestone. Include the next action and any decision needed. Notify immediately for meaningful risk, failure or a real blocker; routine acknowledgments, unchanged polls and department-to-department echoes need no human status message. Do not add review/report layers just because chats exist.

Use existing authorized department chats for their relevant expertise. Use a short-lived subagent only when authorized and useful: a bounded independent review, specific research question or separable task. Default to one active implementer per increment. Parallelize only genuinely independent work with distinct ownership; avoid idle watchers and duplicate investigations. Keep configured models unless selection is authorized; a premium specialist is not the default for routine work.

Keep one home for each fact:
- PROJECT_BRIEF.md: approved outcome, constraints and permissions. Short for small projects.
- WORKING_RECORD.md: current revision/stage, owner, next action, actual blockers and brief verification/review links. Update on meaningful changes, not every tool call.
- Affected usage/API/operations docs: maintain with the implementation.
- ADR: only a consequential decision with lasting tradeoffs. No ADR for ordinary implementation detail.
- Release/handoff receipt: only where another owner or environment needs durable exact-source evidence.

Link existing evidence instead of copying the same status into several reports. Preserve dated history but point entry documents to the current state. Do not create a new audit/report/PR for every test result. Respect client separation and employment boundaries; synthetic data is the default.

## 8. Honest completion and policy adoption

Report: what works now, checks actually run/reused, important unverified behavior, and next action. Distinguish author-verified, independently reviewed where required, merged and deployed. Never claim an unavailable test, approval, role, provider check or release occurred.

This scaffold is the source for new/adopted project instructions, not an automatic rewrite of every existing repository. Project-specific accepted requirements and protections still apply until deliberately reconciled. Ignored local instructions are not delivered by Git clone; supply them through supported session/project mechanisms or explicitly authorize tracking them.

When changing this policy, preserve the previous version outside active sources, update both identical entry points and affected role/templates, and record the change. Do not silently modify project permissions, release workflows, automations or repository settings.
