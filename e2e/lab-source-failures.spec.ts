/**
 * The /lab/ Source failures track (Lab contract section 12; LC11-A01, A04, A36, A37).
 *
 * The capability summaries, incident projections, and operations below are rendering
 * fixtures: they test what the page shows and sends for a given answer, not that any
 * backend produces it. The real exercises are proven on `npm run dev:lab` with real
 * Kafka (deploy/test). Where no route is mocked, the dev stack's fixture API answers
 * 404, as `npm run dev` does.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Request } from "@playwright/test";
import type { LabIncidentSummary, LabIntentRequest, LabOperation } from "../apps/field-station/src/lab/contract.ts";

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
  await expect(page.locator("[data-lab-capability]")).toHaveText(/^This backend runs StreamOtter 0\.1\.0-rc\.3 on real Kafka with synthetic data \(Lab benches enabled\)\. 0 of 8 new exercises can run here\. This page was built for StreamOtter [^ ]+\.$/);
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
  // Jumping to the bench controls keeps the track.
  await page.locator('[data-lab-track="source-failures"] [data-lab-scenario="fouled-sensor"] a[href="#control-fouled-sensor"]').click();
  await expect(source).toHaveAttribute("aria-current", "true");
  await expect(page.locator('[data-lab-track="source-failures"]')).toBeVisible();
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
  // This backend serves the projection but takes no intents: the page names the next step and why it can't send it, and offers no button.
  await expect(panel.locator("[data-lab-incident-next]")).toHaveText("Make snapshot coverage ready (application action). This backend's StreamOtter release (0.1.0-rc.3) doesn't provide quarantine.");
  await expect(panel.locator("[data-lab-incident-act]")).toBeHidden();
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

test("a modified click on a track or scenario link opens it as a link would, leaving this page as it was", async ({ page }) => {
  await workingLab(page);
  await page.goto("/lab/");
  // Whether the browser then opens a tab is its own business (headless Chromium reports the new tab
  // as about:blank first, and under load sometimes not at all), so the test checks what the page
  // controls: it leaves the click's default action alone. The last listener records that, then
  // cancels the default so no tab opens.
  await page.evaluate(() => {
    const seen: boolean[] = (window as unknown as { leftToBrowser: boolean[] }).leftToBrowser = [];
    window.addEventListener("click", event => { seen.push(!event.defaultPrevented); event.preventDefault(); });
  });
  for (const link of [page.locator('[data-lab-track-link="source-failures"]'), page.locator('[data-lab-track="connections"] [data-lab-scenario="relay-cut"] [data-lab-scenario-link]')]) {
    expect(new URL(await link.evaluate((a: HTMLAnchorElement) => a.href)).pathname).toBe("/lab/");
    await link.click({ modifiers: ["ControlOrMeta"] });
    expect(new URL(page.url()).search + new URL(page.url()).hash).toBe("");
    await expect(page.locator('[data-lab-track-link="connections"]')).toHaveAttribute("aria-current", "true");
    await expect(page.locator("[data-lab-scenario][aria-current]")).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as unknown as { leftToBrowser: boolean[] }).leftToBrowser)).toEqual([true, true]);
});

// ---------------------------------------------------------------------------
// Running the exercises against a backend that offers them. Every answer below is a
// fixture (see the header): a scripted field station, not evidence of native behavior.
// ---------------------------------------------------------------------------

const ago = (seconds: number) => new Date(Date.now() - seconds * 1_000).toISOString();
const free = { available: true, reason: null };
/** The summary shape a 0.2.0-rc.1 backend answers with; `restricted` names scenarios this deployment doesn't offer (fixture). */
const rc1 = (restricted: Record<string, string> = {}) => ({
  now: now(), contract: "2026-10-04 (V1.1 W9b)", library: { name: "streamotter", version: "0.2.0-rc.1" }, backend: { mode: "real-kafka-synthetic", lab: "enabled" },
  scenarios: [...["fouled-sensor", "relay-cut", "slow-client", "relay-restart"].map(id => ({ id, ...free })),
    ...NEW.map(id => restricted[id] ? { id, available: false, reason: { code: "deployment-restricted", text: restricted[id] } } : { id, ...free })],
  features: { incidentProjection: free, intents: free }
});
/** A projection fixture: S03's first held state unless overridden. */
const projection = (rest: Partial<LabIncidentSummary> = {}): LabIncidentSummary => ({
  label: "Incident 1", scenario: "bad-projection", scenarioRevision: 1, reason: "LC-03's projection produced a gauge value of the wrong type.",
  openedAt: ago(20), updatedAt: now(), failure: { stage: "public payload validation", class: "payload-schema" }, policy: "quarantine-resync",
  evidence: "saved", source: "held", recovery: "coverage-not-ready", evaluation: null, reprocess: null, discarded: false, nextIntent: "scenario.prepare-coverage",
  detail: { topic: "lab-1.field.gauges", partition: 0, offset: "246", evidenceFingerprint: "sha256:fixture", handlerIdentity: "lontra-lab@fixture", sourceGeneration: "lab-1-fixture" },
  steps: [{ at: ago(19), origin: "application", text: "Scenario record published" }, { at: ago(18), origin: "library", text: "Quarantine write acknowledged" }], stepsGap: false, ...rest
});

