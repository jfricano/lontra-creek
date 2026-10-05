/**
 * A visitor's intent and the operation that answers it (Lab contract sections 12.5 and
 * 12.6), without the DOM.
 *
 * One visitor decision is one `requestId`. The page sends it once; when the answer is
 * lost (no answer, a timeout, or an edge 5xx with no Lab code) it sends the *same* body
 * again, which the field station answers with the operation it already recorded, so a
 * request is never run twice. A refusal is final and shown as such. An `accepted`
 * operation acknowledges the request only, so the page looks the operation up every
 * second while it is `accepted` or `running`; every other status is final. `unknown`
 * is never repeated: the incident projection shows what the bench reports. Nothing
 * here reports an outcome the backend didn't.
 */
import type { LabErrorCode, LabIncidentSummary, LabIntent, LabIntentRequest, LabOperation, LabScenarioId } from "../../../field-station/src/lab/contract.ts";
import { HttpStatusError } from "./sign-in-retry.ts";

export const OPERATION_POLL_MS = 1_000;
/** How many times a lost answer is sent again, with the same `requestId`, before the page says it doesn't know. */
export const RESEND_LIMIT = 3;

export type OperationStatus = LabOperation["status"];

/** The only statuses that change: the page keeps looking the operation up, and the controls wait. Every other status is final. */
export function isPending(status: OperationStatus): boolean { return status === "accepted" || status === "running"; }

/** A fresh idempotency key for one visitor decision: a UUID is 36 of `A-Z a-z 0-9 -`, inside the contract's 8 to 64. */
export function newRequestId(): string { return crypto.randomUUID(); }

export function startRequest(scenario: LabScenarioId, requestId: string): LabIntentRequest {
  return { intent: "scenario.start", requestId, scenario };
}

/** The body for the incident's next supported intent, bound to the revision the page showed. Approval needs the reviewed plan, so it isn't built here. */
export function nextRequest(incident: Pick<LabIncidentSummary, "nextIntent" | "scenarioRevision">, requestId: string): LabIntentRequest | null {
  const intent = incident.nextIntent;
  if (intent === null || intent === "scenario.start" || intent === "incident.approve-reprocess") return null;
  return { intent, requestId, expectedRevision: incident.scenarioRevision };
}

/** The body for approving exactly the evaluation the visitor reviewed. */
export function approveRequest(review: { expectedRevision: number; planToken: string }, requestId: string): LabIntentRequest {
  return { intent: "incident.approve-reprocess", requestId, expectedRevision: review.expectedRevision, planToken: review.planToken };
}

/** What the page says when the bench reports `succeeded`: that the step finished, never that the record or view is fixed. */
export const DONE: Record<LabIntent, string> = {
  "scenario.start": "The bench started the scenario. What the gateway does with it appears in Current incident as it's observed.",
  "scenario.restore-calibration": "The application restored LC-03's calibration. The source is still held until a retry runs.",
  "scenario.prepare-coverage": "The application released its snapshot coverage. The source is still held until the guard is asked again.",
  "incident.retry-current": "The gateway ran the retry. Current incident shows how it turned out.",
  "incident.reassess": "The gateway asked the recovery guard again. Current incident shows its decision.",
  "incident.evaluate": "The evaluation finished. Current incident shows its result; nothing was reprocessed.",
  "incident.approve-reprocess": "The gateway finished the approved reprocessing. Current incident shows the result."
};

/** Short names for the operation line. */
export const INTENT_NAMES: Record<LabIntent, string> = {
  "scenario.start": "Start",
  "scenario.restore-calibration": "Restore calibration",
  "scenario.prepare-coverage": "Make snapshot coverage ready",
  "incident.retry-current": "Retry",
  "incident.reassess": "Reassess",
  "incident.evaluate": "Evaluate",
  "incident.approve-reprocess": "Approved reprocessing"
};

/** One sentence for the operation line, from what the operation resource reported. */
export function operationText(operation: Pick<LabOperation, "intent" | "status" | "detail">): string {
  const name = INTENT_NAMES[operation.intent];
  const detail = operation.detail ?? "The bench gave no reason.";
  switch (operation.status) {
    case "accepted": return `${name}: request accepted. That only acknowledges the request; the bench hasn't reported anything yet.`;
    case "running": return `${name}: running on your bench.`;
    case "succeeded": return `${name}: done. ${DONE[operation.intent]}`;
    case "refused": return `${name}: refused. ${detail}`;
    case "failed": return `${name}: failed. ${detail}`;
    case "unknown": return `${name}: outcome unknown. ${detail} The page doesn't send it again; Current incident shows what your bench reports.`;
    case "cancelled": return `${name}: cancelled. ${detail}`;
  }
}

