/**
 * The home page's live panel (apps/site/src/components/LiveCreek.astro), a real
 * StreamOtter subscription over the field station's fixture replay.
 *
 * Selectors are the `data-*` hooks fe-walk's F.3 refactor promises to keep:
 * [data-live-creek], [data-card], [data-state], [data-drop], [data-restore],
 * [data-connection], [data-log], [data-note]. Other lanes (the walkthrough in
 * particular) can reuse these same hooks and this same drop/restore flow.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import capture from "../apps/site/public/recordings/workbench/capture.json" with { type: "json" };

/** Each card's state chip, scoped to the live panel so it never matches the
 *  static state-name chips in the "no silent failures" section further down
 *  the home page, which share the `[data-state]` attribute on unrelated markup. */
const CARD_STATE = "[data-live-creek] [data-card] [data-state]";

async function expectAllCards(page: import("@playwright/test").Page, state: string, timeout: number): Promise<void> {
  const chips = page.locator(CARD_STATE);
  await expect(chips).toHaveCount(3);
  const handles = await chips.all();
  await Promise.all(handles.map(chip => expect(chip).toHaveAttribute("data-state", state, { timeout })));
}

test.describe("home page live panel", () => {
  test("the three cards reach live", async ({ page }) => {
    await page.goto("/");
    await expectAllCards(page, "live", 30_000);
  });

  test("when the field station doesn't answer at first, the panel keeps asking and goes live once it does", async ({ page }) => {
    let refused = 0;
    await page.route("**/api/config", route => {
      if (refused >= 2) return route.continue();
      refused += 1;
      return route.abort("connectionrefused");
    });
    await page.goto("/");
    const panel = page.locator("[data-live-creek]");
    await expect(panel).toHaveAttribute("data-status", "unavailable");
    await expect(page.locator("[data-clock]")).toHaveText("Still trying to reach the field station");
    // Asked again after 1 s and 2 s: the third request is answered.
    await expectAllCards(page, "live", 30_000);
    await expect(panel).not.toHaveAttribute("data-status", "unavailable");
    await expect(page.locator("[data-source]")).not.toHaveText("Field station unavailable");
    await expect(page.locator("[data-drop]")).toBeEnabled();
    expect(refused).toBe(2);
  });

  test("dropping the connection makes the cards stale, and restoring returns them to live with a revisions note", async ({ page }) => {
    await page.goto("/");
    await expectAllCards(page, "live", 30_000);

    // [data-connection] is on both the root panel and the small text readout inside
    // it (LiveCreek.astro), so a bare `[data-connection]` locator matches two
    // elements; scope to the root, which is the one hook other lanes can rely on
    // being unique.
    const root = page.locator("[data-live-creek]");
    const other = await page.context().newPage();
    await other.goto("/");
    await expectAllCards(other, "live", 30_000);
    const otherRevision = await other.locator("[data-card] [data-rev]").first().textContent();

    // Check for "stale" promptly: leaving the connection cut for long enough lets
    // the SDK's own automatic recovery give up and move a subscription to
    // "resync-required" instead, which is a different, later state.
    await page.locator("[data-drop]").click();
    await expect(root).not.toHaveAttribute("data-connection", "connected", { timeout: 10_000 });
    await expectAllCards(page, "stale", 8_000);
    const frozenRevisions = await page.locator("[data-card] [data-rev]").allTextContents();
    const frozenClock = await page.locator("[data-clock]").textContent();

    // The "weren't replayed" note only appears when a newer revision arrived
    // while the page was offline. The fixture advances one reading every 2s,
    // so hold the drop for 5s here (well past one tick) to make a missed
    // revision certain before restoring, rather than racing the fixture.
    for (let tick = 0; tick < 10; tick++) {
      await page.waitForTimeout(500);
      expect(await page.locator("[data-card] [data-rev]").allTextContents()).toEqual(frozenRevisions);
      await expect(page.locator("[data-clock]")).toHaveText(frozenClock!);
      await expect(root).not.toHaveAttribute("data-connection", "connected");
    }
    await expect(other.locator("[data-live-creek]")).toHaveAttribute("data-connection", "connected");
    await expect(other.locator("[data-card] [data-rev]").first()).not.toHaveText(otherRevision!);

    await page.locator("[data-restore]").click();
    await expectAllCards(page, "live", 30_000);
    await expect(page.locator("[data-note]")).toContainText("weren't replayed", { timeout: 30_000 });
    expect(await page.locator("[data-card] [data-rev]").allTextContents()).not.toEqual(frozenRevisions);
    await other.close();
  });
});

