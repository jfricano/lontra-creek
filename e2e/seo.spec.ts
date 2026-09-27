/** apps/site/src/pages/sitemap.xml.ts and apps/site/public/robots.txt. */
import { expect, test } from "@playwright/test";

test("/sitemap.xml is served", async ({ request }) => {
  const response = await request.get("/sitemap.xml");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toContain("xml");
  const body = await response.text();
  expect(body).toContain("<urlset");
  expect(body).toContain("<loc>https://streamotter.app/</loc>");
});

test("/robots.txt is served", async ({ request }) => {
  const response = await request.get("/robots.txt");
  expect(response.ok()).toBeTruthy();
  const body = await response.text();
  expect(body).toContain("Sitemap: https://streamotter.app/sitemap.xml");
});
