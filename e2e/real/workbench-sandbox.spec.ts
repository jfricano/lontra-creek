/**
 * /workbench/ against the real sandbox on a running stack (`npm run dev:lab`): the
 * published workbench mounted on a slot that runs the pinned release, in each engine of
 * playwright.real.config.ts. Nothing here is stubbed or simulated: every answer comes
 * from the field station and the sandbox service. Skips unless SANDBOX_REAL_ORIGIN is set.
 *
 * Optional: SANDBOX_REAL_STOP_COMMAND and SANDBOX_REAL_START_COMMAND (shell commands that
 * stop and start the sandbox service, for example `docker compose ... stop sandbox`) run
 * the outage spec; the expiry spec runs only when the stack's lease ends within 90 s.
 */
import { execSync } from "node:child_process";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { validateWorkbenchHostConfig } from "streamotter/contracts";
import type { SandboxLease, SandboxStatus } from "../../apps/field-station/src/sandbox/contract.ts";
import { PUBLISHED_SEAM } from "../../apps/site/src/scripts/workbench-seam.ts";

test.skip(!process.env["SANDBOX_REAL_ORIGIN"], "Set SANDBOX_REAL_ORIGIN (for example https://localhost:8443 under npm run dev:lab) to run the real-stack sandbox specs.");
test.describe.configure({ mode: "serial" });

const seam = PUBLISHED_SEAM!;

/** Console messages and securitypolicyviolation events, so a spec can assert the page's policy held. */
async function watchPolicy(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", event => console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`));
  });
  page.on("console", message => { if (/CSP violation|Content.Security.Policy|Refused to|integrity/i.test(message.text())) violations.push(message.text()); });
  page.on("pageerror", error => violations.push(error.message));
  return violations;
}

/** Every allocation request the page sends; only Start may send one. */
function allocations(page: Page): { count: () => number } {
  let count = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/sandbox/session") count++; });
  return { count: () => count };
}

const panel = (page: Page) => ({
  root: page.locator("[data-sandbox]"), headline: page.locator("[data-sandbox-headline]"), start: page.locator("[data-sandbox-start]"),
  claim: page.locator("[data-sandbox-claim]"), end: page.locator("[data-sandbox-return]"), reset: page.locator("[data-sandbox-reset]"),
  repro: page.locator("[data-sandbox-repro]"), mountNote: page.locator("[data-sandbox-mount-note]"), app: page.locator("#app")
});

/** Start from an idle page, claim, and wait for the published workbench to open. */
async function openWorkbench(page: Page): Promise<void> {
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(ui.root).toHaveAttribute("data-phase", /^(?:idle|ended)$/, { timeout: 15_000 });
  await ui.start.click();
  await expect(ui.root).toHaveAttribute("data-phase", "active", { timeout: 60_000 });
  await expect(ui.app).toHaveAttribute("data-streamotter-workbench", "", { timeout: 15_000 });
  await expect(ui.app.getByRole("heading", { name: "StreamOtter Workbench" })).toBeVisible({ timeout: 15_000 });
}

const tab = (page: Page, name: string) => page.locator("#app").getByRole("tab", { name });

test.afterEach(async ({ page }) => {
  // Leave nothing held for the next spec: a client address may hold only two places.
  await page.request.post("/api/sandbox/session/return").catch(() => undefined);
});

test("Start claims a slot and mounts the published workbench, labeled from the service, under the page's policy", async ({ page }) => {
  const violations = await watchPolicy(page);
  const allocated = allocations(page);
  const status = await (await page.request.get("/api/sandbox/status")).json() as SandboxStatus;
  expect(status.availability, JSON.stringify(status)).toBe("available");
  expect(status.runtime).toEqual({ packages: { streamotter: expect.any(String), workbench: seam.version }, mode: "synthetic-fixture", contractVersion: String(seam.hostContract) });
  await openWorkbench(page);
  const ui = panel(page);
  await expect(page.locator("[data-sandbox-mode]")).toHaveText("Synthetic fixture");
  await expect(page.locator("[data-sandbox-packages]")).toContainText(`@streamotter/workbench@${seam.version}`);
  await expect(page.locator("[data-sandbox-contract]")).toHaveText(`Host contract ${seam.hostContract}`);
  await expect(ui.mountNote).toBeHidden();
  await expect(ui.app.getByRole("note", { name: "Environment" })).toContainText("Synthetic fixture");
  await expect(ui.app).not.toContainText("Version mismatch");
  const boot = JSON.parse(await page.locator("script#streamotter-workbench-host").textContent() ?? "null") as unknown;
  expect(validateWorkbenchHostConfig(boot).ok).toBe(true);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(policy).toMatch(/script-src 'self'; style-src 'self'/);
  expect(allocated.count()).toBe(1);
  expect(violations).toEqual([]);
});

