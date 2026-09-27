import type { FieldClient } from "../scripts/field-client.ts";

// These examples are compiled with the page against the pinned package.
// snippet:start
export function dawnSurvey(field: FieldClient) {
  const gauge = field.watch("station", { stationId: "LC-02" });
  gauge.on("state", ({ state }) => console.log(state));
  gauge.on("data", ({ event }) => console.log(event.data));
  return gauge;
}
export function loseSignal(field: FieldClient) {
  field.dropConnection();
  return () => field.restoreConnection();
}
export async function becomeResearcher(field: FieldClient) {
  await field.switchRole("researcher");
  return field.watch("holt", { holtId: "A" });
}
// snippet:end
