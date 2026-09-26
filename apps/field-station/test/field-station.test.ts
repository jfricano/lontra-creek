import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createWorld, currentEmissions, step, TICKS_PER_DAY, type Emission } from "@lontra-creek/sim";
import { createClient, type Client, type StreamError, type StreamEvent, type SubscriptionState } from "streamotter/client";
import { canonicalizeParams, validateProjectConfig, validateValue, type Json } from "streamotter/contracts";
import { createGateway, silentLogger, type Gateway } from "streamotter/gateway";
import { startManagementServer, type ManagementServer } from "streamotter/gateway/management";
import { development, handlers } from "../src/fixture-handlers.ts";
import type { AppChannels } from "../src/generated/streamotter.generated.ts";
import { fieldStationSecret, issueToken, verifyToken, type Badge } from "../src/identity.ts";
import { CONFIG_FILES, paramsSchema, payloadSchema, projectConfig } from "../src/project.ts";

const appDir = join(import.meta.dirname, "..");
const cli = join(appDir, "../../node_modules/streamotter/bin/streamotter.js");
const secret = fieldStationSecret({});
const volunteer: Badge = { subject: "volunteer-test", role: "volunteer", name: "Volunteer" };
const biologist: Badge = { subject: "biologist-test", role: "researcher", name: "Field biologist" };