/** An intent the field station refused outright (no operation was recorded), by its error code. */
export function refusalText(intent: LabIntent, code: string | undefined, status: number): string {
  const name = INTENT_NAMES[intent];
  const known: Partial<Record<LabErrorCode, string>> = {
    "invalid-request": "The Lab didn't accept that request.",
    "no-lease": "You don't have a bench right now. Borrow one to start.",
    "not-applicable": intent === "scenario.start"
      ? "This bench's study can't start that scenario now: another incident is open, or the scenario doesn't follow this one. Returning the bench discards the study."
      : "The incident changed since this page showed it, or this step no longer applies. The panel shows its current state.",
    "unsupported-scenario": "This backend does not support this scenario.",
    "too-many-actions": "One action a second, please. Nothing was sent to your bench; try again.",
    "too-many-requests": "Too many Lab requests from your address. Nothing was sent to your bench; try again shortly.",
    "bench-unavailable": "Your bench stopped answering, so the lease ends.",
    "lab-unavailable": "The Lab is unavailable."
  };
  const text = code !== undefined && code in known ? known[code as LabErrorCode] : `The Lab answered ${status}.`;
  return `${name}: not sent. ${text}`;
}

/** An answer the page can't act on: nothing came back, or an edge answered without a Lab code. The request may or may not have reached the field station. */
export function isLostAnswer(error: unknown): boolean {
  return !(error instanceof HttpStatusError) || (error.status >= 500 && error.code === undefined);
}

export type RunUpdate =
  | { kind: "operation"; operation: LabOperation }
  /** Refused before any operation was recorded. */
  | { kind: "refused"; text: string; code: string | undefined }
  /** No answer after every resend, or the operation is no longer on this lease: the outcome isn't known. */
  | { kind: "lost"; text: string };

export interface RunIo {
  post(body: LabIntentRequest, signal: AbortSignal): Promise<LabOperation>;
  get(operationId: string, signal: AbortSignal): Promise<LabOperation>;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

/** `RunIo.wait` for the page: resolves after `ms`, or at once when `signal` aborts. Either way it leaves no listener on `signal` behind. */
export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Sends one intent and follows its operation until the bench reports how it ended, the
 * lease ends (`signal`), or the answer is lost for good. Each update is passed to
 * `onUpdate`; the last one is returned. Resends carry the same body, so the same `requestId`.
 */
export async function runIntent(body: LabIntentRequest, io: RunIo, signal: AbortSignal, onUpdate: (update: RunUpdate) => void): Promise<RunUpdate> {
  const emit = (update: RunUpdate): RunUpdate => { if (!signal.aborted) onUpdate(update); return update; };
  let operation: LabOperation | undefined;
  for (let attempt = 0; operation === undefined; attempt++) {
    try { operation = await io.post(body, signal); }
    catch (error) {
      if (signal.aborted) return { kind: "lost", text: "" };
      // A resend that meets the action budget is still only a lookup of the first request: wait and ask again.
      const budget = attempt > 0 && error instanceof HttpStatusError && error.code === "too-many-actions";
      if (!isLostAnswer(error) && !budget) {
        const status = error instanceof HttpStatusError ? error.status : 0;
        const code = error instanceof HttpStatusError ? error.code : undefined;
        return emit({ kind: "refused", text: refusalText(body.intent, code, status), code });
      }
      if (attempt >= RESEND_LIMIT) return emit({ kind: "lost", text: `${INTENT_NAMES[body.intent]}: outcome unknown. The Lab didn't answer, so the page can't tell whether your bench received the request. Current incident shows what the bench reports.` });
      await io.wait(OPERATION_POLL_MS * 2 ** attempt, signal);
      if (signal.aborted) return { kind: "lost", text: "" };
    }
  }
  emit({ kind: "operation", operation });
  while (isPending(operation.status) && !signal.aborted) {
    await io.wait(OPERATION_POLL_MS, signal);
    if (signal.aborted) break;
    try {
      const next = await io.get(operation.operationId, signal);
      if (next.status !== operation.status || next.detail !== operation.detail || next.updatedAt !== operation.updatedAt) { operation = next; emit({ kind: "operation", operation }); }
    } catch (error) {
      if (signal.aborted) break;
      // 404: the operation isn't on this session's current lease any more. Anything else is looked up again.
      if (error instanceof HttpStatusError && error.status === 404) return emit({ kind: "lost", text: `${INTENT_NAMES[body.intent]}: this request is no longer on your lease, so its outcome can't be looked up.` });
    }
  }
  return { kind: "operation", operation };
}
