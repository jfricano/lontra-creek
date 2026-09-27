/** Capture actual SDK events from the installed npm gateway, never fabricated states. */
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { createGateway, silentLogger } from "streamotter/gateway";
import { startManagementServer } from "streamotter/gateway/management";
import { createClient } from "streamotter/client";
import { handlers, development, fixtureTickSizes } from "../apps/field-station/src/fixture-handlers.ts";
import { projectConfig } from "../apps/field-station/src/project.ts";
import { fieldStationSecret, issueToken } from "../apps/field-station/src/identity.ts";
import type { AppChannels } from "../apps/field-station/src/generated/streamotter.generated.ts";
const socket = createServer();
await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = (socket.address() as { port: number }).port;
await new Promise<void>(resolve => socket.close(() => resolve()));
const fixture = projectConfig("fixture");
const gateway = createGateway({ config: { ...fixture, gateway: { ...fixture.gateway, port } }, handlers, development, mode: "development", logger: silentLogger });
await gateway.start();
const management = await startManagementServer({ gateway, port: 0, workbenchDir: null });
const client = createClient<AppChannels>({ origin: `http://127.0.0.1:${port}`, getToken: () => issueToken({ subject: "recording-volunteer", role: "volunteer", name: "Volunteer" }, { secret: fieldStationSecret({}), ttlSeconds: 60 }).token });
const started = performance.now();
const events: unknown[] = [];
const recordedAt = new Date().toISOString();
const views = [client.subscribe("station", { channelVersion: 1, params: { stationId: "LC-02" } }), client.subscribe("otter", { channelVersion: 1, params: { otterId: "LO-07" } }), client.subscribe("station", { channelVersion: 1, params: { stationId: "LC-03" } })];
try {
  views.forEach((view, card) => {
    view.on("data", event => events.push({ atMs: Math.round(performance.now()-started), card, type: "data", event }));
    view.on("state", change => events.push({ atMs: Math.round(performance.now()-started), card, type: "state", change }));
  });
  await Promise.all(views.map(view => view.ready({ timeoutMs: 5_000 })));
  for (const count of fixtureTickSizes.slice(0, 8)) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const response = await fetch(`${management.origin}/management/v1/dev/fixtures/advance`, { method: "POST", headers: { authorization: `Bearer ${management.token}`, "content-type": "application/json" }, body: JSON.stringify({ sourceId: "field", count }) });
    if (!response.ok) throw new Error(`Advance failed: ${response.status}`);
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  const destination = new URL("../apps/site/public/recordings/creek.json", import.meta.url);
  await mkdir(new URL(".", destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ recordedAt, where: "Local fixture run on macOS; published streamotter@0.1.0-rc.3, no Kafka; one simulation tick per two seconds", durationMs: Math.round(performance.now()-started), events }, null, 2)+"\n");
  console.log(`Captured ${events.length} actual SDK events.`);
} finally { await client.close(); await management.close(); await gateway.stop(); }
