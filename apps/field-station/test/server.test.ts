import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { advanceTo, createWorld, currentEmissions, seedFrom } from "@lontra-creek/sim";
import { verifyToken } from "../src/identity.ts";
import { readConfig, type ServerConfig } from "../src/server/config.ts";
import { internalApi, publicApi, RateLimiter } from "../src/server/http.ts";
import { Notebooks } from "../src/server/notebooks.ts";
import { PublishQueue, type OutgoingRecord, type Publisher } from "../src/server/queue.ts";
import { FieldStation, SEED } from "../src/server/station.ts";

const EPOCH = "2026-09-01T00:00:00.000Z";
const EPOCH_MS = Date.parse(EPOCH);
const TICK_MS = 2_000;
const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lontra-station-"));
  dirs.push(dir);
  return dir;
}

interface Sent {
  records: readonly OutgoingRecord[];
}

/** A broker that can be down, and whose acknowledgements can be held back. */
class FakePublisher implements Publisher {
  readonly batches: Sent[] = [];
  down = false;
  onPublish: ((records: readonly OutgoingRecord[]) => void) | null = null;
  #held: (() => void) | null = null;
  hold = false;

  async publish(records: readonly OutgoingRecord[]): Promise<void> {
    this.onPublish?.(records);
    if (this.down) throw new Error("Connection refused");
    if (this.hold) await new Promise<void>(resolve => { this.#held = resolve; });
    this.batches.push({ records });
  }

  release(): void {
    this.#held?.();
    this.#held = null;
  }

  async close(): Promise<void> {}

  revisions(): Map<string, bigint[]> {
    const byKey = new Map<string, bigint[]>();
    for (const batch of this.batches) {
      for (const record of batch.records) {
        const list = byKey.get(record.key) ?? [];
        list.push(BigInt((JSON.parse(record.value) as { revision: string }).revision));
        byKey.set(record.key, list);
      }
    }
    return byKey;
  }
}

function clock(startTick: number): { now: () => number; to(tick: number): void } {
  let at = EPOCH_MS + startTick * TICK_MS + 500;
  return { now: () => at, to: tick => { at = EPOCH_MS + tick * TICK_MS + 500; } };
}

async function station(options: { dir: string; publisher: Publisher; now: () => number; generation?: number; epoch?: string | null }): Promise<FieldStation> {
  const created = new FieldStation({
    queue: new PublishQueue(options.publisher, () => undefined),
    dataDir: options.dir,
    epoch: options.epoch === undefined ? EPOCH : options.epoch,
    tickMs: TICK_MS,
    generation: options.generation ?? 1,
    now: options.now,
    log: () => undefined
  });
  await created.start();
  return created;
}

describe("the field station's runner", () => {
  test("it starts at the wall clock's tick and republishes every view", async () => {
    const publisher = new FakePublisher();
    const time = clock(1_000);
    const field = await station({ dir: await dataDir(), publisher, now: time.now });
    assert.equal(field.tick, 1_000);
    const expected = createWorld({ seed: seedFrom(SEED) });
    advanceTo(expected, 1_000);
    await field.flush();
    assert.equal(publisher.batches.length, 1);
    const sent = new Map(publisher.batches[0]!.records.map(record => [record.key, JSON.parse(record.value) as { revision: string; data: unknown }]));
    for (const emission of currentEmissions(expected)) {
      assert.equal(sent.get(emission.key)?.revision, emission.revision, emission.key);
      assert.deepEqual(sent.get(emission.key)?.data, emission.data);
    }
    assert.equal(field.kafkaHealthy, true);
  });

  test("a view is served before it is published, never after", async () => {
    const publisher = new FakePublisher();
    const time = clock(0);
    const field = await station({ dir: await dataDir(), publisher, now: time.now });
    await field.flush();
    let checked = 0;
    publisher.onPublish = records => {
      for (const record of records) {
        const served = field.view(record.key);
        assert.ok(served !== undefined && BigInt(served.revision) >= BigInt((JSON.parse(record.value) as { revision: string }).revision), record.key);
        checked += 1;
      }
    };
    for (let tick = 1; tick <= 300; tick++) {
      time.to(tick);
      await field.advance();
    }
    assert.ok(checked > 100, `checked ${checked} records`);
    const revisions = publisher.revisions();
    for (const [key, list] of revisions) {
      for (let i = 1; i < list.length; i++) assert.ok(list[i]! > list[i - 1]!, `${key} revisions increase`);
    }
  });

  test("while Kafka is down it keeps ticking, then publishes only the latest state of each view", async () => {
    const publisher = new FakePublisher();
    const time = clock(0);
    const field = await station({ dir: await dataDir(), publisher, now: time.now });
    await field.flush();
    publisher.down = true;
    for (let tick = 1; tick <= 120; tick++) {
      time.to(tick);
      await field.advance();
    }
    assert.equal(field.tick, 120);
    assert.equal(field.kafkaHealthy, false);
    assert.equal(publisher.batches.length, 1);
    const waiting = field.pendingCount;
    assert.ok(waiting > 0 && waiting <= 13, `${waiting} views waiting`);

    publisher.down = false;
    time.to(121);
    await field.advance();
    assert.equal(field.kafkaHealthy, true);
    assert.equal(field.pendingCount, 0);
    const catchUp = publisher.batches[1]!.records;
    assert.equal(new Set(catchUp.map(record => record.key)).size, catchUp.length, "one record per view");
    for (const record of catchUp) {
      assert.equal((JSON.parse(record.value) as { revision: string }).revision, field.view(record.key)!.revision, record.key);
    }
  });

  test("one batch is in flight at a time, and a newer view waits for the next", async () => {
    const publisher = new FakePublisher();
    const time = clock(0);
    const field = await station({ dir: await dataDir(), publisher, now: time.now });
    await field.flush();
    publisher.hold = true;
    time.to(1);
    const first = field.advance();
    let calls = 0;
    publisher.onPublish = () => { calls += 1; };
    time.to(2);
    const second = field.advance();
    assert.equal(calls, 0, "no second batch while the first is unacknowledged");
    publisher.hold = false;
    publisher.release();
    await Promise.all([first, second]);
    assert.ok(field.pendingCount > 0, "tick 2's views are still queued");
    await field.flush();
    assert.equal(field.pendingCount, 0);
  });

  test("a restart restores the checkpoint and continues exactly where the world would be", async () => {
    const dir = await dataDir();
    const time = clock(500);
    const first = await station({ dir, publisher: new FakePublisher(), now: time.now });
    for (let tick = 501; tick <= 520; tick++) {
      time.to(tick);
      await first.advance();
    }
    await first.stop(100);

    const logs: string[] = [];
    time.to(900);
    const publisher = new FakePublisher();
    const second = new FieldStation({ queue: new PublishQueue(publisher, () => undefined), dataDir: dir, epoch: EPOCH, tickMs: TICK_MS, generation: 1, now: time.now, log: line => logs.push(line) });
    await second.start();
    assert.match(logs[0]!, /Restored the checkpoint at tick 520/);
    assert.equal(second.tick, 900);
    const fresh = createWorld({ seed: seedFrom(SEED) });
    advanceTo(fresh, 900);
    for (const emission of currentEmissions(fresh)) assert.deepEqual(second.view(emission.key), emission, emission.key);
  });

  test("a new generation starts over from the seed, and outranks every earlier revision", async () => {
    const dir = await dataDir();
    const time = clock(5_000);
    const oldPublisher = new FakePublisher();
    const old = await station({ dir, publisher: oldPublisher, now: time.now });
    await old.flush();
    await old.stop(100);
    const highest = [...oldPublisher.revisions().values()].flat().reduce((max, revision) => (revision > max ? revision : max), 0n);

    const logs: string[] = [];
    const publisher = new FakePublisher();
    const next = new FieldStation({ queue: new PublishQueue(publisher, () => undefined), dataDir: dir, epoch: EPOCH, tickMs: TICK_MS, generation: 2, now: time.now, log: line => logs.push(line) });
    await next.start();
    await next.flush();
    assert.match(logs[0]!, /generation 1, not 2/);
    for (const list of publisher.revisions().values()) for (const revision of list) assert.ok(revision > highest);
  });

  test("a checkpoint from another epoch or tick length is not used", async () => {
    const dir = await dataDir();
    const time = clock(100);
    await (await station({ dir, publisher: new FakePublisher(), now: time.now })).stop(100);
    const logs: string[] = [];
    const moved = new FieldStation({ queue: new PublishQueue(new FakePublisher(), () => undefined), dataDir: dir, epoch: "2026-09-02T00:00:00.000Z", tickMs: TICK_MS, generation: 1, now: time.now, log: line => logs.push(line) });
    await moved.start();
    assert.match(logs[0]!, /epoch 2026-09-01T00:00:00.000Z, not 2026-09-02/);
  });

  test("without a configured epoch, a restart keeps the checkpoint's", async () => {
    const dir = await dataDir();
    const time = clock(50);
    await (await station({ dir, publisher: new FakePublisher(), now: time.now })).stop(100);
    time.to(80);
    const next = await station({ dir, publisher: new FakePublisher(), now: time.now, epoch: null });
    assert.equal(next.epoch, EPOCH);
    assert.equal(next.tick, 80);
  });
});

describe("the field station's HTTP APIs", () => {
  const time = clock(10);
  const publisher = new FakePublisher();
  const token = "service-token-".padEnd(40, "x");
  let field: FieldStation;
  let notebooks: Notebooks;
  let config: ServerConfig;
  let api: Server;
  let internal: Server;
  let apiOrigin: string;
  let internalOrigin: string;

  async function listen(server: Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No address");
    return `http://127.0.0.1:${address.port}`;
  }

  before(async () => {
    config = { ...readConfig({ FIELD_STATION_SERVICE_TOKEN: token }), siteOrigins: ["https://streamotter.dev"], gatewayOrigin: "https://demo.streamotter.dev" };
    const queue = new PublishQueue(publisher, () => undefined);
    field = new FieldStation({ queue, dataDir: await dataDir(), epoch: EPOCH, tickMs: TICK_MS, generation: 1, now: time.now, log: () => undefined });
    notebooks = new Notebooks({ queue, tenantId: "lontra-creek", now: time.now, log: () => undefined });
    api = publicApi({ config, station: field, notebooks, limiter: new RateLimiter({ burst: 5, perSecond: 0.001 }), log: () => undefined });
    internal = internalApi({ serviceToken: token, station: field, notebooks });
    apiOrigin = await listen(api);
    internalOrigin = await listen(internal);
  });

  after(async () => {
    await Promise.all([api, internal].map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  });

  test("before catching up, snapshots and health say so", async () => {
    const health = await fetch(`${apiOrigin}/healthz`);
    assert.equal(health.status, 503);
    const view = await fetch(`${internalOrigin}/internal/views/station/LC-02`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(view.status, 503);
    await field.start();
    await field.flush();
    const loading = await fetch(`${apiOrigin}/healthz`);
    assert.equal(loading.status, 503, "notebooks are still loading");
    assert.equal(((await loading.json()) as { notebooks: string }).notebooks, "loading");
    assert.equal((await fetch(`${internalOrigin}/internal/views/notebook/volunteer-12345678`, { headers: { authorization: `Bearer ${token}` } })).status, 503);
    notebooks.load([]);
    assert.equal((await fetch(`${apiOrigin}/healthz`)).status, 200);
  });

  test("the internal API serves current views to the service token only", async () => {
    const view = await fetch(`${internalOrigin}/internal/views/station/LC-02`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(view.status, 200);
    const body = await view.json() as { revision: string; data: { stationId: string } };
    assert.equal(body.revision, field.view("station:LC-02")!.revision);
    assert.equal(body.data.stationId, "LC-02");
    assert.equal((await fetch(`${internalOrigin}/internal/views/station/LC-02`)).status, 401);
    assert.equal((await fetch(`${internalOrigin}/internal/views/station/LC-02`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${internalOrigin}/internal/views/station/LC-99`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(`${internalOrigin}/internal/views/holt/A`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  });

  test("the site API answers the site's origin with credentials, and nobody else's", async () => {
    const allowed = await fetch(`${apiOrigin}/api/config`, { headers: { origin: "https://streamotter.dev" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://streamotter.dev");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
    assert.deepEqual(await allowed.json(), { gatewayOrigin: "https://demo.streamotter.dev", gatewayPath: "/streamotter/socket.io", mode: "kafka", tickMs: TICK_MS });

    const preflight = await fetch(`${apiOrigin}/api/badge`, { method: "OPTIONS", headers: { origin: "https://streamotter.dev", "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");

    const other = await fetch(`${apiOrigin}/api/config`, { headers: { origin: "https://elsewhere.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const forged = await fetch(`${apiOrigin}/api/badge`, { method: "POST", headers: { origin: "https://elsewhere.example", "content-type": "application/json" }, body: "{}" });
    assert.equal(forged.status, 403);
  });

  test("a malformed request from the site's origin gets a 400 the page can read", async () => {
    const badge = await fetch(`${apiOrigin}/api/badge`, { method: "POST", headers: { origin: "https://streamotter.dev", "content-type": "application/json", "x-client-ip": "198.51.100.39" }, body: "{}" });
    const cookie = badge.headers.get("set-cookie")!.split(";")[0]!;
    for (const path of ["/api/badge", "/api/notebook/sightings"]) {
      const response = await fetch(`${apiOrigin}${path}`, { method: "POST", headers: { origin: "https://streamotter.dev", cookie, "content-type": "application/json", "x-client-ip": "198.51.100.40" }, body: "{not json" });
      assert.equal(response.status, 400, path);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://streamotter.dev", path);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    }
    const tooLarge = await fetch(`${apiOrigin}/api/badge`, { method: "POST", headers: { origin: "https://streamotter.dev", "content-type": "application/json", "x-client-ip": "198.51.100.41" }, body: JSON.stringify({ role: "x".repeat(5_000) }) });
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.headers.get("access-control-allow-origin"), "https://streamotter.dev");
  });

  test("a badge keeps its subject for the same role and changes it for another", async () => {
    const first = await fetch(`${apiOrigin}/api/badge`, { method: "POST", headers: { origin: "https://streamotter.dev", "content-type": "application/json", "x-client-ip": "198.51.100.7" }, body: JSON.stringify({ role: "volunteer" }) });
    assert.equal(first.status, 200);
    const cookie = first.headers.get("set-cookie")!;
    assert.match(cookie, /^lc_session=[^;]+; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=1800$/);
    const firstBody = await first.json() as { token: string; badge: { subject: string } };
    assert.equal(verifyToken(firstBody.token, config.secret)?.subject, firstBody.badge.subject);

    const again = await fetch(`${apiOrigin}/api/badge`, { method: "POST", headers: { cookie: cookie.split(";")[0]!, "x-client-ip": "198.51.100.7" }, body: JSON.stringify({ role: "volunteer" }) });
    assert.equal(((await again.json()) as { badge: { subject: string } }).badge.subject, firstBody.badge.subject);
    assert.equal(again.headers.get("set-cookie"), null);

    const researcher = await fetch(`${apiOrigin}/api/badge`, { method: "POST", headers: { cookie: cookie.split(";")[0]!, "x-client-ip": "198.51.100.7" }, body: JSON.stringify({ role: "researcher" }) });
    const researcherBody = await researcher.json() as { badge: { subject: string; role: string } };
    assert.equal(researcherBody.badge.role, "researcher");
    assert.notEqual(researcherBody.badge.subject, firstBody.badge.subject);
  });

  test("production cookies are Secure", async () => {
    const secure = publicApi({ config: { ...config, production: true }, station: field, notebooks, log: () => undefined });
    const origin = await listen(secure);
    const response = await fetch(`${origin}/api/badge`, { method: "POST", body: "{}" });
    assert.match(response.headers.get("set-cookie")!, /; Secure$/);
    await new Promise(resolve => {
      secure.close(resolve);
      secure.closeAllConnections();
    });
  });

  test("each client has a request budget", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await fetch(`${apiOrigin}/api/status`, { headers: { "x-client-ip": "203.0.113.9" } })).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
    assert.equal((await fetch(`${apiOrigin}/api/status`, { headers: { "x-client-ip": "203.0.113.10" } })).status, 200);
  });

  test("a visitor logs sightings in their own notebook, and only there", async () => {
    const headers = (ip: string, cookie?: string): Record<string, string> => ({
      origin: "https://streamotter.dev", "content-type": "application/json", "x-client-ip": ip, ...(cookie === undefined ? {} : { cookie })
    });
    const sighting = JSON.stringify({ otterId: "LO-07", reachId: "kestrel-bend", activity: "foraging" });
    assert.equal((await fetch(`${apiOrigin}/api/notebook/sightings`, { method: "POST", headers: headers("192.0.2.1"), body: sighting })).status, 401);

    const badge = await fetch(`${apiOrigin}/api/badge`, { method: "POST", headers: headers("192.0.2.1"), body: JSON.stringify({ role: "volunteer" }) });
    const cookie = badge.headers.get("set-cookie")!.split(";")[0]!;
    const { badge: { subject } } = await badge.json() as { badge: { subject: string } };

    const logged = await fetch(`${apiOrigin}/api/notebook/sightings`, { method: "POST", headers: headers("192.0.2.1", cookie), body: sighting });
    assert.equal(logged.status, 200);
    const body = await logged.json() as { observerId: string; revision: string; entries: number };
    assert.equal(body.observerId, subject);
    assert.equal(body.entries, 1);

    const tooSoon = await fetch(`${apiOrigin}/api/notebook/sightings`, { method: "POST", headers: headers("192.0.2.2", cookie), body: sighting });
    assert.equal(tooSoon.status, 429);
    const freeText = await fetch(`${apiOrigin}/api/notebook/sightings`, { method: "POST", headers: headers("192.0.2.2", cookie), body: JSON.stringify({ otterId: "LO-07", reachId: "kestrel-bend", activity: "saw it at my house" }) });
    assert.equal(freeText.status, 400);
    const foreign = await fetch(`${apiOrigin}/api/notebook/sightings`, { method: "POST", headers: { ...headers("192.0.2.3", cookie), origin: "https://elsewhere.example" }, body: sighting });
    assert.equal(foreign.status, 403);

    const snapshot = await fetch(`${internalOrigin}/internal/views/notebook/${subject}`, { headers: { authorization: `Bearer ${token}` } });
    const view = await snapshot.json() as { revision: string; data: { observerId: string; status: string; entries: { otterId: string; at: { day: number; time: string } }[] } };
    assert.equal(view.revision, body.revision);
    assert.equal(view.data.status, "open");
    assert.deepEqual(view.data.entries.map(entry => entry.otterId), ["LO-07"]);
    assert.deepEqual(view.data.entries[0]!.at, { day: 1, time: "05:50" });

    const nobody = await (await fetch(`${internalOrigin}/internal/views/notebook/volunteer-00000000`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(nobody, { revision: "0", data: { observerId: "volunteer-00000000", status: "open", entries: [] } });

    const published = publisher.batches.flatMap(batch => batch.records).filter(record => record.topic === "field.notebooks");
    assert.ok(published.some(record => record.key === `notebook:${subject}`), "the notebook went to field.notebooks, keyed by observer");
  });

  test("status reports the study clock and Kafka", async () => {
    const status = await (await fetch(`${apiOrigin}/api/status`, { headers: { "x-client-ip": "203.0.113.11" } })).json() as Record<string, unknown>;
    assert.deepEqual(status, { mode: "kafka", tick: 10, studyDay: 1, studyTime: "05:50", generation: 1, kafka: "connected", pending: 0 });
  });
});

describe("configuration from the environment", () => {
  const production = {
    NODE_ENV: "production",
    FIELD_STATION_SECRET: "s".repeat(32),
    FIELD_STATION_SERVICE_TOKEN: "t".repeat(32),
    FIELD_EPOCH: "2026-10-01T00:00:00Z",
    SITE_ORIGIN: "https://streamotter.dev",
    GATEWAY_PUBLIC_ORIGIN: "https://demo.streamotter.dev",
    KAFKA_BROKERS: "kafka:9094",
    KAFKA_CA_FILE: "/etc/lontra/kafka/ca.pem",
    KAFKA_FIELD_STATION_USERNAME: "field-station",
    KAFKA_FIELD_STATION_PASSWORD: "p"
  };

  test("production reads everything it needs", () => {
    const config = readConfig(production);
    assert.equal(config.epoch, "2026-10-01T00:00:00.000Z");
    assert.deepEqual(config.kafka, { brokers: ["kafka:9094"], caFile: "/etc/lontra/kafka/ca.pem", sasl: { username: "field-station", password: "p" } });
    assert.deepEqual(config.siteOrigins, ["https://streamotter.dev"]);
  });

  test("production refuses to run without its epoch, TLS, SCRAM, or origins", () => {
    for (const name of ["FIELD_EPOCH", "KAFKA_CA_FILE", "KAFKA_FIELD_STATION_USERNAME", "SITE_ORIGIN", "GATEWAY_PUBLIC_ORIGIN", "FIELD_STATION_SECRET"]) {
      const env: Record<string, string> = { ...production };
      delete env[name];
      assert.throws(() => readConfig(env), Error, name);
    }
    assert.throws(() => readConfig({ ...production, FIELD_EPOCH: "soon" }), /ISO 8601/);
    assert.throws(() => readConfig({ ...production, FIELD_TICK_MS: "5" }), /FIELD_TICK_MS/);
  });

  test("production takes one exact site origin, as Caddy matches it; development may list several", () => {
    for (const origin of ["https://streamotter.dev,https://localhost:8443", "https://streamotter.dev, https://localhost:8443", "https://streamotter.dev/", "streamotter.dev"]) {
      assert.throws(() => readConfig({ ...production, SITE_ORIGIN: origin }), /one exact origin/, origin);
    }
    assert.deepEqual(readConfig({ SITE_ORIGIN: "http://127.0.0.1:4321,http://localhost:4321" }).siteOrigins, ["http://127.0.0.1:4321", "http://localhost:4321"]);
  });

  test("development needs nothing", () => {
    const config = readConfig({});
    assert.equal(config.epoch, null);
    assert.deepEqual(config.kafka, { brokers: ["127.0.0.1:19092"], caFile: null, sasl: null });
    assert.equal(config.production, false);
  });
});