test.describe("home page source-failure panel (LC11-A01, A02, A40)", () => {
  const release = (JSON.parse(readFileSync(new URL("../node_modules/streamotter/package.json", import.meta.url), "utf8")) as { version: string }).version;

  test("describes the installed release's opt-in policies, keeps what this demo runs separate, and links to the Source failures track without borrowing a bench", async ({ page }) => {
    const lab: string[] = [];
    page.on("request", request => { const { pathname } = new URL(request.url()); if (pathname.startsWith("/api/lab/") && request.method() !== "GET") lab.push(pathname); });
    await page.goto("/");
    const panel = page.locator("[data-v11-panel]");
    await expect(panel.locator(".eyebrow")).toHaveText(`In streamotter@${release} · opt-in`);
    await expect(panel).not.toContainText(/planned|specified, not released/i);
    await expect(panel).toContainText("Without a policy, a bad record pauses its source");
    await expect(panel).toContainText("asks this demo's backend which of them it can run");
    await expect(panel.getByRole("heading", { level: 3 })).toHaveText(["Preserve the record", "Continue only under control", "See each outcome"]);
    // The live hero is unchanged: the panel sits below it and doesn't replace it.
    await expect(page.locator("[data-live-creek] [data-card] [data-state]").first()).toHaveAttribute("data-state", "live", { timeout: 30_000 });
    await panel.getByRole("link", { name: "Try source failures" }).click();
    await expect(page).toHaveURL(/\/lab\/#source-failures$/);
    await expect(page.locator('[data-lab-track-link="source-failures"]')).toHaveAttribute("aria-current", "true");
    await expect(page.locator('[data-lab-track="source-failures"]')).toBeVisible();
    await page.waitForTimeout(2_000);
    expect(lab).toEqual([]);
  });

  test("the explore cards carry the updated Lab summary", async ({ page }) => {
    await page.goto("/");
    const card = page.locator('#explore a[href="/lab/"]');
    await expect(card).toContainText("The Source failures track lists the quarantine exercises and whether this demo's backend can run each one.");
    await expect(page.locator("main")).not.toContainText(/four controlled failures/i);
  });
});

test("the workbench screenshot is captioned from its own capture, not the site's pin", async ({ page }) => {
  await page.goto("/");
  const capturedOn = new Date(capture.capturedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  await expect(page.locator("[data-workbench-caption]")).toHaveText(`Recording · ${capturedOn} · streamotter@${capture.version} · local fixture project, not the hosted demo.`);
  const shot = page.locator("#workbench-preview img.workbench-shot");
  await expect(shot).toHaveAttribute("width", String(capture.images.preview.width));
  await expect(shot).toHaveAttribute("height", String(capture.images.preview.height));
});

test("install commands name the pinned release, not npm's latest tag", async ({ page }) => {
  const release = (JSON.parse(readFileSync(new URL("../node_modules/streamotter/package.json", import.meta.url), "utf8")) as { version: string }).version;
  await page.goto("/");
  await expect(page.locator("button[data-copy]")).toHaveAttribute("data-copy", `npm install streamotter@${release}`);
  await expect(page.locator("#start pre")).toContainText(`npm install streamotter@${release}`);
  await expect(page.locator("main")).not.toContainText(/npm install streamotter(?!@)/);
});
