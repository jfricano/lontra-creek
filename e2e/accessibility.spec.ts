/**
 * Axe checks on the pages this harness can reach without the rest of the site's
 * content (which lands in later stories). No rules are disabled: a real violation
 * is reported here, not filtered out, so a serious or critical finding fails the
 * test and lists what it found. If a fix needs a change outside this story's
 * files, that goes in this story's report instead of being patched over here.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Result } from "axe-core";

const SERIOUS_OR_CRITICAL = ["serious", "critical"];

function describeViolations(violations: readonly Result[]): string {
  return violations
    .map(violation => `${violation.id} (${violation.impact}): ${violation.help}\n  ${violation.nodes.map(node => node.target.join(" ")).join("\n  ")}`)
    .join("\n\n");
}

test("home page has no serious or critical axe violations", async ({ page }) => {
  await page.goto("/");
  // Let the live panel reach its steady "live" state so the checks cover the
  // panel's real markup, not just its loading placeholders.
  await expect(page.locator("[data-live-creek] [data-card] [data-state]").first()).toHaveAttribute("data-state", "live", { timeout: 30_000 });

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(violation => SERIOUS_OR_CRITICAL.includes(violation.impact ?? ""));
  expect(serious, describeViolations(serious)).toEqual([]);
});

test("404 page has no serious or critical axe violations", async ({ page }) => {
  await page.goto("/this-page-does-not-exist-anywhere-on-the-site");

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(violation => SERIOUS_OR_CRITICAL.includes(violation.impact ?? ""));
  expect(serious, describeViolations(serious)).toEqual([]);
});
