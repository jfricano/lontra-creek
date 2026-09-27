import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { after, before, describe, test } from "node:test";
import { createWorld, currentEmissions } from "@lontra-creek/sim";
import { validateProjectConfig, type Json, type SourceRecord } from "streamotter/contracts";
import { createGateway } from "streamotter/gateway";
import { benchConfig, benchHandlers } from "../src/lab/bench.ts";
import { bench, benches, CREEK_TOPICS } from "../src/lab/benches.ts";
import { relayControl, startRelay, type Relay } from "../src/lab/relay.ts";
import { projectConfig } from "../src/project.ts";
import { toRecord } from "../src/records.ts";
import { readConfig } from "../src/server/config.ts";
import { benchTopicConfigs, withBenchCopies } from "../src/server/kafka.ts";

const context = { requestId: "test", signal: new AbortController().signal };
const handlerOptions = { secret: "s".repeat(32), serviceToken: "t".repeat(32), internalOrigin: "http://field-station:7410" };

describe("bench names", () => {
  test("each bench has its own project, topics, group, relay, and path", () => {
    assert.deepEqual(bench(2), {
      number: 2,
      projectId: "lontra-creek-lab-2",
      topicPrefix: "lab-2.",
      topics: CREEK_TOPICS.map(topic => `lab-2.${topic}`),
      consumerGroup: "lontra-creek-lab-2-field",
      relayHost: "lab-2-kafka",
      relayPort: 9102,
      gatewayPath: "/lab/2/socket.io"
    });
    assert.deepEqual(benches(3).map(each => each.number), [1, 2, 3]);
    assert.deepEqual(benches(0), []);
    assert.throws(() => bench(0), RangeError);
    assert.throws(() => benches(10), RangeError);
  });

  test("the field station publishes bench copies only when asked", () => {
    assert.equal(readConfig({}).labBenches, 0);
    assert.equal(readConfig({ FIELD_LAB_BENCHES: "3" }).labBenches, 3);
    assert.throws(() => readConfig({ FIELD_LAB_BENCHES: "10" }), /at most 9/);
  });
});

describe("the benches' feed", () => {
  test("every creek record is copied to each bench's topic, with the same key and value", () => {
    const records = [
      { topic: "field.gauges", key: "station:LC-02", value: "{}" },
      { topic: "creek.overview", key: "creekOverview:lontra-creek", value: "{\"a\":1}" },
      { topic: "field.notebooks", key: "notebook:someone", value: "{}" }
    ];
    assert.deepEqual(withBenchCopies(records, []), records);
    assert.deepEqual(withBenchCopies(records, ["lab-1.", "lab-2."]), [
      ...records,
      { topic: "lab-1.field.gauges", key: "station:LC-02", value: "{}" },
      { topic: "lab-1.creek.overview", key: "creekOverview:lontra-creek", value: "{\"a\":1}" },
      { topic: "lab-2.field.gauges", key: "station:LC-02", value: "{}" },
      { topic: "lab-2.creek.overview", key: "creekOverview:lontra-creek", value: "{\"a\":1}" }
    ]);
  });

  test("each bench gets the creek topics, and no notebooks", () => {
    const topics = benchTopicConfigs(["lab-1."]);
    assert.deepEqual(topics.map(config => config.topic), bench(1).topics);
    assert.ok(topics.every(config => config.numPartitions === 3));
  });
});

