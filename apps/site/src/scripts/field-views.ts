/**
 * A view: one SDK subscription and what it has reported so far. Every value comes
 * from the SDK's own events: the state and its reason, each snapshot and update, and
 * the revisions they carried. The home page's cards and log and the walkthrough's
 * under-the-hood panel all read views.
 *
 * Epochs: every synchronization the gateway runs for a subscription is a new epoch,
 * and each epoch's first event is its snapshot (the SDK drops anything else). The
 * SDK keeps the gateway's epoch ID to itself, so a view numbers epochs by their
 * snapshots: 0 before the first, 1 after it, 2 after a reconnect's fresh snapshot.
 *
 * No DOM here, so it runs under Node's test runner.
 */
import type { ErrorCode, Json, StateChange, StreamError, StreamEvent, Subscription, SubscriptionState, Unlisten } from "streamotter/client";
import type { AppChannels } from "../generated/streamotter.generated.ts";

export type ChannelName = keyof AppChannels & string;
export type ChannelParams<K extends ChannelName> = AppChannels[K]["params"];
export type ChannelData<K extends ChannelName> = AppChannels[K]["data"];

/** The shared world's revisions are `generation × 10¹² + tick`. */
export const TICKS_PER_GENERATION = 10n ** 12n;

/** A shared-world revision as the site shows it: its tick within the generation, such as `r42`. */
export function shortRevision(revision: bigint): string {
  return `r${(revision % TICKS_PER_GENERATION).toString()}`;
}

export interface ViewStateChange extends StateChange<SubscriptionState> {
  /** The view's state before this change. */
  previous: SubscriptionState;
  /** The view's epoch when the state changed. */
  epoch: number;
}

export interface ViewEvent<D extends Json> {
  /** The SDK's event, unchanged. */
  event: StreamEvent<D>;
  kind: StreamEvent<D>["kind"];
  revision: bigint;
  /**
   * The newest revision the view had before this event, or null. For a snapshot that
   * starts a later epoch, the states after `previousRevision` and before `revision`
   * weren't replayed: StreamOtter V1 delivers the current state, not history.
   */
  previousRevision: bigint | null;
  /** The epoch this event belongs to; a snapshot starts a new one. */
  epoch: number;
}

export interface View<K extends ChannelName> {
  readonly channel: K;
  readonly params: ChannelParams<K>;
  /** The SDK subscription behind the view. */
  readonly subscription: Subscription<ChannelData<K>>;
  readonly state: SubscriptionState;
  /** Why the view is in its state, when the SDK said (for example `FORBIDDEN` or `UNAUTHENTICATED`). */
  readonly reason: ErrorCode | undefined;
  /** Epochs received so far, counted by their snapshots. */
  readonly epoch: number;
  /** The newest revision delivered, or null before the first snapshot. */
  readonly revision: bigint | null;
  /** The newest data delivered, or null before the first snapshot. */
  readonly data: ChannelData<K> | null;
  /** Listeners run inside the SDK's: one that throws fails the subscription with `HANDLER_FAILED`. */
  on(event: "state", listener: (change: ViewStateChange) => void): Unlisten;
  on(event: "data", listener: (event: ViewEvent<ChannelData<K>>) => void): Unlisten;
  on(event: "error", listener: (error: StreamError) => void): Unlisten;
  /** Unsubscribes; the view closes. */
  close(): Promise<void>;
}

class ChannelView<K extends ChannelName> implements View<K> {
  readonly channel: K;
  readonly params: ChannelParams<K>;
  readonly subscription: Subscription<ChannelData<K>>;
  readonly #state = new Set<(change: ViewStateChange) => void>();
  readonly #data = new Set<(event: ViewEvent<ChannelData<K>>) => void>();
  readonly #error = new Set<(error: StreamError) => void>();
  #current: SubscriptionState;
  #reason: ErrorCode | undefined;
  #epoch = 0;
  #revision: bigint | null = null;
  #latest: ChannelData<K> | null = null;

  constructor(channel: K, params: ChannelParams<K>, subscription: Subscription<ChannelData<K>>) {
    this.channel = channel;
    this.params = params;
    this.subscription = subscription;
    this.#current = subscription.state;
    subscription.on("state", change => {
      const previous = this.#current;
      this.#current = change.state;
      this.#reason = change.reason;
      const viewChange: ViewStateChange = { ...change, previous, epoch: this.#epoch };
      for (const listener of [...this.#state]) listener(viewChange);
    });
    subscription.on("data", event => {
      const revision = BigInt(event.revision);
      const previousRevision = this.#revision;
      if (event.kind === "snapshot") this.#epoch += 1;
      this.#revision = revision;
      this.#latest = event.data;
      const viewEvent: ViewEvent<ChannelData<K>> = { event, kind: event.kind, revision, previousRevision, epoch: this.#epoch };
      for (const listener of [...this.#data]) listener(viewEvent);
    });
    subscription.on("error", error => {
      for (const listener of [...this.#error]) listener(error);
    });
  }

  get state(): SubscriptionState {
    return this.#current;
  }

  get reason(): ErrorCode | undefined {
    return this.#reason;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get revision(): bigint | null {
    return this.#revision;
  }

  get data(): ChannelData<K> | null {
    return this.#latest;
  }

  on(event: "state", listener: (change: ViewStateChange) => void): Unlisten;
  on(event: "data", listener: (event: ViewEvent<ChannelData<K>>) => void): Unlisten;
  on(event: "error", listener: (error: StreamError) => void): Unlisten;
  on(event: "state" | "data" | "error", listener: ((change: ViewStateChange) => void) | ((event: ViewEvent<ChannelData<K>>) => void) | ((error: StreamError) => void)): Unlisten {
    const set = (event === "state" ? this.#state : event === "data" ? this.#data : this.#error) as Set<typeof listener>;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  close(): Promise<void> {
    return this.subscription.unsubscribe();
  }
}

/**
 * Observes an SDK subscription. Call it in the same task as `subscribe`, before the
 * SDK starts the subscription, so the view misses nothing.
 */
export function observe<K extends ChannelName>(channel: K, params: ChannelParams<K>, subscription: Subscription<ChannelData<K>>): View<K> {
  return new ChannelView(channel, params, subscription);
}
