/**
 * The Lab page's view of its bench's redacted feed.
 *
 * The full feed is mostly `ok` traces, so by default the page shows a scenario view:
 * failed or rejected traces, source state changes, the record a fouled sensor stopped
 * on (topic, partition, offset), the visitor's actions, and bench events such as trace
 * gaps. When the same record comes back, after Resume or a gateway restart, it is marked as retried.
 *
 * The bench's `record` item with outcome `processed` is written when its map handler
 * returns, before StreamOtter validates, delivers, or commits anything, so the page
 * calls it "mapper returned" and never treats it as proof of a commit.
 */
import type { LabAction, LabFeedItem } from "../../../field-station/src/lab/contract.ts";

/** How many items the page keeps; the bench keeps 500 per lease too. */
export const FEED_KEEP = 500;
/** How many lines the page shows at once. */
export const FEED_SHOW = 100;

export const ACTION_LABELS: Record<LabAction, string> = {
  "sensor.foul": "Foul sensor",
  "sensor.restore": "Restore calibration",
  "source.resume": "Resume source",
  "relay.cut": "Cut relay",
  "relay.restore": "Restore relay",
  "satellite.start": "Start slow client",
  "gateway.restart": "Restart gateway"
};

export interface FeedLine {
  id: string;
  at: string;
  text: string;
  /** Shown in the scenario view, not only in the full feed. */
  scenario: boolean;
  /** A record that failed earlier in this lease and has now mapped. */
  retried: boolean;
}

/** The action that let a held record be read again, if the feed shows one before it. */
export type Recovery = Extract<LabAction, "source.resume" | "gateway.restart">;

/** A retried record, by its Kafka coordinates, and the latest recovery action before it. */
export interface RetriedRecord { topic: string; partition: number; offset: string; after: Recovery | null }

/** The outcome line for a retried record. It names only an action the feed shows, and never claims a commit. */
export function retriedOutcome(retried: RetriedRecord): string {
  const where = `offset ${retried.offset} on ${retried.topic} partition ${retried.partition}, and the mapper returned`;
  const what = retried.after === "source.resume" ? `After Resume the gateway retried the same record, ${where}.`
    : retried.after === "gateway.restart" ? `After the gateway restart, the restarted gateway read the same record again, ${where}.`
    : `The gateway retried the same record, ${where}.`;
  return `${what} That isn't proof the offset was committed; the source state and your view show what happened next.`;
}

/** The slow client's most recent run, as far as the feed shows it. */
export interface SatelliteRun {
  connected: boolean;
  /** A `receipt` trace failed with OVERLOADED for the slow client's subscription. */
  overloaded: boolean;
  disconnected: boolean;
}

const coordinates = (item: { topic: string; partition: number; offset: string }): string => `${item.topic}/${item.partition}/${item.offset}`;
const place = (item: { topic: string; partition: number; offset: string }): string => `${item.topic} · partition ${item.partition} · offset ${item.offset}`;

export class LabFeedModel {
  #lines: FeedLine[] = [];
  /** Records whose map failed in this lease and haven't been retried successfully yet. */
  readonly #failed = new Set<string>();
  #retried: RetriedRecord | null = null;
  #recovery: Recovery | null = null;
  #satellite: SatelliteRun | null = null;
  #gapCount = 0;

  /** The latest record retried in this lease, if any. */
  get retried(): RetriedRecord | null {
    return this.#retried;
  }

  get satellite(): SatelliteRun | null {
    return this.#satellite;
  }

  clear(): void {
    this.#lines = [];
    this.#failed.clear();
    this.#retried = null;
    this.#recovery = null;
    this.#satellite = null;
  }

  /** The page fell behind the bench's buffer: some items were never shown. */
  gap(at: string): void {
    this.#insert({ id: `page-gap-${++this.#gapCount}`, at, text: "Some older feed entries have expired and weren't shown.", scenario: true, retried: false });
  }

  add(items: readonly LabFeedItem[]): void {
    for (const item of items) this.#insert(this.#line(item));
  }

  /** The newest lines, oldest first: everything, or the scenario view. */
  lines(full: boolean): FeedLine[] {
    return (full ? this.#lines : this.#lines.filter(line => line.scenario)).slice(-FEED_SHOW);
  }

  #insert(line: FeedLine): void {
    // Traces carry the gateway's time and arrive a poll late; keep the list in time order.
    let index = this.#lines.length;
    while (index > 0 && this.#lines[index - 1]!.at > line.at) index--;
    this.#lines.splice(index, 0, line);
    if (this.#lines.length <= FEED_KEEP) return;
    // Busy traffic is mostly routine lines; drop the oldest of those so the scenario
    // view keeps its steps. Only a feed of nothing but scenario lines loses one.
    const routine = this.#lines.findIndex(kept => !kept.scenario);
    this.#lines.splice(routine === -1 ? 0 : routine, 1);
  }

  #line(item: LabFeedItem): FeedLine {
    const line = { id: item.id, at: item.at, scenario: true, retried: false };
    switch (item.kind) {
      case "action":
        if (item.action === "source.resume" || item.action === "gateway.restart") this.#recovery = item.action;
        return { ...line, text: `You: ${ACTION_LABELS[item.action]}` };
      case "source":
        return { ...line, text: `Source ${item.sourceId}: ${item.status}${item.reason ? ` (${item.reason})` : ""}` };
      case "record": {
        const key = coordinates(item);
        if (item.outcome === "failed") {
          const again = this.#failed.has(key);
          this.#failed.add(key);
          return { ...line, text: `${item.stationId} record ${place(item)}: map failed${again ? " again (the same record, retried)" : ""}` };
        }
        if (this.#failed.delete(key)) {
          this.#retried = { topic: item.topic, partition: item.partition, offset: item.offset, after: this.#recovery };
          return { ...line, retried: true, text: `Retried ${item.stationId} record ${place(item)}: mapper returned` };
        }
        return { ...line, scenario: false, text: `${item.stationId} record ${place(item)}: mapper returned` };
      }
      case "trace": {
        if (item.subscriber === "satellite" && item.stage === "receipt" && item.errorCode === "OVERLOADED" && this.#satellite) this.#satellite.overloaded = true;
        const who = item.subscriber === undefined ? "" : item.subscriber === "you" ? " · your view" : " · slow client";
        return { ...line, scenario: item.outcome === "failed" || item.outcome === "rejected", text: `${item.stage} ${item.outcome}${item.errorCode ? ` ${item.errorCode}` : ""}${item.channel ? ` · ${item.channel}` : ""}${who}` };
      }
      case "bench":
        if (item.event === "satellite-connected") this.#satellite = { connected: true, overloaded: false, disconnected: false };
        if (item.event === "satellite-disconnected") this.#satellite = { ...(this.#satellite ?? { connected: false, overloaded: false }), disconnected: true };
        return { ...line, text: BENCH_EVENTS[item.event] };
    }
  }
}

const BENCH_EVENTS: Record<Extract<LabFeedItem, { kind: "bench" }>["event"], string> = {
  "lease-started": "Lease started",
  "satellite-connected": "Slow client connected",
  "satellite-disconnected": "Slow client disconnected",
  "gateway-stopped": "Gateway stopped",
  "gateway-started": "Gateway started",
  gap: "Trace gap: some gateway steps are missing here"
};
