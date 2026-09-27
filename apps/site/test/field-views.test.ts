import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StateChange, StreamError, StreamEvent, Subscription, SubscriptionState, Unlisten } from "streamotter/client";
import type { GaugeReading } from "../src/generated/streamotter.generated.ts";
import { observe, shortRevision, type View, type ViewEvent, type ViewStateChange } from "../src/scripts/field-views.ts";

/** Stands in for the SDK's subscription: the test emits what the SDK would. */
class FakeSubscription implements Subscription<GaugeReading> {
  readonly id = "sub-1";
  state: SubscriptionState = "idle";
  unsubscribed = false;
  readonly #listeners = { data: new Set<(event: StreamEvent<GaugeReading>) => void>(), state: new Set<(change: StateChange<SubscriptionState>) => void>(), error: new Set<(error: StreamError) => void>() };

  on(event: "data", listener: (event: StreamEvent<GaugeReading>) => void): Unlisten;
  on(event: "state", listener: (change: StateChange<SubscriptionState>) => void): Unlisten;
  on(event: "error", listener: (error: StreamError) => void): Unlisten;
  on(event: "data" | "state" | "error", listener: never): Unlisten {
    const set = this.#listeners[event] as Set<unknown>;
    set.add(listener);
    return () => set.delete(listener);
  }

  emitState(state: SubscriptionState, reason?: StateChange<SubscriptionState>["reason"]): void {
    this.state = state;
    for (const listener of this.#listeners.state) listener(reason === undefined ? { state } : { state, reason });
  }

  emitData(kind: "snapshot" | "update", tick: number): void {
    const event: StreamEvent<GaugeReading> = {
      id: `event-${tick}`,
      channel: "station",
      channelVersion: 1,
      kind,
      data: { stationId: "LC-02", flowCfs: tick } as unknown as GaugeReading,
      revision: String(10n ** 12n + BigInt(tick)),
      receivedAt: "2026-09-26T12:00:00.000Z"
    };
    for (const listener of this.#listeners.data) listener(event);
  }

  emitError(error: StreamError): void {
    for (const listener of this.#listeners.error) listener(error);
  }

  async ready(): Promise<void> {}
  async resync(): Promise<void> {}
  async unsubscribe(): Promise<void> {
    this.unsubscribed = true;
  }
}

function setup(): { subscription: FakeSubscription; view: View<"station">; states: ViewStateChange[]; events: ViewEvent<GaugeReading>[] } {
  const subscription = new FakeSubscription();
  const view = observe("station", { stationId: "LC-02" }, subscription);
  const states: ViewStateChange[] = [];
  const events: ViewEvent<GaugeReading>[] = [];
  view.on("state", change => states.push(change));
  view.on("data", event => events.push(event));
  return { subscription, view, states, events };
}

describe("views", () => {
  test("a revision is shown as its tick within the generation", () => {
    assert.equal(shortRevision(3n * 10n ** 12n + 42n), "r42");
  });

  test("a view starts empty, in the subscription's state", () => {
    const { view } = setup();
    assert.equal(view.channel, "station");
    assert.deepEqual(view.params, { stationId: "LC-02" });
    assert.equal(view.state, "idle");
    assert.equal(view.epoch, 0);
    assert.equal(view.revision, null);
    assert.equal(view.data, null);
  });

  test("states carry the previous state, the reason, and the epoch", () => {
    const { subscription, view, states } = setup();
    subscription.emitState("authorizing");
    subscription.emitState("synchronizing");
    subscription.emitData("snapshot", 10);
    subscription.emitState("live");
    subscription.emitState("stale", "SOURCE_UNAVAILABLE");
    assert.deepEqual(states.map(({ previous, state, reason, epoch }) => [previous, state, reason, epoch]), [
      ["idle", "authorizing", undefined, 0],
      ["authorizing", "synchronizing", undefined, 0],
      ["synchronizing", "live", undefined, 1],
      ["live", "stale", "SOURCE_UNAVAILABLE", 1]
    ]);
    assert.equal(view.state, "stale");
    assert.equal(view.reason, "SOURCE_UNAVAILABLE");
  });

  test("each snapshot starts an epoch; updates belong to the current one", () => {
    const { subscription, view, events } = setup();
    subscription.emitData("snapshot", 10);
    subscription.emitData("update", 11);
    subscription.emitData("update", 12);
    assert.deepEqual(events.map(({ kind, epoch }) => [kind, epoch]), [["snapshot", 1], ["update", 1], ["update", 1]]);
    assert.equal(view.epoch, 1);
    assert.equal(view.revision, 10n ** 12n + 12n);
    assert.equal(view.data?.flowCfs, 12);
  });

  test("a fresh snapshot after a gap names the revision it replaced; those between weren't replayed", () => {
    const { subscription, view, events } = setup();
    subscription.emitData("snapshot", 10);
    subscription.emitData("update", 11);
    subscription.emitState("stale");
    subscription.emitData("snapshot", 15);
    const fresh = events.at(-1);
    assert.equal(fresh?.kind, "snapshot");
    assert.equal(fresh?.epoch, 2);
    assert.equal(fresh?.previousRevision, 10n ** 12n + 11n);
    assert.equal(fresh?.revision, 10n ** 12n + 15n);
    assert.equal(events[0]?.previousRevision, null);
    assert.equal(view.epoch, 2);
  });

  test("a refusal arrives as an error, then a failed state with its reason", () => {
    const { subscription, view, states } = setup();
    const errors: StreamError[] = [];
    view.on("error", error => errors.push(error));
    subscription.emitState("authorizing");
    subscription.emitError({ code: "FORBIDDEN", message: "Not allowed.", retryable: false, requestId: "r-1" });
    subscription.emitState("failed", "FORBIDDEN");
    assert.deepEqual(errors.map(error => error.code), ["FORBIDDEN"]);
    assert.equal(states.at(-1)?.reason, "FORBIDDEN");
    assert.equal(view.data, null);
    assert.equal(view.epoch, 0);
  });

  test("unlistening stops a listener; closing unsubscribes", async () => {
    const { subscription, view } = setup();
    let seen = 0;
    const unlisten = view.on("data", () => {
      seen += 1;
    });
    subscription.emitData("snapshot", 10);
    unlisten();
    subscription.emitData("update", 11);
    assert.equal(seen, 1);
    await view.close();
    assert.equal(subscription.unsubscribed, true);
  });

  test("a listener that throws reaches the SDK, which fails the subscription", () => {
    const { subscription, view } = setup();
    view.on("data", () => {
      throw new Error("render failed");
    });
    assert.throws(() => subscription.emitData("snapshot", 10), /render failed/);
  });
});
