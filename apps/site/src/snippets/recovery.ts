import type { Subscription, Json, StreamError } from "streamotter/client";
declare const view: Subscription<Json>;
/** Stand-in for showing the view's state; declared so the snippet type-checks. */
declare function showState(state: string, reason?: string): void;
/** Stand-in for a button that runs `action`. */
declare function offerRetry(action: () => Promise<void>): void;
/** Stand-in for reporting an error. */
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
