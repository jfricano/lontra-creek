import type { Client } from "streamotter/client";
import type { LabStatus, LabLease, LabToken, LabAction, LabActionResult, LabFeedPage, LabBenchState, LabErrorCode, LabIncidentView } from "../../../field-station/src/lab/contract.ts";
import { channelVersions, type AppChannels } from "../generated/streamotter.generated.ts";
import { LabFeedModel, retriedOutcome } from "./lab-feed.ts";
import { capabilityAnswer, type CapabilityAnswer } from "./lab-catalog-model.ts";
import type { BrowserStep } from "./lab-incident.ts";
import { IncidentPanel } from "./lab-incident-panel.ts";
import { mountTracks } from "./lab-tracks.ts";
import { HttpStatusError, SignInRetry } from "./sign-in-retry.ts";
import { installTabletNetwork } from "./tablet-network.ts";
installTabletNetwork();
const origin = (import.meta.env?.PUBLIC_FIELD_STATION_ORIGIN ?? "").replace(/\/+$/, "");
// The chooser and catalog work without the Lab: selecting a track or scenario only explains.
const tracks = mountTracks(document);
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
  "too-many-places": "This network address already holds two places across the Failure Lab and the workbench sandbox. Return one of them, then try again.",
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
  const incident = new IncidentPanel(el("[data-lab-incident]"));
  let capabilities: CapabilityAnswer = { kind: "pending" };
  let connection = "idle";
  let viewReason: string | undefined;
  let lastValue: string | undefined;
  /** The page's own SDK observations, for the incident's observed steps. Bounded. */
  const browserSteps: BrowserStep[] = [];
  /** The incident state last announced, so polling announces only changes. */
  let announced: string | null = null;
  function observe(text: string): void { browserSteps.push({ at: new Date(Date.now() + offset).toISOString(), text }); if (browserSteps.length > 50) browserSteps.shift(); }
  function applicationView(): void { incident.application({ connection, subscription: viewState, reason: viewReason, revision, value: lastValue }); }
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
    connection = "idle"; viewReason = undefined; lastValue = undefined; browserSteps.length = 0; announced = null; incident.clear();
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
    // The bench's own predicates (field-station lab/runtime.ts), so a button is never offered for a 409 `not-applicable`.
    // Every action needs a running gateway; Resume also waits for the calibration, or the record would only fail again.
    const running = state.gateway === "running";
    const allowed: Record<LabAction, boolean> = {
      "sensor.foul": running && state.calibration === "present", "sensor.restore": running && state.calibration === "removed",
      "source.resume": running && state.source.status === "paused" && state.calibration === "present",
      "relay.cut": running && state.relay === "up", "relay.restore": running && state.relay === "cut",
      "satellite.start": running && state.satellite === "idle" && state.source.status === "healthy", "gateway.restart": running && state.relay === "up"
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
      next.on("state", ({ state }) => { if (activeSequence !== sequence) return; connection = state; observe(`Connection ${state}`); applicationView(); });
      const view = client.subscribe("station", { channelVersion: channelVersions.station, params: { stationId: "LC-03" } });
      view.on("state", ({ state, reason }) => { if (activeSequence !== sequence) return; viewState = state; viewReason = reason; el("[data-lab-view-state]").textContent = `${state}${reason ? ` · ${reason}` : ""}`; observe(`LC-03 subscription ${state}${reason ? ` (${reason})` : ""}`); applicationView(); });
      let previous: string | undefined;
      view.on("data", event => {
        if (activeSequence !== sequence) return;
        el("[data-lab-stage]").textContent = `${event.data.stageFt} ft`; el("[data-lab-flow]").textContent = `${event.data.flowCfs} cfs`;
        el("[data-lab-revision]").textContent = event.revision; revision = event.revision; lastValue = `${event.data.stageFt} ft, ${event.data.flowCfs} cfs`; applicationView();
        if (event.kind === "snapshot" && previous) el("[data-lab-snapshot-note]").textContent = `Fresh snapshot ${previous} → ${event.revision}; intermediate states were not replayed.`;
        previous = event.revision;
      });
    } finally { if (activeSequence === sequence) connectingLeaseId = undefined; } // a newer connect owns the marker otherwise
  }
  async function renderLease(next: LabLease): Promise<void> {
    heartbeatHealthy = true;
    const changed = lease?.status !== next.status || ("leaseId" in next && (!lease || !("leaseId" in lease) || lease.leaseId !== next.leaseId));
    lease = next; offset = Date.parse(next.now) - Date.now();
    incident.explain(capabilities, next.status === "ready" || next.status === "active");
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
      catch(error) { heartbeatHealthy = false; actions.disabled = true; await failed(error); }
    }
  }
  /** Says why a request failed. A 401 `no-session` means the session cookie lapsed, and the place or lease ended with it: show it ended, as the workbench does. */
  async function failed(error: unknown): Promise<void> {
    if (error instanceof HttpStatusError && error.code === "no-session" && lease && lease.status !== "none" && lease.status !== "ended") {
      const at = new Date(Date.now() + offset).toISOString();
      await renderLease({ status: "ended", now: at, reason: "session-ended", endedAt: at, bench: null });
    }
    message.textContent = explain(error);
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
      outcome.textContent = retriedOutcome(retried);
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
    } catch(error) { await failed(error); }
  }
  /** The capability summary, once per page and on Check again. A 404 (the fixture demo, an older backend) leaves every new exercise unavailable. */
  async function loadCapabilities(): Promise<void> {
    try { capabilities = capabilityAnswer(await request<unknown>("capabilities")); }
    catch (error) { capabilities = error instanceof HttpStatusError && error.status === 404 ? { kind: "absent" } : { kind: "unreachable" }; }
    tracks?.showCapabilities(capabilities);
    incident.explain(capabilities, lease?.status === "ready" || lease?.status === "active");
  }
  /** The PROPOSED current-incident projection: fetched only when the backend says it serves one, which no release does yet. */
  async function incidentPoll(): Promise<void> {
    if (!leaseId || capabilities.kind !== "summary" || !capabilities.summary.features.incidentProjection.available) return;
    const activeSequence = sequence;
    try {
      const view = await request<LabIncidentView>("incident");
      if (activeSequence !== sequence) return;
      const state = incident.render(view, browserSteps);
      if (state !== null) applicationView();
      if (state !== null && state !== announced) outcome.textContent = state;
      announced = state;
    } catch { /* The lease poll reports a lost lease; the panel keeps its last served state. */ }
  }
  fullFeed.addEventListener("change", renderFeed);
  joins.addEventListener("click", () => { joins.disabled = true; void request<LabLease>("lease", {}).then(renderLease).catch(async error => { await failed(error); joins.disabled = false; }); });
  returns.addEventListener("click", () => { returns.disabled = true; void request<LabLease>("lease/return", undefined, "POST").then(renderLease).catch(async error => { returns.disabled = false; await failed(error); }); });
  el("[data-lab-retry]").addEventListener("click", () => { void status(); if (capabilities.kind !== "summary") void loadCapabilities(); });
  root.querySelectorAll<HTMLButtonElement>("[data-lab-action]").forEach(button => button.addEventListener("click", () => {
    if (actionBusy) return; actionBusy = true; actions.disabled = true;
    const action = button.dataset["labAction"] as LabAction; const from = revision;
    void request<LabActionResult>("actions", { action }).then(result => { nextActionAt = Date.parse(result.nextActionAt); benchState(result.benchState); if (action === "satellite.start") { satelliteFrom = from; outcome.textContent = ""; } })
      .catch(failed).finally(() => { actionBusy = false; });
  }));
  let pollTick = 0;
  async function poll(): Promise<void> {
    if (stopped) return;
    await feed(); if (pollTick % 2 === 0) { await leasePoll(); await incidentPoll(); } if (pollTick % 10 === 0) await status(); pollTick++;
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
  void loadCapabilities();
  await status(); timer = setTimeout(() => { void poll(); }, 1_000);
}

// pagehide closes clients; a bfcache restore must obtain fresh subscriptions.
window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
