/**
 * Cards: a view's newest state drawn into a `[data-card]` element, as on the home
 * page. The markup's hooks are `[data-state]` (the state chip), `[data-rev]`,
 * `[data-age]`, and one `[data-v="…"]` per field; a renderer fills the fields it
 * finds. Stale cards get `is-stale`; a snapshot flashes the card. An update still on
 * its way never overwrites a newer snapshot.
 */
import type { SubscriptionState } from "streamotter/client";
import type { GaugeReading, OtterStatus } from "../generated/streamotter.generated.ts";
import { shortRevision, type ChannelData, type ChannelName, type View } from "./field-views.ts";

/** Finds a required element. */
export function $(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}

/** Sets a `[data-v]` field's text and briefly highlights the change. Fields the card doesn't have are skipped. */
export function setText(root: ParentNode, key: string, value: string): void {
  const element = root.querySelector<HTMLElement>(`[data-v="${key}"]`);
  if (element === null || element.textContent === value) return;
  element.textContent = value;
  element.classList.remove("bump");
  void element.offsetWidth;
  element.classList.add("bump");
}

const ACTIVITY: Readonly<Record<OtterStatus["activity"], string>> = {
  denning: "in a den",
  resting: "resting",
  foraging: "foraging",
  traveling: "traveling",
  grooming: "grooming",
  playing: "playing",
  away: "left the creek"
};

/** A gauge: `flow`, `temp`, `do`, `stage`, `turbidity`, and `trend`, whichever the card shows. */
export function renderStation(element: HTMLElement, data: GaugeReading): void {
  setText(element, "flow", data.flowCfs.toFixed(data.flowCfs >= 100 ? 0 : 1));
  setText(element, "temp", data.waterTempC.toFixed(1));
  setText(element, "do", data.dissolvedOxygenMgL.toFixed(1));
  setText(element, "stage", data.stageFt.toFixed(2));
  setText(element, "turbidity", data.turbidityNtu.toFixed(1));
  setText(element, "trend", data.trend);
}

/** An otter: `reach` (withheld at a den), `activity`, `dives`, and `note`. */
export function renderOtter(element: HTMLElement, data: OtterStatus): void {
  setText(element, "reach", data.reachId === "withheld" ? "withheld" : data.reachName);
  setText(element, "activity", ACTIVITY[data.activity]);
  setText(element, "dives", String(data.divesThisHour));
  setText(element, "note", data.note);
}

export type Renderer<K extends ChannelName> = (element: HTMLElement, data: ChannelData<K>) => void;

/** The renderer each channel's cards use unless a card brings its own. */
export const renderers: { readonly [K in ChannelName]?: Renderer<K> } = {
  station: renderStation,
  otter: renderOtter
};

export interface CardOptions<K extends ChannelName> {
  /** Fills the card's fields; defaults to the channel's entry in `renderers`. */
  render?: Renderer<K>;
  /** Shows an update by calling `apply`; the home page carries it down the creek first. Defaults to at once. */
  deliver?: (apply: () => void) => void;
  /** A fresh snapshot replaced the state the card showed when it went stale; the revisions in between weren't replayed. */
  onCaughtUp?: (before: bigint, after: bigint) => void;
}

export interface Card {
  readonly element: HTMLElement;
  /** The view's state as the card shows it. */
  readonly state: SubscriptionState;
  /** The revision on the card; it can trail the view's while an update is on its way. */
  readonly revision: bigint | null;
  /** When the card last changed (performance.now()), or 0 while waiting. */
  readonly updatedAt: number;
  /** Updates `[data-age]`: waiting, updated just now, updated 5s ago, or stale since. */
  renderAge(now?: number): void;
}

/** Draws `view` into `element` from now on. Bind in the same task as `watch` to miss nothing. */
export function bindCard<K extends ChannelName>(view: View<K>, element: HTMLElement, options: CardOptions<K> = {}): Card {
  const render = options.render ?? (renderers[view.channel] as Renderer<K> | undefined);
  if (render === undefined) throw new Error(`No card renderer for ${view.channel}`);
  const deliver = options.deliver ?? ((apply: () => void) => apply());
  const chip = $(element, "[data-state]");
  const rev = $(element, "[data-rev]");
  const age = $(element, "[data-age]");
  let state: SubscriptionState = "idle";
  let revision: bigint | null = null;
  let revisionBeforeStale: bigint | null = null;
  let updatedAt = 0;

  view.on("state", change => {
    if (change.state === "stale" && state !== "stale") revisionBeforeStale = revision;
    state = change.state;
    chip.dataset["state"] = state;
    chip.textContent = state;
    element.classList.toggle("is-stale", state === "stale" || state === "resync-required");
  });

  view.on("data", ({ event, kind, revision: next }) => {
    const apply = (): void => {
      // An update still in flight must never overwrite a newer snapshot.
      if (revision !== null && next <= revision) return;
      revision = next;
      updatedAt = performance.now();
      render(element, event.data);
      rev.textContent = shortRevision(next);
      rev.title = `Revision ${event.revision}`;
    };
    if (kind === "snapshot") {
      const before = revisionBeforeStale;
      revision = null;
      apply();
      element.classList.remove("flash");
      void element.offsetWidth;
      element.classList.add("flash");
      if (before !== null && next > before) options.onCaughtUp?.(before, next);
      revisionBeforeStale = null;
    } else {
      deliver(apply);
    }
  });

  return {
    element,
    get state() {
      return state;
    },
    get revision() {
      return revision;
    },
    get updatedAt() {
      return updatedAt;
    },
    renderAge(now = performance.now()) {
      const seconds = updatedAt === 0 ? null : Math.round((now - updatedAt) / 1000);
      age.textContent = seconds === null ? (element.closest('[data-status="unavailable"]') !== null ? "not connected" : "waiting") : state === "stale" ? `stale · last update ${seconds}s ago` : seconds < 2 ? "updated just now" : `updated ${seconds}s ago`;
    }
  };
}

/** Keeps every card's `[data-age]` current. Returns a function that stops it. */
export function tickAges(cards: readonly Card[], intervalMs = 500): () => void {
  const timer = setInterval(() => {
    const now = performance.now();
    for (const card of cards) card.renderAge(now);
  }, intervalMs);
  return () => clearInterval(timer);
}
