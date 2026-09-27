import { openFieldClient, type FieldClient } from "./field-client.ts";
import { postSighting } from "./field-api.ts";
import { type View, type ChannelName } from "./field-views.ts";
import { FlowHistory, chapterFromHash } from "./walkthrough-model.ts";
import { watchIdle } from "./idle-session.ts";
import example from "../snippets/walkthrough.ts?raw";

const root = document.querySelector<HTMLElement>("[data-walkthrough]");
if (root !== null) void mount(root);
async function mount(root: HTMLElement): Promise<void> {
  function el<T extends HTMLElement = HTMLElement>(selector: string): T {
    const result = root.querySelector<T>(selector); if (!result) throw new Error(`Missing ${selector}`); return result;
  }
  const status = el("[data-walk-status]");
  const log = el("[data-walk-log]");
  const button = (selector: string): HTMLButtonElement => el<HTMLButtonElement>(selector);
  let field: FieldClient | undefined;
  let gauge: View<"station"> | undefined;
  let holt: View<"holt"> | undefined;
  let book: View<"notebook"> | undefined;
  let stopIdle = (): void => {};
  let chapter = chapterFromHash(location.hash);
  let switching = false;
  let generation = 0;
  let previousRevision: bigint | null = null;
  const history = new FlowHistory();
  function line(text: string): void {
    const li = document.createElement("li"); li.textContent = text; log.prepend(li);
    while (log.children.length > 40) log.lastElementChild?.remove();
  }
  function observe<K extends ChannelName>(view: View<K>, label: string): void {
    view.on("state", ({ state, reason }) => line(`${label}: ${state}${reason ? ` · ${reason}` : ""}`));
    view.on("data", ({ kind, revision, epoch }) => line(`${label}: ${kind} · revision ${revision} · snapshot ${epoch}`));
    view.on("error", error => line(`${label}: ${error.code}`));
  }
  function renderChapter(focus = false): void {
    root.querySelectorAll<HTMLElement>("[data-chapter]").forEach(panel => { panel.hidden = Number(panel.dataset["chapter"]) !== chapter; });
    root.querySelectorAll<HTMLAnchorElement>("[data-chapter-link]").forEach((link,i) => {
      if (i+1 === chapter) link.setAttribute("aria-current", "step"); else link.removeAttribute("aria-current");
    });
    button("[data-chapter-back]").disabled = chapter === 1;
    button("[data-chapter-next]").disabled = chapter === 6;
    el("[data-chapter-count]").textContent = `${chapter} of 6`;
    el("[data-chapter-code]").textContent = example.split("// snippet:start")[1]?.split("// snippet:end")[0]?.trim() ?? "";
    if (focus) root.querySelector<HTMLElement>(`[data-chapter="${chapter}"] h2`)?.focus();
  }
  window.addEventListener("hashchange", () => { chapter = chapterFromHash(location.hash); renderChapter(true); });
  button("[data-chapter-back]").addEventListener("click", () => { location.hash = `chapter-${Math.max(1, chapter-1)}`; });
  button("[data-chapter-next]").addEventListener("click", () => { location.hash = `chapter-${Math.min(6, chapter+1)}`; });
  renderChapter();

  function watchGauge(): void {
    if (!field) return;
    gauge = field.watch("station", { stationId: "LC-02" }); observe(gauge, "LC-02");
    gauge.on("state", ({ state, reason }) => {
      const chip = el("[data-walk-state]"); chip.dataset["walkState"] = state;
      chip.textContent = `${state}${reason ? ` · ${reason}` : ""}`;
      if (state === "stale") previousRevision = gauge?.revision ?? null;
    });
    gauge.on("data", ({ event, revision, epoch, kind }) => {
      el("[data-walk-flow]").textContent = String(event.data.flowCfs);
      el("[data-walk-temp]").textContent = String(event.data.waterTempC);
      el("[data-walk-revision]").textContent = String(revision);
      el("[data-walk-epoch]").textContent = String(epoch);
      if (kind === "snapshot" && previousRevision !== null) {
        el("[data-revision-gap]").textContent = `Fresh snapshot: ${previousRevision} → ${revision}. Intermediate revisions were not replayed; StreamOtter delivers current state, not history.`;
        previousRevision = null;
      }
    });
  }
  async function requestHolt(): Promise<void> {
    if (!field || switching) return;
    await holt?.close();
    holt = field.watch("holt", { holtId: "A" }); observe(holt, "Holt A");
    el("[data-holt-result]").textContent = "Requesting the protected holt…";
    holt.on("state", ({ state, reason }) => {
      if (reason) el("[data-holt-result]").textContent = `${state} · ${reason}. No holt data was delivered.`;
    });
    holt.on("data", ({ event }) => {
      el("[data-holt-result]").textContent = `Researcher access: ${event.data.name} · ${event.data.gridRef}. Occupants: ${event.data.occupants.join(", ") || "none"}.`;
      el("[data-map-holt]").hidden = false;
      el("[data-map-holt]").textContent = `${event.data.name} at ${event.data.reachId}: ${event.data.gridRef} (researcher only).`;
    });
  }
  function watchNotebook(): void {
    if (!field || field.config.mode !== "kafka" || !field.badge) return;
    book = field.watch("notebook", { observerId: field.badge.subject }); observe(book, "Your notebook");
    book.on("data", ({ event }) => {
      const list = el("[data-notebook-entries]"); list.replaceChildren();
      for (const entry of event.data.entries) {
        const li = document.createElement("li"); li.textContent = `${entry.otterId} · ${entry.activity} · ${entry.reachId} · day ${entry.at.day}, ${entry.at.time}`; list.append(li);
      }
      el("[data-notebook-note]").textContent = `${event.data.entries.length} sightings delivered by your private subscription.`;
    });
  }
  function watchOverview(): void {
    if (!field) return;
      const overview = field.watch("creekOverview", { watershed: "lontra" });
      overview.on("data", ({ event, revision }) => {
        const change = history.add(revision, event.data.stations);
        el("[data-flow-change]").textContent = !change ? "Collecting a second reading…" : Math.abs(change.change) < .1
          ? "The creek is calm. No station has changed appreciably over the observed twelve-tick window."
          : `${change.stationId} is changing fastest: ${change.change > 0 ? "+" : ""}${change.change.toFixed(1)} cfs over the observed twelve-tick window.`;
      });
  }
  async function start(): Promise<void> {
    const ownGeneration = ++generation;
    stopIdle(); await field?.close(); field = undefined;
    el("[data-walk-unavailable]").hidden = true; el("[data-idle-notice]").hidden = true;
    status.textContent = "Opening your volunteer session…";
    try {
      const candidate = await openFieldClient();
      if (generation !== ownGeneration) { await candidate.close(); return; }
      field = candidate;
      const source = document.querySelector<HTMLElement>("[data-walk-source]"); if (source) source.textContent = field.sourceLabel;
      field.on("unreachable", () => { el("[data-walk-unavailable]").hidden = false; status.textContent = "Still trying to reach the field station."; });
      field.client.on("state", ({ state }) => {
        status.textContent = `Connection: ${state}`;
        if (state === "connected") {
          el("[data-walk-unavailable]").hidden = true;
          for (const selector of ["[data-walk-drop]", "[data-holt-request]", "[data-role-switch]"]) button(selector).disabled = false;
          if (field?.config.mode === "kafka") { button("[data-sighting-submit]").disabled = false; if (!book) watchNotebook(); }
        }
      });
      watchGauge();
      watchOverview();
      el("[data-notebook-note]").textContent = field.config.mode === "fixture" ? "Sightings need the Kafka field station. This local fixture replay does not save notebooks." : "Your notebook updates here when Kafka delivers it.";
      stopIdle = watchIdle(() => {
        generation++; void field?.close(); field = undefined;
        status.textContent = "Session paused."; el("[data-idle-notice]").hidden = false;
        for (const selector of ["[data-walk-drop]", "[data-walk-restore]", "[data-holt-request]", "[data-role-switch]", "[data-sighting-submit]"]) button(selector).disabled = true;
      });
    } catch { status.textContent = "Field station unavailable."; el("[data-walk-unavailable]").hidden = false; }
  }
  button("[data-walk-drop]").addEventListener("click", () => {
    field?.dropConnection(); button("[data-walk-drop]").disabled = true; button("[data-walk-restore]").disabled = false;
  });
  button("[data-walk-restore]").addEventListener("click", () => {
    button("[data-walk-restore]").disabled = true;
    void field?.restoreConnection().catch(() => { status.textContent = "Reconnection has not completed; the SDK keeps trying."; button("[data-walk-restore]").disabled = false; });
  });
  button("[data-holt-request]").addEventListener("click", () => { void requestHolt(); });
  button("[data-role-switch]").addEventListener("click", () => {
    if (!field || switching) return;
    switching = true; button("[data-role-switch]").disabled = true;
    void field.switchRole("researcher").then(async () => {
      switching = false;
      el("[data-role-result]").textContent = "Signed in as the field biologist. Old subscriptions closed; new subscriptions use the new subject.";
      el("[data-notebook-entries]").replaceChildren(); book = undefined;
      watchGauge(); watchOverview(); watchNotebook(); await requestHolt();
    }).catch(() => { switching = false; status.textContent = "Could not switch identity. Restore your connection and try again."; button("[data-role-switch]").disabled = false; });
  });
  el<HTMLFormElement>("[data-sighting-form]").addEventListener("submit", event => {
    event.preventDefault(); if (!field || field.config.mode !== "kafka") return;
    const data = new FormData(el<HTMLFormElement>("[data-sighting-form]")); button("[data-sighting-submit]").disabled = true;
    void postSighting({ otterId: String(data.get("otterId")), reachId: String(data.get("reachId")), activity: String(data.get("activity")) })
      .then(() => { el("[data-notebook-note]").textContent = "Saved to the field station; waiting for your subscription to deliver it."; })
      .catch(error => { el("[data-notebook-note]").textContent = error instanceof Error ? error.message : "Sighting failed."; })
      .finally(() => { button("[data-sighting-submit]").disabled = false; });
  });
  for (const selector of ["[data-walk-retry]", "[data-session-resume]"]) button(selector).addEventListener("click", () => { location.reload(); });
  window.addEventListener("pagehide", () => { stopIdle(); generation++; void field?.close(); });
  await start();
}
