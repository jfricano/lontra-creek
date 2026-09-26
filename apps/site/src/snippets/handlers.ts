// Shown on the home page between the snippet markers, and type-checked against the release.
import type { HandlerRegistry, Json } from "streamotter/gateway";
import type { AppChannels } from "../generated/streamotter.generated.ts";

type HoltHandlers = HandlerRegistry<AppChannels>["channels"]["holt"];
type Holt = AppChannels["holt"];
declare const fieldStation: { holt(id: Holt["params"]["holtId"], signal: AbortSignal): Promise<{ revision: string; data: Holt["data"] }> };
declare function holtStates(value: Json): { tenantId: string; params: Holt["params"]; revision: string; data: Holt["data"] }[];

// snippet:start
export const holt: HoltHandlers = {
  // Den sites are protected: only researchers may subscribe.
  authorize: ({ principal }) => principal.claims["role"] === "researcher",
  // Pick this channel's state out of each Kafka record.
  map: ({ record }) => holtStates(record.value),
  // The current state, read before any buffered update is released.
  snapshot: ({ params, signal }) => fieldStation.holt(params.holtId, signal)
};
// snippet:end