/** What the scripted field station does with the next new intent. */
interface Step {
  /** Refuse it outright (no operation recorded). */
  refuse?: { status: number; code: string };
  /** Record it, then lose this many answers to it: the page must send the same request again. */
  lose?: number;
  /** The 202 answer's status, then one per lookup. Defaults to accepted, then succeeded. */
  statuses?: LabOperation["status"][];
  detail?: string;
  /** The projection once the operation's last status is served; leave it out to keep the current one. */
  incident?: LabIncidentSummary | null;
}

/** A working Lab whose field station follows `steps`: one per new `requestId`, in order. */
async function exercise(page: Page, steps: Step[], options: { capabilities?: unknown; incident?: LabIncidentSummary | null } = {}) {
  const intents: LabIntentRequest[] = [];
  const lookups: string[] = [];
  let incident = options.incident ?? null;
  const recorded = new Map<string, { operation: LabOperation; queue: LabOperation["status"][]; step: Step; lose: number }>();
  const settle = (entry: { operation: LabOperation; queue: LabOperation["status"][]; step: Step }) => {
    if (entry.queue.length === 0 && !["accepted", "running"].includes(entry.operation.status) && "incident" in entry.step) incident = entry.step.incident ?? null;
  };
  const withStatus = (operation: LabOperation, status: LabOperation["status"], step: Step): LabOperation =>
    ({ ...operation, status, updatedAt: now(), detail: ["refused", "failed", "unknown", "cancelled"].includes(status) ? step.detail ?? null : null });
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json: { enabled: true, now: now(), benches: [{ bench: 1, state: "leased" }], queueLength: 0, nextFreeAt: null } });
    if (path.endsWith("/capabilities")) return route.fulfill({ json: options.capabilities ?? rc1() });
    if (path.endsWith("/lease/token")) return route.fulfill({ json: token });
    if (path.endsWith("/trace")) return route.fulfill({ json: { items: [], next: "", gap: false } });
    if (path.endsWith("/incident")) return route.fulfill({ json: incident ? { status: "open", now: now(), incident } : { status: "none", now: now() } });
    if (path.endsWith("/actions")) {
      const body = route.request().postDataJSON() as LabIntentRequest;
      intents.push(body);
      let entry = recorded.get(body.requestId);
      if (!entry) {
        const step = steps.shift();
        if (!step) return route.fulfill({ status: 409, json: { error: "Not applicable.", code: "not-applicable" } });
        if (step.refuse) return route.fulfill({ status: step.refuse.status, json: { error: "Refused.", code: step.refuse.code } });
        const queue = [...(step.statuses ?? ["accepted", "succeeded"])];
        const operation = withStatus({ operationId: `lop_${String(recorded.size + 1).padStart(22, "A")}`, intent: body.intent, requestId: body.requestId, status: "accepted", acceptedAt: now(), updatedAt: now(), scenarioRevision: null, detail: null }, queue.shift()!, step);
        entry = { operation, queue, step, lose: step.lose ?? 0 };
        recorded.set(body.requestId, entry); settle(entry);
      }
      if (entry.lose > 0) { entry.lose--; return route.abort("failed"); }
      return route.fulfill({ status: 202, json: entry.operation });
    }
    const id = /\/operations\/([^/]+)$/.exec(path)?.[1];
    if (id) {
      lookups.push(id);
      const entry = [...recorded.values()].find(candidate => candidate.operation.operationId === id);
      if (!entry) return route.fulfill({ status: 404, json: { error: "Not found.", code: "invalid-request" } });
      if (entry.queue.length) { entry.operation = withStatus(entry.operation, entry.queue.shift()!, entry.step); settle(entry); }
      return route.fulfill({ json: entry.operation });
    }
    if (path.endsWith("/lease")) return route.fulfill({ json: ready() });
    return route.fulfill({ status: 404, json: { error: "Not found." } });
  });
  return { intents, lookups, setIncident(next: LabIncidentSummary | null) { incident = next; } };
}

