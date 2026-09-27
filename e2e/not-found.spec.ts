/** apps/site/src/pages/404.astro: a made-up path falls through to it, noindex'd. */
import { expect, test } from "@playwright/test";

test("a made-up path shows the 404 page with noindex", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist-anywhere-on-the-site");
  expect(response?.status()).toBe(404);
  // Scoped to the page's own content: under `astro dev`, Astro's dev toolbar
  // (Base.astro doesn't add it; Astro injects it itself) adds its own <h1>s
  // (Audit, Settings, …) outside #main, and a bare "h1" locator hits all of them.
  await expect(page.locator("#main h1")).toContainText("isn't on the map");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});
