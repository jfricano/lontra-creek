import { expect, test } from "@playwright/test";

const now = () => new Date().toISOString();
const state = { gateway: "running", source: { status: "healthy" }, relay: "up", calibration: "present", satellite: "idle", receiptTimeoutMs: 5000 };

test("disabled Lab is honest and offers local instructions", async ({ page }) => {
  await page.route("**/api/lab/status", route => route.fulfill({ json: { enabled:false, now:now(), benches:[], queueLength:0, nextFreeAt:null } }));
  await page.goto("/lab/");
  await expect(page.locator("[data-lab-unavailable]")).toBeVisible();
  await expect(page.locator("[data-lab-join]")).toBeDisabled();
  await expect(page.locator("[data-lab-action]").first()).toBeDisabled();
});

test("queue position and return use only the current session", async ({ page }) => {
  let returned = false;
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json: { enabled:true, now:now(), benches:[1,2,3].map(bench=>({bench,state:"leased"})), queueLength:1, nextFreeAt:null } });
    if (path.endsWith("/lease/return")) { expect(route.request().postData()).toBeNull(); returned = true; return route.fulfill({ json:{status:"ended",now:now(),reason:"left",endedAt:now(),bench:null} }); }
    return route.fulfill({ json:{status:"queued",now:now(),position:1,queueLength:1,joinedAt:now(),nextFreeAt:null,sessionExpiresAt:new Date(Date.now()+300000).toISOString()} });
  });
  await page.goto("/lab/"); await page.locator("[data-lab-join]").click();
  await expect(page.locator("[data-lab-message]")).toContainText("place in line: 1");
  await page.locator("[data-lab-return]").click();
  await expect(page.locator("[data-lab-message]")).toContainText("ended: left"); expect(returned).toBe(true);
});

test("a transient token failure can recover on the next lease poll", async ({ page }) => {
  let tokens = 0;
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json:{enabled:true,now:now(),benches:[{bench:1,state:"ready"}],queueLength:0,nextFreeAt:null} });
    if (path.endsWith("/lease/token")) { tokens++; return route.fulfill({ status:503, json:{error:"Bench is recovering",code:"bench-unavailable"} }); }
    if (path.endsWith("/trace")) return route.fulfill({ json:{items:[],next:"",gap:false} });
    return route.fulfill({ json:{status:"ready",now:now(),leaseId:"fixture-lease",bench:1,grantedAt:now(),expiresAt:new Date(Date.now()+300000).toISOString(),claimBy:new Date(Date.now()+30000).toISOString(),nextActionAt:now(),benchState:state} });
  });
  await page.goto("/lab/"); await page.locator("[data-lab-join]").click();
  await expect.poll(()=>tokens, {timeout:10000}).toBeGreaterThanOrEqual(2);
  await expect(page.locator("[data-lab-action]").first()).toBeDisabled();
});

/** A lease on bench 1, and a token for a gateway nothing listens on: the page's SDK keeps trying, which these tests don't need. */
const ready = (leaseId = "fixture-lease") => ({ status:"ready", now:now(), leaseId, bench:1, grantedAt:now(), expiresAt:new Date(Date.now()+300000).toISOString(), claimBy:new Date(Date.now()+30000).toISOString(), nextActionAt:now(), benchState:state });
const token = { token:"lab1_fixture", expiresAt:new Date(Date.now()+300000).toISOString(), bench:1, gatewayOrigin:"http://127.0.0.1:9", gatewayPath:"/lab/1/socket.io" };
let sequence = 0;
const feedItem = (rest: Record<string, unknown>) => ({ id:`fixture-lease:${++sequence}`, at:new Date(Date.now() + sequence).toISOString(), ...rest });

