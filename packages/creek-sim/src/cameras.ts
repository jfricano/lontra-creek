/**
 * Camera traps. Each tick a camera fires at most once: for otters in its reach
 * (a mother with her pups counts as one group of three), or for the other animals
 * that use the creek, each at the times of day it keeps.
 */
import { dayIndex, type Daylight } from "./clock.ts";
import { REACHES, type Camera, type OtterProfile, type ReachId } from "./geography.ts";
import type { OtterState } from "./otters.ts";
import { chance, int, type Rng } from "./random.ts";

export type Species =
  | "river otter"
  | "American beaver"
  | "great blue heron"
  | "American mink"
  | "raccoon"
  | "white-tailed deer"
  | "belted kingfisher";

export interface Frame {
  number: number;
  tick: number;
  species: Species;
  count: number;
}

export interface CameraState {
  frames: number;
  lastFrame: Frame | null;
  dayIndex: number;
  framesToday: number;
  otterFramesToday: number;
}

interface Visitor {
  species: Exclude<Species, "river otter">;
  /** Chance per tick by time of day. */
  rate: Partial<Record<Daylight, number>>;
  /** Reaches where this species turns up more often. */
  favors?: ReachId;
  count: readonly [number, number];
}

const WILDLIFE: readonly Visitor[] = [
  { species: "American beaver", rate: { night: 0.02, dusk: 0.02 }, favors: "beaver-flats", count: [1, 2] },
  { species: "great blue heron", rate: { day: 0.015, dawn: 0.02 }, favors: "heron-marsh", count: [1, 1] },
  { species: "American mink", rate: { night: 0.008, dusk: 0.008 }, count: [1, 1] },
  { species: "raccoon", rate: { night: 0.012 }, count: [1, 3] },
  { species: "white-tailed deer", rate: { dawn: 0.012, dusk: 0.012 }, count: [1, 4] },
  { species: "belted kingfisher", rate: { day: 0.01 }, favors: "cedar-riffle", count: [1, 1] }
];

const OTTER_TRIGGER_CHANCE = 0.16;

export function initialCamera(tick: number): CameraState {
  return { frames: 0, lastFrame: null, dayIndex: dayIndex(tick), framesToday: 0, otterFramesToday: 0 };
}

export function stepCamera(
  camera: Camera,
  state: CameraState,
  tick: number,
  light: Daylight,
  otters: readonly { profile: OtterProfile; state: OtterState }[],
  rng: Rng
): void {
  const today = dayIndex(tick);
  if (today !== state.dayIndex) {
    state.dayIndex = today;
    state.framesToday = 0;
    state.otterFramesToday = 0;
  }
  const reachIndex = REACHES.findIndex(reach => reach.id === camera.reach);
  let frame: Omit<Frame, "number"> | null = null;

  for (const otter of otters) {
    const here = !otter.state.away && otter.state.reach === reachIndex && otter.state.activity !== "denning";
    if (here && chance(rng, OTTER_TRIGGER_CHANCE)) {
      frame = { tick, species: "river otter", count: 1 + (otter.state.pupsWithHer ? otter.profile.pups.length : 0) };
      break;
    }
  }
  if (frame === null) {
    for (const visitor of WILDLIFE) {
      const rate = (visitor.rate[light] ?? 0) * (visitor.favors === camera.reach ? 2.5 : 1);
      if (rate > 0 && chance(rng, rate)) {
        frame = { tick, species: visitor.species, count: int(rng, visitor.count[0], visitor.count[1]) };
        break;
      }
    }
  }
  if (frame === null) return;

  state.frames += 1;
  state.framesToday += 1;
  if (frame.species === "river otter") state.otterFramesToday += 1;
  state.lastFrame = { number: state.frames, ...frame };
}
