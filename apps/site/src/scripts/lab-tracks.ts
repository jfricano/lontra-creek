/**
 * The `/lab/` track chooser and scenario catalog (Lab contract section 12).
 *
 * Without JavaScript both tracks are visible and the links are ordinary anchors. With
 * it, the chooser shows one track at a time and a scenario link marks its card, both
 * by rewriting the URL in place, so a link can be shared. Selecting explains; it never
 * borrows a bench, starts a scenario, or sends any request. Focus stays where the
 * visitor put it.
 */
import type { LabTrack } from "../../../field-station/src/lab/contract.ts";
import { RELEASE } from "../site.ts";
import { AVAILABILITY_ICONS, capabilityNote, isScenario, scenarioAvailability, selectionFromUrl, urlFor, type CapabilityAnswer, type Selection } from "./lab-catalog-model.ts";

export interface Tracks {
  /** Rewrites every availability line and the backend note from the capability answer. */
  showCapabilities(answer: CapabilityAnswer): void;
}

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
    event.preventDefault();
    const track = link.dataset["labTrackLink"] as LabTrack;
    choose({ track, scenario: selection.scenario !== null && cards.some(card => card.dataset["labScenario"] === selection.scenario && card.closest<HTMLElement>("[data-lab-track]")?.dataset["labTrack"] === track) ? selection.scenario : null });
  });
  for (const card of cards) card.querySelector<HTMLAnchorElement>("[data-lab-scenario-link]")?.addEventListener("click", event => {
    const id = card.dataset["labScenario"] ?? null;
    const track = card.closest<HTMLElement>("[data-lab-track]")?.dataset["labTrack"] as LabTrack | undefined;
    if (!isScenario(id) || track === undefined) return;
    event.preventDefault();
    choose({ track, scenario: id });
  });
  // Back, forward, or an edited hash: follow the URL.
  window.addEventListener("popstate", () => apply(selectionFromUrl(location), true));
  window.addEventListener("hashchange", () => apply(selectionFromUrl(location), true));
  apply(selection, true);

  const note = root.querySelector<HTMLElement>("[data-lab-capability]");
  return {
    showCapabilities(answer) {
      if (note) note.textContent = capabilityNote(answer, RELEASE);
      for (const card of cards) {
        const id = card.dataset["labScenario"] ?? null;
        if (!isScenario(id)) continue;
        const availability = scenarioAvailability(id, answer);
        const line = card.querySelector<HTMLElement>("[data-lab-availability]");
        if (line) line.dataset["state"] = availability.state;
        const icon = card.querySelector("[data-lab-availability-icon]"); if (icon) icon.textContent = AVAILABILITY_ICONS[availability.state];
        const text = card.querySelector("[data-lab-availability-text]"); if (text) text.textContent = availability.text;
        // No exercise in this build is available (PAGE_RUNS is empty); one that is adds its own handler.
        card.querySelector("[data-lab-start]")?.setAttribute("aria-disabled", String(availability.state !== "available"));
      }
    }
  };
}
