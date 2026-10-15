/**
 * The Lab page's share of its address's request budget.
 *
 * The field station gives each client address one Lab request budget, 20 at once and 3 a
 * second, for `/api/lab/*` and `/api/sandbox/*` together (Lab contract), and lets one address
 * hold two places. A leased page polling at full speed asks about 2 a second, so two pages on
 * one computer (two browsers holding two benches) spent the budget within seconds and were
 * answered 429. Every Lab request from this page waits here for a token instead: the page
 * spends at most a little under half the address budget, so two places from one address fit.
 *
 * The page's own polls are background requests: they leave a few tokens in reserve, so what
 * a visitor just did (an action, an intent and its operation, Borrow or Return) isn't queued
 * behind them. Polls slow down instead.
 */
import { abortableWait } from "./lab-operation.ts";

export const PAGE_BURST = 9;
export const PAGE_PER_SECOND = 1.4;
/** Tokens a background request leaves for the visitor's own requests. */
export const BACKGROUND_RESERVE = 3;
/** How long every request waits after a 429 whose Retry-After the page can't read (the Lab API doesn't expose it cross-origin). */
export const REFUSED_PAUSE_MS = 2_000;
/** The longest a Retry-After is honored for: the field station's own answers are a second or two. */
export const REFUSED_PAUSE_CAP_MS = 30_000;

export interface BudgetOptions {
  burst?: number;
  perSecond?: number;
  now?: () => number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const NEVER = new AbortController().signal;

export class RequestBudget {
  readonly #burst: number;
  readonly #perSecond: number;
  readonly #now: () => number;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  #tokens: number;
  #at: number;
  #heldUntil = 0;

  constructor(options: BudgetOptions = {}) {
    this.#burst = options.burst ?? PAGE_BURST;
    this.#perSecond = options.perSecond ?? PAGE_PER_SECOND;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? abortableWait;
    this.#tokens = this.#burst;
    this.#at = this.#now();
  }

  /** Takes a token and returns 0, or returns the milliseconds until one is free, taking nothing. A background request leaves `BACKGROUND_RESERVE`. */
  take(background = false): number {
    const now = this.#now();
    if (now < this.#heldUntil) return this.#heldUntil - now;
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1_000) * this.#perSecond);
    this.#at = now;
    const needed = 1 + (background ? Math.min(BACKGROUND_RESERVE, this.#burst - 1) : 0);
    if (this.#tokens >= needed) { this.#tokens -= 1; return 0; }
    return Math.ceil(((needed - this.#tokens) / this.#perSecond) * 1_000);
  }

  /** Waits for a token. Returns without one when `signal` aborts, so the caller's request then fails as aborted. */
  async acquire(signal: AbortSignal = NEVER, background = false): Promise<void> {
    for (let ms = this.take(background); ms > 0 && !signal.aborted; ms = this.take(background)) await this.#wait(ms, signal);
  }

  /**
   * The field station answered 429: the address budget is spent, by this page or another place
   * from the same address. Every request waits `ms`, and the page starts again from an empty bucket.
   */
  refused(ms: number = REFUSED_PAUSE_MS): void {
    this.#heldUntil = Math.max(this.#heldUntil, this.#now() + ms);
    this.#tokens = 0;
    this.#at = this.#heldUntil;
  }
}

/** A 429's pause from its Retry-After seconds, when the page can read the header; the default otherwise. */
export function refusedPauseMs(retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, REFUSED_PAUSE_CAP_MS) : REFUSED_PAUSE_MS;
}
