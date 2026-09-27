import type { Client } from "streamotter/client";
import type { LabStatus, LabLease, LabToken, LabAction, LabActionResult, LabFeedPage, LabBenchState } from "../../../field-station/src/lab/contract.ts";
import { channelVersions, type AppChannels } from "../generated/streamotter.generated.ts";
import { installTabletNetwork } from "./tablet-network.ts";
installTabletNetwork();
const origin = (import.meta.env?.PUBLIC_FIELD_STATION_ORIGIN ?? "").replace(/\/+$/, "");
const root = document.querySelector<HTMLElement>("[data-lab]");
if (root) void mount(root);
async function mount(root: HTMLElement): Promise<void> {
  function el<T extends HTMLElement = HTMLElement>(selector: string): T { const element = root.querySelector<T>(selector); if (!element) throw new Error(`Missing ${selector}`); return element; }
  let client: Client<AppChannels> | undefined;
  let lease: LabLease | undefined;
  let leaseId: string | undefined;
  let cursor = "";
  let stopped = false;
  let actionBusy = false;
  let heartbeatHealthy = false;
  let poolAvailable = false;
  let nextActionAt = 0;
  let offset = 0;
  let sequence = 0;
  const message = el("[data-lab-message]");
  const joins = el<HTMLButtonElement>("[data-lab-join]");
  const returns = el<HTMLButtonElement>("[data-lab-return]");
  const actions = el<HTMLFieldSetElement>("[data-lab-actions]");
  async function request<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(`${origin}/api/lab/${path}`, { method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(8_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json() as T & { error?: string; code?: string };
    if (!response.ok) throw new Error(data.error ?? `Lab request failed (${response.status}).`);
    return data;
  }
  async function disconnect(): Promise<void> { sequence++; const old = client; client = undefined; leaseId = undefined; cursor = ""; await old?.close(); actions.disabled = true; }
  function benchState(state: LabBenchState): void {
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
    el("[data-lab-feed]").replaceChildren();
    const token = await request<LabToken>("lease/token", {});
    const { createClient } = await import("streamotter/client");
    if (stopped || activeSequence !== sequence) return;
    client = createClient<AppChannels>({ origin: token.gatewayOrigin, path: token.gatewayPath,
      getToken: async () => (await request<LabToken>("lease/token", {})).token });
    leaseId = current.leaseId;
    const view = client.subscribe("station", { channelVersion: channelVersions.station, params: { stationId: "LC-03" } });
    view.on("state", ({ state, reason }) => { el("[data-lab-view-state]").textContent = `${state}${reason ? ` · ${reason}` : ""}`; });
    let previous: string | undefined;
    view.on("data", event => {
      el("[data-lab-stage]").textContent = `${event.data.stageFt} ft`; el("[data-lab-flow]").textContent = `${event.data.flowCfs} cfs`;
      el("[data-lab-revision]").textContent = event.revision;
      if (event.kind === "snapshot" && previous) el("[data-lab-snapshot-note]").textContent = `Fresh snapshot ${previous} → ${event.revision}; intermediate states were not replayed.`;
      previous = event.revision;
    });
  }
  async function renderLease(next: LabLease): Promise<void> {
    heartbeatHealthy = true;
    lease = next; offset = Date.parse(next.now) - Date.now();
    returns.disabled = next.status === "none" || next.status === "ended";
    joins.disabled = !returns.disabled;
    if (next.status === "queued") { message.textContent = `All benches are busy. Your place in line: ${next.position} of ${next.queueLength}.`; await disconnect(); }
    else if (next.status === "ready" || next.status === "active") {
      message.textContent = `Your isolated bench: ${next.bench}.`; benchState(next.benchState); nextActionAt = Date.parse(next.nextActionAt);
      if (leaseId !== next.leaseId) await connect(next);
    } else { message.textContent = next.status === "ended" ? `Your lease ended: ${next.reason}. You can join again.` : "Choose Borrow a bench to begin."; await disconnect(); el("[data-lab-clock]").textContent = ""; }
  }
  async function status(): Promise<void> {
    try {
      const result = await request<LabStatus>("status");
      const working = result.enabled && result.benches.some(b => b.state === "ready" || b.state === "leased" || b.state === "resetting");
      poolAvailable = working;
      el("[data-lab-unavailable]").hidden = working;
      el("[data-lab-pool]").textContent = result.enabled ? result.benches.map(b => `Bench ${b.bench}: ${b.state}`).join(" · ") : "Lab not enabled on this deployment.";
      if (!working) { joins.disabled = true; await disconnect(); message.textContent = "The Lab is unavailable."; }
      else if (!lease || lease.status === "none" || lease.status === "ended") { joins.disabled = false; message.textContent = "Choose Borrow a bench to begin."; }
    } catch { poolAvailable = false; el("[data-lab-unavailable]").hidden = false; message.textContent = "The Lab is unavailable."; joins.disabled = true; await disconnect(); }
  }
  async function leasePoll(): Promise<void> {
    if (lease && lease.status !== "none" && lease.status !== "ended") {
      try { await renderLease(await request<LabLease>("lease")); }
      catch(error) { heartbeatHealthy = false; message.textContent = String(error); actions.disabled = true; }
    }
  }
  async function feed(): Promise<void> {
    if (!leaseId) return;
    const id = leaseId;
    try {
      const page = await request<LabFeedPage>(`trace${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`);
      if (leaseId !== id) return;
      cursor = page.next;
      const list = el("[data-lab-feed]");
      if (page.gap) { const li = document.createElement("li"); li.textContent = "Some older feed entries have expired."; list.append(li); }
      for (const item of page.items) { const li = document.createElement("li"); li.textContent = `${item.at} · ${JSON.stringify(item)}`; list.append(li); }
      while (list.children.length > 100) list.firstElementChild?.remove();
    } catch(error) { message.textContent = String(error); }
  }
  joins.addEventListener("click", () => { joins.disabled = true; void request<LabLease>("lease", {}).then(renderLease).catch(error => { message.textContent = String(error); joins.disabled = false; }); });
  returns.addEventListener("click", () => { returns.disabled = true; void request<LabLease>("lease/return", undefined, "POST").then(renderLease).catch(error => { message.textContent = String(error); returns.disabled = false; }); });
  el("[data-lab-retry]").addEventListener("click", () => { void status(); });
  root.querySelectorAll<HTMLButtonElement>("[data-lab-action]").forEach(button => button.addEventListener("click", () => {
    if (actionBusy) return; actionBusy = true; actions.disabled = true;
    void request<LabActionResult>("actions", { action: button.dataset["labAction"] }).then(result => { nextActionAt = Date.parse(result.nextActionAt); benchState(result.benchState); })
      .catch(error => { message.textContent = String(error); }).finally(() => { actionBusy = false; });
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