/** Borrows the fixture bench and waits until the page holds it. */
async function borrow(page: Page, url = "/lab/#source-failures") {
  await page.goto(url);
  await page.locator("[data-lab-join]").click();
  await expect(page.locator("[data-lab-clock]")).toContainText("left on your lease");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const panel = (page: Page) => page.locator("[data-lab-incident]");
const act = (page: Page) => page.locator("[data-lab-incident-act]");
const operation = (page: Page) => page.locator("[data-lab-operation]");

test("an offered exercise starts only from its Start button, on a borrowed bench, with a fresh requestId (fixture)", async ({ page }) => {
  const lab = await exercise(page, [{ incident: projection() }]);
  await page.goto("/lab/#source-failures");
  const card = page.locator('[data-lab-scenario="bad-projection"]');
  await expect(page.locator("[data-lab-capability]")).toContainText("8 of 8 new exercises can run here.");
  await expect(card.locator("[data-lab-availability]")).toHaveAttribute("data-state", "available");
  await expect(card.locator("[data-lab-availability-text]")).toHaveText("Available on a leased bench. Borrow a bench below, then start it here.");
  const start = card.getByRole("button", { name: "Start this scenario" });
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await start.click({ force: true }); await page.waitForTimeout(300);
  expect(lab.intents).toEqual([]);
  await page.locator("[data-lab-join]").click();
  await expect(card.locator("[data-lab-availability-text]")).toHaveText("Available on your bench.");
  await expect(start).toHaveAttribute("aria-disabled", "false");
  await start.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => lab.intents.length).toBe(1);
  expect(Object.keys(lab.intents[0]!).sort()).toEqual(["intent", "requestId", "scenario"]);
  expect(lab.intents[0]).toMatchObject({ intent: "scenario.start", scenario: "bad-projection" });
  expect(lab.intents[0]!.requestId).toMatch(UUID);
  await expect(start).toBeFocused();
  await expect(operation(page)).toHaveText("Start: done. The bench started the scenario. What the gateway does with it appears in Current incident as it's observed.");
  await expect(panel(page).locator("[data-lab-incident-body]")).toBeVisible();
  await expect(start).toHaveAttribute("aria-disabled", "false");
});