test("Connect, Define, Preview, Inspect, and Export work against the slot", async ({ page }) => {
  const violations = await watchPolicy(page);
  await openWorkbench(page);
  const app = page.locator("#app");

  await expect(app.getByRole("heading", { name: "Connect", level: 2 })).toBeVisible();

  // Define: a candidate that changes a server-owned field is refused by the sandbox's allowlist.
  await tab(page, "Define").click();
  const candidate = app.getByRole("textbox", { name: "Candidate configuration JSON" });
  const config = JSON.parse(await candidate.inputValue()) as { gateway: { port: number } };
  config.gateway.port += 1;
  await candidate.fill(JSON.stringify(config, null, 2));
  await app.getByRole("button", { name: "Validate candidate" }).click();
  await expect(app.getByRole("alert")).toContainText("FIELD_NOT_EDITABLE");
  await app.getByRole("button", { name: "Reset to active" }).click();

  // Preview: both channels reach live as the slot's own principals.
  await tab(page, "Preview").click();
  const preview = async (principal: string, channel: string, params: Record<string, string>): Promise<void> => {
    const principals = app.getByRole("combobox", { name: "Development principal" });
    await principals.selectOption(await principals.locator("option", { hasText: principal }).first().getAttribute("value") ?? "");
    const channels = app.getByRole("combobox", { name: "Channel" });
    await channels.selectOption(await channels.locator("option", { hasText: new RegExp(`^${channel} v`) }).first().getAttribute("value") ?? "");
    for (const [name, value] of Object.entries(params)) {
      const field = app.locator("label", { hasText: name }).locator("input, select");
      if (await field.evaluate(element => element.tagName === "SELECT")) await field.selectOption(value); else await field.fill(value);
    }
    await app.getByRole("button", { name: "Start preview" }).click();
    await expect(app.getByText("live", { exact: true })).toBeVisible({ timeout: 30_000 });
  };
  await preview("creek-volunteer", "station", { stationId: "LC-03" });
  await app.getByRole("button", { name: "Stop preview" }).click();
  await preview("developer", "jobProgress", { jobId: "job_1" });
  await app.getByRole("button", { name: /^Advance ".+" by 1$/ }).click();
  await expect(app.getByText("Advanced one fixture record.")).toBeVisible();
  await app.getByRole("button", { name: "Stop preview" }).click();

  // Inspect: the advance left payload-free trace metadata for this study.
  await tab(page, "Inspect").click();
  await expect(app.getByRole("heading", { name: "Inspect", level: 2 })).toBeVisible();
  await expect(app).toContainText("jobProgress", { timeout: 15_000 });
  await expect(app.getByRole("alert")).toHaveCount(0);

  // Export: the canonical candidate downloads; the gateway is unchanged.
  await tab(page, "Export").click();
  await app.getByRole("button", { name: "Export candidate" }).click();
  const download = page.waitForEvent("download");
  await app.getByRole("link", { name: /^Download streamotter\.json$/ }).click();
  expect((await download).suggestedFilename()).toBe("streamotter.json");

  // And the session's own reproduction bundle.
  const bundle = page.waitForEvent("download");
  await panel(page).repro.click();
  expect((await bundle).suggestedFilename()).toBe("lontra-creek-sandbox-repro.json");
  expect(violations).toEqual([]);
});

