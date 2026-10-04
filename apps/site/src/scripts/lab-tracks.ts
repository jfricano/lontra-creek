/**
 * The `/lab/` track chooser and scenario catalog (Lab contract section 12).
 *
 * Without JavaScript both tracks are visible and the links are ordinary anchors. With
 * it, the chooser shows one track at a time and a scenario link marks its card, both
 * by rewriting the URL in place, so a link can be shared. Selecting explains; it never
 * borrows a bench, starts a scenario, or sends any request. Focus stays where the
 * visitor put it.
 *
 * A card's Start button sends `scenario.start` only when the backend reports the exercise
 * available and the visitor holds a bench with nothing else waiting. Otherwise it stays
 * focusable with `aria-disabled="true"`, its availability line says why, and a press
 * sends nothing.
 */
import type { LabScenarioId, LabTrack } from "../../../field-station/src/lab/contract.ts";
import { RELEASE } from "../site.ts";
import { AVAILABILITY_ICONS, capabilityNote, isScenario, scenarioAvailability, selectionFromUrl, startState, urlFor, type BenchContext, type CapabilityAnswer, type Selection } from "./lab-catalog-model.ts";

export interface Tracks {
  /** Rewrites every availability line and the backend note from the capability answer. */
  showCapabilities(answer: CapabilityAnswer): void;
  /** Rewrites the Start buttons and lines from the visitor's bench. */
  showBench(bench: BenchContext): void;
  /** Called when the visitor presses an enabled Start button. */
  onStart(handler: (scenario: LabScenarioId) => void): void;
}

/** A click the browser handles itself: another button, or a modifier that opens a new tab or window. */
function modified(event: MouseEvent): boolean { return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey; }

export function mountTracks(root: ParentNode): Tracks | null {
  const chooser = root.querySelector<HTMLElement>("[data-lab-tracks]");
  if (!chooser) return null;
  const links = [...chooser.querySelectorAll<HTMLAnchorElement>("[data-lab-track-link]")];
  const panels = [...root.querySelectorAll<HTMLElement>("[data-lab-track]")];
  const cards = [...root.querySelectorAll<HTMLElement>("[data-lab-scenario]")];
  let selection = selectionFromUrl(location);

  function apply(next: Selection, reveal: boolean): void {
    selection = next;
    for (const link of links) {
      if (link.dataset["labTrackLink"] === next.track) link.setAttribute("aria-current", "true"); else link.removeAttribute("aria-current");
    }
    for (const panel of panels) panel.hidden = panel.dataset["labTrack"] !== next.track;
    for (const card of cards) {
      const on = card.dataset["labScenario"] === next.scenario;
      if (on) card.setAttribute("aria-current", "true"); else card.removeAttribute("aria-current");
      const mark = card.querySelector<HTMLElement>("[data-lab-selected-mark]");
      if (mark) mark.hidden = !on;
    }
    // A shared link lands on its card; the chooser and in-page links leave the reading position alone.
    if (reveal && next.scenario) cards.find(card => card.dataset["labScenario"] === next.scenario && !card.closest("[hidden]"))?.scrollIntoView({ block: "start" });
  }
  function choose(next: Selection): void {
    history.replaceState(history.state, "", urlFor(new URL(location.href), next));
    apply(next, false);
  }
  for (const link of links) link.addEventListener("click", event => {
    if (modified(event)) return;
    event.preventDefault();
    const track = link.dataset["labTrackLink"] as LabTrack;
    choose({ track, scenario: selection.scenario !== null && cards.some(card => card.dataset["labScenario"] === selection.scenario && card.closest<HTMLElement>("[data-lab-track]")?.dataset["labTrack"] === track) ? selection.scenario : null });
  });
  for (const card of cards) card.querySelector<HTMLAnchorElement>("[data-lab-scenario-link]")?.addEventListener("click", event => {
    const id = card.dataset["labScenario"] ?? null;
    const track = card.closest<HTMLElement>("[data-lab-track]")?.dataset["labTrack"] as LabTrack | undefined;
    if (!isScenario(id) || track === undefined || modified(event)) return;
    event.preventDefault();
    choose({ track, scenario: id });
  });
  // Back, forward, or an edited hash: follow the URL. A jump to another anchor on the page, such as a
  // scenario's bench controls, keeps the current track rather than falling back to the default.
  const follow = (): void => { if (/^#?(connections|source-failures)?$/.test(location.hash)) apply(selectionFromUrl(location), true); };
  window.addEventListener("popstate", follow);
  window.addEventListener("hashchange", follow);
  apply(selection, true);

  const note = root.querySelector<HTMLElement>("[data-lab-capability]");
  let answer: CapabilityAnswer = { kind: "pending" };
  let bench: BenchContext = { leased: false, busy: false };
  let started: ((scenario: LabScenarioId) => void) | undefined;
  function render(): void {
    for (const card of cards) {
      const id = card.dataset["labScenario"] ?? null;
      if (!isScenario(id)) continue;
      const availability = scenarioAvailability(id, answer);
      const start = startState(availability, bench);
      const line = card.querySelector<HTMLElement>("[data-lab-availability]");
      if (line) line.dataset["state"] = availability.state;
      const icon = card.querySelector("[data-lab-availability-icon]"); if (icon) icon.textContent = AVAILABILITY_ICONS[availability.state];
      const text = card.querySelector("[data-lab-availability-text]"); if (text) text.textContent = start.text;
      card.querySelector("[data-lab-start]")?.setAttribute("aria-disabled", String(!start.enabled));
    }
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-lab-start]")) button.addEventListener("click", () => {
    const id = button.dataset["labStart"] ?? null;
    // Checked again at the press, not only when the line was drawn.
    if (!isScenario(id) || !startState(scenarioAvailability(id, answer), bench).enabled) return;
    started?.(id);
  });
  return {
    showCapabilities(next) {
      answer = next;
      if (note) note.textContent = capabilityNote(answer, RELEASE);
      render();
    },
    showBench(next) {
      if (next.leased === bench.leased && next.busy === bench.busy) return;
      bench = next; render();
    },
    onStart(handler) { started = handler; }
  };
}
