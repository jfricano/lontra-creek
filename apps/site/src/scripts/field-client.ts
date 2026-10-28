/**
 * This page's connection to the Lontra Creek field station: where the gateway is, a
 * StreamOtter client signed in with a badge, views of any channel, handing the tablet
 * to someone else, and dropping or restoring the page's own connection. The home
 * page's live panel and the /field-station walkthrough share it.
 *
 * Base installs the tablet network before any bundled modules evaluate (see
 * tablet-network.ts). Pages create their SDK client through openFieldClient;
 * the dynamic import is not itself an ordering guarantee in production builds.
 */
import type { Client, Unlisten, WaitOptions } from "streamotter/client";
import { channelVersions, type AppChannels } from "../generated/streamotter.generated.ts";
import { fetchConfig, requestBadge, type BadgeResponse, type FieldConfig, type Role } from "./field-api.ts";
import { observe, type ChannelName, type ChannelParams, type View } from "./field-views.ts";
import { SIGN_IN_RETRY_BASE_MS, SIGN_IN_RETRY_CAP_MS, SignInRetry } from "./sign-in-retry.ts";
import { installTabletNetwork, isOnline, onNetworkChange, setOnline } from "./tablet-network.ts";

// Reuse the head bootstrap; also supports isolated tests without Base.astro.
installTabletNetwork();

/** How long to wait, from the first watch(), for a first connection before saying the gateway can't be reached; the SDK keeps trying. */
export const UNREACHABLE_AFTER_MS = 15_000;
/** How long restoring the connection waits for the gateway. */
export const RECONNECT_TIMEOUT_MS = 15_000;

/** Who the newest token signs in as: the badge's subject, role, and display name. */
export type Badge = BadgeResponse["badge"];

/** The site API didn't answer, so there is no gateway to connect to. */
export class FieldStationUnavailableError extends Error {
  /** `options.cause` carries the failed site API request's error. */
  constructor(options?: ErrorOptions) {
    super("The field station is not answering.", options);
    this.name = "FieldStationUnavailableError";
  }
}

/** A page's connection to the field station, as openFieldClient returns it. */
export interface FieldClient {
  /** The site API's answer: the gateway's origin and path, the mode, the tick length. */
  readonly config: FieldConfig;
  /** What feeds the views: "Local replay of the simulation" or "Live on Kafka". */
  readonly sourceLabel: string;
  /** The SDK client. Its `state` and `error` events are the connection's. */
  readonly client: Client<AppChannels>;
  /** The role the next token is asked for. */
  readonly role: Role;
  /** The badge behind the newest token, once one was issued. */
  readonly badge: Badge | null;
  /** Whether the client has reached `connected` at least once. */
  readonly everConnected: boolean;
  /** Whether this page's tablet network is up. */
  readonly online: boolean;
  /** Subscribes to a channel at its deployed version. Listen to the view in the same task. */
  watch<K extends ChannelName>(channel: K, params: ChannelParams<K>): View<K>;
  /**
   * Hands the tablet to someone with `role`: a new badge is a new subject, so the SDK
   * closes every existing view with `UNAUTHENTICATED`. Watch again as the new person.
   * Resolves once connected as them.
   */
  switchRole(role: Role, options?: WaitOptions): Promise<void>;
  /** Cuts this page's connection to the gateway; nothing else changes. Views go stale. */
  dropConnection(): void;
  /** Brings the connection back and reconnects now, for fresh snapshots, instead of waiting out the SDK's backoff. */
  restoreConnection(options?: WaitOptions): Promise<void>;
  /** Each badge issued, including the first. */
  on(event: "badge", listener: (badge: Badge) => void): Unlisten;
  /** The tablet network going down or up. */
  on(event: "network", listener: (online: boolean) => void): Unlisten;
  /** No first connection within UNREACHABLE_AFTER_MS of the first watch() while the network was up; the SDK keeps trying. */
  on(event: "unreachable", listener: () => void): Unlisten;
  /** Closes the client and every view. */
  close(): Promise<void>;
}

/** Exported for tests only; pages create clients through openFieldClient(). */
export class PageFieldClient implements FieldClient {
  /** The site API's answer this client was created with. */
  readonly config: FieldConfig;
  /** The SDK client; each token it asks for comes from a badge for the current role. */
  readonly client: Client<AppChannels>;
  readonly #badgeListeners = new Set<(badge: Badge) => void>();
  readonly #unreachableListeners = new Set<() => void>();
  /** Reconnects after a transient badge failure; the SDK alone would stay in auth-required. */
  readonly #signIn = new SignInRetry();
  #unreachableTimer: ReturnType<typeof setTimeout> | null = null;
  #watchStarted = false;
  #role: Role;
  #badge: Badge | null = null;
  #everConnected = false;

  /** Creates the SDK client for the configured gateway, signing in with badges for `role` and retrying transient sign-in failures. */
  constructor(config: FieldConfig, createClient: typeof import("streamotter/client").createClient, role: Role) {
    this.config = config;
    this.#role = role;
    this.client = createClient<AppChannels>({
      origin: config.gatewayOrigin,
      path: config.gatewayPath,
      getToken: ({ signal }) => this.#signIn.token(async () => {
        const response = await requestBadge(this.#role, signal);
        this.#badge = response.badge;
        for (const listener of [...this.#badgeListeners]) {
          try {
            listener(response.badge);
          } catch (error) {
            console.error(error); // A page's listener must not stop the sign-in.
          }
        }
        return response.token;
      })
    });
    this.#signIn.attach(this.client);
    this.client.on("state", ({ state }) => {
      if (state === "connected") {
        this.#everConnected = true;
        this.#clearUnreachableTimer();
      }
    });
  }

