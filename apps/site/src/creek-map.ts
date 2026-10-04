/**
 * Geometry for the creek schematic on `/field-station/`. The river is two cubic
 * Bézier segments; each reach's dot sits on the curve at the reach's midpoint,
 * measured by arc length from the source (km 0) to the confluence (km 14.2), so
 * the dots follow the river instead of a straight diagonal.
 */
import { REACHES } from "@lontra-creek/sim";

type Point = readonly [number, number];
type Segment = readonly [Point, Point, Point, Point];

/** Source at the top left, confluence at the bottom right. Each segment's first control point mirrors the one before, so the bends are smooth. */
export const CREEK_SEGMENTS: readonly Segment[] = [
  [[75, 25], [370, 50], [40, 115], [300, 140]],
  [[300, 140], [560, 165], [80, 240], [410, 280]]
];

export const CREEK_PATH = `M${CREEK_SEGMENTS[0]![0].join(" ")} ${CREEK_SEGMENTS.map(([, a, b, c]) => `C${a.join(" ")} ${b.join(" ")} ${c.join(" ")}`).join(" ")}`;

const CREEK_KM = REACHES.at(-1)!.toKm;
const STEPS = 400;

function at([p0, p1, p2, p3]: Segment, t: number): Point {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
  return [w[0] * p0[0] + w[1] * p1[0] + w[2] * p2[0] + w[3] * p3[0], w[0] * p0[1] + w[1] * p1[1] + w[2] * p2[1] + w[3] * p3[1]];
}

/** Dense samples along the whole river, with the running arc length at each. */
export const CREEK_SAMPLES: readonly { point: Point; length: number }[] = (() => {
  const samples: { point: Point; length: number }[] = [];
  let length = 0;
  for (const segment of CREEK_SEGMENTS) {
    for (let i = samples.length === 0 ? 0 : 1; i <= STEPS; i++) {
      const point = at(segment, i / STEPS);
      const last = samples.at(-1);
      if (last) length += Math.hypot(point[0] - last.point[0], point[1] - last.point[1]);
      samples.push({ point, length });
    }
  }
  return samples;
})();

/** The point `fraction` (0–1) of the way down the river, and the unit normal on its left bank. */
function along(fraction: number): { point: Point; normal: Point } {
  const total = CREEK_SAMPLES.at(-1)!.length;
  const target = fraction * total;
  const index = Math.max(1, CREEK_SAMPLES.findIndex(sample => sample.length >= target));
  const a = CREEK_SAMPLES[index - 1]!, b = CREEK_SAMPLES[index]!;
  const span = b.length - a.length;
  const t = span === 0 ? 0 : (target - a.length) / span;
  const point: Point = [a.point[0] + (b.point[0] - a.point[0]) * t, a.point[1] + (b.point[1] - a.point[1]) * t];
  const dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1];
  const norm = Math.hypot(dx, dy) || 1;
  return { point, normal: [dy / norm, -dx / norm] };
}

const LABEL_GAP = 12;
const round = (value: number): number => Math.round(value * 10) / 10;

/** One dot per reach on the river, with its label offset across the bank and anchored away from the water. */
export const REACH_MARKERS = REACHES.map(reach => {
  const { point, normal } = along((reach.fromKm + reach.toKm) / 2 / CREEK_KM);
  // Labels sit on whichever bank faces the open side of the map, so they never cross the river.
  const side = normal[0] >= 0 ? 1 : -1;
  return {
    id: reach.id,
    name: reach.name,
    x: round(point[0]),
    y: round(point[1]),
    labelX: round(point[0] + side * normal[0] * LABEL_GAP),
    labelY: round(point[1] + side * normal[1] * LABEL_GAP + 4),
    anchor: side * normal[0] >= 0 ? "start" as const : "end" as const
  };
});
