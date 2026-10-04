/**
 * /workbench/: the sandbox panel's states against stubbed /api/sandbox/* answers
 * (sandbox contract §4), the design-fixture seed, and the labeled fallback screenshots.
 * Every stubbed answer here is a test fixture; versions use "0.0.0-design-fixture" so
 * a label that leaked the site's own build would show. The mounted workbench is the
 * real published app.js, served by the dev server from the pinned release, talking to
 * stubbed /api/sandbox/wb/v1/* answers.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { validateWorkbenchHostConfig, type WorkbenchDiscovery } from "streamotter/contracts";
import type { SandboxConnection, SandboxLease, SandboxRuntime, SandboxStatus } from "../apps/field-station/src/sandbox/contract.ts";
import capture from "../apps/site/public/recordings/workbench/capture.json" with { type: "json" };
import { PUBLISHED_SEAM } from "../apps/site/src/scripts/workbench-seam.ts";

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();
const runtime: SandboxRuntime = { packages: { streamotter: "0.0.0-design-fixture", workbench: "0.0.0-design-fixture" }, mode: "synthetic-fixture", contractVersion: null };
const available = (over: Partial<SandboxStatus> = {}): SandboxStatus => ({ now: iso(), availability: "available", runtime, slots: [{ slot: 1, state: "ready" }, { slot: 2, state: "leased" }, { slot: 3, state: "ready" }], queueLength: 0, nextFreeAt: null, ...over });
const unavailable = (reason: NonNullable<SandboxStatus["reason"]>): SandboxStatus => ({ now: iso(), availability: "unavailable", reason, runtime: null, slots: [], queueLength: 0, nextFreeAt: null });
/** A service that runs exactly the pinned workbench with host contract 1. */
const pinned: SandboxRuntime = { ...runtime, packages: { streamotter: "0.0.0-design-fixture", workbench: PUBLISHED_SEAM!.version }, contractVersion: "1" };
const lease = (status: "ready" | "active" | "resetting", studyId = "study-a", leaseRuntime = runtime): SandboxLease =>
  ({ status, now: iso(), leaseId: "lease-fixture", studyId, slot: 2, grantedAt: iso(), expiresAt: iso(600_000), claimBy: status === "ready" ? iso(30_000) : null, runtime: leaseRuntime });
const ended = (reason: Extract<SandboxLease, { status: "ended" }>["reason"]): SandboxLease => ({ status: "ended", now: iso(), reason, endedAt: iso() });
const connection = (studyId = "study-a"): SandboxConnection => ({ leaseId: "lease-fixture", studyId, expiresAt: iso(600_000), gatewayOrigin: "http://127.0.0.1:1", gatewayPath: "/sandbox/2/socket.io" });

type Answer = { status?: number; json: unknown; headers?: Record<string, string> };
type Handler = (request: { method: string; path: string }) => Answer | undefined;

