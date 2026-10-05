import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createWorld, currentEmissions, TOPICS, type ChannelName } from "@lontra-creek/sim";
import type { Json, Principal, SourceRecord } from "streamotter/contracts";
import { mayRead } from "../src/access.ts";
import { issueToken, type Badge } from "../src/identity.ts";
import { createKafkaHandlers, kafkaHandlerOptions } from "../src/kafka-handlers.ts";
import { toRecord } from "../src/records.ts";

const appDir = join(import.meta.dirname, "..");
const cli = join(appDir, "../../node_modules/streamotter/bin/streamotter.js");
const secret = "s".repeat(32);
const token = "t".repeat(32);
const context = { requestId: "test", signal: new AbortController().signal };

function principal(role: "volunteer" | "researcher"): Principal {
  return { subject: `${role}-1`, tenantId: "lontra-creek", sessionId: "session-1", expiresAt: "2099-01-01T00:00:00.000Z", claims: { role, name: role } };
}

function kafkaRecord(value: Json, topic: string): SourceRecord {
  return { id: `${topic}/0/1`, sourceId: "field", key: null, value, receivedAt: new Date().toISOString(), position: { kind: "kafka", topic, partition: 0, offset: "1" } };
}

const world = createWorld({ seed: "lontra-creek" });
const emissions = new Map(currentEmissions(world).map(emission => [emission.key, emission]));
function recordFor(key: string, topic?: string): SourceRecord {
  const emission = emissions.get(key)!;
  return kafkaRecord(toRecord(emission).value as unknown as Json, topic ?? emission.topic);
}

describe("access rules", () => {
  const channels: ChannelName[] = ["creekOverview", "station", "otter", "reach", "holt"];

  test("volunteers read everything but den sites", () => {
    for (const channel of channels) assert.equal(mayRead(channel, principal("volunteer"), {}), channel !== "holt", channel);
  });

  test("researchers read everything", () => {
    for (const channel of channels) assert.equal(mayRead(channel, principal("researcher"), {}), true, channel);
  });

  test("a principal without a role is not a researcher", () => {
    const anonymous = { ...principal("volunteer"), claims: {} };
    assert.equal(mayRead("holt", anonymous, {}), false);
    assert.equal(mayRead("station", anonymous, {}), true);
  });

  test("a notebook is for its owner alone, whatever their role", () => {
    for (const role of ["volunteer", "researcher"] as const) {
      const reader = principal(role);
      assert.equal(mayRead("notebook", reader, { observerId: reader.subject }), true, role);
      assert.equal(mayRead("notebook", reader, { observerId: "someone-else" }), false, role);
    }
  });
});

