# Delivery workflow

Practical workflow v3.1.1, updated October 9, 2026. Existing product requirements,
project permissions and repository protections continue to apply.

- One delivery owner implements and verifies a useful increment in an owned
  branch/worktree. Keep shared main clean; preserve unrelated work and history.
- Author verification is the default for routine documentation, UI, maintenance
  and bounded changes within existing controls. Inspect the diff and run
  proportionate checks; state failed or unrun checks.
- Use focused independent review before affected release/use for authentication,
  privileged access, secrets, payments, destructive migrations, backup/restore,
  deletion/retention, sensitive-data or tenant boundaries and recovery-critical
  production changes. Classify consequences, including small fixes to controls.
- Reuse valid evidence with its revision/environment. Review repairs and later
  changes by the affected delta; do not restart unchanged work automatically.
  A known blocker still prevents affected use. Honor required repository checks.
- Keep one coherent PR per useful outcome. Use configured signing and the owner's
  identity. Normal merge belongs to the owner; any explicit recorded exception
  applies only within its repository/action scope. No new merge, deployment,
  publishing, spending, CI/protection or messaging authority is granted here.
- Resolve ordinary engineering choices directly. Ask only for missing material
  scope/UX, cost, authority or reserved-risk decisions; continue unaffected work.
- Prove a thin actual integration before expanding around an external dependency.
  Source tests, provider acceptance and deployed acceptance are distinct. Reuse
  unchanged recovery/capacity evidence; do not infer deployment from a merge.
- Update affected docs and the existing working record for meaningful changes.
  Use ADRs for consequential choices and send one concise milestone update with
  result, evidence/gaps and next action. Optional roles are not required staffing.

Author verification is part of implementation, not a separate exhaustive self-review, report or subagent. For a typo, inspect the edit; for UI, exercise the affected rendered flow; for a bug, reproduce it and run relevant regressions. A full suite or fresh context is not the default.

After two failed attempts at the same issue, narrow the cause and seek focused
help instead of repeating guesses. Keep secrets, private data and client material
out of logs, commits and reports. Historical receipts retain their dated scope.

## Durable operating principles — v3.1.1

Deep thinking and complex logic beneath intuitive interfaces and powerful simplicity applies to products, architecture, code, documentation, tools, workflows, verification and handoffs. Make the next useful action clear and handle necessary complexity underneath. Simplicity must never substitute for completeness: deliver complete approved behavior, necessary edge cases, invariants, failure handling and operational obligations. Completeness follows approved scope, not speculative expansion. Keep material consequences, permissions, costs and recovery choices visible.

Documentation is a core operational asset and shared memory for resilience across teams. Another authorized team or session must be able to continue without depending on one chat or person. Maintain scope, consequential decisions and why, implementation versus deployed state, interfaces, remaining issues, useful evidence and applicable setup/release/recovery alongside meaningful changes and handoffs. Keep one authoritative home per fact and link it; preserve dated history while pointing to current truth. Scale detail to actual scope/risk and make records navigable and usable. Less duplicate reporting, not less durable knowledge; brevity or token savings must not erase essentials. This adds no mandatory independent documentation review or separate reporting layer.

Understand goals and consequential tradeoffs before expanding the solution. Use accessible controls, clear language, sensible defaults and useful feedback; reveal advanced detail when useful. Separate business rules, presentation and provider integrations at real boundaries, keep privileged operations on the trusted side, and model important invariants. Prefer adequate existing tools and a modular monolith; complexity needs a demonstrated requirement. Preserve export/migration paths for valuable data and record consequential tradeoffs in existing decision records.

Prefer suitable existing entitlements, local tools, open source and free tiers. Check relevant current limits, licenses, retention, export and upgrade paths when adopting or materially changing services; reuse applicable evidence. New or increased charges, overages and converting trials require authorization or an existing recorded budget; a payment method is not permission. For a cost decision, present the free and smallest adequate paid options, upgrade trigger and recommendation. Respect the existing execution budget; avoid duplicate work and idle watchers, and preserve a safe increment when constrained.

Keep studio work on personal devices/accounts and other-employment information out of studio work. Keep client material within its authorized project without cross-client context, examples or code. Use synthetic data; real client data needs explicit authority and checked confidentiality terms and must not enter public repositories or unauthorized services. Never log or commit secrets or personal data. Material client scope changes require a concise scope/time/cost proposal; reuse approved scope for ordinary work within it.

Deliver applicable setup/usage instructions, meaningful evidence, limitations and recovery guidance. Substantive releases/handoffs include relevant change history, dependency/license information and maintenance boundaries; link existing records rather than manufacturing documents. Source approval, release acceptance and publication authority are distinct; passing checks alone is not acceptance. Preserve work durably through authorized destinations. Author verification happens during implementation: inspect a typo, exercise affected UI, or reproduce a bug and check relevant regressions. No exhaustive self-review, full suite or fresh context by default. Existing repository permissions, privacy rules, consequence-based checks and explicit review exceptions remain controlling.
