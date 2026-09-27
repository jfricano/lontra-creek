import { expect, test } from "@playwright/test";

test("walkthrough delivers SDK states, reconnects, denies the holt, and switches subject", async ({ page }) => {
  await page.goto("/field-station/#chapter-3");
  await expect(page.locator('[data-chapter="3"]')).toBeVisible();
  await expect(page.locator("[data-walk-state]")).toHaveText("live", { timeout: 30_000 });
  await page.locator("[data-walk-drop]").click();
  await expect(page.locator("[data-walk-state]")).toHaveText(/stale/);
  await expect(page.locator("[data-walk-flow]")).not.toHaveText("—");
  await page.waitForTimeout(2_300);
  await page.locator("[data-walk-restore]").click();
  await expect(page.locator("[data-walk-state]")).toHaveText("live");
  await expect(page.locator("[data-revision-gap]")).toContainText("not replayed");
  await page.locator("[data-chapter-next]").click();
  await page.locator("[data-holt-request]").click();
  await expect(page.locator("[data-holt-result]")).toContainText("FORBIDDEN");
  await expect(page.locator("[data-map-holt]")).toBeHidden();
  await page.locator("[data-chapter-next]").click();
  await page.locator("[data-role-switch]").click();
  await expect(page.locator("[data-role-result]")).toContainText("field biologist");
  await expect(page.locator("[data-map-holt]")).toContainText("LC ");
  await expect(page.locator("[data-role-switch]")).toBeDisabled();
  await expect(page.locator("[data-walk-log]")).toContainText("UNAUTHENTICATED");
  await page.locator("[data-chapter-next]").click();
  await expect(page.locator("[data-notebook-note]")).toContainText("need the Kafka field station");
  await expect(page.locator("[data-sighting-submit]")).toBeDisabled();
});

test("walkthrough navigation works from keyboard and bounded deep links", async ({ page }) => {
  await page.goto("/field-station/#chapter-99");
  await expect(page.locator('[data-chapter="1"]')).toBeVisible();
  for (let chapter = 2; chapter <= 6; chapter++) {
    await page.locator("[data-chapter-next]").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(`[data-chapter="${chapter}"] h2`)).toBeFocused();
  }
});

test("unavailable home freezes the illustration and offers an honest fallback", async ({ page }) => {
  await page.route("**/api/config", route => route.abort());
  await page.goto("/");
  await expect(page.locator("[data-live-creek]")).toHaveAttribute("data-status", "unavailable");
  await expect(page.locator("[data-clock]")).toHaveText("Still trying to reach the field station");
  await expect(page.locator("canvas")).toHaveAttribute("aria-label", /static creek is illustrative/);
  await expect(page.locator("[data-age]").first()).toHaveText("not connected");
  await page.locator("[data-pause-motion]").click();
  await expect(page.locator("[data-pause-motion]")).toHaveAttribute("aria-pressed", "true");
});

test("fallback recording identifies its origin and replays captured SDK values", async ({ page }) => {
  await page.route("**/api/config", route => route.abort());
  await page.goto("/");
  await page.locator("[data-open-recording]").click();
  await expect(page.locator("[data-recording]")).toBeVisible();
  await expect(page.locator("[data-recording-label]")).toContainText("no Kafka");
  await expect(page.locator("[data-recorded-rev]").first()).toContainText("Recorded revision");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-recording]")).not.toBeVisible();
});

test("idle walkthrough closes subscriptions until explicitly resumed", async ({ page }) => {
  await page.clock.install();
  await page.goto("/field-station/");
  await expect(page.locator("[data-walk-state]")).toHaveText("live", { timeout: 30_000 });
  await page.clock.fastForward(601_000);
  await expect(page.locator("[data-idle-notice]")).toBeVisible();
  await expect(page.locator("[data-walk-drop]")).toBeDisabled();
  await page.locator("[data-session-resume]").click();
  await expect(page.locator("[data-idle-notice]")).toBeHidden();
  await expect(page.locator("[data-walk-state]")).toHaveText("live", { timeout: 30_000 });
});

test("back navigation gets fresh field subscriptions", async ({ page }) => {
  await page.goto("/field-station/");
  await expect(page.locator("[data-walk-state]")).toHaveText("live", {timeout:30000});
  await page.goto("/docs/");
  await page.goBack();
  await expect(page.locator("[data-walk-state]")).toHaveText("live", {timeout:30000});
  // Explicit persisted event covers engines that disable bfcache under automation.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator("[data-walk-state]")).toHaveText("live", {timeout:30000});
});