test("LC11-S03: hold, make coverage ready, reassess, each bound to the revision shown; focus stays on the next step (fixture)", async ({ page }) => {
  const established = projection({ scenarioRevision: 2, recovery: "coverage-established", nextIntent: "incident.reassess" });
  const advanced = projection({ scenarioRevision: 3, source: "advanced", recovery: "view-resynchronized", nextIntent: null });
  const lab = await exercise(page, [
    { incident: projection() },
    { statuses: ["accepted", "running", "succeeded"], incident: established },
    { statuses: ["accepted", "running", "running", "succeeded"], incident: advanced }
  ]);
  await borrow(page);
  await page.locator('[data-lab-start="bad-projection"]').click();
  await expect(panel(page).locator("[data-lab-incident-recovery]")).toContainText("Saved, but not safe to continue: snapshot coverage not ready");
  await expect(act(page)).toHaveText("Make snapshot coverage ready (application action)");
  await expect(panel(page).locator("[data-lab-incident-next]")).toHaveText("Lontra Creek's application releases its authoritative-state update and coverage evidence. StreamOtter doesn't invent it.");
  await act(page).focus(); await page.keyboard.press("Enter");
  await expect(operation(page)).toHaveText("Make snapshot coverage ready: running on your bench.");
  await expect(act(page)).toHaveAttribute("aria-disabled", "true");
  await expect(operation(page)).toContainText("Make snapshot coverage ready: done. The application released its snapshot coverage. The source is still held");
  await expect(act(page)).toHaveText("Reassess continuation");
  await expect(act(page)).toBeFocused();
  await expect(act(page)).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Enter");
  await expect(operation(page)).toHaveText("Reassess: done. The gateway asked the recovery guard again. Current incident shows its decision.", { timeout: 10_000 });
  await expect(panel(page).locator("[data-lab-incident-source]")).toContainText("Source advanced past quarantined record");
  await expect(panel(page).locator("[data-lab-incident-recovery]")).toContainText("View resynchronized");
  // No intent left to offer: the button goes, and focus moves to the text that says so rather than to the page.
  await expect(act(page)).toBeHidden();
  await expect(panel(page).locator("[data-lab-incident-next]")).toHaveText("None right now.");
  await expect(panel(page).locator("[data-lab-incident-next]")).toBeFocused();
  expect(lab.intents.slice(1)).toEqual([
    { intent: "scenario.prepare-coverage", requestId: expect.stringMatching(UUID), expectedRevision: 1 },
    { intent: "incident.reassess", requestId: expect.stringMatching(UUID), expectedRevision: 2 }
  ]);
  expect(new Set(lab.intents.map(intent => intent.requestId)).size).toBe(3);
  await expect(page.locator("[data-lab-outcome]")).toHaveText("Incident 1: Evidence saved; Source advanced past quarantined record; View resynchronized.");
});

test("when the incident goes (status none) while its next step has focus, focus moves to the panel's heading, not the page (fixture)", async ({ page }) => {
  const lab = await exercise(page, [], { incident: projection() });
  await borrow(page);
  await expect(act(page)).toHaveText("Make snapshot coverage ready (application action)");
  await act(page).focus();
  lab.setIncident(null);
  await expect(panel(page).locator("[data-lab-incident-empty]")).toBeVisible({ timeout: 5_000 });
  await expect(panel(page).locator("[data-lab-incident-title]")).toBeFocused();
});

test("when the lease ends while the next step has focus, focus moves to the panel's heading, not the page (fixture)", async ({ page }) => {
  await exercise(page, [], { incident: projection() });
  await borrow(page);
  await expect(act(page)).toHaveText("Make snapshot coverage ready (application action)");
  await act(page).focus();
  // Registered last, so it answers the lease poll before the scripted station does.
  await page.route("**/api/lab/lease", route => route.fulfill({ json: { status: "ended", now: now(), reason: "expired", endedAt: now(), bench: 1 } }));
  await expect(page.locator("[data-lab-message]")).toContainText("Your lease ended", { timeout: 5_000 });
  await expect(panel(page).locator("[data-lab-incident-empty]")).toBeVisible();
  await expect(panel(page).locator("[data-lab-incident-title]")).toBeFocused();
});

