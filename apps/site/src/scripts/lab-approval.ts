/**
 * The approval dialog for `incident.approve-reprocess` (Lab contract section 12.5;
 * companion plan sections 5.4 and 6).
 *
 * Opening it approves nothing. It shows the evaluation the visitor is approving and
 * binds the approval to that projection's revision and plan token, captured when it
 * opened: if the incident moves on, the plan changes, or the approval expires while it
 * is open, Approve sends nothing and the dialog says why. Approve checks again when it is
 * pressed, against the latest projection and the clock at that moment, not only the
 * check last drawn. Focus moves into the dialog
 * when it opens and back to the button that opened it when it closes. A page restored
 * from the back-forward cache reloads (lab.ts), so a review is never carried over.
 */
import type { LabIncidentSummary } from "../../../field-station/src/lab/contract.ts";

/** What the visitor reviews, captured from one projection. */
export interface Review {
  label: string;
  revision: number;
  planToken: string;
  evaluatedAt: string;
  expiresAt: string | null;
  /** The backend's one sentence about what the evaluation found. */
  summary: string;
}

const time = (at: string): string => `${at.slice(11, 19)} UTC`;

/** The review an incident offers, or null when it offers no approvable plan. */
export function reviewFrom(incident: LabIncidentSummary): Review | null {
  const evaluation = incident.evaluation;
  if (incident.nextIntent !== "incident.approve-reprocess" || incident.discarded || evaluation?.result !== "passed" || !evaluation.planToken) return null;
  return { label: incident.label, revision: incident.scenarioRevision, planToken: evaluation.planToken, evaluatedAt: evaluation.at, expiresAt: evaluation.expiresAt, summary: evaluation.summary };
}

/** Why the reviewed plan can't be approved any more, or null while it still can. */
export function reviewProblem(review: Review, current: LabIncidentSummary | null, nowMs: number): string | null {
  if (current === null || current.label !== review.label) return "This incident is no longer on your bench, so there is nothing to approve. Cancel to close this review.";
  if (current.discarded) return "This study was discarded, and its plan with it. Cancel to close this review.";
  if (current.scenarioRevision !== review.revision || current.evaluation?.planToken !== review.planToken) return "The incident changed while this review was open. Cancel, then review the current evaluation.";
  if (review.expiresAt !== null && nowMs >= Date.parse(review.expiresAt)) return `This approval expired at ${time(review.expiresAt)}. Cancel, then evaluate again for a new plan.`;
  return null;
}

/** The dialog's fixed lines for a review. */
export function reviewText(review: Review): { incident: string; evaluation: string; expiry: string } {
  return {
    incident: `${review.label}, revision ${review.revision}.`,
    evaluation: `Evaluation passed at ${time(review.evaluatedAt)}. ${review.summary}`,
    expiry: review.expiresAt === null
      ? "This approval lasts no longer than your lease or this study."
      : `This approval is good until ${time(review.expiresAt)}, and no longer than your lease or this study.`
  };
}

export class ApprovalDialog {
  readonly #dialog: HTMLDialogElement;
  #review: Review | null = null;
  #opener: HTMLElement | null = null;
  #fallback: (() => HTMLElement | null) | undefined;
  #approve: ((review: Review) => void) | undefined;
  #latest: (() => { current: LabIncidentSummary | null; nowMs: number }) | undefined;
  #problem: string | null = null;

  constructor(dialog: HTMLDialogElement) {
    this.#dialog = dialog;
    this.#el("[data-lab-approval-cancel]").addEventListener("click", () => dialog.close());
    this.#el("[data-lab-approval-approve]").addEventListener("click", () => {
      const review = this.#review;
      if (review === null) return;
      // The drawn check can be up to one clock tick old: an approval may have expired since.
      const latest = this.#latest?.();
      if (latest) this.update(latest.current, latest.nowMs);
      if (this.#problem !== null) return;
      dialog.close();
      this.#approve?.(review);
    });
    // Escape closes it too (the native `cancel`); either way focus goes back where it came from.
    dialog.addEventListener("close", () => {
      // `close` is queued: a review opened again before it fired is a new one, not this.
      if (dialog.open) return;
      this.#review = null;
      const opener = this.#opener; this.#opener = null;
      const target = opener?.isConnected && !opener.closest("[hidden]") && !opener.hidden ? opener : this.#fallback?.();
      target?.focus();
    });
  }

  #el(selector: string): HTMLElement {
    const element = this.#dialog.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  }

  get open(): boolean { return this.#dialog.open; }

  /**
   * Opens the review; `fallback` names where focus goes when the opener is gone by the time it
   * closes, and `latest` gives the projection and the clock now, checked when it opens and again at Approve.
   */
  show(review: Review, opener: HTMLElement, options: { fallback: () => HTMLElement | null; approve: (review: Review) => void; latest: () => { current: LabIncidentSummary | null; nowMs: number } }): void {
    this.#review = review; this.#opener = opener; this.#fallback = options.fallback; this.#approve = options.approve; this.#latest = options.latest;
    const text = reviewText(review);
    this.#el("[data-lab-approval-incident]").textContent = text.incident;
    this.#el("[data-lab-approval-evaluation]").textContent = text.evaluation;
    this.#el("[data-lab-approval-expiry]").textContent = text.expiry;
    const { current, nowMs } = options.latest();
    this.update(current, nowMs);
    this.#dialog.showModal();
    this.#el("#approval-title").focus();
  }

  /** Checks the open review against the latest projection and the clock. */
  update(current: LabIncidentSummary | null, nowMs: number): void {
    if (this.#review === null) return;
    const problem = reviewProblem(this.#review, current, nowMs);
    if (problem === this.#problem && this.#dialog.open) return;
    this.#problem = problem;
    const line = this.#el("[data-lab-approval-problem]");
    line.textContent = problem ?? ""; line.hidden = problem === null;
    this.#el("[data-lab-approval-approve]").setAttribute("aria-disabled", String(problem !== null));
  }

  close(): void { if (this.#dialog.open) this.#dialog.close(); }
}
