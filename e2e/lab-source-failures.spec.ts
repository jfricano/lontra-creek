/**
 * The /lab/ Source failures track (Lab contract section 12; LC11-A01, A04, A36, A37).
 *
 * The capability summaries and the incident projection below are rendering fixtures:
 * they test what the page shows for a given answer, not that any backend produces it.
 * Where no route is mocked, the dev stack's fixture API answers 404, as `npm run dev` does.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";

const now = () => new Date().toISOString();
const NEW = ["garbled-reading", "bad-projection", "inspect-old-reading", "conflicting-readings", "calibration-blip", "too-many-bad-readings", "restart-recovery", "unavailable-evidence"];
const NEEDS: Record<string, string> = {
  "garbled-reading": "quarantine", "bad-projection": "quarantine or a recovery guard", "inspect-old-reading": "incident evaluation or controlled reprocessing",
  "conflicting-readings": "quarantine or a recovery guard", "calibration-blip": "bounded retry for transient mapper errors", "too-many-bad-readings": "quarantine or an automatic-continuation limit",
  "restart-recovery": "a durable failure journal or a recovery guard", "unavailable-evidence": "quarantine or a durable failure journal"
};
const lacks = (needs: string) => ({ available: false, reason: { code: "library-lacks-capability", text: `This backend's StreamOtter release (0.1.0-rc.3) doesn't provide ${needs}.` } });
/** The shape the field station answers with on 0.1.0-rc.3. */
const rc3 = (incidentProjection: unknown = lacks("quarantine")) => ({
  now: now(), contract: "2026-10-03 (V1.1 W4)", library: { name: "streamotter", version: "0.1.0-rc.3" }, backend: { mode: "real-kafka-synthetic", lab: "enabled" },
  scenarios: [...["fouled-sensor", "relay-cut", "slow-client", "relay-restart"].map(id => ({ id, available: true, reason: null })), ...NEW.map(id => ({ id, ...lacks(NEEDS[id]!) }))],
  features: { incidentProjection, intents: lacks("quarantine") }
});
const state = { gateway: "running", source: { status: "healthy" }, relay: "up", calibration: "present", satellite: "idle", receiptTimeoutMs: 5000 };
const ready = () => ({ status: "ready", now: now(), leaseId: "fixture-lease", bench: 1, grantedAt: now(), expiresAt: new Date(Date.now() + 300_000).toISOString(), claimBy: new Date(Date.now() + 30_000).toISOString(), nextActionAt: now(), benchState: state });
const token = { token: "lab1_fixture", expiresAt: new Date(Date.now() + 300_000).toISOString(), bench: 1, gatewayOrigin: "http://127.0.0.1:9", gatewayPath: "/lab/1/socket.io" };

/** A working Lab with one ready bench: anything that borrows, starts, or approves would be visible in `requests`. */
async function workingLab(page: Page, capabilities: unknown = rc3(), incident?: unknown): Promise<Request[]> {
  const requests: Request[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/lab/")) requests.push(request); });
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json: { enabled: true, now: now(), benches: [{ bench: 1, state: "ready" }], queueLength: 0, nextFreeAt: null } });
    if (path.endsWith("/capabilities")) return route.fulfill({ json: capabilities });
    if (path.endsWith("/lease/token")) return route.fulfill({ json: token });
    if (path.endsWith("/trace")) return route.fulfill({ json: { items: [], next: "", gap: false } });
    if (path.endsWith("/incident") && incident !== undefined) return route.fulfill({ json: incident });
    if (path.endsWith("/lease")) return route.fulfill({ json: ready() });
    return route.fulfill({ status: 404, json: { error: "Not found." } });
  });
  return requests;
}
const posts = (requests: Request[]) => requests.filter(request => request.method() !== "GET").map(request => new URL(request.url()).pathname);

for (const [link, track, scenario] of [
  ["/lab/#source-failures", "source-failures", null],
  ["/lab/?scenario=bad-projection", "source-failures", "bad-projection"],
  ["/lab/?scenario=fouled-sensor#connections", "connections", "fouled-sensor"],
  ["/lab/?scenario=relay-cut", "connections", "relay-cut"]
] as const) {
  test(`${link} selects explanation only: no lease, injection, or approval`, async ({ page }) => {
    const requests = await workingLab(page);
    await page.goto(link);
    await expect(page.locator(`[data-lab-track-link="${track}"]`)).toHaveAttribute("aria-current", "true");
    await expect(page.locator(`[data-lab-track="${track}"]`)).toBeVisible();
    await expect(page.locator("[data-lab-track]:not([hidden])")).toHaveCount(1);
    if (scenario) {
      const card = page.locator(`[data-lab-track="${track}"] [data-lab-scenario="${scenario}"]`);
      await expect(card).toHaveAttribute("aria-current", "true");
      await expect(card.locator("[data-lab-selected-mark]")).toBeVisible();
    }
    await expect(page.locator("[data-lab-join]")).toBeEnabled();
    await page.waitForTimeout(2_500); // two poll cycles
    expect(posts(requests)).toEqual([]);
    expect(requests.map(request => new URL(request.url()).pathname)).not.toContain("/api/lab/incident");
    // Navigation keeps the eight routes reachable from the header.
    for (const href of ["/", "/field-station/", "/lab/", "/playground/", "/workbench/", "/when-it-breaks/", "/docs/", "/releases/"]) await expect(page.locator(`header a[href="${href}"]`).first()).toHaveCount(1);
  });
}