/** Stubs /api/sandbox/* and records every request the page makes there. */
async function stubSandbox(page: Page, handler: Handler): Promise<string[]> {
  const seen: string[] = [];
  await page.route("**/api/sandbox/**", async (route: Route) => {
    const request = route.request(); const path = new URL(request.url()).pathname.replace(/^\/api\/sandbox\//, "");
    seen.push(`${request.method()} ${path}`);
    const answer = handler({ method: request.method(), path });
    if (!answer) return route.fulfill({ status: 404, json: { error: "Not found." } });
    return route.fulfill({ status: answer.status ?? 200, json: answer.json, ...(answer.headers ? { headers: answer.headers } : {}) });
  });
  return seen;
}
const allocations = (seen: string[]): number => seen.filter(entry => entry === "POST session").length;
const panel = (page: Page) => ({
  root: page.locator("[data-sandbox]"), headline: page.locator("[data-sandbox-headline]"), detail: page.locator("[data-sandbox-detail]"), note: page.locator("[data-sandbox-note]"),
  start: page.locator("[data-sandbox-start]"), claim: page.locator("[data-sandbox-claim]"), end: page.locator("[data-sandbox-return]"), reset: page.locator("[data-sandbox-reset]"), repro: page.locator("[data-sandbox-repro]"),
  mode: page.locator("[data-sandbox-mode]"), packages: page.locator("[data-sandbox-packages]"), mountNote: page.locator("[data-sandbox-mount-note]")
});

test("today's production answer, seam-unavailable, is first-class: nothing to start, nothing simulated, no version invented", async ({ page }) => {
  const seen = await stubSandbox(page, ({ path }) => path === "status" ? { json: unavailable("seam-unavailable") } : undefined);
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(ui.root).toHaveAttribute("data-phase", "unavailable");
  await expect(ui.headline).toHaveText("The workbench sandbox is not available yet.");
  await expect(ui.detail).toContainText("The StreamOtter the sandbox service runs does not");
  await expect(ui.start).toBeDisabled();
  await expect(ui.mode).toHaveText("Not reported");
  await expect(ui.packages).toHaveText("Not reported");
  await expect(page.locator("[data-sandbox-runtime-note]")).toBeVisible();
  await expect(page.locator("#streamotter-workbench-host")).toHaveCount(0);
  await expect(page.locator("[data-sandbox-mount]")).toBeHidden();
  // Status only: an unavailable sandbox is not even asked for a session.
  expect(seen).toEqual(["GET status"]);
});

for (const [reason, headline] of [
  ["disabled", "The workbench sandbox is not enabled on this deployment."],
  ["service-unavailable", "The sandbox service is not answering."],
  ["all-slots-unavailable", "Every sandbox slot is out of service."]
] as const) {
  test(`${reason} says so in plain words and cannot be started`, async ({ page }) => {
    await stubSandbox(page, ({ path }) => path === "status" ? { json: unavailable(reason) } : undefined);
    await page.goto("/workbench/");
    await expect(panel(page).headline).toHaveText(headline);
    await expect(panel(page).start).toBeDisabled();
  });
}

test("the dev field station, which serves no sandbox routes, is reported as not enabled", async ({ page }) => {
  await page.goto("/workbench/");
  await expect(panel(page).headline).toHaveText("The workbench sandbox is not enabled on this deployment.");
  await expect(panel(page).detail).toHaveText("This field station does not serve the sandbox API, so no session can start here.");
  await expect(panel(page).start).toBeDisabled();
});

test("a network failure is unknown, not available, and Check again asks again", async ({ page }) => {
  let fail = true;
  await page.route("**/api/sandbox/**", route => fail ? route.abort("connectionrefused") : route.fulfill({ json: unavailable("seam-unavailable") }));
  await page.goto("/workbench/");
  await expect(panel(page).headline).toHaveText("The sandbox's status is unknown.");
  await expect(panel(page).detail).toContainText("The field station did not answer");
  await expect(panel(page).start).toBeDisabled();
  fail = false;
  await page.locator("[data-sandbox-retry]").click();
  await expect(panel(page).headline).toHaveText("The workbench sandbox is not available yet.");
});

test("opening, reloading, and going back never allocate", async ({ page }) => {
  const seen = await stubSandbox(page, ({ method, path }) => path === "status" ? { json: available() } : method === "GET" && path === "session" ? { status: 401, json: { error: "No session.", code: "no-session" } } : undefined);
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(ui.root).toHaveAttribute("data-phase", "idle");
  await expect(ui.start).toBeEnabled();
  await page.reload();
  await expect(ui.root).toHaveAttribute("data-phase", "idle");
  await page.goto("/docs/");
  await page.goBack();
  await expect(ui.root).toHaveAttribute("data-phase", "idle");
  expect(allocations(seen)).toBe(0);
  expect(seen.filter(entry => entry.startsWith("POST"))).toEqual([]);
});

test("a back-forward cache restore revalidates before showing anything active, and returns rather than re-allocates", async ({ page }) => {
  let state: SandboxLease = { status: "none", now: iso() };
  const seen = await stubSandbox(page, ({ method, path }) => {
    if (path === "status") return { json: available() };
    if (method === "POST" && path === "session") { state = lease("ready"); return { json: state }; }
    if (path === "session/claim") { state = lease("active"); return { json: connection() }; }
    if (path === "session/return") { state = ended("returned"); return { json: state }; }
    if (path === "session") return { json: state };
    return undefined;
  });
  const ui = panel(page);
  await page.goto("/workbench/");
  await ui.start.click();
  await expect(ui.root).toHaveAttribute("data-phase", "active");
  // Hold the revalidation's session answer so the in-between state can be seen.
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sandbox/session", async route => { if (route.request().method() === "GET") await held; return route.fallback(); });
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
  await expect(ui.root).toHaveAttribute("data-phase", "checking");
  await expect(ui.end).toBeHidden();
  await expect(ui.mode).toHaveText("Not reported");
  await expect.poll(() => seen.includes("POST session/return")).toBe(true);
  release();
  await expect(ui.root).toHaveAttribute("data-phase", "ended");
  await expect(ui.headline).toHaveText("You returned your slot. Its study was discarded.");
  expect(allocations(seen)).toBe(1);
});

test("a full pool queues with position, and leaving the line returns the place", async ({ page }) => {
  const seen = await stubSandbox(page, ({ method, path }) => {
    // One clock reading per answer: two Date.now() calls a millisecond apart would round "4 min" up to 5.
    const at = Date.now(), stamp = (offsetMs = 0): string => new Date(at + offsetMs).toISOString();
    if (path === "status") return { json: available({ now: stamp(), slots: [1, 2, 3].map(slot => ({ slot: slot as 1 | 2 | 3, state: "leased" as const })), queueLength: 2, nextFreeAt: stamp(240_000) }) };
    if (method === "GET" && path === "session") return { status: 401, json: { error: "No session.", code: "no-session" } };
    if (path === "session") return { json: { status: "queued", now: stamp(), position: 3, queueLength: 3, joinedAt: stamp(), nextFreeAt: stamp(240_000), sessionExpiresAt: stamp(3_600_000) } };
    if (path === "session/return") return { json: ended("left") };
    return undefined;
  });
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(page.locator("[data-sandbox-pool]")).toContainText("All 3 sandbox slots are in use. Starting a session puts you in line.");
  await ui.start.click();
  await expect(ui.headline).toHaveText("You are number 3 of 3 in line for a sandbox slot.");
  await expect(ui.detail).toContainText("within 4 min at the latest");
  await expect(ui.end).toHaveText("Leave the line");
  await ui.end.click();
  await expect(ui.headline).toHaveText("You left the line.");
  await expect(ui.start).toBeEnabled();
  expect(seen).toContain("POST session/return");
});

test("an explicit start claims at once; labels come from the service; the mount point stays inert while the service reports no host contract", async ({ page }) => {
  let state: SandboxLease = lease("ready");
  const seen = await stubSandbox(page, ({ method, path }) => {
    if (path === "status") return { json: available() };
    if (method === "GET" && path === "session") return seen.includes("POST session") ? { json: state } : { json: { status: "none", now: iso() } };
    if (path === "session") return { json: state };
    if (path === "session/claim") { state = lease("active"); return { json: connection() }; }
    if (path === "session/return") { state = ended("returned"); return { json: state }; }
    return undefined;
  });
  const appRequests: string[] = [];
  page.on("request", request => { if (/\/app\.js|workbench-host\.css/.test(request.url())) appRequests.push(request.url()); });
  const ui = panel(page);
  await page.goto("/workbench/");
  await ui.start.click();
  await expect(ui.root).toHaveAttribute("data-phase", "active");
  await expect(ui.headline).toHaveText("Your sandbox session is running on slot 2.");
  await expect(page.locator("[data-sandbox-clock]")).toContainText("left in this session");
  await expect(ui.mode).toHaveText("Synthetic fixture");
  await expect(ui.packages).toHaveText("streamotter@0.0.0-design-fixture · @streamotter/workbench@0.0.0-design-fixture");
  await expect(page.locator("[data-sandbox-contract]")).toHaveText("No host contract reported");
  await expect(ui.mountNote).toContainText("The sandbox service reports no host contract; this page mounts host contract 1.");
  await expect(page.locator("#streamotter-workbench-host")).toHaveCount(0);
  await expect(page.locator("[data-sandbox-mount]")).toBeHidden();
  expect(appRequests).toEqual([]);
  expect(seen.filter(entry => entry === "POST session/claim")).toHaveLength(1);
  await ui.end.click();
  await expect(ui.headline).toHaveText("You returned your slot. Its study was discarded.");
});

test("a ready slot found on load shows its claim window and waits for the visitor", async ({ page }) => {
  const seen = await stubSandbox(page, ({ path }) => path === "status" ? { json: available() } : path === "session" ? { json: lease("ready") } : path === "session/claim" ? { json: connection() } : undefined);
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(ui.root).toHaveAttribute("data-phase", "ready");
  await expect(ui.detail).toHaveText("Claim it within the time shown below, or it goes to the next visitor.");
  await expect(page.locator("[data-sandbox-clock]")).toContainText(/^0:[23]\d left to claim it · /);
  await expect(ui.claim).toBeVisible();
  await expect(ui.claim).toBeEnabled();
  expect(seen.filter(entry => entry.startsWith("POST"))).toEqual([]);
});

test("expiry ends the session on the next heartbeat and offers a new start, never an automatic one", async ({ page }) => {
  let state: SandboxLease = lease("active");
  const seen = await stubSandbox(page, ({ path }) => path === "status" ? { json: available() } : path === "session" ? { json: state } : undefined);
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(ui.root).toHaveAttribute("data-phase", "active");
  state = ended("expired");
  await expect(ui.headline).toHaveText("Your session reached its time limit. Its study was discarded.", { timeout: 10_000 });
  await expect(ui.start).toBeEnabled();
  expect(seen.filter(entry => entry.startsWith("POST"))).toEqual([]);
});

for (const [code, status, text] of [
  ["too-many-places", 429, "already holds two places across the Failure Lab and the workbench sandbox"],
  ["queue-full", 503, "The line for a sandbox slot is full."]
] as const) {
  test(`a ${code} refusal is shown in plain words and starts nothing`, async ({ page }) => {
    await stubSandbox(page, ({ method, path }) => path === "status" ? { json: available() } : method === "GET" && path === "session" ? { status: 401, json: { error: "No session.", code: "no-session" } } : path === "session" ? { status, json: { error: "refused", code } } : undefined);
    const ui = panel(page);
    await page.goto("/workbench/");
    await ui.start.click();
    await expect(ui.note).toContainText(text);
    await expect(ui.root).toHaveAttribute("data-phase", "idle");
    await expect(ui.start).toBeEnabled();
  });
}

test("reset discards the study, waits, and claims the new study; the reproduction bundle downloads", async ({ page }) => {
  let state: SandboxLease = lease("active", "study-a");
  const seen = await stubSandbox(page, ({ path }) => {
    if (path === "status") return { json: available() };
    if (path === "session") return { json: state };
    if (path === "session/claim") return { json: connection(state.status === "active" ? state.studyId : "study-a") };
    if (path === "session/reset") { state = lease("resetting", "study-b"); return { status: 202, json: state }; }
    if (path === "session/repro") return { json: { filename: "lontra-creek-sandbox-repro.json", content: "{\"format\":\"lontra-creek.sandbox-repro\"}" } };
    return undefined;
  });
  const ui = panel(page);
  await page.goto("/workbench/");
  await ui.claim.click();
  await expect(ui.claim).toBeHidden();
  const download = page.waitForEvent("download");
  await ui.repro.click();
  expect((await download).suggestedFilename()).toBe("lontra-creek-sandbox-repro.json");
  await ui.reset.click();
  await expect(ui.headline).toHaveText("Starting a fresh study on slot 2…");
  state = lease("active", "study-b");
  await expect.poll(() => seen.filter(entry => entry === "POST session/claim").length, { timeout: 10_000 }).toBe(2);
  await expect(ui.root).toHaveAttribute("data-phase", "active");
  await expect(ui.claim).toBeHidden();
});

test("the seed is labeled a design fixture and the screenshots carry their own capture provenance", async ({ page }) => {
  await stubSandbox(page, ({ path }) => path === "status" ? { json: unavailable("seam-unavailable") } : undefined);
  await page.goto("/workbench/");
  await expect(page.locator("[data-design-fixture]")).toContainText("Design fixture.");
  await expect(page.getByRole("heading", { name: "The creek's station channel" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The init example's jobProgress channel" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "In your app" })).toBeVisible();
  await expect(page.locator("table")).toContainText("jobId: \"job_1\"");
  const provenance = page.locator("[data-recording-provenance]");
  await expect(provenance).toContainText("Fallback: screenshots, not a sandbox session.");
  await expect(provenance).toContainText(`streamotter@${capture.version}`);
  await expect(provenance).toContainText(`Node.js ${capture.node.replace(/^v/, "")}`);
  for (const caption of await page.locator("figcaption").allTextContents()) expect(caption).toContain(`streamotter@${capture.version}`);
});

for (const scheme of ["light", "dark"] as const) {
  test(`unavailable and active sandbox states have no serious or critical axe violations in ${scheme}`, async ({ page }) => {
    let status: SandboxStatus = unavailable("seam-unavailable");
    await stubSandbox(page, ({ path }) => path === "status" ? { json: status } : path === "session" ? { json: lease("active") } : path === "session/claim" ? { json: connection() } : undefined);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    const check = async (): Promise<void> => {
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""));
      expect(serious, serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`).join("\n")).toEqual([]);
    };
    await page.goto("/workbench/");
    await expect(page.locator("[data-sandbox]")).toHaveAttribute("data-phase", "unavailable");
    await check();
    status = available();
    await page.reload();
    await expect(page.locator("[data-sandbox]")).toHaveAttribute("data-phase", "active");
    await check();
  });
}

test("while Start is in flight, Check again waits, so the field station's answer is shown and kept alive", async ({ page }) => {
  let release!: () => void; const answered = new Promise<void>(resolve => { release = resolve; });
  const queued: SandboxLease = { status: "queued", now: iso(), position: 1, queueLength: 1, joinedAt: iso(), nextFreeAt: null, sessionExpiresAt: iso(3_600_000) };
  const seen = await stubSandbox(page, ({ method, path }) => {
    if (path === "status") return { json: available() };
    if (method === "GET" && path === "session") return seen.includes("POST session") ? { json: { ...queued, now: iso() } } : { status: 401, json: { error: "No session.", code: "no-session" } };
    if (path === "session") return { json: queued };
    return undefined;
  });
  await page.route("**/api/sandbox/session", async route => { if (route.request().method() === "POST") await answered; return route.fallback(); });
  const ui = panel(page); const retry = page.locator("[data-sandbox-retry]");
  await page.goto("/workbench/");
  await expect(ui.start).toBeEnabled();
  await ui.start.click();
  await expect(retry).toBeDisabled();
  release();
  await expect(ui.root).toHaveAttribute("data-phase", "queued");
  await expect(retry).toBeEnabled();
  const before = seen.filter(entry => entry === "GET session").length;
  await expect.poll(() => seen.filter(entry => entry === "GET session").length, { timeout: 8_000 }).toBeGreaterThan(before);
});

test("leaving the page while Start is in flight still returns the place", async ({ page }) => {
  const seen = await stubSandbox(page, ({ method, path }) => {
    if (path === "status") return { json: available() };
    if (method === "GET" && path === "session") return { status: 401, json: { error: "No session.", code: "no-session" } };
    if (path === "session/return") return { json: ended("left") };
    if (path === "session") return { json: { status: "queued", now: iso(), position: 1, queueLength: 1, joinedAt: iso(), nextFreeAt: null, sessionExpiresAt: iso(3_600_000) } };
    return undefined;
  });
  let release!: () => void; const answered = new Promise<void>(resolve => { release = resolve; });
  let sent = false;
  await page.route("**/api/sandbox/session", async route => { if (route.request().method() === "POST") { sent = true; await answered; } return route.fallback(); });
  const ui = panel(page);
  await page.goto("/workbench/");
  await ui.start.click();
  await expect.poll(() => sent).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect.poll(() => seen.includes("POST session/return")).toBe(true);
  release();
});

for (const phase of ["idle", "ready"] as const) {
  test(`the polite status region holds still in the ${phase} phase: the panel's once-a-second render rewrites nothing in it`, async ({ page }) => {
    await stubSandbox(page, ({ path }) => path === "status" ? { json: available() } : path === "session" ? (phase === "ready" ? { json: lease("ready") } : { status: 401, json: { error: "No session.", code: "no-session" } }) : undefined);
    await page.goto("/workbench/");
    await expect(panel(page).root).toHaveAttribute("data-phase", phase);
    const mutations = await page.evaluate(() => new Promise<number>(resolve => {
      let count = 0;
      const observer = new MutationObserver(records => { count += records.length; });
      observer.observe(document.querySelector(".sandbox-state")!, { subtree: true, childList: true, characterData: true });
      setTimeout(() => { observer.disconnect(); resolve(count); }, 3_000);
    }));
    expect(mutations).toBe(0);
    if (phase === "ready") await expect(page.locator("[data-sandbox-clock]")).toContainText("left to claim it");
  });
}

test("keyboard focus follows a lifecycle action instead of falling to the page", async ({ page }) => {
  let state: SandboxLease = { status: "none", now: iso() };
  await stubSandbox(page, ({ method, path }) => {
    if (path === "status") return { json: available() };
    if (method === "POST" && path === "session") { state = { status: "queued", now: iso(), position: 1, queueLength: 1, joinedAt: iso(), nextFreeAt: null, sessionExpiresAt: iso(3_600_000) }; return { json: state }; }
    if (path === "session/return") { state = ended(state.status === "queued" ? "left" : "returned"); return { json: state }; }
    if (path === "session/repro") return { json: { filename: "lontra-creek-sandbox-repro.json", content: "{}" } };
    if (path === "session") return { json: state };
    return undefined;
  });
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(ui.start).toBeEnabled();
  await ui.start.focus(); await page.keyboard.press("Enter");
  // Start is gone once queued: focus moves to the new state's headline.
  await expect(ui.root).toHaveAttribute("data-phase", "queued");
  await expect(ui.headline).toBeFocused();
  await expect(ui.end).toBeEnabled(); await ui.end.focus(); await page.keyboard.press("Enter");
  // Leaving the line brings Start back: focus goes to it.
  await expect(ui.headline).toHaveText("You left the line.");
  await expect(ui.start).toBeFocused();
  state = lease("active");
  await page.locator("[data-sandbox-retry]").click();
  await expect(ui.root).toHaveAttribute("data-phase", "active");
  // A button still there after its action keeps focus.
  await expect(ui.repro).toBeEnabled(); await ui.repro.focus(); await page.keyboard.press("Enter");
  await expect(ui.note).toContainText("Saved lontra-creek-sandbox-repro.json");
  await expect(ui.repro).toBeFocused();
  await expect(ui.end).toBeEnabled(); await ui.end.focus(); await page.keyboard.press("Enter");
  await expect(ui.headline).toHaveText("You returned your slot. Its study was discarded.");
  await expect(ui.start).toBeFocused();
});

test("coming back to the page checks in at once, without starting a second heartbeat", async ({ page }) => {
  const seen = await stubSandbox(page, ({ path }) => path === "status" ? { json: available() } : path === "session" ? { json: lease("active") } : path === "session/claim" ? { json: connection() } : undefined);
  const beats = () => seen.filter(entry => entry === "GET session").length;
  await page.goto("/workbench/");
  await expect(panel(page).root).toHaveAttribute("data-phase", "active");
  const before = beats(); // the next timed heartbeat is 5 s away
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(beats, { timeout: 1_500 }).toBe(before + 1);
  await page.waitForTimeout(5_500);
  expect(beats()).toBe(before + 2);
});

// The published workbench, mounted. Discovery and the shell's reads are stubbed WHC-1 answers
// (test fixtures); app.js and workbench-host.css are the pinned release's own files.
const SHELL: WorkbenchDiscovery = { hostContract: 1, operations: ["workbench", "capabilities", "health", "sources", "channels", "config", "config.validate", "config.export", "traces", "dev.principals", "preview-sessions"], limits: { maxRequestBytes: 65_536 } };
const FIXTURE_CONFIG = { projectId: "lontra-creek-sandbox-design-fixture" };
/** The gateway on the page's own origin, as under `npm run dev:lab`, so a production build's policy ('self') allows it too. */
const SAME_ORIGIN = `http://127.0.0.1:${process.env["LONTRA_SITE_PORT"] ?? 4321}`;
function hostApi(path: string): Answer | undefined {
  const op = path.replace(/^wb\/v1\//, "");
  const ok = (data: unknown): Answer => ({ json: { ok: true, data } });
  switch (op) {
    case "workbench": return ok(SHELL);
    case "config": return ok({ config: FIXTURE_CONFIG, fingerprint: "0".repeat(64) });
    case "channels": case "sources": case "dev/principals": return ok({ items: [] });
    case "health": return ok({ ready: true, sources: [] });
    case "traces": return ok({ items: [], nextCursor: null });
    default: return undefined;
  }
}
/** An active lease on the pinned runtime, claimed by Start; `state` and the WHC-1 answers can be changed by the test. */
async function stubMounted(page: Page, options: { hostApi?: (path: string) => Answer | undefined } = {}) {
  const world = { state: { status: "none", now: iso() } as SandboxLease, headers: [] as { path: string; headers: Record<string, string> }[] };
  const seen = await stubSandbox(page, ({ method, path }) => {
    if (path.startsWith("wb/v1/")) return (options.hostApi ?? hostApi)(path);
    if (path === "status") return { json: { ...available(), runtime: pinned } };
    if (method === "POST" && path === "session") { world.state = lease("ready", "study-a", pinned); return { json: world.state }; }
    if (path === "session/claim") { const study = world.state.status === "ready" || world.state.status === "active" ? world.state.studyId : "study-a"; world.state = lease("active", study, pinned); return { json: { ...connection(study), gatewayOrigin: SAME_ORIGIN } }; }
    if (path === "session/reset") { world.state = lease("resetting", "study-b", pinned); return { status: 202, json: world.state }; }
    if (path === "session/return") { world.state = ended("returned"); return { json: world.state }; }
    if (path === "session") return { json: world.state };
    return undefined;
  });
  page.on("request", request => { if (request.url().includes("/api/sandbox/")) world.headers.push({ path: new URL(request.url()).pathname, headers: request.headers() }); });
  return { world, seen };
}

test("with an active lease on the pinned release and host contract 1, the real published workbench mounts in session mode, scoped to its mount", async ({ page }) => {
  const { world, seen } = await stubMounted(page);
  const violations: string[] = [];
  page.on("console", message => { if (/Content.Security.Policy|Refused to|integrity/i.test(message.text())) violations.push(message.text()); });
  page.on("pageerror", error => violations.push(error.message));
  const ui = panel(page);
  await page.goto("/workbench/");
  const h1 = page.locator(".reference > header h1");
  const before = await page.evaluate(() => ({ accent: getComputedStyle(document.documentElement).getPropertyValue("--accent"), h1: getComputedStyle(document.querySelector(".reference > header h1")!).fontSize, body: getComputedStyle(document.body).fontFamily }));
  await ui.start.click();
  await expect(ui.root).toHaveAttribute("data-phase", "active");
  const mount = page.locator("#app");
  await expect(mount).toHaveAttribute("data-streamotter-workbench", "");
  await expect(mount.getByRole("heading", { name: "StreamOtter Workbench" })).toBeVisible();
  await expect(mount.getByRole("note", { name: "Environment" })).toContainText("Synthetic fixture");
  await expect(mount).not.toContainText("Version mismatch");
  // The boot block is what WHC-1 accepts: same origin here, so no apiOrigin.
  const boot = JSON.parse(await page.locator("script#streamotter-workbench-host").textContent() ?? "null") as unknown;
  const checked = validateWorkbenchHostConfig(boot);
  expect(checked.ok, JSON.stringify(checked)).toBe(true);
  expect(boot).toMatchObject({ hostContract: 1, apiBase: "/api/sandbox/wb/v1", auth: { mode: "session" }, gateway: { origin: SAME_ORIGIN, path: "/sandbox/2/socket.io" }, environment: { kind: "sandbox", packageVersion: PUBLISHED_SEAM!.version } });
  expect(boot).not.toHaveProperty("apiOrigin");
  // Pinned files with their integrity; the scoped host stylesheet, never the native one.
  await expect(page.locator("[data-sandbox-mount] link[rel=stylesheet]")).toHaveAttribute("href", PUBLISHED_SEAM!.hostStyle);
  await expect(page.locator("[data-sandbox-mount] link[rel=stylesheet]")).toHaveAttribute("integrity", PUBLISHED_SEAM!.integrity.hostStyle);
  await expect(page.locator("[data-sandbox-mount] script[type=module]")).toHaveAttribute("src", PUBLISHED_SEAM!.script);
  await expect(page.locator("[data-sandbox-mount] script[type=module]")).toHaveAttribute("integrity", PUBLISHED_SEAM!.integrity.script);
  await expect(page.locator(`a[href="${PUBLISHED_SEAM!.licenses}"]`)).toBeVisible();
  // The site keeps its own heading and tokens (R12).
  await expect(h1).toHaveText("Meet the workbench");
  const after = await page.evaluate(() => ({ accent: getComputedStyle(document.documentElement).getPropertyValue("--accent"), h1: getComputedStyle(document.querySelector(".reference > header h1")!).fontSize, body: getComputedStyle(document.body).fontFamily }));
  expect(after).toEqual(before);
  // The browser holds only the session cookie: no Authorization anywhere, and the WHC-1 header on every host API request.
  const hostRequests = world.headers.filter(entry => entry.path.startsWith("/api/sandbox/wb/v1/"));
  expect(hostRequests.map(entry => entry.path)).toEqual(expect.arrayContaining(["/api/sandbox/wb/v1/workbench", "/api/sandbox/wb/v1/config", "/api/sandbox/wb/v1/health"]));
  for (const entry of world.headers) expect(entry.headers["authorization"], entry.path).toBeUndefined();
  for (const entry of hostRequests) expect(entry.headers["x-streamotter-workbench"], entry.path).toBe("1");
  expect(allocations(seen)).toBe(1);
  // In a production build the page's meta policy is enforced; nothing the workbench does breaks it.
  expect(violations).toEqual([]);
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""));
  expect(serious, serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`).join("\n")).toEqual([]);
});

test("a service on another workbench version is not mounted, and says why", async ({ page }) => {
  const other: SandboxRuntime = { ...pinned, packages: { ...pinned.packages, workbench: "0.0.0-design-fixture" } };
  await stubSandbox(page, ({ path }) => path === "status" ? { json: available({ runtime: other }) } : path === "session" ? { json: lease("active", "study-a", other) } : path === "session/claim" ? { json: connection() } : path.startsWith("wb/v1/") ? hostApi(path) : undefined);
  const scripts: string[] = [];
  page.on("request", request => { if (request.url().includes(PUBLISHED_SEAM!.script)) scripts.push(request.url()); });
  const ui = panel(page);
  await page.goto("/workbench/");
  await ui.claim.click();
  await expect(ui.mountNote).toHaveText(`The sandbox runs @streamotter/workbench@0.0.0-design-fixture; this page pins ${PUBLISHED_SEAM!.version}.`);
  await expect(page.locator("#app")).toHaveCount(0);
  expect(scripts).toEqual([]);
});

test("when the field station ends the browser session, the mounted workbench shows Session ended", async ({ page }) => {
  let expired = false;
  await stubMounted(page, { hostApi: path => expired ? { status: 401, json: { ok: false, error: { code: "UNAUTHENTICATED", message: "No session.", retryable: false, requestId: "" } } } : hostApi(path) });
  const ui = panel(page);
  await page.goto("/workbench/");
  await ui.start.click();
  const mount = page.locator("#app");
  await expect(mount.getByRole("heading", { name: "StreamOtter Workbench" })).toBeVisible();
  expired = true;
  await mount.getByRole("tab", { name: "Inspect" }).click();
  await expect(mount.getByRole("heading", { name: "Session ended" })).toBeVisible();
  await expect(mount.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("a reset reloads the page once and reopens the same lease on the new study, without a second allocation or a return", async ({ page }) => {
  const { world, seen } = await stubMounted(page);
  const ui = panel(page);
  await page.goto("/workbench/");
  await ui.start.click();
  await expect(page.locator("#app")).toHaveAttribute("data-streamotter-workbench", "");
  await page.evaluate(() => { (window as unknown as { beforeReset: boolean }).beforeReset = true; });
  const reloaded = page.waitForEvent("load");
  await ui.reset.click();
  await expect(ui.headline).toHaveText("Starting a fresh study on slot 2…");
  world.state = lease("active", "study-b", pinned);
  await reloaded;
  expect(await page.evaluate(() => (window as unknown as { beforeReset?: boolean }).beforeReset)).toBeUndefined();
  await expect(ui.root).toHaveAttribute("data-phase", "active");
  await expect(page.locator("#app")).toHaveAttribute("data-streamotter-workbench", "");
  await expect(page.locator("#app").getByRole("heading", { name: "StreamOtter Workbench" })).toBeVisible();
  await expect(ui.claim).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem("lontra.workbench.reopen"))).toBeNull();
  expect(allocations(seen)).toBe(1);
  expect(seen).not.toContain("POST session/return");
  // Start's claim, the claim after the reset, and the reopening claim after the reload.
  expect(seen.filter(entry => entry === "POST session/claim")).toHaveLength(3);
});

test("a reload while the workbench is open does not reopen it by itself", async ({ page }) => {
  const { seen } = await stubMounted(page);
  const ui = panel(page);
  await page.goto("/workbench/");
  await ui.start.click();
  await expect(page.locator("#app")).toHaveAttribute("data-streamotter-workbench", "");
  await page.reload();
  // Leaving returns the slot, as always; whether or not the return lands first, nothing reopens, claims, or allocates by itself.
  await expect(ui.root).toHaveAttribute("data-phase", /^(?:active|ended)$/);
  await page.waitForTimeout(1_000);
  await expect(page.locator("#app")).toHaveCount(0);
  expect(seen.filter(entry => entry === "POST session/claim")).toHaveLength(1);
  expect(allocations(seen)).toBe(1);
});
