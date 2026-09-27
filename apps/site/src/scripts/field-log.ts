/**
 * The SDK log: what the StreamOtter SDK reported, newest first, each line timed from
 * when the page started. Every line comes from an SDK event or the visitor's own
 * action. A polite live region announces the few lines worth hearing.
 */
import type { Client, ConnectionState, SubscriptionState, Unlisten } from "streamotter/client";
import type { AppChannels } from "../generated/streamotter.generated.ts";
import { shortRevision, type ChannelName, type View } from "./field-views.ts";

/** A line's highlight: `k` live or fine, `w` a warning, `s` on its way. */
export type Tone = "k" | "w" | "s";
/** Text, or a highlighted word such as a view's label. */
export type LogPart = string | { tone: Tone; text: string };

export interface SdkLog {
  /** Adds a line at the top and, with `announce`, says it to screen readers. */
  write(parts: readonly LogPart[], announce?: string): void;
  /** Says something to screen readers without a line. */
  announce(text: string): void;
}

/** Writes into an `<ol>` (the home page's `[data-log]`), keeping the newest `limit` lines. */
export function createSdkLog(list: HTMLElement, announcer: HTMLElement, options: { limit?: number; started?: number } = {}): SdkLog {
  const limit = options.limit ?? 8;
  const started = options.started ?? performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  function announce(text: string): void {
    pending.add(text);
    clearTimeout(timer);
    timer = setTimeout(() => {
      announcer.textContent = [...pending].join(". ");
      pending.clear();
    }, 700);
  }
  return {
    write(parts, announcement) {
      const item = document.createElement("li");
      const time = document.createElement("span");
      time.className = "t";
      time.textContent = `+${((performance.now() - started) / 1000).toFixed(1).padStart(5, " ")}s`;
      item.append(time, " ");
      for (const part of parts) {
        if (typeof part === "string") {
          item.append(part);
        } else {
          const span = document.createElement("span");
          span.className = part.tone;
          span.textContent = part.text;
          item.append(span);
        }
      }
      list.prepend(item);
      while (list.children.length > limit) list.lastElementChild?.remove();
      if (announcement !== undefined) announce(announcement);
    },
    announce
  };
}

export function subscriptionTone(state: SubscriptionState): Tone {
  if (state === "live") return "k";
  return state === "stale" || state === "failed" || state === "resync-required" ? "w" : "s";
}

export function connectionTone(state: ConnectionState): Tone {
  return state === "connected" ? "k" : "w";
}

/** Logs the connection's states. */
export function logConnection(log: SdkLog, client: Client<AppChannels>): Unlisten {
  return client.on("state", ({ state }) => {
    log.write([{ tone: connectionTone(state), text: "connection" }, ` ${state}`]);
  });
}

/** Logs a view's states, snapshots, updates, and errors under `label`; announces live and stale. */
export function logView<K extends ChannelName>(log: SdkLog, view: View<K>, label: string): Unlisten {
  const unlisten = [
    view.on("state", ({ state }) => {
      const announce = state === "live" || state === "stale" || state === "resync-required" || state === "failed" ? `${label} is ${state}` : undefined;
      log.write([{ tone: subscriptionTone(state), text: label }, ` state ${state}`], announce);
    }),
    view.on("data", ({ kind, revision }) => {
      log.write([{ tone: "k", text: label }, ` ${kind} ${shortRevision(revision)}`]);
    }),
    view.on("error", error => {
      log.write([{ tone: "w", text: label }, ` ${error.code}: ${error.message}`]);
    })
  ];
  return () => {
    for (const stop of unlisten) stop();
  };
}
