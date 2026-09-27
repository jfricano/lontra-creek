/**
 * Axe checks on the pages this harness can reach without the rest of the site's
 * content (which lands in later stories). No rules are disabled: a real violation
 * is reported here, not filtered out, so a serious or critical finding fails the
 * test and lists what it found. If a fix needs a change outside this story's
 * files, that goes in this story's report instead of being patched over here.
 *
 * Three exceptions, all the design team's theme work and all decided by the
 * owner to merge as known issues rather than block the harness on:
 *
 * 1. The primary button's white text on #0091f5 measures 3.29:1.
 * 2. Syntax-highlighted comments in the `night-owl` code theme (home page):
 *    `#637777` italic comment tokens on `#07142e` measure 3.86:1.
 * 3. The version tag in the footer (`/` and the 404 page): `#62708a` on
 *    `#e8f0f8` measures 4.34:1.
 *
 * WCAG AA needs 4.5:1 for all three. `filterKnownIssues` strips only the
 * color-contrast nodes matching these three; every other serious or critical
 * violation, including any other color-contrast node, still fails. Each has
 * its own "known issue tracker" test below that fails on purpose until the
 * design team's fix lands, so none of the three can be quietly forgotten.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { NodeResult, Result } from "axe-core";

const SERIOUS_OR_CRITICAL = ["serious", "critical"];

function describeViolations(violations: readonly Result[]): string {
  return violations
    .map(violation => `${violation.id} (${violation.impact}): ${violation.help}\n  ${violation.nodes.map(node => node.target.join(" ")).join("\n  ")}`)
    .join("\n\n");
}

/** True if every selector in this node's target names a `.button-primary` element. */
function isButtonPrimaryNode(node: NodeResult): boolean {
  return node.target.every(selector => typeof selector === "string" && selector.includes(".button-primary"));
}

/**
 * True if this node is a `night-owl` comment token: a `<span>` with an inline
 * `color:#637777` (its italic comment color) inside a `pre.astro-code` block
 * on the home page (3.86:1 on the panel's `#07142e`). Matched on the rendered
 * inline style rather than an ancestor selector, because axe's
 * shortest-unique-selector for one of these spans doesn't always keep
 * `astro-code` in the chain (it can bottom out at `.line:nth-child(n) >
 * span:nth-child(m)`), so a selector-based match would miss some of them.
 */
function isNightOwlCommentNode(node: NodeResult): boolean {
  return /^<span\b[^>]*\bstyle="[^"]*color:#637777[^"]*"[^>]*>/i.test(node.html);
}

/**
 * True if this node is the footer's release-version tag in `Base.astro`: a
 * bare `<code>` element whose only content is the release version (4.34:1,
 * `#62708a` on `#e8f0f8`). Astro also stamps this element with a per-build
 * `data-astro-cid-*` scope attribute (currently `data-astro-cid-hkbrpulz`);
 * that hash changes whenever `Base.astro`'s `<style>` block changes, so this
 * matches the element's structure (a bare `code` tag holding a version
 * string) instead of keying on the hash.
 */
function isFooterVersionCodeNode(node: NodeResult): boolean {
  const match = /^<code(?:\s+data-astro-cid-[a-z0-9]+="")?>([^<]*)<\/code>$/i.exec(node.html.trim());
  const text = match?.[1];
  return text !== undefined && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(text);
}

/**
 * Drops color-contrast nodes that are one of the three known issues above. A
 * violation with other nodes keeps those nodes; a violation that is entirely
 * known-issue nodes is dropped.
 */
function filterKnownIssues(violations: readonly Result[]): Result[] {
  return violations
    .map(violation =>
      violation.id === "color-contrast"
        ? { ...violation, nodes: violation.nodes.filter(node => !isButtonPrimaryNode(node) && !isNightOwlCommentNode(node) && !isFooterVersionCodeNode(node)) }
        : violation
    )
    .filter(violation => violation.nodes.length > 0);
}

test("home page has no serious or critical axe violations", async ({ page }) => {
  await page.goto("/");
  // Let the live panel reach its steady "live" state so the checks cover the
  // panel's real markup, not just its loading placeholders.
  await expect(page.locator("[data-live-creek] [data-card] [data-state]").first()).toHaveAttribute("data-state", "live", { timeout: 30_000 });

  const results = await new AxeBuilder({ page }).analyze();
  const serious = filterKnownIssues(results.violations.filter(violation => SERIOUS_OR_CRITICAL.includes(violation.impact ?? "")));
  expect(serious, describeViolations(serious)).toEqual([]);
});

test("404 page has no serious or critical axe violations", async ({ page }) => {
  await page.goto("/this-page-does-not-exist-anywhere-on-the-site");

  const results = await new AxeBuilder({ page }).analyze();
  const serious = filterKnownIssues(results.violations.filter(violation => SERIOUS_OR_CRITICAL.includes(violation.impact ?? "")));
  expect(serious, describeViolations(serious)).toEqual([]);
});

// Known issue tracker: the primary button's white text on #0091f5 is 3.29:1,
// short of the 4.5:1 WCAG AA needs. That's the design team's theme work, not
// this harness's. test.fail() marks this as expected to fail; when the design
// team's contrast fix lands, this assertion starts passing, test.fail() flags
// that as an unexpected pass, and CI goes red — the signal to remove this test
// and the color-contrast filter in filterKnownIssues above.
test("primary button meets AA color contrast (known issue, owned by design)", async ({ page }) => {
  test.fail();
  await page.goto("/");
  const results = await new AxeBuilder({ page }).include(".button-primary").withRules(["color-contrast"]).analyze();
  expect(results.violations, describeViolations(results.violations)).toEqual([]);
});

// Known issue tracker: night-owl's italic comment color, #637777 on #07142e,
// is 3.86:1, short of the 4.5:1 WCAG AA needs. That's the design team's theme
// work, not this harness's. test.fail() marks this as expected to fail; when
// the design team's contrast fix lands, this assertion starts passing,
// test.fail() flags that as an unexpected pass, and CI goes red — the signal
// to remove this test and the isNightOwlCommentNode filter above.
test("syntax-highlighted comments meet AA color contrast (known issue, owned by design)", async ({ page }) => {
  test.fail();
  await page.goto("/");
  const results = await new AxeBuilder({ page }).include("span[style*='color:#637777']").withRules(["color-contrast"]).analyze();
  expect(results.violations, describeViolations(results.violations)).toEqual([]);
});

// Known issue tracker: the footer's version tag, #62708a on #e8f0f8, is
// 4.34:1, short of the 4.5:1 WCAG AA needs. That's the design team's theme
// work, not this harness's. test.fail() marks this as expected to fail; when
// the design team's contrast fix lands, this assertion starts passing,
// test.fail() flags that as an unexpected pass, and CI goes red — the signal
// to remove this test and the isFooterVersionCodeNode filter above.
test("footer version tag meets AA color contrast (known issue, owned by design)", async ({ page }) => {
  test.fail();
  await page.goto("/");
  const results = await new AxeBuilder({ page }).include("footer code").withRules(["color-contrast"]).analyze();
  expect(results.violations, describeViolations(results.violations)).toEqual([]);
});