describe("the Kafka handlers", () => {
  const requests: { url: string; authorization: string | null; signal: AbortSignal | null }[] = [];
  let reply: () => Response = () => new Response("{}", { status: 500 });
  const handlers = createKafkaHandlers({
    secret,
    serviceToken: token,
    internalOrigin: "http://field-station:7410",
    fetch: async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), signal: init?.signal ?? null });
      return reply();
    }
  });

  test("authenticate accepts a signed badge and refuses anything else", async () => {
    const badge: Badge = { subject: "volunteer-abc", role: "volunteer", name: "Volunteer" };
    const signed = issueToken(badge, { secret, ttlSeconds: 60 }).token;
    assert.equal((await handlers.authenticate({ ...context, token: signed, origin: "https://streamotter.dev" }))?.subject, "volunteer-abc");
    const forged = issueToken(badge, { secret: "f".repeat(32), ttlSeconds: 60 }).token;
    assert.equal(await handlers.authenticate({ ...context, token: forged, origin: "https://streamotter.dev" }), null);
  });

  test("authorize follows the access rules", async () => {
    assert.equal(await handlers.channels.holt.authorize({ ...context, principal: principal("volunteer"), params: { holtId: "A" } }), false);
    assert.equal(await handlers.channels.holt.authorize({ ...context, principal: principal("researcher"), params: { holtId: "A" } }), true);
    assert.equal(await handlers.channels.station.authorize({ ...context, principal: principal("volunteer"), params: { stationId: "LC-02" } }), true);
  });

  test("each channel's map keeps its own records and passes over the others", async () => {
    const record = recordFor("station:LC-02");
    const [mapped, ...rest] = await handlers.channels.station.map({ ...context, record });
    assert.equal(rest.length, 0);
    assert.deepEqual(mapped?.params, { stationId: "LC-02" });
    assert.equal(mapped?.tenantId, "lontra-creek");
    assert.equal(mapped?.revision, "1000000000000");
    assert.equal(mapped?.data.stationId, "LC-02");
    assert.deepEqual(await handlers.channels.otter.map({ ...context, record }), []);
    assert.deepEqual(await handlers.channels.holt.map({ ...context, record }), []);
  });

  test("an unreadable record pauses the source instead of being skipped", () => {
    assert.throws(() => handlers.channels.station.map({ ...context, record: kafkaRecord({ hello: "world" }, TOPICS.station) }), /not a field station record/);
    assert.throws(() => handlers.channels.station.map({ ...context, record: kafkaRecord("text", TOPICS.station) }), /not a field station record/);
  });

  test("a view on another channel's topic pauses the source", () => {
    const misplaced = recordFor("holt:A", TOPICS.station);
    assert.throws(() => handlers.channels.otter.map({ ...context, record: misplaced }), /holt view on field.gauges/);
  });

  test("snapshot reads the field station's internal API with the service token and the handler's signal", async () => {
    const emission = emissions.get("station:LC-02")!;
    reply = () => Response.json({ revision: emission.revision, data: emission.data });
    const controller = new AbortController();
    const snapshot = await handlers.channels.station.snapshot({ ...context, signal: controller.signal, principal: principal("volunteer"), params: { stationId: "LC-02" } });
    assert.equal(snapshot.revision, emission.revision);
    assert.deepEqual(snapshot.data, emission.data);
    const last = requests.at(-1)!;
    assert.equal(last.url, "http://field-station:7410/internal/views/station/LC-02");
    assert.equal(last.authorization, `Bearer ${token}`);
    assert.equal(last.signal, controller.signal);
  });

  test("snapshot fails on a missing view, an error, or a malformed answer", async () => {
    const params = { holtId: "A" } as const;
    for (const answer of [() => new Response("{}", { status: 404 }), () => new Response("{}", { status: 503 }), () => Response.json({ data: {} })]) {
      reply = answer;
      await assert.rejects(Promise.resolve(handlers.channels.holt.snapshot({ ...context, principal: principal("researcher"), params })));
    }
  });

  test("production needs both secrets", () => {
    assert.throws(() => kafkaHandlerOptions({ NODE_ENV: "production", FIELD_STATION_SECRET: secret }), /FIELD_STATION_SERVICE_TOKEN/);
    assert.throws(() => kafkaHandlerOptions({ NODE_ENV: "production", FIELD_STATION_SERVICE_TOKEN: token }), /FIELD_STATION_SECRET/);
    const options = kafkaHandlerOptions({ NODE_ENV: "production", FIELD_STATION_SECRET: secret, FIELD_STATION_SERVICE_TOKEN: token, FIELD_STATION_INTERNAL_URL: "http://field-station:7410/" });
    assert.equal(options.internalOrigin, "http://field-station:7410");
  });
});

describe("streamotter start with the compiled handlers", () => {
  const build = spawnSync(process.execPath, [join(appDir, "../../node_modules/typescript/bin/tsc"), "-p", join(appDir, "tsconfig.build.json")], { encoding: "utf8" });

  function start(env: NodeJS.ProcessEnv): { status: number | null; output: string } {
    const result = spawnSync(process.execPath, [cli, "start", "--config", "streamotter.production.json", "--handlers", "dist/kafka-handlers.js"], {
      cwd: appDir,
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: process.env["PATH"], NODE_ENV: "production", ...env }
    });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  test("the handlers compile", () => {
    assert.equal(build.status, 0, build.stdout + build.stderr);
  });

  test("without its secrets, the gateway refuses to load the handlers", () => {
    const { status, output } = start({});
    assert.equal(status, 1, output);
    assert.match(output, /FIELD_STATION_SECRET/);
  });

  test("with them, it loads the handlers and stops at the missing Kafka CA without printing secrets", () => {
    const { status, output } = start({
      FIELD_STATION_SECRET: secret,
      FIELD_STATION_SERVICE_TOKEN: token,
      KAFKA_GATEWAY_USERNAME: "gateway",
      KAFKA_GATEWAY_PASSWORD: "kafka-password-that-must-not-be-printed"
    });
    assert.equal(status, 2, output);
    assert.match(output, /ca\.pem/);
    assert.doesNotMatch(output, /kafka-password-that-must-not-be-printed|s{32}|t{32}/);
  });
});
