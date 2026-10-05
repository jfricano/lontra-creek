import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChannelMap, Client, ClientOptions, ConnectionState, Json, StateChange, StreamError, StreamEvent, Subscription, SubscriptionState, Unlisten } from "streamotter/client";
import type { FieldConfig } from "../src/scripts/field-api.ts";

// field-client.ts installs its "tablet network" against `window.WebSocket` as soon as
// it loads (see tablet-network.ts). Stub just enough of `window` before the dynamic
// import below so this module can load under Node, which has no `window`.
class StubWebSocket {
  addEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { window: { WebSocket: typeof StubWebSocket } }).window = { WebSocket: StubWebSocket };

const { PageFieldClient, UNREACHABLE_AFTER_MS } = await import("../src/scripts/field-client.ts");
const { SIGN_IN_RETRY_BASE_MS, SIGN_IN_RETRY_CAP_MS, isTransientFailure, HttpStatusError } = await import("../src/scripts/sign-in-retry.ts");

/** Stands in for the SDK's subscription: just enough for field-views.ts's observe() to wrap it. */
class FakeSubscription implements Subscription<Json> {
  readonly id = "sub-1";
  readonly state: SubscriptionState = "idle";

  on(event: "data", listener: (event: StreamEvent<Json>) => void): Unlisten;
  on(event: "state", listener: (change: StateChange<SubscriptionState>) => void): Unlisten;
  on(event: "error", listener: (error: StreamError) => void): Unlisten;
  on(): Unlisten {
    return () => undefined;
  }

  async ready(): Promise<void> {}
  async resync(): Promise<void> {}
  async unsubscribe(): Promise<void> {}
}

/** Stands in for the SDK's connection: the test drives its "state" the way the SDK would. */
class FakeClient implements Client<ChannelMap> {
  state: ConnectionState = "idle";
  readonly #stateListeners = new Set<(change: StateChange<ConnectionState>) => void>();

  subscribe(): Subscription<Json> {
    return new FakeSubscription();
  }

  on(event: "state", listener: (state: StateChange<ConnectionState>) => void): Unlisten;
  on(event: "error", listener: (error: StreamError) => void): Unlisten;
  on(event: "state" | "error", listener: ((state: StateChange<ConnectionState>) => void) | ((error: StreamError) => void)): Unlisten {
    if (event !== "state") return () => undefined;
    const stateListener = listener as (state: StateChange<ConnectionState>) => void;
    this.#stateListeners.add(stateListener);
    return () => this.#stateListeners.delete(stateListener);
  }

  reconnects = 0;
  getToken: ClientOptions["getToken"] | undefined;
  /** Set to make the next reconnect() sign in for real and reject when that fails, as the SDK does. */
  signInOnReconnect = false;

  async reconnect(): Promise<void> {
    this.reconnects += 1;
    if (!this.signInOnReconnect) return;
    this.signInOnReconnect = false;
    await this.signIn();
    if (this.state !== "connected") throw new Error("auth-required");
  }
  async close(): Promise<void> {}

  /** Asks for a token and then reports the outcome the way the SDK does: auth-required on any failure. */
  async signIn(): Promise<void> {
    this.emitState("connecting");
    try {
      await this.getToken!({ signal: new AbortController().signal });
      this.emitState("connected");
    } catch {
      this.emitState("auth-required");
    }
  }

  /** Drives the client the way the SDK would when it tries to connect. */
  emitState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.#stateListeners]) listener({ state });
  }
}

const CONFIG: FieldConfig = { gatewayOrigin: "https://field-station.test", gatewayPath: "/socket", mode: "fixture", tickMs: 100 };

function setup(): { client: FakeClient; field: InstanceType<typeof PageFieldClient> } {
  const client = new FakeClient();
  const createClient = <C extends ChannelMap>(options: ClientOptions): Client<C> => {
    client.getToken = options.getToken;
    return client as unknown as Client<C>;
  };
  const field = new PageFieldClient(CONFIG, createClient, "volunteer");
  return { client, field };
}

describe("field client unreachable timer", () => {
  test("no unreachable event fires before the first watch(), even long past UNREACHABLE_AFTER_MS", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { field } = setup();
    let unreachable = 0;
    field.on("unreachable", () => {
      unreachable += 1;
    });

    // The client was just created; nothing has watched a channel yet.
    t.mock.timers.tick(UNREACHABLE_AFTER_MS * 4);
    assert.equal(unreachable, 0);
  });

  test("the countdown starts on the first watch(), not on client creation", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { field } = setup();
    let unreachable = 0;
    field.on("unreachable", () => {
      unreachable += 1;
    });

    // Time passes with nothing watched yet; this must not count toward the timer.
    t.mock.timers.tick(UNREACHABLE_AFTER_MS * 4);
    assert.equal(unreachable, 0);

    field.watch("station", { stationId: "LC-02" });
    t.mock.timers.tick(UNREACHABLE_AFTER_MS - 1);
    assert.equal(unreachable, 0, "the timer should not fire before UNREACHABLE_AFTER_MS has elapsed since watch()");

    t.mock.timers.tick(1);
    assert.equal(unreachable, 1);
  });

  test("reaching connected before the deadline cancels the unreachable event", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { client, field } = setup();
    let unreachable = 0;
    field.on("unreachable", () => {
      unreachable += 1;
    });

    field.watch("station", { stationId: "LC-02" });
    client.emitState("connecting");
    t.mock.timers.tick(UNREACHABLE_AFTER_MS - 1);
    client.emitState("connected");
    t.mock.timers.tick(UNREACHABLE_AFTER_MS * 4);
    assert.equal(unreachable, 0);
    assert.equal(field.everConnected, true);
  });
});