test("LC11-S02: a garbled reading stays held; evaluation fails and nothing is offered after it (fixture)", async ({ page }) => {
  const garbled = (rest: Partial<LabIncidentSummary>) => projection({ scenario: "garbled-reading", reason: "LC-03 sent bytes that aren't JSON.", failure: { stage: "decode", class: "invalid-json" }, policy: "quarantine-hold", recovery: "none", ...rest });
  await exercise(page, [
    { incident: garbled({ nextIntent: "incident.retry-current" }) },
    { incident: garbled({ scenarioRevision: 2, nextIntent: "incident.evaluate" }) },
    { incident: garbled({ scenarioRevision: 3, nextIntent: null, evaluation: { result: "failed", at: now(), expiresAt: null, planToken: null, summary: "The saved bytes still don't decode as JSON, so they can't be reprocessed." } }) }
  ]);
  await borrow(page);
  await page.locator('[data-lab-start="garbled-reading"]').click();
  await expect(act(page)).toHaveText("Retry the held record");
  await act(page).click();
  await expect(operation(page)).toHaveText("Retry: done. The gateway ran the retry. Current incident shows how it turned out.");
  await expect(panel(page).locator("[data-lab-incident-source]")).toContainText("Source held at this record");
  await act(page).click();
  await expect(panel(page).locator("[data-lab-incident-evaluation]")).toContainText("Evaluation failed");
  await expect(panel(page).locator("[data-lab-incident-evaluation]")).toContainText("The saved bytes still don't decode as JSON");
  await expect(panel(page).locator("[data-lab-incident-next]")).toHaveText("None. The source stays held at this record; returning the bench discards this study, which doesn't fix the incident.");
  await expect(panel(page).locator("[data-lab-incident-reprocess]")).toBeHidden();
  await expect(operation(page)).toHaveText("Evaluate: done. The evaluation finished. Current incident shows its result; nothing was reprocessed.");
});

test("LC11-S04: approval opens a review, moves focus in and back, and sends exactly the reviewed plan (fixture)", async ({ page }) => {
  const passed = { result: "passed" as const, at: now(), expiresAt: new Date(Date.now() + 240_000).toISOString(), planToken: "pt_fixture_reviewed_0123", summary: "The saved record maps and validates with the corrected mapper." };
  const inspect = (rest: Partial<LabIncidentSummary>) => projection({ scenario: "inspect-old-reading", source: "advanced", recovery: "view-resynchronized", ...rest });
  const lab = await exercise(page, [
    { incident: inspect({ scenarioRevision: 4, nextIntent: "incident.evaluate" }) },
    { incident: inspect({ scenarioRevision: 5, evaluation: passed, nextIntent: "incident.approve-reprocess" }) },
    { statuses: ["accepted", "running", "succeeded"], incident: inspect({ scenarioRevision: 6, evaluation: { ...passed, planToken: null }, reprocess: "superseded", nextIntent: null }) }
  ]);
  await borrow(page);
  await page.locator('[data-lab-start="inspect-old-reading"]').click();
  await expect(act(page)).toHaveText("Evaluate the saved record");
  await act(page).click();
  await expect(panel(page).locator("[data-lab-incident-evaluation]")).toContainText("Evaluation passed");
  await expect(operation(page)).toContainText("Evaluate: done. The evaluation finished. Current incident shows its result; nothing was reprocessed.");
  await expect(act(page)).toHaveText("Review and approve reprocessing");
  const dialog = page.locator("[data-lab-approval]");
  await act(page).focus(); await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Review reprocessing" })).toBeFocused();
  await expect(dialog).toContainText("Incident 1, revision 5.");
  await expect(dialog).toContainText("The saved record maps and validates with the corrected mapper.");
  await expect(dialog).toContainText("This evaluation changed no source offset, sent no state, and published no business event.");
  await expect(dialog).toContainText("Superseded by a newer snapshot");
  await expect(dialog.locator("[data-lab-approval-expiry]")).toContainText(/^This approval is good until \d\d:\d\d:\d\d UTC, and no longer than your lease or this study\.$/);
  const results = await new AxeBuilder({ page }).include("[data-lab-approval]").analyze();
  expect(results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? "")).map(v => v.id)).toEqual([]);
  // Escape cancels: nothing sent, focus back on the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(act(page)).toBeFocused();
  expect(lab.intents.map(intent => intent.intent)).toEqual(["scenario.start", "incident.evaluate"]);
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(act(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Approve reprocessing" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => lab.intents.length).toBe(3);
  expect(lab.intents[2]).toEqual({ intent: "incident.approve-reprocess", requestId: expect.stringMatching(UUID), expectedRevision: 5, planToken: "pt_fixture_reviewed_0123" });
  await expect(operation(page)).toHaveText("Approved reprocessing: done. The gateway finished the approved reprocessing. Current incident shows the result.", { timeout: 10_000 });
  await expect(panel(page).locator("[data-lab-incident-reprocess]")).toContainText("Superseded by a newer snapshot");
  await expect(panel(page).locator("[data-lab-incident-reprocess]")).toContainText("A safe outcome");
});

