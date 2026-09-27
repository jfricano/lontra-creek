# Browser harness checkpoint

September 27, 2026 · PR #14 · review-ready locally; CI rerun pending

The last published Browser run (36354481494) passed 29 of 30 cases. Its sole
failure was WebKit's 404 accessibility check: Astro debug attributes caused
the known footer version contrast issue to miss the old HTML matcher.

The resumed change preserves the attribute-tolerant matcher and narrows the
exception to an actual `footer code` DOM target with the documented foreground
and background colors. An unrelated version snippet or changed color pair is
not exempted. Existing design-owned primary-button, syntax-comment, and footer
contrast trackers remain expected failures until the brand work fixes them.

Local verification:

- `npm run typecheck`: passed.
- `npm test`: 107 passed (local socket permissions required).
- `npm run build -w @lontra-creek/site`: passed, nine pages.
- `npx playwright test --project=chromium --workers=2`: 10 passed, including
  three expected design-issue failures, on Node 26.9.0 and installed Playwright
  Chromium. Used site/gateway/workbench/API ports 4341/7440/7441/7442.
- Firefox and WebKit are not installed locally; their rerun remains a CI gate.
  No browser download, push, merge, or deployment performed in this checkpoint.

Next: independently review this change, rerun all three engines in CI, then
integrate the brand changes and remove contrast exceptions as their fixes pass.
