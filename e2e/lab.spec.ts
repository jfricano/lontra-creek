import { expect, test } from "@playwright/test";

const now = () => new Date().toISOString();
const state = { gateway: "running", source: { status: "healthy" }, relay: "up", calibration: "present", satellite: "idle", receiptTimeoutMs: 5000 };

test("disabled Lab is honest and offers local instructions", async ({ page }) => {
  await page.route("**/api/lab/status", route => route.fulfill({ json: { enabled:false, now:now(), benches:[], queueLength:0, nextFreeAt:null } }));
  await page.goto("/lab/");
  await expect(page.locator("[data-lab-unavailable]")).toBeVisible();
  await expect(page.locator("[data-lab-join]")).toBeDisabled();
  await expect(page.locator("[data-lab-actions]")).toBeDisabled();
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
  await expect(page.locator("[data-lab-actions]")).toBeDisabled();
});
