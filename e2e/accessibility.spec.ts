import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  for (const route of ["/", "/field-station/", "/lab/", "/when-it-breaks/", "/releases/", "/docs/", "/docs/api/", "/docs/api/client/createClient/", "/docs/api/contracts/StreamOtterError/", "/this-page-does-not-exist-anywhere-on-the-site"]) {
    test(`${route} has no serious or critical axe violations in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(route);
      if (route === "/") await expect(page.locator("[data-live-creek] [data-card] [data-state]").first()).toHaveAttribute("data-state", "live", { timeout: 30_000 });
      if (route === "/field-station/") await expect(page.locator("[data-walk-state]")).toHaveText("live", { timeout: 30_000 });
      if (route === "/releases/") await expect(page.locator("[data-release-service]")).not.toHaveAttribute("data-service", "checking", { timeout: 15_000 });
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""));
      expect(serious, serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`).join("\n")).toEqual([]);
    });
  }
}