test("on 0.1.0-rc.3 every new exercise is unavailable with the capability it lacks, and Start sends nothing", async ({ page }) => {
  const requests = await workingLab(page);
  await page.goto("/lab/#source-failures");
  await expect(page.locator("[data-lab-capability]")).toHaveText("This backend runs StreamOtter 0.1.0-rc.3 on real Kafka with synthetic data (Lab benches enabled). 0 of 8 new exercises can run here.");
  for (const id of NEW) {
    const card = page.locator(`[data-lab-track="source-failures"] [data-lab-scenario="${id}"]`);
    await expect(card.locator("[data-lab-availability]")).toHaveAttribute("data-state", "unavailable");
    await expect(card.locator("[data-lab-availability-text]")).toHaveText(`This backend's StreamOtter release (0.1.0-rc.3) doesn't provide ${NEEDS[id]}.`);
    await expect(card.getByRole("button", { name: "Start this scenario" })).toHaveAttribute("aria-disabled", "true");
  }
  await expect(page.locator('[data-lab-scenario="fouled-sensor"] [data-lab-availability]').first()).toHaveAttribute("data-state", "existing");
  await page.locator('[data-lab-start="garbled-reading"]').click({ force: true });
  await page.locator('[data-lab-start="garbled-reading"]').press("Enter");
  await page.waitForTimeout(500);
  expect(posts(requests)).toEqual([]);
  await expect(page.locator("[data-lab-incident-reason]")).toHaveText("This backend's StreamOtter release (0.1.0-rc.3) doesn't provide quarantine. This panel stays empty rather than show sample data.");
  await expect(page.locator("[data-lab-incident-body]")).toBeHidden();
});

test("a backend without the capability route (the fixture demo) leaves every new exercise unsupported", async ({ page }) => {
  await page.goto("/lab/?scenario=garbled-reading");
  await expect(page.locator("[data-lab-capability]")).toContainText("doesn't report Lab capabilities");
  for (const id of NEW) await expect(page.locator(`[data-lab-scenario="${id}"] [data-lab-availability-text]`)).toHaveText("This backend does not support this scenario.");
  await expect(page.locator("[data-lab-unavailable]")).toBeVisible();
});

test("an older backend's summary that doesn't list a scenario shows it unsupported", async ({ page }) => {
  const older = rc3(); older.scenarios = older.scenarios.filter(scenario => scenario.id !== "calibration-blip");
  await workingLab(page, older);
  await page.goto("/lab/#source-failures");
  await expect(page.locator('[data-lab-scenario="calibration-blip"] [data-lab-availability-text]')).toHaveText("This backend does not support this scenario.");
});

