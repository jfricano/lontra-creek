/**
 * The home page's live panel: real StreamOtter subscriptions to the Lontra Creek
 * field station. Every state, revision, and log line comes from the SDK.
 */
// First: it installs the tablet network before anything can load the SDK.
import { FieldStationUnavailableError, openFieldClient, type FieldClient } from "./field-client.ts";
import { $, bindCard, tickAges, type Card } from "./field-cards.ts";
import { createSdkLog, logConnection, logView } from "./field-log.ts";
import { shortRevision, type ChannelName, type ChannelParams } from "./field-views.ts";
import { watchIdle } from "./idle-session.ts";
import { CreekCanvas, type Lane } from "./creek-canvas.ts";

const BASEFLOW_LC02 = 61;

export async function mountLiveCreek(root: HTMLElement): Promise<void> {
  const log = createSdkLog($(root, "[data-log]"), $(root, "[data-announce]"));
  const connection = $(root, "[data-connection]");
  const clock = $(root, "[data-clock]");
  const source = $(root, "[data-source]");
  const note = $(root, "[data-note]");
  const drop = $(root, "[data-drop]") as HTMLButtonElement;
  const restore = $(root, "[data-restore]") as HTMLButtonElement;

  const lanes: Lane[] = [
    { label: "LC-02", offset: -0.52 },
    { label: "LO-07", offset: 0.04 },
    { label: "LC-03", offset: 0.56 }
  ];
  const canvas = new CreekCanvas($(root, "canvas") as HTMLCanvasElement, lanes);

  const motion = $(root, "[data-pause-motion]") as HTMLButtonElement;
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  let paused = preference.matches;
  function renderMotion(): void {
    root.dataset["motion"] = paused ? "paused" : "running";
    motion.setAttribute("aria-pressed", String(paused));
    motion.textContent = paused ? "Resume motion" : "Pause motion";
    canvas.setPaused(paused);
  }
  motion.addEventListener("click", () => { paused = !paused; renderMotion(); });
  preference.addEventListener("change", event => { paused = event.matches; renderMotion(); });
  renderMotion();
  canvas.setLive(false);

  function unavailable(why: string): void {
    if (root.dataset["status"] === "unavailable") return;
    root.dataset["status"] = "unavailable";
    source.textContent = "Field station unavailable";
    clock.textContent = "Still trying to reach the field station";
    canvas.setLive(false);
    root.querySelectorAll<HTMLElement>("[data-age]").forEach(age => { age.textContent = "not connected"; });
    drop.disabled = true;
    log.write([{ tone: "w", text: why }], "The live demo is unavailable right now.");
  }

  let field: FieldClient;
  try {
    field = await openFieldClient();
  } catch (error) {
    if (!(error instanceof FieldStationUnavailableError)) throw error;
    unavailable(error.message);
    return;
  }
  source.textContent = field.sourceLabel;

  logConnection(log, field.client);
  field.client.on("state", ({ state }) => {
    connection.textContent = state;
    root.dataset["connection"] = state;
    if (state === "connected" && root.dataset["status"] === "unavailable") {
      delete root.dataset["status"];
      source.textContent = field.sourceLabel;
      drop.disabled = root.dataset["network"] === "offline";
      log.announce("Connected to the field station.");
    }
  });
  field.on("unreachable", () => unavailable("The gateway can't be reached; still trying."));

  const notes = new Map<string, string>();
  function renderNotes(): void {
    if (notes.size === 0) return;
    note.innerHTML = `<b>Back with fresh snapshots.</b> ${[...notes.values()].join(" · ")}. Revisions in between weren't replayed: StreamOtter V1 delivers the current state, not history.`;
  }

  function card<K extends ChannelName>(element: HTMLElement, label: string, lane: number, channel: K, params: ChannelParams<K>): Card {
    const view = field.watch(channel, params);
    const bound = bindCard(view, element, {
      deliver: apply => canvas.launch(lane, apply),
      onCaughtUp: (before, after) => {
        notes.set(label, `${label} ${shortRevision(before)} → ${shortRevision(after)}`);
        renderNotes();
      }
    });
    logView(log, view, label);
    return bound;
  }

  const [gauge, pebble, canyon] = [...root.querySelectorAll<HTMLElement>("[data-card]")];
  if (gauge === undefined || pebble === undefined || canyon === undefined) throw new Error("Missing cards");
  const cards = [
    card(gauge, "LC-02", 0, "station", { stationId: "LC-02" }),
    card(pebble, "LO-07", 1, "otter", { otterId: "LO-07" }),
    card(canyon, "LC-03", 2, "station", { stationId: "LC-03" })
  ];

  const overview = field.watch("creekOverview", { watershed: "lontra" });
  overview.on("data", ({ event: { data } }) => {
    clock.textContent = `Study day ${data.observed.day} · ${data.observed.time} · ${data.daylight} · ${data.weather}`;
    const lc02 = data.stations.find(station => station.stationId === "LC-02");
    canvas.setConditions({ flowRatio: (lc02?.flowCfs ?? BASEFLOW_LC02) / BASEFLOW_LC02, weather: data.weather, daylight: data.daylight });
  });
  overview.on("state", ({ state }) => {
    root.dataset["overview"] = state;
    canvas.setLive(state === "live");
  });

  const stopAges = tickAges(cards);
  const stopIdle = watchIdle(() => {
    stopAges();
    void field.close();
    canvas.setLive(false);
    clock.textContent = "Session paused after ten minutes idle";
    drop.disabled = true; restore.disabled = true;
    const resume = document.createElement("button");
    resume.className = "lc-button lc-restore";
    resume.textContent = "Resume with fresh snapshots";
    resume.dataset["sessionResume"] = "";
    resume.addEventListener("click", () => location.reload());
    note.replaceChildren("Your session is paused. ", resume);
    log.announce("Session paused after ten minutes idle. Resume for fresh snapshots.");
  });
  window.addEventListener("pagehide", () => { stopIdle(); stopAges(); canvas.setLive(false); void field.close(); }, { once: true });

  drop.addEventListener("click", () => {
    field.dropConnection();
    root.dataset["network"] = "offline";
    drop.disabled = true;
    restore.disabled = false;
    notes.clear();
    note.innerHTML = "<b>You're in Slate Canyon: no signal.</b> This page's connection to the gateway is cut. The creek keeps moving; your views say they're stale.";
    log.write([{ tone: "w", text: "network" }, " cut by you"], "Connection cut");
    restore.focus();
  });
  restore.addEventListener("click", () => {
    root.dataset["network"] = "online";
    restore.disabled = true;
    drop.disabled = false;
    note.innerHTML = "<b>Signal's back.</b> Reconnecting and asking for fresh snapshots…";
    log.write([{ tone: "k", text: "network" }, " restored; reconnecting"], "Connection restored");
    // Reconnects now instead of waiting out the SDK's backoff.
    field.restoreConnection().catch(() => undefined);
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
