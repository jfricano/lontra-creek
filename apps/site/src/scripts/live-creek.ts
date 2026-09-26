/**
 * The home page's live panel: real StreamOtter subscriptions to the Lontra Creek
 * field station. Every state, revision, and log line comes from the SDK.
 */
import type { Client, StreamError, StreamEvent, SubscriptionState } from "streamotter/client";
import type { AppChannels } from "../generated/streamotter.generated.ts";
import { CreekCanvas, type Lane } from "./creek-canvas.ts";
import { fetchConfig, requestBadge } from "./field-api.ts";
import { installTabletNetwork, setOnline } from "./tablet-network.ts";

// Must run before the SDK is imported; see tablet-network.ts.
installTabletNetwork();

type Gauge = AppChannels["station"]["data"];
type Otter = AppChannels["otter"]["data"];
type Overview = AppChannels["creekOverview"]["data"];

const BASEFLOW_LC02 = 61;
const TICKS_PER_GENERATION = 10n ** 12n;

interface Card {
  label: string;
  element: HTMLElement;
  lane: number;
  state: SubscriptionState;
  revision: bigint | null;
  revisionBeforeStale: bigint | null;
  updatedAt: number;
  render(data: unknown): void;
}

function $(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}

function shortRevision(revision: bigint): string {
  return `r${(revision % TICKS_PER_GENERATION).toString()}`;
}

function setText(root: ParentNode, key: string, value: string): void {
  const element = root.querySelector<HTMLElement>(`[data-v="${key}"]`);
  if (element === null || element.textContent === value) return;
  element.textContent = value;
  element.classList.remove("bump");
  void element.offsetWidth;
  element.classList.add("bump");
}

const ACTIVITY: Readonly<Record<Otter["activity"], string>> = {
  denning: "in a den",
  resting: "resting",
  foraging: "foraging",
  traveling: "traveling",
  grooming: "grooming",
  playing: "playing",
  away: "left the creek"
};

