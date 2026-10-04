import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabIntentRequest, LabOperation } from "../../field-station/src/lab/contract.ts";
import { OPERATION_POLL_MS, RESEND_LIMIT, approveRequest, newRequestId, nextRequest, operationText, refusalText, runIntent, startRequest, type RunIo, type RunUpdate } from "../src/scripts/lab-operation.ts";
import { HttpStatusError } from "../src/scripts/sign-in-retry.ts";

/** Operation answers here are fixtures: they test what the page does with an answer, not that a backend gives it. */
const op = (status: LabOperation["status"], rest: Partial<LabOperation> = {}): LabOperation => ({
  operationId: "lop_AAAAAAAAAAAAAAAAAAAAAA", intent: "incident.reassess", requestId: "11111111-2222-4333-8444-555555555555", status,
  acceptedAt: "2026-10-04T00:00:00.000Z", updatedAt: `2026-10-04T00:00:0${"accepted running succeeded refused failed unknown cancelled".split(" ").indexOf(status)}.000Z`,
  scenarioRevision: null, detail: null, ...rest
});
const body: LabIntentRequest = { intent: "incident.reassess", requestId: "11111111-2222-4333-8444-555555555555", expectedRevision: 4 };
const network = () => new TypeError("Failed to fetch");
const http = (status: number, code?: string) => new HttpStatusError("refused", status, code);

/** A scripted bench: each post or get takes the next answer; an Error is thrown. */
function fake(posts: (LabOperation | Error)[], gets: (LabOperation | Error)[] = []) {
  const sent: LabIntentRequest[] = []; const looked: string[] = []; const waits: number[] = [];
  const io: RunIo = {
    async post(intent) { sent.push(structuredClone(intent)); const next = posts.shift(); if (next === undefined) throw new Error("no more posts"); if (next instanceof Error) throw next; return next; },
    async get(id) { looked.push(id); const next = gets.shift(); if (next === undefined) throw new Error("no more gets"); if (next instanceof Error) throw next; return next; },
    async wait(ms) { waits.push(ms); }
  };
  return { io, sent, looked, waits };
}
async function run(io: RunIo, intent = body, signal = new AbortController().signal) {
  const updates: RunUpdate[] = [];
  const last = await runIntent(intent, io, signal, update => updates.push(update));
  return { updates, last };
}
const statuses = (updates: RunUpdate[]) => updates.map(update => update.kind === "operation" ? update.operation.status : update.kind);

test("an accepted operation is looked up every second until the bench reports how it ended", async () => {
  const bench = fake([op("accepted")], [op("accepted"), op("running"), op("succeeded")]);
  const { updates, last } = await run(bench.io);
  assert.deepEqual(statuses(updates), ["accepted", "running", "succeeded"]); // an unchanged answer isn't announced again
  assert.deepEqual(bench.waits, [OPERATION_POLL_MS, OPERATION_POLL_MS, OPERATION_POLL_MS]);
  assert.deepEqual(bench.looked, Array(3).fill("lop_AAAAAAAAAAAAAAAAAAAAAA"));
  assert.equal(bench.sent.length, 1);
  assert.deepEqual(last.kind === "operation" && last.operation.status, "succeeded");
});

test("every status but accepted and running is final: unknown is never looked up or sent again", async () => {
  for (const status of ["succeeded", "refused", "failed", "unknown", "cancelled"] as const) {
    const bench = fake([op("running")], [op(status, { detail: status === "succeeded" ? null : "Because." })]);
    const { updates } = await run(bench.io);
    assert.deepEqual(statuses(updates), ["running", status], status);
    assert.equal(bench.looked.length, 1, status); assert.equal(bench.sent.length, 1, status);
  }
});

test("a lost answer sends the same body again, so the same requestId, and the recorded operation answers", async () => {
  const bench = fake([network(), http(502), op("running")], [op("succeeded")]);
  const { updates } = await run(bench.io);
  assert.equal(bench.sent.length, 3);
  for (const sent of bench.sent) assert.deepEqual(sent, body);
  assert.deepEqual(bench.waits.slice(0, 2), [OPERATION_POLL_MS, OPERATION_POLL_MS * 2]);
  assert.deepEqual(statuses(updates), ["running", "succeeded"]);
});

test("after every resend is lost the outcome is unknown, and the page says it can't tell", async () => {
  const bench = fake(Array.from({ length: RESEND_LIMIT + 1 }, network));
  const { updates } = await run(bench.io);
  assert.equal(bench.sent.length, RESEND_LIMIT + 1);
  assert.equal(new Set(bench.sent.map(sent => sent.requestId)).size, 1);
  assert.deepEqual(statuses(updates), ["lost"]);
  assert.match((updates[0] as { text: string }).text, /^Reassess: outcome unknown\. The Lab didn't answer, so the page can't tell whether your bench received the request\./);
});