test("the pool refreshes when a lease is granted, and returning resets the bench panel", async ({ page }) => {
  let pool = "ready";
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json:{ enabled:true, now:now(), benches:[{ bench:1, state:pool }], queueLength:0, nextFreeAt:null } });
    if (path.endsWith("/lease/token")) return route.fulfill({ json:token });
    if (path.endsWith("/trace")) return route.fulfill({ json:{ items:[], next:"", gap:false } });
    if (path.endsWith("/lease/return")) { pool = "resetting"; return route.fulfill({ json:{ status:"ended", now:now(), reason:"returned", endedAt:now(), bench:1 } }); }
    if (route.request().method() === "POST") pool = "leased";
    return route.fulfill({ json:ready() });
  });
  await page.goto("/lab/");
  await expect(page.locator("[data-lab-pool]")).toHaveText("Bench 1: ready");
  await page.waitForTimeout(2_500); // past the first poll's status check: the next is ten seconds away
  await page.locator("[data-lab-join]").click();
  await expect(page.locator("[data-lab-pool]")).toHaveText("Bench 1: leased", { timeout:3_000 });
  await expect(page.locator("[data-lab-state]")).toContainText("Gateway running");
  await page.locator("[data-lab-return]").click();
  await expect(page.locator("[data-lab-message]")).toContainText("ended: returned");
  await expect(page.locator("[data-lab-pool]")).toHaveText("Bench 1: resetting", { timeout:3_000 });
  await expect(page.locator("[data-lab-state]")).toHaveText("Not leased.");
  await expect(page.locator("[data-lab-view-state]")).toHaveText("idle");
  await expect(page.locator("[data-lab-revision]")).toHaveText("—");
});

test("the feed opens on the scenario view, marks the retried record, and says how Resume turned out", async ({ page }) => {
  const pages = [
    [feedItem({ kind:"bench", event:"lease-started" }), feedItem({ kind:"trace", stage:"send", outcome:"ok", group:"g1", channel:"station", subscriber:"you" }),
      feedItem({ kind:"action", action:"sensor.foul" }), feedItem({ kind:"record", stationId:"LC-03", topic:"lab-1.field.gauges", partition:0, offset:"246", outcome:"failed" }),
      feedItem({ kind:"trace", stage:"map", outcome:"failed", group:"g2", channel:"station", errorCode:"HANDLER_FAILED" }), feedItem({ kind:"source", sourceId:"field", status:"paused", reason:"HANDLER_FAILED" })],
    [feedItem({ kind:"action", action:"source.resume" }), feedItem({ kind:"record", stationId:"LC-03", topic:"lab-1.field.gauges", partition:0, offset:"246", outcome:"processed" }), feedItem({ kind:"source", sourceId:"field", status:"healthy" })]
  ];
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json:{ enabled:true, now:now(), benches:[{ bench:1, state:"leased" }], queueLength:0, nextFreeAt:null } });
    if (path.endsWith("/lease/token")) return route.fulfill({ json:token });
    if (path.endsWith("/trace")) { const items = pages.shift() ?? []; return route.fulfill({ json:{ items, next:items.at(-1)?.id ?? "fixture-lease:0", gap:false } }); }
    return route.fulfill({ json:ready() });
  });
  await page.goto("/lab/"); await page.locator("[data-lab-join]").click();
  const feed = page.locator("[data-lab-feed]");
  await expect(feed.locator(".feed-retried")).toContainText("Retried LC-03 record lab-1.field.gauges · partition 0 · offset 246: mapper returned");
  await expect(feed).toContainText("map failed HANDLER_FAILED");
  await expect(feed).toContainText("Source field: paused (HANDLER_FAILED)");
  await expect(feed).not.toContainText("send ok");
  await expect(feed).not.toContainText("processed");
  await expect(page.locator("[data-lab-outcome]")).toContainText("retried the same record, offset 246");
  await expect(page.locator("[data-lab-outcome]")).toContainText("isn't proof the offset was committed");
  await page.locator("[data-lab-feed-all]").check();
  await expect(feed).toContainText("send ok · station · your view");
});

