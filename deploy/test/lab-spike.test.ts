/**
 * The relay-cut spike (E2.0): a Failure Lab bench's path to Kafka is cut and
 * restored while the demo host's gateway keeps serving. CI runs it against
 * deploy/compose.yaml with deploy/compose.lab-spike.yaml (.github/workflows/lab-spike.yml):
 *
 *   LAB_PROXY_TOKEN=<relay token> STACK_ORIGIN=https://demo.streamotter.app \
 *   NODE_EXTRA_CA_CERTS=<test origin CA> node --test deploy/test/lab-spike.test.ts
 *
 * Each cycle cuts the bench's proxy, measures how long the bench's subscription
 * takes to go stale, restores the proxy, and measures how long it takes to be live
 * again from a fresh snapshot. The acceptance bounds are 20 and 30 seconds;
 * StreamOtter 0.1.0-rc.3 marks a Kafka source degraded after 12 seconds without
 * broker activity.
 *
 * Environment: LAB_PROXY_TOKEN (required), LAB_PROXY_CONTROL (default
 * http://127.0.0.1:9180), LAB_BENCH_ORIGIN (default http://127.0.0.1:7500),
 * LAB_BENCH_PATH (default /lab/1/socket.io), LAB_BADGE_ORIGIN (where /api/badge
 * answers; default STACK_ORIGIN), SITE_ORIGIN (default https://streamotter.app),
 * STACK_ORIGIN (the demo host through Caddy; without it the demo host's gateway
 * isn't watched), LAB_STOP_PROXY and LAB_START_PROXY (shell commands that stop and
 * start the proxy's container; without them that cycle skips), LAB_SPIKE_LONG_CUT_MS
 * (default 45000), LAB_SPIKE_LABEL (where it ran), and LAB_SPIKE_RESULTS (a file
 * to append each cycle's timings to, as JSON lines).
 */
import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { appendFile } from "node:fs/promises";
import https from "node:https";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { createClient, type Client, type StreamEvent, type Subscription, type SubscriptionState } from "streamotter/client";
import type { AppChannels } from "../../apps/field-station/src/generated/streamotter.generated.ts";

const PROXY_TOKEN = process.env["LAB_PROXY_TOKEN"];
const PROXY_CONTROL = process.env["LAB_PROXY_CONTROL"] ?? "http://127.0.0.1:9180";
const BENCH_ORIGIN = process.env["LAB_BENCH_ORIGIN"] ?? "http://127.0.0.1:7500";
const BENCH_PATH = process.env["LAB_BENCH_PATH"] ?? "/lab/1/socket.io";
const STACK = process.env["STACK_ORIGIN"];
const BADGES = process.env["LAB_BADGE_ORIGIN"] ?? STACK ?? "https://demo.streamotter.app";
const SITE = process.env["SITE_ORIGIN"] ?? "https://streamotter.app";
const STOP_PROXY = process.env["LAB_STOP_PROXY"];
const START_PROXY = process.env["LAB_START_PROXY"];
const LONG_CUT_MS = Number(process.env["LAB_SPIKE_LONG_CUT_MS"] ?? 45_000);
const LABEL = process.env["LAB_SPIKE_LABEL"] ?? "local";
const RESULTS = process.env["LAB_SPIKE_RESULTS"];
const STALE_WITHIN_MS = 20_000;
const LIVE_WITHIN_MS = 30_000;
const run = promisify(exec);

// Production gateways require the browser's Origin, which Node's WebSocket client
// doesn't send (see deploy/test/stack.test.ts). The bench is in development mode.
const request = https.request;
https.request = ((...args: unknown[]) => {
  const options = args[0];
  if (typeof options === "object" && options !== null && !(options instanceof URL)) {
    const headers = (options as https.RequestOptions).headers as Record<string, unknown> | undefined;
    if (headers?.["Upgrade"] === "websocket") headers["Origin"] = SITE;
  }
  return (request as (...forwarded: unknown[]) => ReturnType<typeof https.request>)(...args);
}) as typeof https.request;

