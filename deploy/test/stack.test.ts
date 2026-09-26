/**
 * The whole stack, from outside, as the site's pages use it: Caddy, the gateway
 * (`streamotter start` from npm), the field station, and Kafka over TLS with SCRAM.
 * CI runs it against deploy/compose.yaml (.github/workflows/stack.yml):
 *
 *   NODE_EXTRA_CA_CERTS=<test origin CA> STACK_ORIGIN=https://demo.streamotter.app \
 *   STACK_RESTART_GATEWAY="docker compose … restart gateway" node --test deploy/test/stack.test.ts
 *
 * STACK_ORIGIN is where Caddy answers; SITE_ORIGIN (default https://streamotter.app)
 * is the page origin the gateway allows. STACK_RESTART_GATEWAY and
 * STACK_RESTART_FIELD_STATION are shell commands; without them those tests skip.
 */
import assert from "node:assert/strict";
import { exec } from "node:child_process";
import https from "node:https";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";
import { createClient, type Client, type StreamError, type StreamEvent, type Subscription, type SubscriptionState } from "streamotter/client";
import type { AppChannels } from "../../apps/field-station/src/generated/streamotter.generated.ts";

const STACK = process.env["STACK_ORIGIN"] ?? "https://demo.streamotter.app";
const SITE = process.env["SITE_ORIGIN"] ?? "https://streamotter.app";
const RESTART_GATEWAY = process.env["STACK_RESTART_GATEWAY"];
const RESTART_FIELD_STATION = process.env["STACK_RESTART_FIELD_STATION"];
const run = promisify(exec);

// Browsers send Origin on every WebSocket handshake, and production gateways require
// it. Node's `ws` client (under the SDK's Socket.IO) sends none unless asked, and the
// SDK doesn't expose that option, so this test adds what the site's pages would send.
let pageOrigin = SITE;
const request = https.request;
https.request = ((...args: unknown[]) => {
  const options = args[0];
  if (typeof options === "object" && options !== null && !(options instanceof URL)) {
    const headers = (options as https.RequestOptions).headers as Record<string, unknown> | undefined;
    if (headers?.["Upgrade"] === "websocket") headers["Origin"] = pageOrigin;
  }
  return (request as (...forwarded: unknown[]) => ReturnType<typeof https.request>)(...args);
}) as typeof https.request;

type Role = "volunteer" | "researcher";

/** One visitor: a cookie jar and badges from the site API, like a page's fetch with credentials. */
class Visitor {
  cookie = "";
  subject = "";

  async badge(role: Role): Promise<{ token: string; badge: { subject: string; role: Role }; response: Response }> {
    const response = await fetch(`${STACK}/api/badge`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json", ...(this.cookie === "" ? {} : { cookie: this.cookie }) },
      body: JSON.stringify({ role })
    });
    assert.equal(response.status, 200, await response.clone().text());
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) this.cookie = setCookie.split(";")[0]!;
    const body = await response.json() as { token: string; badge: { subject: string; role: Role } };
    this.subject = body.badge.subject;
    return { ...body, response };
  }

  async sighting(sighting: { otterId: string; reachId: string; activity: string }): Promise<Response> {
    return fetch(`${STACK}/api/notebook/sightings`, {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json", cookie: this.cookie },
      body: JSON.stringify(sighting)
    });
  }
}

const clients: Client<AppChannels>[] = [];
after(async () => {
  await Promise.all(clients.map(client => client.close()));
});

