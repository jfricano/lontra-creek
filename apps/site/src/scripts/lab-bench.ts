/**
 * The "Your bench" strip: one chip per part of the bench, from the lease's bench state
 * and the page's own LC-03 view, plus the Kafka position the feed shows. Pure, so the
 * chips are testable without a DOM; `lab.ts` writes them into the strip.
 */
import type { LabBenchState } from "../../../field-station/src/lab/contract.ts";
import type { Coordinates } from "./lab-feed.ts";

export type BenchChipKey = "gateway" | "source" | "relay" | "calibration" | "satellite" | "view";

export interface BenchChip {
  key: BenchChipKey;
  label: string;
  text: string;
  /** The `.chip` state class (styles/global.css): the SDK's own state for the view, a matching tone for the rest. */
  state: string;
}

/** What the page's SDK reports for its LC-03 view. */
export interface ViewSummary {
  state: string;
  reason: string | undefined;
  revision: string | undefined;
}

export const CHIP_LABELS: Record<BenchChipKey, string> = {
  gateway: "Gateway", source: "Source", relay: "Relay", calibration: "Calibration", satellite: "Slow client", view: "Your view"
};

const KEYS: readonly BenchChipKey[] = ["gateway", "source", "relay", "calibration", "satellite", "view"];

/** healthy: consuming · degraded: the Kafka connection is lost · paused: held at a record. */
const SOURCE_TONES: Record<string, string> = { healthy: "live", degraded: "stale", paused: "failed" };

export function benchChips(state: LabBenchState | undefined, view: ViewSummary): BenchChip[] {
  const text: Record<BenchChipKey, [string, string]> = state === undefined
    ? { gateway: ["—", "idle"], source: ["—", "idle"], relay: ["—", "idle"], calibration: ["—", "idle"], satellite: ["—", "idle"], view: [view.state, view.state] }
    : {
      gateway: [state.gateway, state.gateway === "running" ? "live" : "synchronizing"],
      source: [`${state.source.status}${state.source.reason ? ` · ${state.source.reason}` : ""}`, SOURCE_TONES[state.source.status] ?? "idle"],
      relay: [state.relay, state.relay === "up" ? "live" : "failed"],
      calibration: [state.calibration, state.calibration === "present" ? "live" : "failed"],
      satellite: [state.satellite, state.satellite === "idle" ? "idle" : "synchronizing"],
      view: [`${view.state}${view.reason ? ` · ${view.reason}` : ""}`, view.state]
    };
  return KEYS.map(key => ({ key, label: CHIP_LABELS[key], text: text[key][0], state: text[key][1] }));
}

/** The line beside the view chip while the view is stale: what the SDK keeps on screen is the last value, not current data. */
export function staleNote(view: ViewSummary): string {
  return view.state === "stale" && view.revision ? `Stale: revision ${view.revision} is the last value your SDK received, kept on screen, not current data.` : "";
}

/** The bench's Kafka position, from the feed: the record it is held at, or the last one its mapper returned for. */
export function positionText(position: { held: Coordinates | null; last: Coordinates | null }): string {
  const where = (c: Coordinates) => `${c.topic} · partition ${c.partition} · offset ${c.offset}`;
  if (position.held) return `Held at ${where(position.held)}`;
  if (position.last) return `Last mapped ${where(position.last)}`;
  return "";
}