async function badge(): Promise<string> {
  const response = await fetch(`${BADGES}/api/badge`, {
    method: "POST",
    headers: { origin: SITE, "content-type": "application/json" },
    body: JSON.stringify({ role: "volunteer" })
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as { token: string }).token;
}

async function proxy(action: "cut" | "restore" | "state"): Promise<{ state: string; connections: number }> {
  const response = await fetch(`${PROXY_CONTROL}/${action}`, {
    method: action === "state" ? "GET" : "POST",
    headers: { authorization: `Bearer ${PROXY_TOKEN}` }
  });
  assert.equal(response.status, 200, `proxy ${action}`);
  return await response.json() as { state: string; connections: number };
}

async function until(check: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One subscription to LC-02, with every state change and event timed. */
class Watch {
  readonly states: { state: SubscriptionState; reason: string | undefined; at: number }[] = [];
  readonly events: { event: StreamEvent<AppChannels["station"]["data"]>; at: number }[] = [];
  readonly subscription: Subscription<AppChannels["station"]["data"]>;

  constructor(client: Client<AppChannels>) {
    this.subscription = client.subscribe("station", { channelVersion: 1, params: { stationId: "LC-02" } });
    this.subscription.on("state", ({ state, reason }) => this.states.push({ state, reason, at: Date.now() }));
    this.subscription.on("data", event => this.events.push({ event, at: Date.now() }));
  }

  firstState(state: SubscriptionState, since: number) {
    return this.states.find(entry => entry.state === state && entry.at >= since);
  }

  eventsBetween(from: number, to: number) {
    return this.events.filter(entry => entry.at >= from && entry.at <= to);
  }
}

const clients: Client<AppChannels>[] = [];
after(async () => {
  if (PROXY_TOKEN !== undefined) await proxy("restore").catch(() => undefined);
  await Promise.all(clients.map(client => client.close()));
});

interface Cycle {
  name: string;
  /** How long the path stays cut, from the cut; 0 restores as soon as the bench is stale. */
  holdMs: number;
  cut: () => Promise<void>;
  restore: () => Promise<void>;
}

describe("a Failure Lab bench whose proxy to Kafka is cut", { skip: PROXY_TOKEN === undefined && "LAB_PROXY_TOKEN is not set" }, () => {
  let bench: Watch;
  let demo: Watch | null = null;

  before(async () => {
    const benchClient = createClient<AppChannels>({ origin: BENCH_ORIGIN, path: BENCH_PATH, getToken: badge });
    clients.push(benchClient);
    bench = new Watch(benchClient);
    if (STACK !== undefined) {
      const config = await (await fetch(`${STACK}/api/config`, { headers: { origin: SITE } })).json() as { gatewayOrigin: string; gatewayPath: string };
      const demoClient = createClient<AppChannels>({ origin: config.gatewayOrigin, path: config.gatewayPath, getToken: badge });
      clients.push(demoClient);
      demo = new Watch(demoClient);
      await demo.subscription.ready({ timeoutMs: 30_000 });
    }
    await bench.subscription.ready({ timeoutMs: 30_000 });
    assert.equal(bench.events[0]?.event.kind, "snapshot");
    await until(() => bench.events.length >= 3, "live readings on the bench", 20_000);
  });

  async function measure(cycle: Cycle): Promise<void> {
    const before = await proxy("state");
    const demoStates = demo?.states.length ?? 0;
    const cutAt = Date.now();
    await cycle.cut();
    const cutDone = Date.now();

    await until(() => bench.firstState("stale", cutAt) !== undefined, "the bench to go stale", STALE_WITHIN_MS + 10_000);
    const stale = bench.firstState("stale", cutAt)!;
    await sleep(Math.max(0, cutAt + cycle.holdMs - Date.now()));
    assert.equal(bench.subscription.state, "stale", "the bench stays stale while cut");

    const restoreAt = Date.now();
    await cycle.restore();
    await until(() => {
      const live = bench.firstState("live", restoreAt);
      return live !== undefined && bench.events.some(entry => entry.at >= restoreAt && entry.event.kind === "snapshot");
    }, "the bench to be live again", LIVE_WITHIN_MS + 30_000);
    const live = bench.firstState("live", restoreAt)!;
    const snapshot = bench.events.find(entry => entry.at >= restoreAt && entry.event.kind === "snapshot")!;
    const lastBefore = bench.events.filter(entry => entry.at < cutAt).at(-1)!;

    const result = {
      where: LABEL,
      cycle: cycle.name,
      cutLengthMs: restoreAt - cutAt,
      staleAfterCutMs: stale.at - cutAt,
      staleReason: stale.reason,
      liveAfterRestoreMs: live.at - restoreAt,
      connectionsCut: before.connections,
      cutCommandMs: cutDone - cutAt,
      demoReadingsDuringCut: demo === null ? null : demo.eventsBetween(cutAt, restoreAt).length,
      demoStatesDuringCycle: demo === null ? null : demo.states.slice(demoStates).map(entry => entry.state)
    };
    console.log(JSON.stringify(result));
    if (RESULTS !== undefined) await appendFile(RESULTS, `${JSON.stringify(result)}\n`);

    assert.equal(stale.reason, "SOURCE_UNAVAILABLE");
    assert.ok(result.staleAfterCutMs <= STALE_WITHIN_MS, `stale ${result.staleAfterCutMs} ms after the cut`);
    assert.ok(result.liveAfterRestoreMs <= LIVE_WITHIN_MS, `live ${result.liveAfterRestoreMs} ms after the restore`);
    assert.ok(BigInt(snapshot.event.revision) > BigInt(lastBefore.event.revision), "the fresh snapshot is newer than what was shown before the cut");
    if (demo !== null) {
      assert.deepEqual(result.demoStatesDuringCycle, [], "the demo host's view never changed state");
      assert.equal(demo.subscription.state, "live");
      assert.ok(result.demoReadingsDuringCut! >= Math.floor(result.cutLengthMs / 2_000) - 2, "the demo host kept receiving readings");
    }

    // Settle: readings flow again before the next cycle.
    const settled = bench.events.length;
    await until(() => bench.events.length >= settled + 2, "readings after the restore", 20_000);
    assert.equal(bench.subscription.state, "live");
  }

  const proxyCut = { cut: async () => { assert.equal((await proxy("cut")).state, "cut"); }, restore: async () => { assert.equal((await proxy("restore")).state, "open"); } };

  test("cut, then restored as soon as the bench is stale", async () => {
    await measure({ name: "proxy cut, restored at stale", holdMs: 0, ...proxyCut });
  });

  test(`cut for ${LONG_CUT_MS / 1_000} seconds, longer than the consumer's session`, async () => {
    await measure({ name: `proxy cut for ${LONG_CUT_MS / 1_000} s`, holdMs: LONG_CUT_MS, ...proxyCut });
  });

  test("cut again, restored at stale: repeatable", async () => {
    await measure({ name: "proxy cut again, restored at stale", holdMs: 0, ...proxyCut });
  });

  test("the proxy's container stopped, then started", { skip: (STOP_PROXY === undefined || START_PROXY === undefined) && "LAB_STOP_PROXY and LAB_START_PROXY are not set" }, async () => {
    await measure({
      name: "proxy container stopped, started at stale",
      holdMs: 0,
      cut: async () => { await run(STOP_PROXY!, { timeout: 60_000 }); },
      restore: async () => { await run(START_PROXY!, { timeout: 60_000 }); }
    });
  });
});
