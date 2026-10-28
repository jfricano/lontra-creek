// Shown on the home page between the snippet markers, and type-checked against the release.
import type { HandlerRegistry, Json } from "streamotter/gateway";
import type { AppChannels } from "../generated/streamotter.generated.ts";

type HoltHandlers = HandlerRegistry<AppChannels>["channels"]["holt"];
type Holt = AppChannels["holt"];
declare const fieldStation: { holt(id: Holt["params"]["holtId"], signal: AbortSignal): Promise<{ revision: string; data: Holt["data"] }> };
/** Stand-in for the application's record decoding; declared so the snippet type-checks. */
declare function holtStates(value: Json): { tenantId: string; params: Holt["params"]; revision: string; data: Holt["data"] }[];

/** The holt channel's handlers: researchers only, states picked from each Kafka record, snapshots read from the field station. */
// snippet:start
export const holt: HoltHandlers = {
  // Den sites are protected: only researchers may subscribe.
  authorize: ({ principal }) =>
    principal.claims["role"] === "researcher",
  // Pick this channel's state out of each Kafka record.
  map: ({ record }) => holtStates(record.value),
  // Read current state before releasing buffered updates.
  snapshot: ({ params, signal }) =>
    fieldStation.holt(params.holtId, signal)
};
// snippet:end
