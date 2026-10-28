/**
 * Camera traps. Each tick a camera fires at most once: for otters in its reach
 * (a mother with her pups counts as one group of three), or for the other animals
 * that use the creek, each at the times of day it keeps.
 */
import { dayIndex, type Daylight } from "./clock.ts";
import { REACHES, type Camera, type OtterProfile, type ReachId } from "./geography.ts";
import type { OtterState } from "./otters.ts";
import { chance, int, type Rng } from "./random.ts";

/** What the camera traps can record. */
export type Species =
  | "river otter"
  | "American beaver"
  | "great blue heron"
  | "American mink"
  | "raccoon"
  | "white-tailed deer"
  | "belted kingfisher";

/** One camera-trap trigger. */
export interface Frame {
  /** Frame number on this camera, counting from 1. */
  number: number;
  tick: number;
  species: Species;
  /** Animals in the frame; an otter frame counts a mother's pups when they are with her. */
  count: number;
}

/** A camera's frame count, last frame, and tallies for the current study day. */
export interface CameraState {
  frames: number;
  lastFrame: Frame | null;
  /** The 0-based study day the daily tallies count. */
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

/** A camera with no frames, its tallies counting from the study day of `tick`. */
export function initialCamera(tick: number): CameraState {
  return { frames: 0, lastFrame: null, dayIndex: dayIndex(tick), framesToday: 0, otterFramesToday: 0 };
}

/**
 * Runs one tick of a camera: resets the tallies on a new study day, then records at
 * most one frame, trying the tagged otters in its reach before other wildlife.
 */
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