describe("configuration", () => {
  test("the committed configuration files match src/project.ts", () => {
    const result = spawnSync(process.execPath, [join(appDir, "scripts/configs.ts"), "--check"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  for (const [environment, file] of Object.entries(CONFIG_FILES)) {
    test(`the published CLI accepts ${file}`, () => {
      const result = spawnSync(process.execPath, [cli, "validate", "--config", join(appDir, file)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /is valid/);
      assert.deepEqual(validateProjectConfig(projectConfig(environment as keyof typeof CONFIG_FILES)).issues, []);
    });
  }

  test("every view the simulation publishes over three study days fits its channel's schema", () => {
    const world = createWorld({ seed: "lontra-creek" });
    const check = (emission: Emission): void => {
      const issue = validateValue(payloadSchema(emission.channel), emission.data as unknown as Json);
      assert.equal(issue, null, `${emission.key} at tick ${world.tick}: ${JSON.stringify(issue)}`);
      assert.ok(canonicalizeParams(paramsSchema(emission.channel), emission.params).ok, `${emission.key} params`);
    };
    currentEmissions(world).forEach(check);
    let checked = 0;
    while (world.tick < 3 * TICKS_PER_DAY) {
      for (const emission of step(world)) {
        check(emission);
        checked += 1;
      }
    }
    assert.ok(checked > 1_000);
  });
});

describe("badges", () => {
  test("a signed badge becomes a principal in the study's tenant", () => {
    const { token } = issueToken(biologist, { secret, ttlSeconds: 60 });
    const principal = verifyToken(token, secret);
    assert.equal(principal?.subject, "biologist-test");
    assert.equal(principal?.tenantId, "lontra-creek");
    assert.equal(principal?.claims["role"], "researcher");
  });

  test("forged, tampered, and expired badges are refused", () => {
    const { token } = issueToken(volunteer, { secret, ttlSeconds: 60 });
    assert.equal(verifyToken(token, "another-secret-that-is-at-least-32-chars"), null);
    const [payload, signature] = token.split(".");
    const promoted = Buffer.from(Buffer.from(payload!, "base64url").toString("utf8").replace("volunteer\"", "researcher\"")).toString("base64url");
    assert.equal(verifyToken(`${promoted}.${signature}`, secret), null);
    const expired = issueToken(volunteer, { secret, ttlSeconds: 60, now: Date.now() - 120_000 });
    assert.equal(verifyToken(expired.token, secret), null);
    assert.equal(verifyToken("not-a-token", secret), null);
  });

  test("production refuses to run without a real secret", () => {
    assert.throws(() => fieldStationSecret({ NODE_ENV: "production" }), /FIELD_STATION_SECRET/);
    assert.equal(fieldStationSecret({ NODE_ENV: "production", FIELD_STATION_SECRET: "x".repeat(32) }), "x".repeat(32));
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No port");
  return address.port;
}

describe("the gateway, running the published streamotter package against the fixture", () => {
  let gateway: Gateway;
  let management: ManagementServer;
  let origin: string;
  const clients: Client<AppChannels>[] = [];

  before(async () => {
    const port = await freePort();
    const fixture = projectConfig("fixture");
    gateway = createGateway({ config: { ...fixture, gateway: { ...fixture.gateway, port } }, handlers, development, mode: "development", logger: silentLogger });
    await gateway.start();
    management = await startManagementServer({ gateway, port: 0, workbenchDir: null });
    origin = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await management?.close();
    await gateway?.stop();
  });

  function connect(getBadge: () => Badge): Client<AppChannels> {
    const client = createClient<AppChannels>({ origin, getToken: () => issueToken(getBadge(), { secret, ttlSeconds: 300 }).token });
    clients.push(client);
    return client;
  }

  async function advance(count: number): Promise<void> {
    const response = await fetch(`${management.origin}/management/v1/dev/fixtures/advance`, {
      method: "POST",
      headers: { authorization: `Bearer ${management.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "field", count })
    });
    assert.equal(response.status, 200, await response.text());
  }

  async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  test("a volunteer gets a snapshot, goes live, then receives newer readings in order", async () => {
    const client = connect(() => volunteer);
    const station = client.subscribe("station", { channelVersion: 1, params: { stationId: "LC-02" } });
    const events: StreamEvent<AppChannels["station"]["data"]>[] = [];
    const states: SubscriptionState[] = [];
    station.on("data", event => events.push(event));
    station.on("state", ({ state }) => states.push(state));
    await station.ready({ timeoutMs: 5_000 });

    assert.deepEqual(states.slice(0, 3), ["authorizing", "synchronizing", "live"]);
    assert.equal(events[0]?.kind, "snapshot");
    assert.equal(events[0]?.revision, "1000000000000");
    assert.equal(events[0]?.data.stationId, "LC-02");

    for (let i = 0; i < 4; i++) await advance(40);
    await until(() => events.length >= 5, "five LC-02 readings");
    const revisions = events.map(event => BigInt(event.revision));
    for (let i = 1; i < revisions.length; i++) assert.ok(revisions[i]! > revisions[i - 1]!, "revisions increase");
    assert.ok(events.slice(1).every(event => event.kind === "update"));
    assert.equal(station.state, "live");
  });

  test("a volunteer asking for a den site is refused with FORBIDDEN and receives nothing", async () => {
    const client = connect(() => volunteer);
    const holt = client.subscribe("holt", { channelVersion: 1, params: { holtId: "A" } });
    let received = 0;
    holt.on("data", () => { received += 1; });
    await assert.rejects(holt.ready({ timeoutMs: 5_000 }), (error: StreamError) => error.code === "FORBIDDEN");
    assert.equal(holt.state, "failed");
    assert.equal(received, 0);
  });

  test("the field biologist sees Holt A", async () => {
    const client = connect(() => biologist);
    const holt = client.subscribe("holt", { channelVersion: 1, params: { holtId: "A" } });
    let latest: AppChannels["holt"]["data"] | undefined;
    holt.on("data", event => { latest = event.data; });
    await holt.ready({ timeoutMs: 5_000 });
    assert.equal(latest?.gridRef, "LC 4417 2203");
    assert.equal(latest?.reachId, "beaver-flats");
    assert.equal(latest?.occupied, (latest?.occupants.length ?? 0) > 0);
  });

  test("handing the tablet to someone else closes the previous person's subscriptions", async () => {
    let holder = volunteer;
    const client = connect(() => holder);
    const overview = client.subscribe("creekOverview", { channelVersion: 1, params: { watershed: "lontra" } });
    const errors: StreamError[] = [];
    overview.on("error", error => errors.push(error));
    await overview.ready({ timeoutMs: 5_000 });

    holder = biologist;
    await client.reconnect({ timeoutMs: 5_000 });
    await until(() => overview.state === "failed" || overview.state === "closed", "the volunteer's view to close");
    assert.ok(errors.some(error => error.code === "UNAUTHENTICATED"), JSON.stringify(errors));

    const holt = client.subscribe("holt", { channelVersion: 1, params: { holtId: "A" } });
    await holt.ready({ timeoutMs: 5_000 });
  });

  test("parameters outside the study are rejected before any handler runs", async () => {
    const client = connect(() => biologist);
    // A station the study doesn't have: the schema's enum refuses it.
    const unknown = client.subscribe("station", { channelVersion: 1, params: { stationId: "LC-99" as "LC-01" } });
    await assert.rejects(unknown.ready({ timeoutMs: 5_000 }), (error: StreamError) => error.code === "INVALID_PARAMS" || error.code === "FORBIDDEN");
  });
});
