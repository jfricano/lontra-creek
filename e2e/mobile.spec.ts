import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test(`all routes fit a narrow screen with accessible controls in ${colorScheme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const route of ["/", "/field-station/", "/lab/", "/docs/", "/releases/", "/when-it-breaks/", "/playground/", "/workbench/"]) {
      await page.goto(route);
      if (route === "/") await expect(page.locator("[data-card] [data-state]").first()).toHaveAttribute("data-state", "live", { timeout: 30_000 });
      if (route === "/field-station/") await expect(page.locator("[data-walk-state]")).toHaveText("live", { timeout: 30_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), route).toBe(true);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? "")), route).toEqual([]);
    }
  });
}

test("mobile menu and live motion controls work by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  const menu = page.locator("[data-menu] summary");
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-menu]")).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(page.locator("[data-menu]")).not.toHaveAttribute("open");
  const pause = page.locator("[data-pause-motion]");
  await expect(pause).toHaveAttribute("aria-pressed", "true");
  await pause.focus();
  await page.keyboard.press("Enter");
  await expect(pause).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await expect(pause).toHaveAttribute("aria-pressed", "true");
});
