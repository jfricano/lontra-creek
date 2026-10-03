/**
 * Recovering from a failed sign-in.
 *
 * The StreamOtter SDK treats any getToken rejection as `auth-required` and then waits
 * for reconnect(); it never retries on its own. So one 429 from the badge limiter, or
 * one 502 while the field station restarts, would leave a page dead for good.
 *
 * A page runs each token request through `token()` and attaches its client. When the
 * latest request failed transiently (no answer, a timeout, 429, or a 5xx) this calls
 * reconnect() after 1 s, doubling to 30 s, and starts again from 1 s once connected.
 * A refusal (any other 4xx, such as the Lab's 409 `no-lease`) stays final, and so does
 * an `auth-required` the gateway caused itself, such as a revoked lease.
 */
import type { ConnectionState, StateChange, Unlisten, WaitOptions } from "streamotter/client";

export const SIGN_IN_RETRY_BASE_MS = 1_000;
export const SIGN_IN_RETRY_CAP_MS = 30_000;

/** An HTTP answer that wasn't the one asked for. */
export class HttpStatusError extends Error {
  readonly status: number;
  /** The API's own error code, when its body had one. */
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
    this.code = code;
  }
}

/** Worth trying again: no HTTP answer at all (network failure, timeout, abort), a 429, or a 5xx. */
export function isTransientFailure(error: unknown): boolean {
  return !(error instanceof HttpStatusError) || error.status === 429 || error.status >= 500;
}

/** The part of the SDK client this needs. */
export interface ReconnectingClient {
  on(event: "state", listener: (change: StateChange<ConnectionState>) => void): Unlisten;
  reconnect(options?: WaitOptions): Promise<void>;
}

export class SignInRetry {
  readonly #onFinal: (() => void) | undefined;
  #transient = false;
  #delay = SIGN_IN_RETRY_BASE_MS;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unlisten: Unlisten | null = null;

  /** `onFinal` runs when sign-in stops for good, so the page can say why. */
  constructor(onFinal?: () => void) {
    this.#onFinal = onFinal;
  }

  /** The delay before the next retry. */
  get nextDelayMs(): number {
    return this.#delay;
  }

  /** Runs one token request and remembers whether its failure is worth retrying. */
  async token<T>(request: () => Promise<T>): Promise<T> {
    // Pending counts as transient: the SDK gives up on a getToken after ten seconds
    // and reports auth-required before this request's own rejection arrives.
    this.#transient = true;
    try {
      const value = await request();
      this.#transient = false;
      return value;
    } catch (error) {
      this.#transient = isTransientFailure(error);
      throw error;
    }
  }

  attach(client: ReconnectingClient): void {
    this.#unlisten?.();
    this.#unlisten = client.on("state", ({ state }) => {
      if (state === "connected") {
        this.#delay = SIGN_IN_RETRY_BASE_MS;
        this.cancel();
      } else if (state === "auth-required") {
        if (this.#transient) this.#schedule(client);
        else this.#onFinal?.();
      } else if (state === "closed") {
        this.stop();
      }
    });
  }

  /** Drops a pending retry, for example because the page reconnects on its own now. */
  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  stop(): void {
    this.cancel();
    this.#unlisten?.();
    this.#unlisten = null;
  }

  #schedule(client: ReconnectingClient): void {
    this.cancel();
    const delay = this.#delay;
    this.#delay = Math.min(SIGN_IN_RETRY_CAP_MS, delay * 2);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      // A failure reports auth-required again, which schedules the next attempt.
      client.reconnect().catch(() => undefined);
    }, delay);
  }
}