test("a refusal is final and says nothing was sent; only a resend may wait out the action budget", async () => {
  for (const [code, status, text] of [
    ["too-many-actions", 429, /^Reassess: not sent\. One action a second, please\. Nothing was sent to your bench; try again\.$/],
    ["not-applicable", 409, /The incident changed since this page showed it/],
    ["unsupported-scenario", 409, /This backend does not support this scenario\./],
    ["no-lease", 409, /You don't have a bench right now/],
    ["bench-unavailable", 503, /Your bench stopped answering/]
  ] as const) {
    const bench = fake([http(status, code)]);
    const { updates } = await run(bench.io);
    assert.equal(bench.sent.length, 1, code);
    assert.equal(updates.length, 1, code);
    assert.equal(updates[0]!.kind, "refused", code);
    assert.match((updates[0] as { text: string }).text, text, code);
  }
  // The first answer was lost, so the resend is a lookup of the same request: the budget doesn't end it.
  const bench = fake([network(), http(429, "too-many-actions"), op("succeeded")]);
  assert.deepEqual(statuses((await run(bench.io)).updates), ["succeeded"]);
  assert.equal(bench.sent.length, 3);
  assert.match(refusalText("scenario.start", "not-applicable", 409), /^Start: not sent\. This bench's study can't start that scenario now: .*Returning the bench discards the study\.$/);
  assert.equal(refusalText("incident.evaluate", undefined, 418), "Evaluate: not sent. The Lab answered 418.");
});

test("a lookup that fails is tried again; one the lease no longer has (404) ends it as unknown", async () => {
  const bench = fake([op("accepted")], [network(), http(503), op("succeeded")]);
  assert.deepEqual(statuses((await run(bench.io)).updates), ["accepted", "succeeded"]);
  assert.equal(bench.sent.length, 1);
  const gone = fake([op("accepted")], [http(404)]);
  const { updates } = await run(gone.io);
  assert.deepEqual(statuses(updates), ["accepted", "lost"]);
  assert.match((updates[1] as { text: string }).text, /no longer on your lease/);
});

test("an ended lease stops following the operation without another update", async () => {
  const controller = new AbortController();
  const bench = fake([op("accepted")], [op("running"), op("succeeded")]);
  const updates: RunUpdate[] = [];
  await runIntent(body, { ...bench.io, async wait() { controller.abort(); } }, controller.signal, update => updates.push(update));
  assert.deepEqual(statuses(updates), ["accepted"]);
  assert.equal(bench.looked.length, 0);
});

test("intent bodies carry only the contract's keys, bound to the revision and plan the page showed", () => {
  const id = newRequestId();
  assert.match(id, /^[A-Za-z0-9-]{8,64}$/);
  assert.notEqual(newRequestId(), id);
  assert.deepEqual(startRequest("bad-projection", id), { intent: "scenario.start", requestId: id, scenario: "bad-projection" });
  assert.deepEqual(nextRequest({ nextIntent: "scenario.prepare-coverage", scenarioRevision: 3 }, id), { intent: "scenario.prepare-coverage", requestId: id, expectedRevision: 3 });
  assert.equal(nextRequest({ nextIntent: null, scenarioRevision: 3 }, id), null);
  assert.equal(nextRequest({ nextIntent: "incident.approve-reprocess", scenarioRevision: 3 }, id), null); // approval needs the reviewed plan
  assert.deepEqual(approveRequest({ expectedRevision: 7, planToken: "pt_0123456789abcdef" }, id), { intent: "incident.approve-reprocess", requestId: id, expectedRevision: 7, planToken: "pt_0123456789abcdef" });
});

test("the operation line claims only what the bench reported", () => {
  assert.match(operationText(op("accepted")), /^Reassess: request accepted\. That only acknowledges the request/);
  assert.equal(operationText(op("succeeded", { intent: "incident.retry-current" })), "Retry: done. The gateway ran the retry. Current incident shows how it turned out.");
  assert.doesNotMatch(operationText(op("succeeded", { intent: "incident.retry-current" })), /processed|recovered|fixed/);
  assert.match(operationText(op("succeeded", { intent: "incident.evaluate" })), /nothing was reprocessed/);
  assert.equal(operationText(op("refused", { detail: "The automatic-continuation limit is reached; returning the bench clears it." })), "Reassess: refused. The automatic-continuation limit is reached; returning the bench clears it.");
  assert.equal(operationText(op("failed")), "Reassess: failed. The bench gave no reason.");
  assert.match(operationText(op("unknown", { detail: "The bench didn't answer." })), /outcome unknown\. The bench didn't answer\. The page doesn't send it again/);
  for (const status of ["refused", "failed", "unknown", "cancelled"] as const) assert.doesNotMatch(operationText(op(status)), /done/, status);
});
