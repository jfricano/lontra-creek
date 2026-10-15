import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_RESERVE, PAGE_BURST, PAGE_PER_SECOND, REFUSED_PAUSE_CAP_MS, REFUSED_PAUSE_MS, RequestBudget, refusedPauseMs } from "../src/scripts/lab-budget.ts";

/** A budget on a fake clock: each wait moves the clock on by exactly what was asked. */
function fake(options: { burst?: number; perSecond?: number } = {}) {
  let now = 0; const waits: number[] = [];
  const budget = new RequestBudget({ ...options, now: () => now, wait: async ms => { waits.push(ms); now += ms; } });
  return { budget, waits, at: () => now, advance: (ms: number) => { now += ms; } };
}

test("a page's share fits twice in the field station's per-address Lab budget (20 at once, 3 a second)", () => {
  // Lab contract: one address may hold two places, and each place is one page polling.
  assert.ok(2 * PAGE_BURST <= 20);
  assert.ok(2 * PAGE_PER_SECOND <= 3);
});

test("the burst goes at once, then requests are spaced at the page's rate", async () => {
  const { budget, waits, at } = fake({ burst: 3, perSecond: 2 });
  for (let i = 0; i < 3; i++) await budget.acquire();
  assert.deepEqual(waits, []);
  await budget.acquire(); await budget.acquire();
  assert.deepEqual(waits, [500, 500]);
  assert.equal(at(), 1_000);
});

test("over any minute, a page sends no more than its burst plus its rate", async () => {
  const { budget, at } = fake();
  let sent = 0;
  while (at() < 60_000) { await budget.acquire(); if (at() <= 60_000) sent++; }
  assert.ok(sent <= PAGE_BURST + 60 * PAGE_PER_SECOND + 1, `${sent} requests in a minute`);
});

test("an idle page refills to its burst and no further", async () => {
  const { budget, waits, advance } = fake({ burst: 2, perSecond: 1 });
  await budget.acquire(); await budget.acquire();
  advance(60_000);
  await budget.acquire(); await budget.acquire(); await budget.acquire();
  assert.deepEqual(waits, [1_000]);
});

test("a 429 holds every request for the pause, then starts from an empty bucket", async () => {
  const { budget, waits, at } = fake({ burst: 5, perSecond: 2 });
  budget.refused(3_000);
  await budget.acquire();
  assert.equal(at(), 3_500, "the pause, then one token's refill");
  assert.deepEqual(waits, [3_000, 500]);
});

test("a shorter pause never shortens a longer one already running", () => {
  const { budget } = fake();
  budget.refused(5_000); budget.refused(1_000);
  assert.equal(budget.take(), 5_000);
});

test("an aborted wait returns without a token", async () => {
  const controller = new AbortController();
  let now = 0;
  const budget = new RequestBudget({ burst: 1, perSecond: 1, now: () => now, wait: async () => { controller.abort(); } });
  await budget.acquire(controller.signal);
  await budget.acquire(controller.signal);
  now += 1_000;
  assert.equal(budget.take(), 0, "the aborted acquire took nothing, so the refilled token is still there");
});

test("Retry-After is honored when readable, capped, and defaulted otherwise", () => {
  assert.equal(refusedPauseMs("1"), 1_000);
  assert.equal(refusedPauseMs(" 4 "), 4_000);
  assert.equal(refusedPauseMs("3600"), REFUSED_PAUSE_CAP_MS);
  for (const header of [null, "", "0", "-2", "soon", "Wed, 21 Oct 2026 07:28:00 GMT"]) assert.equal(refusedPauseMs(header), REFUSED_PAUSE_MS, String(header));
});

test("background polls leave a reserve, so the visitor's own request goes at once", async () => {
  const { budget, waits } = fake({ burst: 9, perSecond: 1.4 });
  for (let i = 0; i < 9 - BACKGROUND_RESERVE; i++) await budget.acquire(undefined, true);
  assert.deepEqual(waits, []);
  assert.ok(budget.take(true) > 0, "a further poll waits");
  for (let i = 0; i < BACKGROUND_RESERVE; i++) assert.equal(budget.take(), 0, "the visitor's requests don't");
});
