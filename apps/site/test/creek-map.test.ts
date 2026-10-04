import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { REACHES } from "@lontra-creek/sim";
import { CREEK_SAMPLES, REACH_MARKERS } from "../src/creek-map.ts";

const nearest = (x: number, y: number): { distance: number; length: number } =>
  CREEK_SAMPLES.reduce((best, sample) => {
    const distance = Math.hypot(sample.point[0] - x, sample.point[1] - y);
    return distance < best.distance ? { distance, length: sample.length } : best;
  }, { distance: Infinity, length: 0 });

describe("creek map", () => {
  test("has one marker per reach, in order from source to confluence", () => {
    assert.deepEqual(REACH_MARKERS.map(marker => marker.id), REACHES.map(reach => reach.id));
    const lengths = REACH_MARKERS.map(marker => nearest(marker.x, marker.y).length);
    assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
  });

  test("puts every reach's dot on the river, not on a straight line beside it", () => {
    for (const marker of REACH_MARKERS) assert.ok(nearest(marker.x, marker.y).distance < 1, `${marker.name} is off the river`);
  });

  test("keeps every label clear of the river's 8-unit stroke", () => {
    for (const marker of REACH_MARKERS) assert.ok(nearest(marker.labelX, marker.labelY).distance > 8, `${marker.name}'s label touches the river`);
  });
});
