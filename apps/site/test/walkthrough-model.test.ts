import test from "node:test";
import assert from "node:assert/strict";
import { FlowHistory, IdleDeadline, chapterFromHash } from "../src/scripts/walkthrough-model.ts";

test("chapter deep links are bounded", () => {
  assert.equal(chapterFromHash("#chapter-5"), 5);
  for (const hash of ["", "#chapter-99", "#chapter-0", "#chapter-2-extra"]) assert.equal(chapterFromHash(hash), 1);
});
test("flow history compares real readings within twelve ticks", () => {
  const history = new FlowHistory();
  const stations = (flow: number) => [{ stationId: "LC-02" as const, name: "Kestrel Bend", flowCfs: flow, trend: "rising" as const }];
  assert.equal(history.add(1000n, stations(10)), null);
  assert.deepEqual(history.add(1001n, stations(16)), { stationId: "LC-02", change: 6 });
  assert.equal(history.add(1001n, stations(20)), null);
  assert.equal(history.add(1014n, stations(50)), null);
});
test("idle deadline respects hidden time and active interactions", () => {
  const idle = new IdleDeadline(0, 100);
  idle.activity(80); assert.equal(idle.expired(100), false);
  idle.visibility(true, 90); idle.activity(150);
  assert.equal(idle.expired(179), false); assert.equal(idle.expired(180), true);
  const active = new IdleDeadline(0, 100);
  active.activity(80); assert.equal(active.expired(180), true);
});

test("hiding after nine minutes idle does not renew the idle deadline", () => {
  const idle = new IdleDeadline(0);
  idle.visibility(true, 540_000);
  assert.equal(idle.expired(600_000), true);
});
