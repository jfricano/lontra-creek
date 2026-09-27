import type { Subscription, Json, StreamError } from "streamotter/client";
declare const view: Subscription<Json>;
declare function showState(state: string, reason?: string): void;
declare function offerRetry(action: () => Promise<void>): void;
declare function report(error: StreamError): void;
// snippet:start
view.on("state", ({ state, reason }) => {
  showState(state, reason);
  if (state === "resync-required") {
    offerRetry(async () => { await view.resync(); });
  }
});
view.on("error", error => report(error));
// A source pause arrives through "state", not "error".
// A failed subscription needs a replacement subscription.
// snippet:end
