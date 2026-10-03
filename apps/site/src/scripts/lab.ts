import type { Client } from "streamotter/client";
import type { LabStatus, LabLease, LabToken, LabAction, LabActionResult, LabFeedPage, LabBenchState, LabErrorCode } from "../../../field-station/src/lab/contract.ts";
import { channelVersions, type AppChannels } from "../generated/streamotter.generated.ts";
import { LabFeedModel } from "./lab-feed.ts";
import { HttpStatusError, SignInRetry } from "./sign-in-retry.ts";
import { installTabletNetwork } from "./tablet-network.ts";
installTabletNetwork();
const origin = (import.meta.env?.PUBLIC_FIELD_STATION_ORIGIN ?? "").replace(/\/+$/, "");
const root = document.querySelector<HTMLElement>("[data-lab]");
if (root) void mount(root);
/** What each Lab error means to a visitor; the API's own codes, not its messages. */
const MESSAGES: Record<LabErrorCode, string> = {
  "invalid-request": "The Lab didn't accept that request.",
  "no-session": "Your Lab session has ended. Borrow a bench to start again.",
  "origin-not-allowed": "The Lab only accepts requests from this site.",
  "no-lease": "You don't have a bench right now.",
  "not-applicable": "That action doesn't apply to your bench's current state.",
  "unsupported-scenario": "This backend does not support this scenario.",
  "too-many-requests": "Too many Lab requests from your address. Trying again shortly.",
  "too-many-actions": "One action a second, please.",
  "too-many-places": "Your address already holds two places in the Lab.",
  "queue-full": "The line for a bench is full. Try again in a few minutes.",
  "lab-unavailable": "The Lab is unavailable.",
  "bench-unavailable": "Your bench stopped answering."
};
function explain(error: unknown): string {
  if (error instanceof HttpStatusError) return (error.code !== undefined && error.code in MESSAGES ? MESSAGES[error.code as LabErrorCode] : undefined) ?? (error.status >= 500 ? "The Lab isn't answering right now. Trying again." : `The Lab answered ${error.status}.`);
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "The Lab didn't answer in time. Trying again.";
  return "The Lab couldn't be reached. Trying again.";
}
async function mount(root: HTMLElement): Promise<void> {
  function el<T extends HTMLElement = HTMLElement>(selector: string): T { const element = root.querySelector<T>(selector); if (!element) throw new Error(`Missing ${selector}`); return element; }
  let client: Client<AppChannels> | undefined;
  let signIn: SignInRetry | undefined;
  let lease: LabLease | undefined;
  let leaseId: string | undefined;
  /** The lease a connect() is under way for, so polls and visibility changes don't start a second one. */
  let connectingLeaseId: string | undefined;
  let cursor = "";
  let stopped = false;
  let actionBusy = false;
  let heartbeatHealthy = false;
  let poolAvailable = false;
  let nextActionAt = 0;
  let offset = 0;
  /** Bumped on every disconnect: a connect, view event, or feed page from an older client is dropped. */
  let sequence = 0;
  let benchStateNow: LabBenchState | undefined;
  let viewState = "idle";
  let revision: string | undefined;
  let satelliteFrom: string | undefined;
  const model = new LabFeedModel();
  const message = el("[data-lab-message]");
  const joins = el<HTMLButtonElement>("[data-lab-join]");
  const returns = el<HTMLButtonElement>("[data-lab-return]");
  const actions = el<HTMLFieldSetElement>("[data-lab-actions]");
  const outcome = el("[data-lab-outcome]");
  const fullFeed = el<HTMLInputElement>("[data-lab-feed-all]");
  async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(8_000);
    const response = await fetch(`${origin}/api/lab/${path}`, { method, credentials: "include", cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    // A 502 from the edge has no JSON body: check the status first.
    const data = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
    if (!response.ok) throw new HttpStatusError(data.error ?? `Lab request failed (${response.status}).`, response.status, data.code);
    return data;
  }
  function resetPanel(): void {
    el("[data-lab-state]").textContent = "Not leased.";
    el("[data-lab-view-state]").textContent = "idle";
    for (const selector of ["[data-lab-stage]", "[data-lab-flow]", "[data-lab-revision]"]) el(selector).textContent = "—";
    el("[data-lab-snapshot-note]").textContent = "";
    outcome.textContent = "";
    benchStateNow = undefined; viewState = "idle"; revision = undefined; satelliteFrom = undefined;
    model.clear(); renderFeed();
  }
  async function disconnect(): Promise<void> {
    sequence++; const old = client; client = undefined; leaseId = undefined; connectingLeaseId = undefined; cursor = "";
    signIn?.stop(); signIn = undefined;
    await old?.close(); actions.disabled = true;
  }
  function benchState(state: LabBenchState): void {
    benchStateNow = state;
    el("[data-lab-state]").textContent = `Gateway ${state.gateway} · source ${state.source.status}${state.source.reason ? ` (${state.source.reason})` : ""} · relay ${state.relay} · calibration ${state.calibration} · satellite ${state.satellite} · receipt timeout ${state.receiptTimeoutMs / 1000}s`;
    const allowed: Record<LabAction, boolean> = {
      "sensor.foul": state.calibration === "present", "sensor.restore": state.calibration === "removed",
      "source.resume": state.source.status === "paused" && state.calibration === "present",
      "relay.cut": state.relay === "up", "relay.restore": state.relay === "cut",
      "satellite.start": state.satellite === "idle", "gateway.restart": state.gateway === "running"
    };
    root.querySelectorAll<HTMLButtonElement>("[data-lab-action]").forEach(button => { button.disabled = !allowed[button.dataset["labAction"] as LabAction]; });
  }
  async function connect(current: Extract<LabLease, { status: "ready" | "active" }>): Promise<void> {
    await disconnect();
    const activeSequence = sequence;
    connectingLeaseId = current.leaseId;
    resetPanel(); benchState(current.benchState);
    try {
      const token = await request<LabToken>("lease/token", {});
      const { createClient } = await import("streamotter/client");
      if (stopped || activeSequence !== sequence) return;
      // A transient token failure is retried with backoff; a 409 no-lease (the lease ended) stays final, and the lease poll says why.
      const retry = new SignInRetry(() => { void leasePoll(); });
      const next = createClient<AppChannels>({ origin: token.gatewayOrigin, path: token.gatewayPath,
        getToken: ({ signal }) => retry.token(async () => (await request<LabToken>("lease/token", {}, "POST", signal)).token) });
      retry.attach(next);
      client = next; signIn = retry; leaseId = current.leaseId;
      const view = client.subscribe("station", { channelVersion: channelVersions.station, params: { stationId: "LC-03" } });
      view.on("state", ({ state, reason }) => { if (activeSequence !== sequence) return; viewState = state; el("[data-lab-view-state]").textContent = `${state}${reason ? ` · ${reason}` : ""}`; });
      let previous: string | undefined;
      view.on("data", event => {
        if (activeSequence !== sequence) return;
        el("[data-lab-stage]").textContent = `${event.data.stageFt} ft`; el("[data-lab-flow]").textContent = `${event.data.flowCfs} cfs`;
        el("[data-lab-revision]").textContent = event.revision; revision = event.revision;
        if (event.kind === "snapshot" && previous) el("[data-lab-snapshot-note]").textContent = `Fresh snapshot ${previous} → ${event.revision}; intermediate states were not replayed.`;
        previous = event.revision;
      });
    } finally { if (activeSequence === sequence) connectingLeaseId = undefined; } // a newer connect owns the marker otherwise
  }
  async function renderLease(next: LabLease): Promise<void> {
    heartbeatHealthy = true;
    const changed = lease?.status !== next.status || ("leaseId" in next && (!lease || !("leaseId" in lease) || lease.leaseId !== next.leaseId));
    lease = next; offset = Date.parse(next.now) - Date.now();
    returns.disabled = next.status === "none" || next.status === "ended";
    joins.disabled = !returns.disabled;
    if (next.status === "queued") { message.textContent = `All benches are busy. Your place in line: ${next.position} of ${next.queueLength}.`; await disconnect(); resetPanel(); }
    else if (next.status === "ready" || next.status === "active") {
      message.textContent = `Your isolated bench: ${next.bench}.`; benchState(next.benchState); nextActionAt = Date.parse(next.nextActionAt);
      if (leaseId !== next.leaseId && connectingLeaseId !== next.leaseId) await connect(next);
    } else { message.textContent = next.status === "ended" ? `Your lease ended: ${next.reason}. You can join again.` : "Choose Borrow a bench to begin."; await disconnect(); resetPanel(); el("[data-lab-clock]").textContent = ""; }
    // The pool changes whenever this visitor's place does: show it now, not at the next 10 s poll.
    if (changed) void status();
  }
  async function status(): Promise<void> {
    try {
      const result = await request<LabStatus>("status");
      const working = result.enabled && result.benches.some(b => b.state === "ready" || b.state === "leased" || b.state === "resetting");
      poolAvailable = working;
      el("[data-lab-unavailable]").hidden = working;
      el("[data-lab-pool]").textContent = result.enabled ? result.benches.map(b => `Bench ${b.bench}: ${b.state}`).join(" · ") : "Lab not enabled on this deployment.";
      if (!working) { joins.disabled = true; await disconnect(); message.textContent = "The Lab is unavailable."; }
      else if (!lease || lease.status === "none" || lease.status === "ended") { joins.disabled = false; if (lease?.status !== "ended") message.textContent = "Choose Borrow a bench to begin."; }
    } catch { poolAvailable = false; el("[data-lab-unavailable]").hidden = false; message.textContent = "The Lab is unavailable."; joins.disabled = true; await disconnect(); }
  }
  async function leasePoll(): Promise<void> {
    if (lease && lease.status !== "none" && lease.status !== "ended") {
      try { await renderLease(await request<LabLease>("lease")); }
      catch(error) { heartbeatHealthy = false; message.textContent = explain(error); actions.disabled = true; }
    }
  }
  function renderFeed(): void {
    const list = el("[data-lab-feed]");
    list.replaceChildren(...model.lines(fullFeed.checked).map(line => {
      const li = document.createElement("li"); li.textContent = `${line.at.slice(11, 19)} · ${line.text}`;
      if (line.retried) li.className = "feed-retried";
      return li;
    }));
  }
  /** One line saying how the latest scenario turned out, from what the feed and the page's own view observed. */
  function renderOutcome(kind: "satellite" | "retried"): void {
    const satellite = model.satellite; const retried = model.retried;
    if (kind === "satellite" && satellite?.disconnected) {
      const timeout = benchStateNow ? `${benchStateNow.receiptTimeoutMs / 1000} s ` : "";
      const moved = satelliteFrom && revision && satelliteFrom !== revision ? ` and moved from revision ${satelliteFrom} to ${revision} since you started it` : "";
      outcome.textContent = `${satellite.overloaded ? `The slow client missed its ${timeout}receipt deadline and the gateway disconnected it (OVERLOADED).` : "The slow client disconnected."} Your LC-03 view is ${viewState}${moved}.`;
    } else if (kind === "retried" && retried) {
      outcome.textContent = `After Resume the gateway retried the same record, offset ${retried.offset} on ${retried.topic} partition ${retried.partition}, and the mapper returned. That isn't proof the offset was committed; the source state and your view show what happened next.`;
    }
  }
  async function feed(): Promise<void> {
    if (!leaseId) return;
    const activeSequence = sequence;
    try {
      const page = await request<LabFeedPage>(`trace${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`);
      // A reconnect while this was in flight reset the cursor: this page belongs to the old one.
      if (activeSequence !== sequence) return;
      cursor = page.next;
      if (page.gap) model.gap(page.items[0]?.at ?? new Date(Date.now() + offset).toISOString());
      const satellite = model.satellite; const overloaded = satellite?.overloaded; const retried = model.retried;
      model.add(page.items);
      const run = model.satellite; const changed = run !== satellite || run?.overloaded !== overloaded;
      if (page.items.length || page.gap) renderFeed();
      if (model.retried !== retried) renderOutcome("retried");
      if (run?.disconnected && changed) renderOutcome("satellite");
    } catch(error) { message.textContent = explain(error); }
  }
  fullFeed.addEventListener("change", renderFeed);
  joins.addEventListener("click", () => { joins.disabled = true; void request<LabLease>("lease", {}).then(renderLease).catch(error => { message.textContent = explain(error); joins.disabled = false; }); });
  returns.addEventListener("click", () => { returns.disabled = true; void request<LabLease>("lease/return", undefined, "POST").then(renderLease).catch(error => { message.textContent = explain(error); returns.disabled = false; }); });
  el("[data-lab-retry]").addEventListener("click", () => { void status(); });
  root.querySelectorAll<HTMLButtonElement>("[data-lab-action]").forEach(button => button.addEventListener("click", () => {
    if (actionBusy) return; actionBusy = true; actions.disabled = true;
    const action = button.dataset["labAction"] as LabAction; const from = revision;
    void request<LabActionResult>("actions", { action }).then(result => { nextActionAt = Date.parse(result.nextActionAt); benchState(result.benchState); if (action === "satellite.start") { satelliteFrom = from; outcome.textContent = ""; } })
      .catch(error => { message.textContent = explain(error); }).finally(() => { actionBusy = false; });
  }));
  let pollTick = 0;
  async function poll(): Promise<void> {
    if (stopped) return;
    await feed(); if (pollTick % 2 === 0) await leasePoll(); if (pollTick % 10 === 0) await status(); pollTick++;
    if (!stopped) timer = setTimeout(() => { void poll(); }, 1_000);
  }
  const clock = setInterval(() => {
    if (lease?.status === "ready" || lease?.status === "active") {
      const seconds = Math.max(0, Math.ceil((Date.parse(lease.expiresAt) - Date.now() - offset) / 1_000));
      el("[data-lab-clock]").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,"0")} left on your lease`;
      actions.disabled = !poolAvailable || !heartbeatHealthy || !client || !leaseId || actionBusy || Date.now() + offset < nextActionAt || seconds === 0;
    }
  }, 250);
  let timer: ReturnType<typeof setTimeout>;
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void leasePoll(); });
  window.addEventListener("pagehide", () => {
    stopped = true; clearTimeout(timer); clearInterval(clock); void disconnect();
    if (lease && lease.status !== "none" && lease.status !== "ended") void fetch(`${origin}/api/lab/lease/return`, { method: "POST", credentials: "include", keepalive: true });
  });
  await status(); timer = setTimeout(() => { void poll(); }, 1_000);
}

// pagehide closes clients; a bfcache restore must obtain fresh subscriptions.
window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
