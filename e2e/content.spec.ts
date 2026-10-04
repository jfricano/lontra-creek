import { readFileSync } from "node:fs";
import { expect, test, type Request } from "@playwright/test";

/** The StreamOtter version the site pins, read from its package.json as the site itself does. */
const release = (JSON.parse(readFileSync(new URL("../node_modules/streamotter/package.json", import.meta.url), "utf8")) as { version: string }).version;
/** Non-GET Lab requests: anything that would borrow a bench, start a scenario, or approve an operation. */
function labWrites(page: import("@playwright/test").Page): string[] {
  const writes: string[] = [];
  page.on("request", (request: Request) => { const { pathname } = new URL(request.url()); if (pathname.startsWith("/api/lab/") && request.method() !== "GET") writes.push(pathname); });
  return writes;
}

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
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://streamotter.dev${route}`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /social-preview\.png$/);
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
    for (const href of await page.locator('a[href^="/"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("href")!))) links.add(href.split("#")[0]!);
  }
  for (const href of links) expect((await request.get(href || "/")).ok(), href).toBe(true);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  for (const route of routes) expect(sitemap).toContain(`https://streamotter.dev${route}</loc>`);
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
  await expect(page.getByRole("heading", { name: "Step by step" })).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.locator('img[src^="/recordings/workbench/"]')).toHaveCount(5);
  for (const image of await page.locator('img[src^="/recordings/workbench/"]').all()) await expect(image).toHaveAttribute("alt", /Recorded/);
});

test("the walkthrough keeps six chapters and offers an optional next step into Source failures (LC11-A01, A02)", async ({ page }) => {
  const writes = labWrites(page);
  await page.goto("/field-station/");
  await expect(page.locator("[data-chapter-link]")).toHaveCount(6);
  const next = page.locator("[data-walk-next]");
  await expect(next).toContainText("never breaks the shared creek");
  await expect(next).toContainText(`This demo runs streamotter@${release}. Quarantine and guarded continuation are planned for StreamOtter V1.1 and aren't in this release.`);
  const link = next.getByRole("link", { name: "Next: handle a bad reading" });
  await expect(link).toHaveAttribute("href", "/lab/?scenario=fouled-sensor#source-failures");
  await link.click();
  await expect(page).toHaveURL(/\/lab\/\?scenario=fouled-sensor#source-failures$/);
  await expect(page.locator('[data-lab-track="source-failures"] [data-lab-scenario="fouled-sensor"]')).toHaveAttribute("aria-current", "true");
  await page.waitForTimeout(2_000);
  expect(writes).toEqual([]);
});

test("the failure reference shows the planned policy matrix and record-disposition lifecycle, labeled as planned", async ({ page }) => {
  await page.goto("/when-it-breaks/");
  const planned = page.locator("[data-planned-policies]");
  await expect(planned.getByRole("heading", { level: 2 })).toHaveText("Planned: source-failure policies in StreamOtter V1.1");
  await expect(planned.locator(".notice")).toContainText(`Not in ${release}.`);
  await expect(planned.locator(".notice")).toContainText("UNKNOWN_KEY");
  await expect(planned).toContainText("There is no ignore, discard, or force-skip option.");
  const matrix = planned.getByRole("table", { name: "Failure-policy matrix (planned)" });
  await expect(matrix.locator("tbody tr")).toHaveCount(8);
  await expect(matrix.locator("tbody tr").first()).toContainText("invalid-json");
  await expect(planned.locator(".lifecycle h4")).toHaveText(["Held", "Evidence saved", "Hold, or ask the recovery guard", "Source advanced", "Views resynchronized"]);
  await expect(planned).toContainText("Subscription states don't change.");
  // Every planned source is pinned to one StreamOtter commit, never main.
  for (const href of await planned.locator('a[href^="https://github.com/jfricano/StreamOtter/"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("href")!))) {
    expect(href).toMatch(/\/(?:blob|tree)\/[0-9a-f]{40}\/docs\/releases\/v1\.1/);
  }
  // The installed release's reference is still first and unchanged in kind.
  await expect(page.getByLabel("Subscription state")).toBeVisible();
  await expect(page.locator("details summary").filter({ hasText: "HANDLER_FAILED" })).toHaveCount(1);
});

test("releases keep the site release, library package, demo availability, and verified boundary apart (LC11-A40)", async ({ page }) => {
  await page.goto("/releases/");
  await expect(page.locator("main h2")).toHaveText(["Site release", "Library package", "Demo availability", "Verified operating boundary", "Verified support matrix", "Default package limits"]);
  await expect(page.locator("[data-release-site]")).toContainText("Pre-launch.");
  await expect(page.locator("[data-release-site]")).toContainText("V1.1, in development.");
  await expect(page.locator("[data-release-library]")).toContainText(`install streamotter@${release}, pinned exactly`);
  await expect(page.locator("[data-release-library]")).toContainText("StreamOtter V1.1 is planned, not installed.");
  const rows = page.locator("[data-release-demo] tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: "Source failures" })).toContainText("Fouled sensor, on the same benches. The other 8 stories");
  const service = page.locator("[data-release-service]");
  await expect(service).toHaveAttribute("data-service", "answered", { timeout: 15_000 });
  await expect(service.locator("li").first()).toHaveText("Field station: answering, replaying fixture data without Kafka.");
});

test("releases say so when the field station doesn't answer, without filling in from the build", async ({ page }) => {
  await page.route("**/api/**", route => route.abort());
  await page.goto("/releases/");
  const service = page.locator("[data-release-service]");
  await expect(service).toHaveAttribute("data-service", "unreachable", { timeout: 15_000 });
  await expect(service.locator("[role=status]")).toHaveText("The field station didn't answer.");
  await expect(service.locator("li")).toHaveText(["The field station didn't answer, so this page can't say what the demo runs right now. The facts above still describe this build."]);
});

test("version and availability facts agree across pages (LC11-A40)", async ({ page }) => {
  const versions = new Set<string>();
  for (const route of ["/", "/field-station/", "/lab/", "/when-it-breaks/", "/docs/", "/releases/", "/playground/"]) {
    await page.goto(route);
    const text = await page.locator("main").innerText();
    for (const match of text.matchAll(/streamotter@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)/g)) versions.add(`${route} ${match[1]}`);
    for (const match of text.matchAll(/[Nn]ot in (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)/g)) versions.add(`${route} ${match[1]}`);
  }
  expect(versions.size).toBeGreaterThan(3);
  for (const entry of versions) expect(entry.split(" ")[1], entry).toBe(release);
  // The Lab's count of exercises that can't run matches the releases page's.
  await page.goto("/lab/#source-failures");
  const waiting = await page.locator('[data-lab-track="source-failures"] [data-lab-start]').count();
  await expect(page.locator("main")).not.toContainText(/four controlled failures/i);
  await expect(page.getByRole("heading", { name: "Bench controls" })).toBeVisible();
  await page.goto("/releases/");
  await expect(page.locator("[data-release-demo]")).toContainText(`The other ${waiting} stories are listed`);
});
