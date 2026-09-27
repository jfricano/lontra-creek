/** apps/site/src/pages/404.astro: a made-up path falls through to it, noindex'd. */
import { expect, test } from "@playwright/test";

test("a made-up path shows the 404 page with noindex", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist-anywhere-on-the-site");
  expect(response?.status()).toBe(404);
  await expect(page.locator("h1")).toContainText("isn't on the map");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});
