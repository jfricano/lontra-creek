import { expect, test } from "@playwright/test";

test("the Docs page leads to the API reference, and the reference to each declaration", async ({ page }) => {
  await page.goto("/docs/");
  await page.getByRole("link", { name: /^Every export of streamotter@/ }).click();
  await expect(page).toHaveURL(/\/docs\/api\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("API reference");
  await page.getByRole("article").getByRole("link", { name: "streamotter/client" }).click();
  await page.getByRole("article").getByRole("link", { name: "createClient", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("createClient");
  // The signature's types link to their own pages.
  await page.locator(".api-code").getByRole("link", { name: "ClientOptions" }).first().click();
  await expect(page).toHaveURL(/\/docs\/api\/contracts\/ClientOptions\/$/);
  await expect(page.getByText(/^Also exported from/)).toContainText("streamotter/client");
});

test("the index filters every export by name or description", async ({ page }) => {
  await page.goto("/docs/api/");
  const rows = page.locator("[data-api-name]");
  const total = await rows.count();
  expect(total).toBeGreaterThan(200);
  await page.getByLabel("Filter by name or description").fill("CreateClient");
  const shown = rows.filter({ visible: true });
  await expect(shown.getByRole("link", { name: "createClient", exact: true })).toBeVisible();
  const count = await shown.count();
  expect(count).toBeLessThan(10);
  await expect(page.locator("[data-api-filter-count]")).toHaveText(`${count} ${count === 1 ? "export" : "exports"} match “CreateClient”`);
  for (const text of await shown.allTextContents()) expect(text.toLowerCase()).toContain("createclient");
  await page.getByLabel("Filter by name or description").fill("");
  await expect(rows.filter({ visible: true })).toHaveCount(total);
});
