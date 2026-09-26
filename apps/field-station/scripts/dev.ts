/**
 * The field station for local development, with no Kafka: a StreamOtter gateway in
 * development mode on the simulation fixture, advanced one study tick every two
 * seconds; the StreamOtter workbench; and the small API the site signs in with.
 *
 *   node scripts/dev.ts        (or `npm run dev` at the repository root, with the site)
 *
 * Environment: FIELD_FIXTURE_DAYS (default 7), FIELD_TICK_MS (default 2000).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

process.env["FIELD_FIXTURE_DAYS"] ??= "7";
const TICK_MS = Number(process.env["FIELD_TICK_MS"] ?? "2000");
const API_PORT = 7402;
const MANAGEMENT_PORT = 7401;

const { studyTime } = await import("@lontra-creek/sim");
const { createGateway } = await import("streamotter/gateway");
const { startManagementServer } = await import("streamotter/gateway/management");
const { development, fixtureTickSizes, handlers } = await import("../src/fixture-handlers.ts");
const { fieldStationSecret } = await import("../src/identity.ts");
const { projectConfig } = await import("../src/project.ts");
const { badgeFor } = await import("../src/sessions.ts");

const config = projectConfig("fixture");
const gatewayOrigin = `http://${config.gateway.host}:${config.gateway.port}`;
const secret = fieldStationSecret();

const gateway = createGateway({ config, handlers, development, mode: "development" });
await gateway.start();

const require = createRequire(import.meta.url);
const workbenchDir = join(dirname(require.resolve("@streamotter/workbench/package.json")), "dist");
const management = await startManagementServer({ gateway, port: MANAGEMENT_PORT, workbenchDir });

// Replay the fixture in study time: one tick's records every TICK_MS.
let tick = 0;
let replaying = true;
async function advanceOneTick(): Promise<void> {
  if (tick >= fixtureTickSizes.length) {
    if (replaying) console.log("The fixture has ended. Restart to replay it from the beginning.");
    replaying = false;
    return;
  }
  const count = fixtureTickSizes[tick]!;
  tick += 1;
  if (count === 0) return;
  const response = await fetch(`${management.origin}/management/v1/dev/fixtures/advance`, {
    method: "POST",
    headers: { authorization: `Bearer ${management.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "field", count })
  });
  if (!response.ok) console.error(`Advancing the fixture failed: ${response.status} ${await response.text()}`);
}
let ticker: NodeJS.Timeout | undefined;
function schedule(): void {
  ticker = setTimeout(() => {
    advanceOneTick().catch(error => console.error("Advancing the fixture failed", error)).finally(schedule);
  }, TICK_MS);
}
schedule();

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 4_096) throw new Error("Body too large");
  }
  const value: unknown = text === "" ? {} : JSON.parse(text);
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

const api = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://field-station.invalid");
  try {
    if (request.method === "GET" && url.pathname === "/api/config") {
      return json(response, 200, { gatewayOrigin, gatewayPath: config.gateway.path, mode: "fixture", tickMs: TICK_MS });
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const time = studyTime(tick);
      return json(response, 200, { mode: "fixture", tick, fixtureTicks: fixtureTickSizes.length, replaying, studyDay: time.day, studyTime: time.clock });
    }
    if (request.method === "POST" && url.pathname === "/api/badge") {
      const body = await readJson(request);
      const role = body["role"] === "researcher" ? "researcher" : "volunteer";
      const result = badgeFor({ cookieHeader: request.headers.cookie, role, secret, secure: false });
      return json(response, 200, { badge: result.badge, token: result.token.token, expiresAt: result.token.expiresAt },
        result.setCookie === null ? {} : { "set-cookie": result.setCookie });
    }
    json(response, 404, { error: "Not found." });
  } catch (error) {
    console.error("Request failed", error);
    if (!response.headersSent) json(response, 400, { error: "Bad request." });
  }
});
await new Promise<void>(resolve => api.listen(API_PORT, "127.0.0.1", resolve));

console.log([
  "Lontra Creek field station: fixture mode, no Kafka",
  `  Gateway     ${gatewayOrigin}${config.gateway.path}`,
  `  Workbench   ${management.origin}/   token ${management.token}`,
  `  Site API    http://127.0.0.1:${API_PORT}/api`,
  `  Replay      ${fixtureTickSizes.length} ticks (${fixtureTickSizes.length / 288} study days), one every ${TICK_MS / 1000} s`,
  "Press Ctrl+C to stop."
].join("\n"));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(ticker);
  await new Promise<void>(resolve => api.close(() => resolve()));
  await management.close();
  await gateway.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