  /** Starts the unreachable countdown the first time a view is watched; later calls are no-ops. */
  #startUnreachableTimer(): void {
    if (this.#watchStarted) return;
    this.#watchStarted = true;
    // The gateway may be down while the site API answers; say so rather than spin.
    this.#unreachableTimer = setTimeout(() => {
      if (this.#everConnected || !isOnline()) return;
      for (const listener of [...this.#unreachableListeners]) listener();
    }, UNREACHABLE_AFTER_MS);
  }

  #clearUnreachableTimer(): void {
    if (this.#unreachableTimer === null) return;
    clearTimeout(this.#unreachableTimer);
    this.#unreachableTimer = null;
  }

  /** "Local replay of the simulation" in fixture mode, otherwise "Live on Kafka". */
  get sourceLabel(): string {
    return this.config.mode === "fixture" ? "Local replay of the simulation" : "Live on Kafka";
  }

  /** The role the next token is asked for; a failed switchRole puts the previous one back. */
  get role(): Role {
    return this.#role;
  }

  /** The badge behind the newest token, or null before the first one is issued. */
  get badge(): Badge | null {
    return this.#badge;
  }

  /** Whether the client has reached `connected` at least once; the unreachable notice never fires after that. */
  get everConnected(): boolean {
    return this.#everConnected;
  }

  /** Whether this page's tablet network is up. */
  get online(): boolean {
    return isOnline();
  }

  /** Subscribes at the channel's generated version; the first call starts the unreachable countdown. */
  watch<K extends ChannelName>(channel: K, params: ChannelParams<K>): View<K> {
    this.#startUnreachableTimer();
    const channelVersion = channelVersions[channel] as AppChannels[K]["version"];
    return observe(channel, params, this.client.subscribe(channel, { channelVersion, params }));
  }

  /** Drops any pending sign-in retry and reconnects as `role`. On failure the previous role is restored and the error rethrown. */
  switchRole(role: Role, options?: WaitOptions): Promise<void> {
    this.#signIn.cancel();
    const previous = this.#role;
    this.#role = role;
    // A failed switch keeps the earlier volunteer, so a sign-in retry already scheduled
    // reconnects as the same identity and the page's views stay open.
    return this.client.reconnect(options).catch((error: unknown) => {
      this.#role = previous;
      throw error;
    });
  }

  /** Takes the tablet network down, which closes this page's gateway sockets. */
  dropConnection(): void {
    setOnline(false);
  }

  /** Brings the tablet network back, drops any pending sign-in retry, and reconnects now, waiting up to RECONNECT_TIMEOUT_MS by default. */
  restoreConnection(options: WaitOptions = { timeoutMs: RECONNECT_TIMEOUT_MS }): Promise<void> {
    setOnline(true);
    this.#signIn.cancel();
    return this.client.reconnect(options);
  }

  /** Listens for each badge issued, including the first. */
  on(event: "badge", listener: (badge: Badge) => void): Unlisten;
  /** Listens for the tablet network going down or up. */
  on(event: "network", listener: (online: boolean) => void): Unlisten;
  /** Listens for the gateway staying unreachable after the first watch(). */
  on(event: "unreachable", listener: () => void): Unlisten;
  /** Network listeners go to the tablet network; badge and unreachable listeners stay on this client. Returns a function that removes the listener. */
  on(event: "badge" | "network" | "unreachable", listener: ((badge: Badge) => void) | ((online: boolean) => void) | (() => void)): Unlisten {
    if (event === "network") return onNetworkChange(listener as (online: boolean) => void);
    const set = (event === "badge" ? this.#badgeListeners : this.#unreachableListeners) as Set<typeof listener>;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Stops the unreachable countdown and sign-in retries, then closes the SDK client and every view. */
  close(): Promise<void> {
    this.#clearUnreachableTimer();
    this.#signIn.stop();
    return this.client.close();
  }
}

/**
 * Asks the site API where the gateway is, loads the SDK, and creates a client that
 * signs in as `role` (a volunteer by default). The client connects when the first
 * view is watched. Rejects with FieldStationUnavailableError when the site API
 * doesn't answer, or with the abort reason when `signal` aborts.
 */
export async function openFieldClient(options: { role?: Role; signal?: AbortSignal } = {}): Promise<FieldClient> {
  installTabletNetwork();
  let config: FieldConfig;
  try {
    config = await fetchConfig(options.signal);
  } catch (cause) {
    if (options.signal?.aborted === true) throw cause;
    throw new FieldStationUnavailableError({ cause });
  }
  const { createClient } = await import("streamotter/client");
  return new PageFieldClient(config, createClient, options.role ?? "volunteer");
}

/**
 * openFieldClient, asked again for as long as the site API doesn't answer: after 1 s,
 * doubling to 30 s, the same backoff as a failed sign-in. A page that says it is still
 * trying needs this, because openFieldClient alone gives up after one failed request.
 * `onUnavailable` runs after each unanswered attempt; any other error rejects.
 */
export async function openFieldClientUntilAnswered(onUnavailable: (error: FieldStationUnavailableError) => void, open: () => Promise<FieldClient> = () => openFieldClient()): Promise<FieldClient> {
  let delay = SIGN_IN_RETRY_BASE_MS;
  for (;;) {
    try {
      return await open();
    } catch (error) {
      if (!(error instanceof FieldStationUnavailableError)) throw error;
      onUnavailable(error);
    }
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(SIGN_IN_RETRY_CAP_MS, delay * 2);
  }
}
