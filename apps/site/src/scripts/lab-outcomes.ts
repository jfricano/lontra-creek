/**
 * Feedback where the visitor clicked: each bench control and each source-failure row has
 * one outcome slot under its buttons (`[data-lab-outcome="<slot>"]`). A pressed action
 * writes its sentence there at once; what the feed and the incident projection observe
 * later lands in the same slot, so the cause and its effect are never apart.
 */
import type { LabAction, LabScenarioId } from "../../../field-station/src/lab/contract.ts";
import type { Recovery } from "./lab-feed.ts";

export type OutcomeSlot = "sensor" | "blip" | "relay" | "satellite" | "gateway" | `scenario:${LabScenarioId}`;

export const ACTION_SLOT: Record<LabAction, OutcomeSlot> = {
  "sensor.foul": "sensor", "sensor.restore": "sensor", "source.resume": "sensor",
  "relay.cut": "relay", "relay.restore": "relay",
  "satellite.start": "satellite", "gateway.restart": "gateway"
};

/** Written the moment the bench accepts the action: what to watch for, never that it already happened. */
export const ACTION_SENT: Record<LabAction, string> = {
  "sensor.foul": "Calibration removed. The next LC-03 record can't be mapped: watch Source go paused and your view go stale.",
  "sensor.restore": "Calibration is back. The source stays paused at the held record until you retry it.",
  "source.resume": "Resume sent: the gateway re-reads the exact held record, never a later one. The feed shows how it went.",
  "relay.cut": "Kafka path cut. Your connection to the gateway stays up; the view goes stale in a few seconds.",
  "relay.restore": "Relay back. Watch for a fresh snapshot.",
  "satellite.start": "Slow client started. It stops acknowledging; after the receipt timeout the gateway disconnects it. Your own view keeps flowing.",
  "gateway.restart": "Gateway restarting. The SDK reconnects on its own, no reload, and takes a fresh snapshot."
};

/** Written when Start is accepted for a source-failure story. */
export const SCENARIO_SENT = "Started. The bench is publishing the record; what the gateway does with it appears in Current incident below.";

/** Where a story's lines go: the two stories with bench controls share their control's slot. */
export function scenarioSlot(id: LabScenarioId): OutcomeSlot {
  if (id === "fouled-sensor") return "sensor";
  if (id === "calibration-blip") return "blip";
  return `scenario:${id}`;
}

/**
 * Where a retried record's line goes: under the bench control that let it be read again,
 * or, when no bench action did (an incident intent retried it), under the story that holds
 * the record; Fouled sensor when nothing says which.
 */
export function retriedSlot(after: Recovery | null, scenario: LabScenarioId | null = null): OutcomeSlot {
  if (after === "gateway.restart") return "gateway";
  if (after === "source.resume" || scenario === null) return "sensor";
  return scenarioSlot(scenario);
}
