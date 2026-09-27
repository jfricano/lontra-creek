/// <reference lib="dom" />
// Shown on the home page between the snippet markers, and type-checked against the release.
import { createClient } from "streamotter/client";
import type { AppChannels } from "../generated/streamotter.generated.ts";

declare const session: { token(signal: AbortSignal): Promise<string> };
declare function render(reading: AppChannels["station"]["data"]): void;
declare function showState(state: string): void;

// snippet:start
const client = createClient<AppChannels>({
  getToken: ({ signal }) => session.token(signal)
});

const gauge = client.subscribe("station", {
  channelVersion: 1,
  params: { stationId: "LC-02" }
});
// A snapshot, then newer states in order.
gauge.on("data", event => render(event.data));
// Live, stale, resync-required…
gauge.on("state", ({ state }) => showState(state));
await gauge.ready();
// snippet:end