test("the keyboard reaches the session controls and the workbench, and axe finds nothing serious", async ({ page }) => {
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(ui.start).toBeEnabled({ timeout: 15_000 });
  await ui.start.focus(); await page.keyboard.press("Enter");
  await expect(ui.app.getByRole("heading", { name: "StreamOtter Workbench" })).toBeVisible({ timeout: 60_000 });
  await tab(page, "Define").focus(); await page.keyboard.press("Enter");
  await expect(ui.app.getByRole("heading", { name: "Define", level: 2 })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""));
  expect(serious, serious.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`).join("\n")).toEqual([]);
  await ui.end.focus(); await page.keyboard.press("Enter");
  await expect(ui.headline).toHaveText("You returned your slot. Its study was discarded.");
  await expect(ui.app).toHaveCount(0);
});

test("a reset reopens the workbench on a fresh study after one reload, without allocating again", async ({ page }) => {
  const allocated = allocations(page);
  await openWorkbench(page);
  const ui = panel(page);
  const reloaded = page.waitForEvent("load");
  await ui.reset.click();
  await reloaded;
  await expect(ui.root).toHaveAttribute("data-phase", "active", { timeout: 60_000 });
  await expect(ui.app.getByRole("heading", { name: "StreamOtter Workbench" })).toBeVisible({ timeout: 15_000 });
  expect(allocated.count()).toBe(1);
});

test("reloading and going back revalidate and never allocate", async ({ page }) => {
  const allocated = allocations(page);
  const ui = panel(page);
  await page.goto("/workbench/");
  await expect(ui.root).toHaveAttribute("data-phase", /^(?:idle|ended)$/, { timeout: 15_000 });
  await page.reload();
  await expect(ui.root).toHaveAttribute("data-phase", /^(?:idle|ended)$/, { timeout: 15_000 });
  await page.goto("/docs/");
  await page.goBack();
  await expect(ui.root).toHaveAttribute("data-phase", /^(?:idle|ended)$/, { timeout: 15_000 });
  await expect(ui.app).toHaveCount(0);
  expect(allocated.count()).toBe(0);
});

test("with every slot taken, Start queues with a position, and leaving the line returns the place", async ({ browser, page }) => {
  // A client address holds at most two places: one slot held from another context plus this page's place in line.
  // So the pool can be filled from one machine only when a single slot is free.
  const before = await (await page.request.get("/api/sandbox/status")).json() as SandboxStatus;
  test.skip(before.slots.filter(slot => slot.state === "ready").length !== 1, "Exercising the line from one address needs exactly one free slot; run the stack with SANDBOX_SLOTS=1.");
  const holder = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const held = await (await holder.request.post("/api/sandbox/session")).json() as SandboxLease;
    expect(held.status).toBe("ready");
    const ui = panel(page);
    await page.goto("/workbench/");
    await expect(page.locator("[data-sandbox-pool]")).toContainText("Starting a session puts you in line.");
    await ui.start.click();
    await expect(ui.root).toHaveAttribute("data-phase", "queued");
    await expect(ui.headline).toHaveText(/^You are number 1 of 1 in line for a sandbox slot\.$/);
    await ui.end.click();
    await expect(ui.headline).toHaveText("You left the line.");
  } finally {
    await holder.request.post("/api/sandbox/session/return").catch(() => undefined);
    await holder.close();
  }
});

test("a lease that runs out ends the session honestly and offers a new start", async ({ page }) => {
  await openWorkbench(page);
  const lease = await (await page.request.get("/api/sandbox/session")).json() as SandboxLease;
  const remaining = lease.status === "active" ? Date.parse(lease.expiresAt) - Date.parse(lease.now) : Infinity;
  test.skip(remaining > 90_000, "The stack's lease lasts longer than 90 s; configure a short lease to exercise expiry.");
  const ui = panel(page);
  await expect(ui.headline).toHaveText("Your session reached its time limit. Its study was discarded.", { timeout: remaining + 20_000 });
  await expect(ui.app).toHaveCount(0);
  await expect(ui.start).toBeEnabled();
});

test("stopping the sandbox service ends the session and says so; nothing is simulated", async ({ page }) => {
  const stop = process.env["SANDBOX_REAL_STOP_COMMAND"], start = process.env["SANDBOX_REAL_START_COMMAND"];
  test.skip(!stop || !start, "Set SANDBOX_REAL_STOP_COMMAND and SANDBOX_REAL_START_COMMAND to exercise a sandbox outage.");
  await openWorkbench(page);
  const ui = panel(page);
  try {
    execSync(stop!, { stdio: "inherit" });
    await expect(ui.root).toHaveAttribute("data-phase", /^(?:ended|unavailable)$/, { timeout: 60_000 });
    await expect(ui.app).toHaveCount(0);
    await expect(ui.start).toBeDisabled();
    await page.locator("[data-sandbox-retry]").click();
    await expect(ui.headline).toHaveText(/The sandbox service is not answering\.|Every sandbox slot is out of service\./);
  } finally {
    execSync(start!, { stdio: "inherit" });
  }
});
