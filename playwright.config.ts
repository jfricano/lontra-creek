/**
 * The browser-test harness (F.5): end-to-end and accessibility checks against the
 * dev stack, outside `npm test`'s glob so `node --test` never picks these up.
 *
 * `npm run dev` starts the field station in fixture mode (no Kafka) plus the site,
 * on the defaults from docs/DEPLOYMENT_PLAN.md: site 4321, gateway 7400, workbench
 * 7401, site API 7402. Set LONTRA_SITE_PORT, LONTRA_GATEWAY_PORT,
 * LONTRA_WORKBENCH_PORT, and LONTRA_API_PORT to use a separate port block;
 * the dev stack and this harness both read those overrides.
 */
import { defineConfig, devices } from "@playwright/test";

const SITE_PORT = Number(process.env["LONTRA_SITE_PORT"] ?? 4321);
const SITE_URL = `http://127.0.0.1:${SITE_PORT}`;
const CI = process.env["CI"] !== undefined;
const PRODUCTION = process.env["LONTRA_BROWSER_MODE"] === "production";

export default defineConfig({
  testDir: "./e2e",
  // e2e/real/ runs against a running `npm run dev:lab` stack instead (playwright.real.config.ts).
  testIgnore: ["real/**"],
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI ? [["html", { open: "never" }], ["github"], ["list"]] : "list",
  // The Lab page paces its requests to its share of the address budget (lab-budget.ts), and in these
  // specs its SDK keeps signing in to a gateway nothing listens on, which spends that budget too: a
  // poll-driven change can take longer than the default 5 s to show.
  expect: { timeout: 10_000 },
  use: {
    baseURL: SITE_URL,
    trace: "on-first-retry"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } }
  ],
  webServer: {
    command: PRODUCTION ? "node scripts/dev.mjs --preview" : "npm run dev",
    url: SITE_URL,
    reuseExistingServer: !CI && !PRODUCTION,
    // The field station and Astro both need to start; generous on a cold cache.
    timeout: 120_000
  }
});
