/**
 * Browser specs against the real workbench sandbox (e2e/real/), on a running stack, in
 * three engines (LC11-A41, A46). Nothing is started or stubbed here: start the stack with
 * `npm run dev:lab`, then
 *
 *   SANDBOX_REAL_ORIGIN=https://localhost:8443 npx playwright test -c playwright.real.config.ts
 *
 * Without SANDBOX_REAL_ORIGIN every spec skips. The local stack's certificate comes from a
 * throwaway CA, so HTTPS errors are ignored for that origin only; the specs talk to nothing
 * else. One worker: a client address holds at most two places across the Failure Lab and
 * the sandbox, and the pool has three slots.
 */
import { defineConfig, devices } from "@playwright/test";

const ORIGIN = process.env["SANDBOX_REAL_ORIGIN"];
const CI = process.env["CI"] !== undefined;

export default defineConfig({
  testDir: "./e2e/real",
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: 0,
  reporter: CI ? [["html", { open: "never" }], ["github"], ["list"]] : "list",
  // A slot can take a few seconds to reset, and an expiry spec waits out a short lease.
  timeout: 120_000,
  use: {
    ...(ORIGIN ? { baseURL: ORIGIN } : {}),
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } }
  ]
});