test("an approval whose plan expired or whose incident moved on sends nothing (fixture)", async ({ page }) => {
  const plan = (expiresAt: string) => ({ result: "passed" as const, at: ago(60), expiresAt, planToken: "pt_fixture_reviewed_0123", summary: "The saved record maps." });
  const base = projection({ scenario: "inspect-old-reading", scenarioRevision: 5, source: "advanced", recovery: "view-resynchronized", nextIntent: "incident.approve-reprocess" });
  const lab = await exercise(page, [], { incident: { ...base, evaluation: plan(ago(1)) } });
  await borrow(page);
  await act(page).click();
  const dialog = page.locator("[data-lab-approval]");
  const approve = dialog.getByRole("button", { name: "Approve reprocessing" });
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.locator("[data-lab-approval-problem]")).toHaveText(/^This approval expired at \d\d:\d\d:\d\d UTC\. Cancel, then evaluate again for a new plan\.$/);
  await approve.click({ force: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // A fresh plan, then the incident moves on while the review is open.
  lab.setIncident({ ...base, evaluation: plan(new Date(Date.now() + 240_000).toISOString()) });
  await page.waitForTimeout(2_500);
  await act(page).click();
  await expect(approve).toHaveAttribute("aria-disabled", "false");
  lab.setIncident({ ...base, scenarioRevision: 6, evaluation: plan(new Date(Date.now() + 240_000).toISOString()) });
  await expect(dialog.locator("[data-lab-approval-problem]")).toHaveText("The incident changed while this review was open. Cancel, then review the current evaluation.", { timeout: 5_000 });
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await approve.click({ force: true });
  await page.waitForTimeout(300);
  expect(lab.intents).toEqual([]);
});

test("LC11-S05: conflicting readings stay held, and a refused reassessment says so (fixture)", async ({ page }) => {
  const conflict = projection({ scenario: "conflicting-readings", reason: "Two LC-03 readings claim the same revision with different values.", failure: { stage: "queue", class: "revision-conflict" }, policy: "pause", evidence: "not-required", recovery: "none", nextIntent: "incident.reassess" });
  await exercise(page, [{ incident: conflict }, { statuses: ["accepted", "refused"], detail: "An integrity failure can't be continued past; the source stays held until the study is reset." }]);
  await borrow(page);
  await page.locator('[data-lab-start="conflicting-readings"]').click();
  await expect(panel(page).locator("[data-lab-incident-evidence]")).toContainText("No evidence kept");
  await act(page).click();
  await expect(operation(page)).toHaveText("Reassess: refused. An integrity failure can't be continued past; the source stays held until the study is reset.");
  await expect(operation(page)).not.toContainText("done");
  await expect(panel(page).locator("[data-lab-incident-source]")).toContainText("Source held at this record");
  await expect(act(page)).toHaveAttribute("aria-disabled", "false");
});

test("LC11-S06: a blip that retries cleanly opens no incident; one that runs out holds, then retries to processed (fixture)", async ({ page }) => {
  const blip = (rest: Partial<LabIncidentSummary>) => projection({ scenario: "calibration-blip", reason: "LC-03's calibration lookup timed out on every retry.", failure: { stage: "map", class: "mapper-transient" }, policy: "pause", evidence: "not-required", recovery: "none", ...rest });
  await exercise(page, [
    { incident: null },
    { incident: blip({ nextIntent: "scenario.restore-calibration" }) },
    { incident: blip({ scenarioRevision: 2, nextIntent: "incident.retry-current" }) },
    { incident: blip({ scenarioRevision: 3, source: "processed", nextIntent: null }) }
  ]);
  await borrow(page);
  const start = page.locator('[data-lab-start="calibration-blip"]');
  await start.click();
  await expect(operation(page)).toContainText("Start: done.");
  await page.waitForTimeout(2_500);
  await expect(panel(page).locator("[data-lab-incident-body]")).toBeHidden();
  await expect(panel(page).locator("[data-lab-incident-reason]")).toHaveText("Nothing is held on your bench right now.");
  await start.click();
  await expect(act(page)).toHaveText("Restore calibration (application action)");
  await act(page).click();
  await expect(act(page)).toHaveText("Retry the held record");
  await act(page).click();
  await expect(panel(page).locator("[data-lab-incident-source]")).toContainText("Record processed on retry");
  await expect(panel(page).locator("[data-lab-incident-next]")).toHaveText("None right now.");
});

test("LC11-S07: the sixth bad reading holds, and the page says only a reset clears it (fixture)", async ({ page }) => {
  await exercise(page, [{ incident: projection({ scenario: "too-many-bad-readings", label: "Incident 6", reason: "Five automatic continuations already ran in this window, so the sixth incident holds. Returning the bench resets the study and clears it.", nextIntent: null, recovery: "none" }) }]);
  await borrow(page);
  await page.locator('[data-lab-start="too-many-bad-readings"]').click();
  await expect(panel(page).locator("[data-lab-incident-summary]")).toContainText("Returning the bench resets the study and clears it.");
  await expect(panel(page).locator("[data-lab-incident-source]")).toContainText("Source held at this record");
  await expect(act(page)).toBeHidden();
  await expect(panel(page).locator("[data-lab-incident-next]")).toHaveText("None. The source stays held at this record; returning the bench discards this study, which doesn't fix the incident.");
});

test("LC11-S08 and S09: restart recovery and unavailable evidence render as reported (fixture)", async ({ page }) => {
  await exercise(page, [
    { incident: projection({ scenario: "restart-recovery", scenarioRevision: 4, source: "advanced", recovery: "coverage-established", nextIntent: null }) },
    { incident: projection({ scenario: "unavailable-evidence", label: "Incident 2", scenarioRevision: 1, evidence: "unavailable", source: "advanced", recovery: "none", nextIntent: "incident.evaluate" }) },
    { incident: projection({ scenario: "unavailable-evidence", label: "Incident 2", scenarioRevision: 2, evidence: "unavailable", source: "advanced", recovery: "none", nextIntent: null, evaluation: { result: "failed", at: now(), expiresAt: null, planToken: null, summary: "The saved copy has expired from the quarantine topic, so it can't be reprocessed." } }) }
  ]);
  await borrow(page);
  await page.locator('[data-lab-start="restart-recovery"]').click();
  await expect(panel(page).locator("[data-lab-incident-recovery]")).toContainText("Snapshot coverage established");
  await page.locator('[data-lab-start="unavailable-evidence"]').click();
  await expect(panel(page).locator("[data-lab-incident-evidence]")).toContainText("Evidence unavailable");
  await act(page).click();
  await expect(panel(page).locator("[data-lab-incident-evaluation]")).toContainText("The saved copy has expired");
  await expect(panel(page).locator("[data-lab-incident-reprocess]")).toBeHidden();
});

test("a lost answer sends the same request again and follows the operation it recorded (fixture)", async ({ page }) => {
  const lab = await exercise(page, [{ lose: 1, statuses: ["accepted", "running", "succeeded"], incident: projection() }]);
  await borrow(page);
  await page.locator('[data-lab-start="bad-projection"]').click();
  await expect(operation(page)).toContainText("Start: done.", { timeout: 10_000 });
  expect(lab.intents).toHaveLength(2);
  expect(lab.intents[1]).toEqual(lab.intents[0]);
  expect(lab.lookups.length).toBeGreaterThanOrEqual(2);
});

test("refusals are shown, not retried: the action budget, a stale revision, and an unknown outcome (fixture)", async ({ page }) => {
  const lab = await exercise(page, [
    { refuse: { status: 429, code: "too-many-actions" } },
    { incident: projection() },
    { refuse: { status: 409, code: "not-applicable" } },
    { statuses: ["accepted", "unknown"], detail: "The bench didn't answer in time." }
  ]);
  await borrow(page);
  const start = page.locator('[data-lab-start="bad-projection"]');
  await start.click();
  await expect(operation(page)).toHaveText("Start: not sent. One action a second, please. Nothing was sent to your bench; try again.");
  await page.waitForTimeout(1_500);
  expect(lab.intents).toHaveLength(1);
  await expect(start).toHaveAttribute("aria-disabled", "false");
  await start.click();
  await expect(act(page)).toBeVisible();
  await act(page).click();
  await expect(operation(page)).toHaveText("Make snapshot coverage ready: not sent. The incident changed since this page showed it, or this step no longer applies. The panel shows its current state.");
  await act(page).click();
  await expect(operation(page)).toHaveText("Make snapshot coverage ready: outcome unknown. The bench didn't answer in time. The page doesn't send it again; Current incident shows what your bench reports.");
  const looked = lab.lookups.length;
  await page.waitForTimeout(2_500);
  expect(lab.lookups.length).toBe(looked);
  expect(lab.intents).toHaveLength(4);
  expect(new Set(lab.intents.map(intent => intent.requestId)).size).toBe(4);
});

test("a deployment-restricted exercise says why and its Start sends nothing, even on a borrowed bench (fixture)", async ({ page }) => {
  const restricted = "This deployment's Kafka authorization isn't verified for quarantine, so it doesn't run this exercise.";
  const lab = await exercise(page, [], { capabilities: rc1({ "garbled-reading": restricted, "too-many-bad-readings": "This exercise runs only on a local or CI stack." }) });
  await borrow(page);
  const card = page.locator('[data-lab-scenario="garbled-reading"]');
  await expect(card.locator("[data-lab-availability]")).toHaveAttribute("data-state", "unavailable");
  await expect(card.locator("[data-lab-availability-text]")).toHaveText(restricted);
  await expect(page.locator('[data-lab-scenario="too-many-bad-readings"] [data-lab-availability-text]')).toHaveText("This exercise runs only on a local or CI stack.");
  await expect(page.locator("[data-lab-capability]")).toContainText("6 of 8 new exercises can run here.");
  const start = card.getByRole("button", { name: "Start this scenario" });
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await start.click({ force: true }); await start.press("Enter"); await page.waitForTimeout(300);
  expect(lab.intents).toEqual([]);
});

test("returning the bench stops following its operation and clears the operation line (fixture)", async ({ page }) => {
  const lab = await exercise(page, [{ statuses: ["accepted", "running", "running", "running", "running", "running", "running", "running"] }]);
  await page.route("**/api/lab/lease/return", route => route.fulfill({ json: { status: "ended", now: now(), reason: "returned", endedAt: now(), bench: 1 } }));
  await borrow(page);
  await page.locator('[data-lab-start="bad-projection"]').click();
  await expect(operation(page)).toHaveText("Start: running on your bench.");
  await page.locator("[data-lab-return]").click();
  await expect(operation(page)).toHaveText("");
  const looked = lab.lookups.length;
  await page.waitForTimeout(2_000);
  expect(lab.lookups.length).toBe(looked);
  await expect(page.locator('[data-lab-scenario="bad-projection"] [data-lab-availability-text]')).toHaveText("Available on a leased bench. Borrow a bench below, then start it here.");
});

for (const scheme of ["light", "dark"] as const) {
  test(`a running exercise has no serious axe violations in ${scheme} (fixture)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await exercise(page, [{ incident: projection({ evidence: "not-required", source: "processed" }) }]);
    await borrow(page);
    await page.locator('[data-lab-start="bad-projection"]').click();
    await expect(act(page)).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""));
    expect(serious, serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`).join("\n")).toEqual([]);
  });
}