test("the slow-client scenario ends with a visible outcome", async ({ page }) => {
  const pages = [[feedItem({ kind:"action", action:"satellite.start" }), feedItem({ kind:"bench", event:"satellite-connected" })],
    [feedItem({ kind:"bench", event:"satellite-disconnected" })],
    [feedItem({ kind:"trace", stage:"receipt", outcome:"failed", group:"g3", channel:"station", errorCode:"OVERLOADED", subscriber:"satellite" })]];
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json:{ enabled:true, now:now(), benches:[{ bench:1, state:"leased" }], queueLength:0, nextFreeAt:null } });
    if (path.endsWith("/lease/token")) return route.fulfill({ json:token });
    if (path.endsWith("/trace")) { const items = pages.shift() ?? []; return route.fulfill({ json:{ items, next:items.at(-1)?.id ?? "fixture-lease:0", gap:false } }); }
    return route.fulfill({ json:ready() });
  });
  await page.goto("/lab/"); await page.locator("[data-lab-join]").click();
  await expect(page.locator("[data-lab-outcome]")).toContainText("The slow client disconnected.");
  await expect(page.locator("[data-lab-outcome]")).toContainText("missed its 5 s receipt deadline and the gateway disconnected it (OVERLOADED)");
  await expect(page.locator("[data-lab-feed]")).toContainText("receipt failed OVERLOADED · station · slow client");
});

for (const [name, failure, expected] of [
  ["a transient bench-token failure is retried with backoff", { status:503, json:{ error:"bench-unavailable", code:"bench-unavailable" } }, "retried"],
  ["a no-lease refusal stays final", { status:409, json:{ error:"no-lease", code:"no-lease" } }, "final"]
] as const) {
  test(`after the SDK's sign-in fails, ${name}`, async ({ page }) => {
    let tokens = 0;
    await page.route("**/api/lab/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/status")) return route.fulfill({ json:{ enabled:true, now:now(), benches:[{ bench:1, state:"leased" }], queueLength:0, nextFreeAt:null } });
      if (path.endsWith("/lease/token")) return ++tokens === 1 ? route.fulfill({ json:token }) : route.fulfill(failure);
      if (path.endsWith("/trace")) return route.fulfill({ json:{ items:[], next:"", gap:false } });
      return route.fulfill({ json:ready() });
    });
    await page.goto("/lab/"); await page.locator("[data-lab-join]").click();
    await expect.poll(() => tokens).toBeGreaterThanOrEqual(2); // the page's token, then the SDK's own getToken
    if (expected === "retried") await expect.poll(() => tokens, { timeout:10_000 }).toBeGreaterThanOrEqual(4); // 1 s, then 2 s later
    else { await page.waitForTimeout(5_000); expect(tokens).toBe(2); }
  });
}

test("a slow token request starts one connect, not one per poll", async ({ page }) => {
  let tokens = 0;
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json:{ enabled:true, now:now(), benches:[{ bench:1, state:"leased" }], queueLength:0, nextFreeAt:null } });
    if (path.endsWith("/lease/token")) { if (++tokens === 1) await new Promise(resolve => setTimeout(resolve, 6_000)); return route.fulfill({ json:token }); }
    if (path.endsWith("/trace")) return route.fulfill({ json:{ items:[], next:"", gap:false } });
    return route.fulfill({ json:ready() });
  });
  await page.goto("/lab/"); await page.locator("[data-lab-join]").click();
  await page.waitForTimeout(3_500); // two lease polls and a visibility check while the first token is pending
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(300);
  expect(tokens).toBe(1);
});

test("an error answer without a JSON body reads as a sentence, not a parser error", async ({ page }) => {
  await page.route("**/api/lab/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json:{ enabled:true, now:now(), benches:[{ bench:1, state:"ready" }], queueLength:0, nextFreeAt:null } });
    return route.fulfill({ status:502, body:"" });
  });
  await page.goto("/lab/"); await page.locator("[data-lab-join]").click();
  await expect(page.locator("[data-lab-message]")).toHaveText("The Lab isn't answering right now. Trying again.");
  await expect(page.locator("[data-lab-join]")).toBeEnabled();
});