describe("field client sign-in recovery (review finding S1)", () => {
  const badge = { badge: { subject: "v-1", role: "volunteer", name: "Volunteer" }, token: "badge-token", expiresAt: "2026-10-03T01:00:00Z" };
  /** Answers POST /api/badge with each status in turn, then 200; a status of 0 is a network failure. */
  function badgeAnswers(t: import("node:test").TestContext, statuses: number[]): void {
    t.mock.method(globalThis, "fetch", async () => {
      const status = statuses.shift() ?? 200;
      if (status === 0) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(status === 200 ? badge : { error: "no" }), { status, headers: { "content-type": "application/json" } });
    });
  }

  test("a transient badge failure is retried after 1 s, doubling to 30 s, and the backoff resets once connected", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    badgeAnswers(t, [503, 429, 0, 502, 502, 502, 502, 502]);
    const { client } = setup();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      await client.signIn();
      assert.equal(client.state, "auth-required");
      const before = client.reconnects;
      let waited = 0;
      while (client.reconnects === before) {
        t.mock.timers.tick(500);
        waited += 500;
        assert.ok(waited <= SIGN_IN_RETRY_CAP_MS, "a retry is always scheduled within the cap");
      }
      delays.push(waited);
    }
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    await client.signIn();
    assert.equal(client.state, "connected");

    badgeAnswers(t, [503]);
    await client.signIn();
    const before = client.reconnects;
    t.mock.timers.tick(SIGN_IN_RETRY_BASE_MS - 1);
    assert.equal(client.reconnects, before);
    t.mock.timers.tick(1);
    assert.equal(client.reconnects, before + 1, "after connecting, the next retry starts from 1 s again");
  });

  test("a real refusal stays final", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    badgeAnswers(t, [403]);
    const { client } = setup();
    await client.signIn();
    assert.equal(client.state, "auth-required");
    t.mock.timers.tick(SIGN_IN_RETRY_CAP_MS * 4);
    assert.equal(client.reconnects, 0);
  });

  test("an auth-required the gateway caused after a good token stays final", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { client } = setup();
    client.emitState("auth-required");
    t.mock.timers.tick(SIGN_IN_RETRY_CAP_MS * 4);
    assert.equal(client.reconnects, 0);
  });

  test("closing the page client drops a pending retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    badgeAnswers(t, [502]);
    const { client, field } = setup();
    await client.signIn();
    await field.close();
    t.mock.timers.tick(SIGN_IN_RETRY_CAP_MS);
    assert.equal(client.reconnects, 0);
  });

  test("a role switch whose badge request fails keeps the earlier role, so the retry signs the same volunteer back in", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const roles: string[] = [];
    let statuses = [503];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      roles.push((JSON.parse(String(init.body)) as { role: string }).role);
      const status = statuses.shift() ?? 200;
      return new Response(JSON.stringify(status === 200 ? badge : { error: "no" }), { status, headers: { "content-type": "application/json" } });
    });
    const { client, field } = setup();
    client.signInOnReconnect = true;
    await assert.rejects(field.switchRole("researcher"));
    assert.equal(field.role, "volunteer", "the page reports the switch failed, and it did");
    statuses = [];
    t.mock.timers.tick(SIGN_IN_RETRY_BASE_MS);
    client.signInOnReconnect = false;
    await client.signIn();
    assert.deepEqual(roles, ["researcher", "volunteer"]);
    assert.equal(client.state, "connected");
  });

  test("only the newest token request decides whether a failure is retried", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { SignInRetry } = await import("../src/scripts/sign-in-retry.ts");
    const retry = new SignInRetry();
    const client = new FakeClient();
    retry.attach(client);
    let finishOld!: (value: string) => void;
    const old = retry.token(() => new Promise<string>(resolve => { finishOld = resolve; }));
    const newer = retry.token(() => Promise.reject(new TypeError("Failed to fetch")));
    await assert.rejects(newer);
    finishOld("late token");
    await old;
    client.emitState("auth-required");
    t.mock.timers.tick(SIGN_IN_RETRY_BASE_MS);
    assert.equal(client.reconnects, 1, "a late answer to an older request doesn't make the newer failure final");
  });

  test("network failures, timeouts, 429, and 5xx are transient; other answers are refusals", () => {
    assert.equal(isTransientFailure(new TypeError("Failed to fetch")), true);
    assert.equal(isTransientFailure(new DOMException("signal timed out", "TimeoutError")), true);
    for (const status of [429, 500, 502, 503]) assert.equal(isTransientFailure(new HttpStatusError("x", status)), true, String(status));
    for (const status of [400, 401, 403, 404, 409]) assert.equal(isTransientFailure(new HttpStatusError("x", status)), false, String(status));
  });
});
