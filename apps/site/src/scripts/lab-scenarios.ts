/**
 * The `/lab/` source-failure cards and scenario deep links (Lab contract section 12).
 *
 * `?scenario=<id>` marks that scenario's card, or scrolls to its bench controls when it
 * runs with them. Pressing a card's title marks it by rewriting the URL in place, so a link
 * can be shared. Selecting explains; it never borrows a bench, starts a scenario, or sends
 * any request. Focus stays where the visitor put it.
 *
 * A card's Start button sends `scenario.start` only when the backend reports the exercise
 * available and the visitor holds a bench with nothing else waiting. Otherwise it stays
 * focusable with `aria-disabled="true"`, its availability line says why, and a press
 * sends nothing. A story this deployment never runs has no Start button at all.
 */
import type { LabScenarioId } from "../../../field-station/src/lab/contract.ts";
import { SCENARIOS } from "../lab-catalog.ts";
import { RELEASE } from "../site.ts";
import { AVAILABILITY_ICONS, capabilityNote, isScenario, scenarioAvailability, scenarioFromUrl, startState, urlFor, type BenchContext, type CapabilityAnswer } from "./lab-catalog-model.ts";

export interface Scenarios {
  /** Rewrites every availability line and the backend note from the capability answer. */
  showCapabilities(answer: CapabilityAnswer): void;
  /** Rewrites the Start buttons and lines from the visitor's bench. */
  showBench(bench: BenchContext): void;
  /** Called when the visitor presses an enabled Start button. */
  onStart(handler: (scenario: LabScenarioId) => void): void;
}

/** A click the browser handles itself: another button, or a modifier that opens a new tab or window. */
function modified(event: MouseEvent): boolean { return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey; }

export function mountScenarios(root: ParentNode): Scenarios | null {
  const cards = [...root.querySelectorAll<HTMLElement>("[data-lab-scenario]")];
  if (cards.length === 0) return null;

  function apply(scenario: LabScenarioId | null, reveal: boolean): void {
    for (const card of cards) {
      const on = card.dataset["labScenario"] === scenario;
      if (on) card.setAttribute("aria-current", "true"); else card.removeAttribute("aria-current");
      const mark = card.querySelector<HTMLElement>("[data-lab-selected-mark]");
      if (mark) mark.hidden = !on;
    }
    // A shared link lands on its card, or on the bench controls a scenario runs with; in-page links leave the reading position alone.
    if (!reveal || scenario === null) return;
    const controls = SCENARIOS[scenario].controls;
    const target = cards.find(card => card.dataset["labScenario"] === scenario) ?? (controls === null ? null : root.querySelector<HTMLElement>(`#${controls}`));
    const scroll = (): void => target?.scrollIntoView({ block: "start" });
    // An older link's hash (`?scenario=fouled-sensor#source-failures`) scrolls to its section while the page loads; land after it.
    if (document.readyState === "complete") scroll(); else window.addEventListener("load", scroll, { once: true });
  }
  for (const card of cards) card.querySelector<HTMLAnchorElement>("[data-lab-scenario-link]")?.addEventListener("click", event => {
    const id = card.dataset["labScenario"] ?? null;
    if (!isScenario(id) || modified(event)) return;
    event.preventDefault();
    history.replaceState(history.state, "", urlFor(new URL(location.href), id));
    apply(id, false);
  });
  // Back or forward: follow the URL.
  window.addEventListener("popstate", () => apply(scenarioFromUrl(location), true));
  apply(scenarioFromUrl(location), true);

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
      const button = card.querySelector<HTMLElement>("[data-lab-start]");
      if (button) { button.setAttribute("aria-disabled", String(!start.enabled)); button.hidden = availability.state === "restricted"; }
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
