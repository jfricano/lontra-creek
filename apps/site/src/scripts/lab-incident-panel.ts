/**
 * The incident panel's DOM: an empty, explained state, or three areas (application
 * view, record disposition, observed steps) from a served `LabIncidentSummary`.
 *
 * Updates only change text inside nodes that already exist, so polling never moves
 * focus or closes the coordinates disclosure. The steps list keeps its scroll position.
 */
import type { LabIncidentView } from "../../../field-station/src/lab/contract.ts";
import type { CapabilityAnswer } from "./lab-catalog-model.ts";
import { incidentView, type BrowserStep, type Mark } from "./lab-incident.ts";

/** What the page's own SDK reports for its LC-03 view. */
export interface ApplicationView {
  connection: string;
  subscription: string;
  reason: string | undefined;
  revision: string | undefined;
  value: string | undefined;
}

export class IncidentPanel {
  readonly #root: HTMLElement;
  #shown = false;
  constructor(root: HTMLElement) { this.#root = root; }

  #el(selector: string): HTMLElement {
    const element = this.#root.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  }

  /** Why the panel is empty, from the capability summary. */
  explain(answer: CapabilityAnswer, leased: boolean): void {
    const feature = answer.kind === "summary" ? answer.summary.features.incidentProjection : null;
    this.#el("[data-lab-incident-reason]").textContent =
      answer.kind === "pending" ? "Until this backend reports that it supports incidents, this panel stays empty."
      : feature === null ? "This backend doesn't report incidents, so this panel stays empty rather than show sample data."
      : !feature.available ? `${feature.reason?.text ?? "This backend doesn't report incidents."} This panel stays empty rather than show sample data.`
      : leased ? "Nothing is held on your bench right now." : "Borrow a bench and start a scenario to see an incident here.";
  }

  clear(): void {
    this.#shown = false;
    this.#el("[data-lab-incident-empty]").hidden = false;
    this.#el("[data-lab-incident-body]").hidden = true;
  }

  /** Renders a served projection; returns its one-sentence state, for the page to announce when it changes. */
  render(view: LabIncidentView, browser: readonly BrowserStep[]): string | null {
    if (view.status === "none") { this.clear(); return null; }
    const model = incidentView(view.incident, browser);
    this.#el("[data-lab-incident-empty]").hidden = true;
    this.#el("[data-lab-incident-body]").hidden = false;
    this.#shown = true;
    this.#el("[data-lab-incident-label]").textContent = model.label;
    this.#el("[data-lab-incident-summary]").textContent = model.reason;
    this.#el("[data-lab-incident-failure]").textContent = model.failure;
    this.#el("[data-lab-incident-policy]").textContent = model.policy;
    mark(this.#el("[data-lab-incident-evidence]"), model.evidence);
    mark(this.#el("[data-lab-incident-source]"), model.source);
    // Once the study is discarded, its recovery requirement no longer applies to anything.
    mark(this.#el("[data-lab-incident-recovery]"), model.discarded ?? model.recovery);
    for (const [key, value] of [["evaluation", model.evaluation], ["reprocess", model.reprocess]] as const) {
      this.#el(`[data-lab-incident-${key}-term]`).hidden = value === null;
      const dd = this.#el(`[data-lab-incident-${key}]`); dd.hidden = value === null;
      if (value) mark(dd, value);
    }
    this.#el("[data-lab-incident-next]").textContent = model.next;
    this.#el("[data-lab-incident-detail-list]").replaceChildren(...model.detail.flatMap(([term, value]) => [node("dt", term), node("dd", value)]));
    const steps = this.#el("[data-lab-incident-steps]");
    steps.replaceChildren(...(model.gap ? [node("li", "Some earlier steps are missing here; they can't be reconstructed.", "lab-step-gap")] : []),
      ...model.steps.map(step => node("li", `${step.at.slice(11, 19)} · ${step.origin} · ${step.text}`)));
    return model.announcement;
  }

  /** The application view area: only ever the page's own SDK observations. */
  application(view: ApplicationView): void {
    if (!this.#shown) return;
    this.#el("[data-lab-incident-connection]").textContent = view.connection;
    const chip = node("span", view.subscription, "chip"); chip.dataset["state"] = view.subscription;
    this.#el("[data-lab-incident-subscription]").replaceChildren(chip, ...(view.reason ? [document.createTextNode(` ${view.reason}`)] : []));
    this.#el("[data-lab-incident-last]").textContent = view.revision ? `${view.value ?? "—"} · revision ${view.revision}` : "Nothing received yet.";
    this.#el("[data-lab-incident-stale]").textContent = view.subscription === "stale" && view.revision
      ? `Stale: this is the last value your SDK received (revision ${view.revision}), kept on screen, not current data.` : "";
  }
}

function node(tag: string, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  return element;
}

function mark(target: HTMLElement, value: Mark): void {
  const label = node("span", "", "lab-mark"); label.dataset["tone"] = value.tone;
  const icon = node("span", value.icon); icon.setAttribute("aria-hidden", "true");
  label.append(icon, node("span", value.text));
  target.replaceChildren(label, ...(value.note ? [node("span", value.note, "lab-mark-note")] : []));
}