test("the chooser and scenario links work from the keyboard without moving focus or reloading", async ({ page }) => {
  const requests = await workingLab(page);
  await page.goto("/lab/");
  await page.evaluate(() => { (window as unknown as { marker: boolean }).marker = true; });
  await expect(page.locator('[data-lab-track-link="connections"]')).toHaveAttribute("aria-current", "true");
  const source = page.locator('[data-lab-track-link="source-failures"]');
  await page.locator('[data-lab-track-link="connections"]').focus();
  await page.keyboard.press("Tab");
  await expect(source).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(source).toHaveAttribute("aria-current", "true");
  await expect(source).toBeFocused();
  await expect(page.locator('[data-lab-track="connections"]')).toBeHidden();
  expect(new URL(page.url()).hash).toBe("#source-failures");
  const link = page.locator('[data-lab-track="source-failures"] [data-lab-scenario="conflicting-readings"] [data-lab-scenario-link]');
  await link.focus(); await page.keyboard.press("Enter");
  await expect(page.locator('[data-lab-track="source-failures"] [data-lab-scenario="conflicting-readings"]')).toHaveAttribute("aria-current", "true");
  await expect(link).toBeFocused();
  expect(new URL(page.url()).searchParams.get("scenario")).toBe("conflicting-readings");
  expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(true);
  await page.goBack().catch(() => undefined); // replaceState: Back leaves /lab/ rather than stepping through selections
  expect(posts(requests)).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the Source failures track and the incident panel have no serious axe violations in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await workingLab(page);
    await page.goto("/lab/?scenario=bad-projection");
    await expect(page.locator("[data-lab-capability]")).toContainText("0 of 8");
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""));
    expect(serious, serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`).join("\n")).toEqual([]);
  });
}

test("on a narrow screen the page reads reading, then incident, then steps", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workingLab(page);
  await page.goto("/lab/");
  const top = async (selector: string) => (await page.locator(selector).boundingBox())!.y;
  const reading = await top('[data-lab] .content-card:has([data-lab-view-state])');
  const incident = await top("[data-lab-incident]");
  const steps = await top('[data-lab] .content-card:has([data-lab-feed])');
  expect(reading).toBeLessThan(incident); expect(incident).toBeLessThan(steps);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("without JavaScript, both tracks and every story explain themselves", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/lab/?scenario=bad-projection#source-failures");
  await expect(page.locator("[data-lab-track]")).toHaveCount(2);
  for (const track of ["connections", "source-failures"]) await expect(page.locator(`[data-lab-track="${track}"]`)).toBeVisible();
  await expect(page.locator('[data-lab-track="source-failures"] [data-lab-scenario]')).toHaveCount(9);
  await expect(page.locator('[data-lab-scenario="bad-projection"] [data-lab-availability-text]')).toHaveText("Unavailable until this backend reports support for it.");
  await expect(page.locator("noscript")).toHaveCount(1);
  await context.close();
});

test("a served incident projection renders with precise labels, hidden coordinates, and stable focus (rendering fixture)", async ({ page }) => {
  const incident = {
    status: "open", now: now(), incident: {
      label: "Incident 1", scenario: "bad-projection", scenarioRevision: 3, reason: "LC-03's projection produced a gauge value of the wrong type.",
      openedAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: now(), failure: { stage: "public payload validation", class: "invalid public payload" }, policy: "quarantine-and-hold",
      evidence: "saved", source: "held", recovery: "coverage-not-ready", evaluation: null, reprocess: null, discarded: false, nextIntent: "scenario.prepare-coverage",
      detail: { topic: "lab-1.field.gauges", partition: 0, offset: "246", evidenceFingerprint: "sha256:fixture", handlerIdentity: null, sourceGeneration: null },
      steps: [{ at: new Date(Date.now() - 50_000).toISOString(), origin: "library", text: "Quarantine write acknowledged" }], stepsGap: true
    }
  };
  const requests = await workingLab(page, rc3({ available: true, reason: null }), incident);
  await page.goto("/lab/");
  await page.locator("[data-lab-join]").click();
  const panel = page.locator("[data-lab-incident]");
  await expect(panel.locator("[data-lab-incident-body]")).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator("[data-lab-incident-empty]")).toBeHidden();
  await expect(panel.locator("[data-lab-incident-evidence]")).toContainText("Evidence saved");
  await expect(panel.locator("[data-lab-incident-evidence]")).toContainText("isn't repaired");
  await expect(panel.locator("[data-lab-incident-source]")).toContainText("Source held at this record");
  await expect(panel.locator("[data-lab-incident-recovery]")).toContainText("snapshot coverage not ready");
  await expect(panel.locator("[data-lab-incident-evaluation]")).toBeHidden();
  await expect(panel.locator("[data-lab-incident-next]")).toHaveText("Make snapshot coverage ready (application action). This version of the page can't send it.");
  await expect(panel.locator("[data-lab-incident-steps]")).toContainText("Library observation · Quarantine write acknowledged");
  await expect(panel.locator("[data-lab-incident-steps]")).toContainText("Some earlier steps are missing here");
  await expect(panel.locator("[data-lab-incident-detail]")).not.toHaveAttribute("open", "");
  await expect(panel.getByText("lab-1.field.gauges · partition 0 · offset 246")).toBeHidden();
  await expect(page.locator("[data-lab-outcome]")).toHaveText("Incident 1: Evidence saved; Source held at this record; Saved, but not safe to continue: snapshot coverage not ready.");
  const summary = panel.locator("[data-lab-incident-detail] summary");
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(panel.getByText("lab-1.field.gauges · partition 0 · offset 246")).toBeVisible();
  await page.waitForTimeout(4_500); // two incident polls
  await expect(summary).toBeFocused();
  await expect(panel.locator("[data-lab-incident-detail]")).toHaveAttribute("open", "");
  const results = await new AxeBuilder({ page }).include("[data-lab-incident]").analyze();
  expect(results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? "")).map(v => v.id)).toEqual([]);
  // The page reads the projection; it never sends an intent.
  expect(posts(requests).filter(path => path !== "/api/lab/lease" && path !== "/api/lab/lease/token")).toEqual([]);
});
