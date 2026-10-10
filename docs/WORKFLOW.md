# Delivery workflow

Practical workflow v3.0, adopted October 9, 2026. Existing product requirements,
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
