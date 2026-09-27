import { expect, test } from "@playwright/test";

const routes = ["/", "/docs/", "/releases/", "/when-it-breaks/", "/playground/", "/workbench/", "/field-station/", "/lab/"];

test("every public route has unique metadata and internal links resolve", async ({ page, request }) => {
  const titles = new Set<string>();
  const links = new Set<string>();
  for (const route of routes) {
    const response = await page.goto(route);
    expect(response?.ok(), route).toBe(true);
    const title = await page.title();
    expect(titles.has(title), `${route}: duplicate title`).toBe(false);
    titles.add(title);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /.{10}/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://streamotter.app${route}`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /social-preview\.png$/);
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
    for (const href of await page.locator('a[href^="/"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("href")!))) links.add(href.split("#")[0]!);
  }
  for (const href of links) expect((await request.get(href || "/")).ok(), href).toBe(true);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const route of routes) expect(sitemap).toContain(`https://streamotter.app${route}</loc>`);
});

test("playground validates real configuration and receives real SDK data", async ({ page }) => {
  await page.goto("/playground/");
  const status = page.locator("#validation-status");
  await expect(status).toContainText("Valid configuration");
  await page.locator("#config-editor").fill("{");
  await expect(status).toContainText("Invalid JSON");
  await page.locator("#config-editor").fill("{}");
  await expect(page.locator("#validation-issues li").first()).toBeVisible();
  await page.getByRole("button", { name: "Reset example" }).click();
  await expect(status).toContainText("Valid configuration");
  await page.getByRole("button", { name: "Connect to field station" }).click();
  await expect(page.locator("#console-log")).toContainText("snapshot revision", { timeout: 30_000 });
  await expect(page.locator("#console-status")).toContainText("live");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator("#console-status")).toHaveText("Disconnected.");
  await expect(page.getByRole("button", { name: "Connect to field station" })).toBeEnabled();
});

test("playground reports service unavailability without replacing it with sample data", async ({ page }) => {
  await page.route("**/api/config", route => route.abort());
  await page.goto("/playground/");
  await page.getByRole("button", { name: "Connect to field station" }).click();
  await expect(page.locator("#console-status")).toContainText("unavailable");
  await expect(page.locator("#console-log")).toHaveText("No events yet.");
  await expect(page.getByRole("button", { name: "Connect to field station" })).toBeEnabled();
});

test("playground ends idle sessions and leaves an explicit reconnect control", async ({ page }) => {
  await page.clock.install();
  await page.goto("/playground/");
  await page.getByRole("button", { name: "Connect to field station" }).click();
  await expect(page.locator("#console-log")).toContainText("snapshot revision", { timeout: 30_000 });
  await page.clock.fastForward(601_000);
  await expect(page.locator("#console-status")).toContainText("paused");
  await expect(page.getByRole("button", { name: "Connect to field station" })).toBeEnabled();
});

test("state reference works from the keyboard and workbench media is labeled", async ({ page }) => {
  await page.goto("/when-it-breaks/");
  await page.getByLabel("Subscription state").focus();
  await page.keyboard.press("s");
  await page.getByLabel("Subscription state").selectOption("stale");
  await expect(page.locator('[data-state-detail="stale"]')).toBeVisible();
  await expect(page.locator('[data-state-detail="live"]')).toBeHidden();
  await page.locator("summary").filter({ hasText: "SOURCE_UNAVAILABLE" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("details[open]")).toContainText("Browser SDK");
  await page.goto("/workbench/");
  await expect(page.getByRole("heading", { name: "Recorded session" })).toBeVisible();
  await expect(page.locator("video")).toHaveAttribute("controls", "");
  await expect(page.locator("video")).not.toHaveAttribute("autoplay");
  await expect(page.locator('img[src^="/recordings/workbench/"]')).toHaveCount(5);
  for (const image of await page.locator('img[src^="/recordings/workbench/"]').all()) await expect(image).toHaveAttribute("alt", /Recorded/);
});