export async function mountLiveCreek(root: HTMLElement): Promise<void> {
  const logList = $(root, "[data-log]");
  const announcer = $(root, "[data-announce]");
  const connection = $(root, "[data-connection]");
  const clock = $(root, "[data-clock]");
  const source = $(root, "[data-source]");
  const note = $(root, "[data-note]");
  const drop = $(root, "[data-drop]") as HTMLButtonElement;
  const restore = $(root, "[data-restore]") as HTMLButtonElement;
  const started = performance.now();

  function log(html: string, announce?: string): void {
    const item = document.createElement("li");
    const seconds = ((performance.now() - started) / 1000).toFixed(1).padStart(5, " ");
    item.innerHTML = `<span class="t">+${seconds}s</span> ${html}`;
    logList.prepend(item);
    while (logList.children.length > 8) logList.lastElementChild?.remove();
    if (announce !== undefined) announcer.textContent = announce;
  }

  const lanes: Lane[] = [
    { label: "LC-02", offset: -0.52 },
    { label: "LO-07", offset: 0.04 },
    { label: "LC-03", offset: 0.56 }
  ];
  const canvas = new CreekCanvas($(root, "canvas") as HTMLCanvasElement, lanes);

  let config;
  try {
    config = await fetchConfig();
  } catch {
    root.dataset["status"] = "unavailable";
    source.textContent = "Field station unavailable";
    log('<span class="w">The field station is not answering.</span>', "The field station is unavailable.");
    return;
  }
  source.textContent = config.mode === "fixture" ? "Local replay of the simulation" : "Live on Kafka";

  const { createClient } = await import("streamotter/client");
  const client: Client<AppChannels> = createClient<AppChannels>({
    origin: config.gatewayOrigin,
    path: config.gatewayPath,
    getToken: async ({ signal }) => (await requestBadge("volunteer", signal)).token
  });

  client.on("state", ({ state }) => {
    connection.textContent = state;
    root.dataset["connection"] = state;
    log(`<span class="${state === "connected" ? "k" : "w"}">connection</span> ${state}`);
  });

  const cards: Card[] = [];

  function watch<K extends "station" | "otter">(
    element: HTMLElement,
    label: string,
    lane: number,
    channel: K,
    params: AppChannels[K]["params"],
    render: (data: AppChannels[K]["data"]) => void
  ): void {
    const card: Card = { label, element, lane, state: "idle", revision: null, revisionBeforeStale: null, updatedAt: 0, render: render as (data: unknown) => void };
    cards.push(card);
    const chip = $(element, "[data-state]");
    const subscription = client.subscribe(channel, { channelVersion: 1, params });

    subscription.on("state", ({ state }) => {
      if (state === "stale" && card.state !== "stale") card.revisionBeforeStale = card.revision;
      card.state = state;
      chip.dataset["state"] = state;
      chip.textContent = state;
      element.classList.toggle("is-stale", state === "stale" || state === "resync-required");
      const tone = state === "live" ? "k" : state === "stale" || state === "failed" || state === "resync-required" ? "w" : "s";
      log(`<span class="${tone}">${label}</span> state ${state}`, state === "live" || state === "stale" ? `${label} is ${state}` : undefined);
    });

    subscription.on("data", (event: StreamEvent<AppChannels[K]["data"]>) => {
      const revision = BigInt(event.revision);
      const apply = (): void => {
        // An update still in flight must never overwrite a newer snapshot.
        if (card.revision !== null && revision <= card.revision) return;
        card.revision = revision;
        card.updatedAt = performance.now();
        card.render(event.data);
        const rev = $(element, "[data-rev]");
        rev.textContent = shortRevision(revision);
        rev.title = `Revision ${event.revision}`;
      };
      if (event.kind === "snapshot") {
        const before = card.revisionBeforeStale;
        card.revision = null;
        apply();
        element.classList.remove("flash");
        void element.offsetWidth;
        element.classList.add("flash");
        log(`<span class="k">${label}</span> snapshot ${shortRevision(revision)}`);
        if (before !== null && revision > before) {
          notes.set(label, `${label} ${shortRevision(before)} → ${shortRevision(revision)}`);
          renderNotes();
        }
        card.revisionBeforeStale = null;
      } else {
        canvas.launch(lane, apply);
        log(`<span class="k">${label}</span> update ${shortRevision(revision)}`);
      }
    });

    subscription.on("error", (error: StreamError) => {
      log(`<span class="w">${label}</span> ${error.code}: ${error.message}`);
    });
  }

  const notes = new Map<string, string>();
  function renderNotes(): void {
    if (notes.size === 0) return;
    note.innerHTML = `<b>Back with fresh snapshots.</b> ${[...notes.values()].join(" · ")}. Revisions in between weren't replayed: StreamOtter V1 delivers the current state, not history.`;
  }

  const [gauge, pebble, canyon] = [...root.querySelectorAll<HTMLElement>("[data-card]")];
  if (gauge === undefined || pebble === undefined || canyon === undefined) throw new Error("Missing cards");

  watch(gauge, "LC-02", 0, "station", { stationId: "LC-02" }, (data: Gauge) => {
    setText(gauge, "flow", data.flowCfs.toFixed(data.flowCfs >= 100 ? 0 : 1));
    setText(gauge, "temp", data.waterTempC.toFixed(1));
    setText(gauge, "do", data.dissolvedOxygenMgL.toFixed(1));
    setText(gauge, "trend", data.trend);
  });
  watch(pebble, "LO-07", 1, "otter", { otterId: "LO-07" }, (data: Otter) => {
    setText(pebble, "reach", data.reachId === "withheld" ? "withheld" : data.reachName);
    setText(pebble, "activity", ACTIVITY[data.activity]);
    setText(pebble, "dives", String(data.divesThisHour));
    setText(pebble, "note", data.note);
  });
  watch(canyon, "LC-03", 2, "station", { stationId: "LC-03" }, (data: Gauge) => {
    setText(canyon, "stage", data.stageFt.toFixed(2));
    setText(canyon, "turbidity", data.turbidityNtu.toFixed(1));
    setText(canyon, "trend", data.trend);
  });

  const overview = client.subscribe("creekOverview", { channelVersion: 1, params: { watershed: "lontra" } });
  overview.on("data", (event: StreamEvent<Overview>) => {
    const data = event.data;
    clock.textContent = `Study day ${data.observed.day} · ${data.observed.time} · ${data.daylight} · ${data.weather}`;
    const lc02 = data.stations.find(station => station.stationId === "LC-02");
    canvas.setConditions({ flowRatio: (lc02?.flowCfs ?? BASEFLOW_LC02) / BASEFLOW_LC02, weather: data.weather, daylight: data.daylight });
  });
  overview.on("state", ({ state }) => {
    root.dataset["overview"] = state;
  });

  setInterval(() => {
    const now = performance.now();
    for (const card of cards) {
      const age = card.updatedAt === 0 ? null : Math.round((now - card.updatedAt) / 1000);
      const text = age === null ? "waiting" : card.state === "stale" ? `stale · last update ${age}s ago` : age < 2 ? "updated just now" : `updated ${age}s ago`;
      $(card.element, "[data-age]").textContent = text;
    }
  }, 500);

  drop.addEventListener("click", () => {
    setOnline(false);
    root.dataset["network"] = "offline";
    drop.disabled = true;
    restore.disabled = false;
    notes.clear();
    note.innerHTML = "<b>You're in Slate Canyon: no signal.</b> This page's connection to the gateway is cut. The creek keeps moving; your views say they're stale.";
    log('<span class="w">network</span> cut by you', "Connection cut");
    restore.focus();
  });
  restore.addEventListener("click", () => {
    setOnline(true);
    root.dataset["network"] = "online";
    restore.disabled = true;
    drop.disabled = false;
    note.innerHTML = "<b>Signal's back.</b> Reconnecting and asking for fresh snapshots…";
    log('<span class="k">network</span> restored; reconnecting', "Connection restored");
    // Reconnect now instead of waiting out the SDK's backoff.
    client.reconnect({ timeoutMs: 15_000 }).catch(() => undefined);
    drop.focus();
  });
}

const root = document.querySelector<HTMLElement>("[data-live-creek]");
if (root !== null) {
  mountLiveCreek(root).catch(error => {
    console.error(error);
    root.dataset["status"] = "unavailable";
  });
}