async function connect(role: Role, visitor = new Visitor()): Promise<Client<AppChannels>> {
  const config = await (await fetch(`${STACK}/api/config`, { headers: { origin: SITE } })).json() as { gatewayOrigin: string; gatewayPath: string };
  const client = createClient<AppChannels>({ origin: config.gatewayOrigin, path: config.gatewayPath, getToken: async () => (await visitor.badge(role)).token });
  clients.push(client);
  return client;
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe("the demo host from outside", () => {
  test("Caddy serves only the site API and the gateway", async () => {
    const config = await fetch(`${STACK}/api/config`, { headers: { origin: SITE } });
    assert.equal(config.status, 200);
    const body = await config.json() as { mode: string; gatewayPath: string };
    assert.equal(body.mode, "kafka");
    assert.equal(body.gatewayPath, "/streamotter/socket.io");
    assert.equal(config.headers.get("access-control-allow-origin"), SITE);
    assert.match(config.headers.get("strict-transport-security") ?? "", /max-age=/);
    assert.equal(config.headers.get("x-content-type-options"), "nosniff");
    for (const path of ["/", "/healthz", "/internal/views/station/LC-02", "/management/v1/sources"]) {
      assert.equal((await fetch(`${STACK}${path}`)).status, 404, path);
    }
  });

  test("the site API issues badges with a secure session cookie", async () => {
    const { response, badge } = await new Visitor().badge("volunteer");
    assert.equal(badge.role, "volunteer");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(response.headers.get("set-cookie") ?? "", /Path=\/api; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  });

  test("the gateway refuses a page from any other origin", async () => {
    const client = await connect("volunteer");
    const errors: StreamError[] = [];
    client.on("error", error => errors.push(error));
    pageOrigin = "https://elsewhere.example";
    try {
      const station = client.subscribe("station", { channelVersion: 1, params: { stationId: "LC-02" } });
      await until(() => errors.length > 0, "the connection to be refused");
      assert.equal(errors[0]?.code, "FORBIDDEN");
      assert.notEqual(station.state, "live");
    } finally {
      pageOrigin = SITE;
    }
  });
});

describe("a volunteer at Kestrel Bend", () => {
  let client: Client<AppChannels>;
  const notebookOwner = new Visitor();
  const notebookEvents: StreamEvent<AppChannels["notebook"]["data"]>[] = [];
  const events: StreamEvent<AppChannels["station"]["data"]>[] = [];
  const states: SubscriptionState[] = [];
  let station: Subscription<AppChannels["station"]["data"]>;

  test("gets a snapshot, goes live, then receives newer readings in revision order", async () => {
    client = await connect("volunteer");
    station = client.subscribe("station", { channelVersion: 1, params: { stationId: "LC-02" } });
    station.on("data", event => events.push(event));
    station.on("state", ({ state }) => states.push(state));
    await station.ready({ timeoutMs: 20_000 });
    assert.deepEqual(states.slice(0, 3), ["authorizing", "synchronizing", "live"]);
    assert.equal(events[0]?.kind, "snapshot");
    assert.equal(events[0]?.data.stationId, "LC-02");

    // A gauge reports every study tick: every two seconds.
    await until(() => events.length >= 3, "two live readings");
    assert.ok(events.slice(1).every(event => event.kind === "update"));
    for (let i = 1; i < events.length; i++) assert.ok(BigInt(events[i]!.revision) > BigInt(events[i - 1]!.revision), "revisions increase");
    assert.equal(station.state, "live");
  });

  test("is refused Holt A with FORBIDDEN and receives nothing", async () => {
    const holt = client.subscribe("holt", { channelVersion: 1, params: { holtId: "A" } });
    let received = 0;
    holt.on("data", () => { received += 1; });
    await assert.rejects(holt.ready({ timeoutMs: 20_000 }), (error: StreamError) => error.code === "FORBIDDEN");
    assert.equal(holt.state, "failed");
    assert.equal(received, 0);
    assert.equal(station.state, "live", "the refusal doesn't disturb other views");
  });

  test("the field biologist sees Holt A", async () => {
    const biologist = await connect("researcher");
    const holt = biologist.subscribe("holt", { channelVersion: 1, params: { holtId: "A" } });
    let latest: AppChannels["holt"]["data"] | undefined;
    holt.on("data", event => { latest = event.data; });
    await holt.ready({ timeoutMs: 20_000 });
    assert.equal(latest?.gridRef, "LC 4417 2203");
  });

  test("logs a sighting in their own notebook and sees it arrive through Kafka", async () => {
    await notebookOwner.badge("volunteer");
    const owner = await connect("volunteer", notebookOwner);
    const notebook = owner.subscribe("notebook", { channelVersion: 1, params: { observerId: notebookOwner.subject } });
    notebook.on("data", event => notebookEvents.push(event));
    await notebook.ready({ timeoutMs: 20_000 });
    assert.equal(notebookEvents[0]?.kind, "snapshot");
    assert.deepEqual(notebookEvents[0]?.data.entries, []);

    const response = await notebookOwner.sighting({ otterId: "LO-07", reachId: "kestrel-bend", activity: "foraging" });
    assert.equal(response.status, 200, await response.clone().text());
    const { revision } = await response.json() as { revision: string };
    await until(() => notebookEvents.some(event => event.kind === "update" && event.revision === revision), "the sighting to arrive");
    const update = notebookEvents.find(event => event.revision === revision)!;
    assert.equal(update.data.status, "open");
    assert.deepEqual(update.data.entries.map(entry => [entry.otterId, entry.reachId, entry.activity]), [["LO-07", "kestrel-bend", "foraging"]]);
  });

  test("another visitor asking for that notebook is refused with FORBIDDEN", async () => {
    const stranger = await connect("researcher");
    const notebook = stranger.subscribe("notebook", { channelVersion: 1, params: { observerId: notebookOwner.subject } });
    let received = 0;
    notebook.on("data", () => { received += 1; });
    await assert.rejects(notebook.ready({ timeoutMs: 20_000 }), (error: StreamError) => error.code === "FORBIDDEN");
    assert.equal(received, 0);
  });

  test("after a gateway restart, goes stale, then live again from a fresh snapshot", { skip: RESTART_GATEWAY === undefined && "STACK_RESTART_GATEWAY is not set" }, async () => {
    const before = events.length;
    const lastRevision = BigInt(events.at(-1)!.revision);
    const statesBefore = states.length;
    await run(RESTART_GATEWAY!, { timeout: 120_000 });
    await until(() => states.slice(statesBefore).includes("stale"), "the view to go stale", 60_000);
    await until(() => station.state === "live" && events.slice(before).some(event => event.kind === "snapshot"), "live again with a fresh snapshot", 120_000);
    const snapshot = events.slice(before).find(event => event.kind === "snapshot")!;
    assert.ok(BigInt(snapshot.revision) >= lastRevision, "the fresh snapshot is not older than what was shown");
    const afterSnapshot = events.length;
    await until(() => events.length > afterSnapshot, "live readings after the restart");
    const recent = events.slice(afterSnapshot - 1).map(event => BigInt(event.revision));
    for (let i = 1; i < recent.length; i++) assert.ok(recent[i]! > recent[i - 1]!, "revisions keep increasing");
  });

  test("after a field station restart, the world carries on from its checkpoint and notebooks from Kafka", { skip: RESTART_FIELD_STATION === undefined && "STACK_RESTART_FIELD_STATION is not set" }, async () => {
    const statusBefore = await (await fetch(`${STACK}/api/status`)).json() as { tick: number };
    const lastRevision = BigInt(events.at(-1)!.revision);
    await run(RESTART_FIELD_STATION!, { timeout: 120_000 });
    await until(() => BigInt(events.at(-1)!.revision) > lastRevision + 2n, "readings from the restarted field station", 120_000);
    const statusAfter = await (await fetch(`${STACK}/api/status`)).json() as { tick: number; kafka: string };
    assert.ok(statusAfter.tick > statusBefore.tick);
    assert.equal(statusAfter.kafka, "connected");
    assert.equal(station.state, "live");

    // A fresh subscription's snapshot comes from the notebook the field station rebuilt from field.notebooks.
    const owner = await connect("volunteer", notebookOwner);
    const notebook = owner.subscribe("notebook", { channelVersion: 1, params: { observerId: notebookOwner.subject } });
    let snapshot: StreamEvent<AppChannels["notebook"]["data"]> | undefined;
    notebook.on("data", event => { snapshot ??= event; });
    await notebook.ready({ timeoutMs: 20_000 });
    const logged = notebookEvents.at(-1)!;
    assert.equal(snapshot?.revision, logged.revision);
    assert.deepEqual(snapshot?.data, logged.data);
  });
});
