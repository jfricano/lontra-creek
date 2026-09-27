import { IdleDeadline } from "./walkthrough-model.ts";

/** Close after ten minutes idle or hidden, with an explicit fresh-session resume. */
export function watchIdle(onExpire: () => void): () => void {
  const deadline = new IdleDeadline(Date.now());
  const activity = (): void => {
    const now = Date.now();
    if (deadline.expired(now)) expire(); else deadline.activity(now);
  };
  const visibility = (): void => {
    // Check before clearing hiddenAt: coming back must not renew an expired lease.
    if (deadline.expired(Date.now())) expire();
    deadline.visibility(document.hidden, Date.now());
  };
  const events = ["pointerdown", "keydown", "pointermove", "scroll"] as const;
  let ended = false;
  const expire = (): void => { if (!ended) { ended = true; cleanup(); onExpire(); } };
  const timer = setInterval(() => { if (deadline.expired(Date.now())) expire(); }, 1_000);
  const cleanup = (): void => {
    clearInterval(timer);
    for (const event of events) window.removeEventListener(event, activity);
    document.removeEventListener("visibilitychange", visibility);
  };
  for (const event of events) window.addEventListener(event, activity, { passive: true });
  document.addEventListener("visibilitychange", visibility);
  deadline.visibility(document.hidden, Date.now());
  return cleanup;
}
