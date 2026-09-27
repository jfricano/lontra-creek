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

  async reconnect(): Promise<void> {}
  async close(): Promise<void> {}

  /** Drives the client the way the SDK would when it tries to connect. */
  emitState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.#stateListeners]) listener({ state });
  }
}

const CONFIG: FieldConfig = { gatewayOrigin: "https://field-station.test", gatewayPath: "/socket", mode: "fixture", tickMs: 100 };

function setup(): { client: FakeClient; field: InstanceType<typeof PageFieldClient> } {
  const client = new FakeClient();
  const createClient = <C extends ChannelMap>(_options: ClientOptions): Client<C> => client as unknown as Client<C>;
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
