/**
 * The home page's live panel (apps/site/src/components/LiveCreek.astro), a real
 * StreamOtter subscription over the field station's fixture replay.
 *
 * Selectors are the `data-*` hooks fe-walk's F.3 refactor promises to keep:
 * [data-live-creek], [data-card], [data-state], [data-drop], [data-restore],
 * [data-connection], [data-log], [data-note]. Other lanes (the walkthrough in
 * particular) can reuse these same hooks and this same drop/restore flow.
 */
import { expect, test } from "@playwright/test";

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

  test("dropping the connection makes the cards stale, and restoring returns them to live with a revisions note", async ({ page }) => {
    await page.goto("/");
    await expectAllCards(page, "live", 30_000);

    // [data-connection] is on both the root panel and the small text readout inside
    // it (LiveCreek.astro), so a bare `[data-connection]` locator matches two
    // elements; scope to the root, which is the one hook other lanes can rely on
    // being unique.
    const root = page.locator("[data-live-creek]");

    // Check for "stale" promptly: leaving the connection cut for long enough lets
    // the SDK's own automatic recovery give up and move a subscription to
    // "resync-required" instead, which is a different, later state.
    await page.locator("[data-drop]").click();
    await expect(root).not.toHaveAttribute("data-connection", "connected", { timeout: 10_000 });
    await expectAllCards(page, "stale", 8_000);

    await page.locator("[data-restore]").click();
    await expectAllCards(page, "live", 25_000);
    await expect(page.locator("[data-note]")).toContainText("weren't replayed", { timeout: 25_000 });
  });
});