describe("a bench's project", () => {
  test("is valid, separate from the demo host's, and reads its own topics through its relay", () => {
    const config = benchConfig(1);
    assert.deepEqual(validateProjectConfig(config).issues, []);
    assert.equal(config.projectId, "lontra-creek-lab-1");
    assert.notEqual(config.projectId, projectConfig("production").projectId);
    assert.equal(config.gateway.path, "/lab/1/socket.io");
    assert.deepEqual(config.connections["field"]?.brokers, ["lab-1-kafka:9101"]);
    assert.equal(config.connections["field"]?.sasl?.username.env, "KAFKA_LAB_USERNAME");
    const source = config.sources["field"];
    assert.equal(source?.kind, "kafka");
    if (source?.kind === "kafka") {
      assert.deepEqual(source.topics, bench(1).topics);
      assert.equal(source.consumerGroup, "lontra-creek-lab-1-field");
    }
    assert.deepEqual(Object.keys(config.channels).sort(), ["creekOverview", "holt", "otter", "reach", "station"]);
    assert.deepEqual(benchConfig(1, { brokers: ["localhost:8443"], port: 7500 }).connections["field"]?.brokers, ["localhost:8443"]);
  });

  test("runs as a development-mode gateway with the creek's handlers", () => {
    assert.doesNotThrow(() => createGateway({ config: benchConfig(1), handlers: benchHandlers(1, handlerOptions), mode: "development" }));
  });

  test("maps records from its own topics and refuses the demo host's", async () => {
    const handlers = benchHandlers(1, handlerOptions);
    const emission = currentEmissions(createWorld({ seed: "lontra-creek" })).find(each => each.key === "station:LC-02")!;
    const record = (topic: string): SourceRecord => ({
      id: `${topic}/0/1`, sourceId: "field", key: emission.key, value: toRecord(emission).value as unknown as Json,
      receivedAt: new Date().toISOString(), position: { kind: "kafka", topic, partition: 0, offset: "1" }
    });
    const mapped = await handlers.channels.station.map({ ...context, record: record("lab-1.field.gauges") });
    assert.equal(mapped.length, 1);
    await assert.rejects(async () => handlers.channels.station.map({ ...context, record: record("field.gauges") }), /expected lab-1\.field\.gauges/);
  });
});

describe("a bench's relay", () => {
  let upstream: Server;
  let relay: Relay;
  let control: HttpServer;
  let controlOrigin: string;
  const controlToken = "c".repeat(32);

  before(async () => {
    // An echo server stands in for the broker's bench listener.
    upstream = createServer(socket => socket.pipe(socket));
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    relay = await startRelay({ listen: { host: "127.0.0.1", port: 0 }, target: { host: "127.0.0.1", port: (upstream.address() as AddressInfo).port } });
    control = relayControl(relay, controlToken);
    await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
    controlOrigin = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  });

  after(async () => {
    await relay.close();
    control.closeAllConnections();
    await new Promise<void>(resolve => control.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });

  function open(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  function echo(socket: Socket, text: string): Promise<string> {
    return new Promise(resolve => {
      socket.once("data", data => resolve(data.toString("utf8")));
      socket.write(text);
    });
  }

  const call = (method: string, path: string, token = controlToken) =>
    fetch(`${controlOrigin}${path}`, { method, headers: { authorization: `Bearer ${token}` } });

  test("relays both ways", async () => {
    const socket = await open(relay.port!);
    assert.equal(await echo(socket, "hello"), "hello");
    socket.destroy();
  });

  test("a cut resets what it carries and refuses new connections; a restore accepts them again on the same port", async () => {
    const port = relay.port!;
    const socket = await open(port);
    assert.equal(await echo(socket, "before"), "before");
    const closed = new Promise<string>(resolve => {
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
      socket.once("close", () => resolve("closed"));
    });

    const cut = await call("POST", "/cut");
    assert.equal(cut.status, 200);
    assert.deepEqual(await cut.json(), { state: "cut", connections: 0 });
    assert.equal(await closed, "ECONNRESET");
    await assert.rejects(open(port), (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED");

    const restored = await call("POST", "/restore");
    assert.deepEqual(await restored.json(), { state: "open", connections: 0 });
    const again = await open(port);
    assert.equal(await echo(again, "after"), "after");
    assert.deepEqual(await (await call("GET", "/state")).json(), { state: "open", connections: 1 });
    again.destroy();
  });

  test("the control API needs its token", async () => {
    assert.equal((await call("POST", "/cut", "x".repeat(32))).status, 401);
    assert.equal((await fetch(`${controlOrigin}/state`)).status, 401);
    assert.equal((await call("DELETE", "/state")).status, 404);
    assert.equal(relay.state, "open");
    assert.throws(() => relayControl(relay, "short"), /at least 32/);
  });
});
