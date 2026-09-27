/**
 * Axe checks on the pages this harness can reach without the rest of the site's
 * content (which lands in later stories). No rules are disabled: a real violation
 * is reported here, not filtered out, so a serious or critical finding fails the
 * test and lists what it found. If a fix needs a change outside this story's
 * files, that goes in this story's report instead of being patched over here.
 *
 * One exception: the primary button's white text on #0091f5 measures 3.29:1,
 * and WCAG AA needs 4.5:1. That's the design team's theme work, not ours, and
 * the owner has decided to merge this harness with it marked as a known issue
 * rather than block on it. `filterKnownIssues` strips only the color-contrast
 * nodes that target a `.button-primary` element; every other serious or
 * critical violation, including any other color-contrast node, still fails.
 * The "known issue tracker" test below fails on purpose until the design
 * team's fix lands, so the known issue can't be quietly forgotten.
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
 * Drops color-contrast nodes that are the known `.button-primary` issue
 * (3.29:1, white on #0091f5, owned by the design team's theme work). A
 * violation with other nodes keeps those nodes; a violation that is entirely
 * `.button-primary` nodes is dropped.
 */
function filterKnownIssues(violations: readonly Result[]): Result[] {
  return violations
    .map(violation => (violation.id === "color-contrast" ? { ...violation, nodes: violation.nodes.filter(node => !isButtonPrimaryNode(node)) } : violation))
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
