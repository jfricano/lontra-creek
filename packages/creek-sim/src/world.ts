/**
 * The world: every piece of state, one tick at a time. A world is a pure function
 * of its seed and tick, and its whole state is plain JSON, so it checkpoints with
 * JSON.stringify and a restored world continues exactly as the original would.
 *
 * Revisions. A view's revision is generation × 10^12 + the tick it last changed.
 * Ticks only grow, so revisions only grow. Raise the generation whenever the
 * simulation's logic changes or the world is reset: recomputed history can then
 * differ without ever reusing a revision for different data, which StreamOtter
 * would reject as a revision conflict.
 */
import { initialCamera, stepCamera, type CameraState } from "./cameras.ts";
import { studyTime } from "./clock.ts";
import {
  CAMERAS, HOLTS, OTTERS, REACHES, STATIONS, type CameraId, type HoltId, type OtterId, type OtterName, type PupName, type StationId
} from "./geography.ts";
import { initialStations, initialWeather, isHighFlow, stepStations, stepWeather, type StationState, type WeatherState } from "./hydrology.ts";
import { initialOtter, stepOtter, type OtterState } from "./otters.ts";
import { createRng, seedFrom } from "./random.ts";
import { allViews, TOPICS, type View } from "./views.ts";

export const WORLD_FORMAT = 1;
const TICKS_PER_GENERATION = 10n ** 12n;

export interface HoltState {
  occupants: (OtterName | PupName)[];
  lastEntryTick: number | null;
  lastExitTick: number | null;
}

export interface WorldState {
  format: typeof WORLD_FORMAT;
  seed: number;
  generation: number;
  tick: number;
  rng: number;
  weather: WeatherState;
  stations: Record<StationId, StationState>;
  otters: Record<OtterId, OtterState>;
  cameras: Record<CameraId, CameraState>;
  holts: Record<HoltId, HoltState>;
  /** The last published view of each channel instance and the tick it changed. */
  published: Record<string, { tick: number; json: string }>;
}

export interface WorldOptions {
  /** A number, or a name such as "lontra-creek" that is hashed into one. */
  seed: number | string;
  /** Defaults to 1. */
  generation?: number;
}

/** A view ready to publish: its topic, record key, and revision. */
export type Emission = View & { topic: string; revision: string };

export function revisionFor(generation: number, tick: number): string {
  return (BigInt(generation) * TICKS_PER_GENERATION + BigInt(tick)).toString();
}

export function createWorld(options: WorldOptions): WorldState {
  const seed = typeof options.seed === "string" ? seedFrom(options.seed) : options.seed >>> 0;
  const generation = options.generation ?? 1;
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RangeError("generation must be a positive integer");
  const rng = createRng(seed);
  const world: WorldState = {
    format: WORLD_FORMAT,
    seed,
    generation,
    tick: 0,
    rng: 0,
    weather: initialWeather(rng),
    stations: initialStations(studyTime(0).hour, rng),
    otters: byId(OTTERS, profile => initialOtter(profile, 0)),
    cameras: byId(CAMERAS, () => initialCamera(0)),
    holts: byId(HOLTS, (): HoltState => ({ occupants: [], lastEntryTick: null, lastExitTick: null })),
    published: {}
  };
  world.rng = rng.state;
  updateHolts(world);
  collect(world);
  return world;
}

/** Advances one tick and returns the views that changed, ready to publish. */
export function step(world: WorldState): Emission[] {
  world.tick += 1;
  const rng = createRng(world.rng);
  const time = studyTime(world.tick);

  stepWeather(world.weather, world.tick, rng);
  stepStations(world.stations, world.weather, time.hour, rng);

  const highFlow = (reach: number): boolean => {
    const station = STATIONS.find(candidate => candidate.id === REACHES[reach]!.station)!;
    return isHighFlow(station, world.stations[station.id]);
  };
  for (const profile of OTTERS) {
    stepOtter(profile, world.otters[profile.id], { tick: world.tick, hour: time.hour, rng, highFlow });
  }
  const otters = OTTERS.map(profile => ({ profile, state: world.otters[profile.id] }));
  for (const camera of CAMERAS) {
    stepCamera(camera, world.cameras[camera.id], world.tick, time.daylight, otters, rng);
  }
  updateHolts(world);

  world.rng = rng.state;
  return collect(world);
}

/**
 * Steps until the world reaches `tick` and returns only the latest emission of each
 * channel instance. Skipping the intermediate states is correct for full-state
 * channels: subscribers need the current state, not every state in between.
 */
export function advanceTo(world: WorldState, tick: number): Emission[] {
  const latest = new Map<string, Emission>();
  while (world.tick < tick) {
    for (const emission of step(world)) latest.set(emission.key, emission);
  }
  return [...latest.values()];
}

/** Every channel instance's current state with its published revision: for snapshots, and for republishing after a restart. */
export function currentEmissions(world: WorldState): Emission[] {
  return allViews(world).map(view => emission(world, view, world.published[view.key]!.tick));
}

export function serialize(world: WorldState): string {
  return JSON.stringify(world);
}

export function restore(text: string): WorldState {
  const world = JSON.parse(text) as WorldState;
  if (world.format !== WORLD_FORMAT) throw new Error(`Unsupported world format ${String(world.format)}; expected ${WORLD_FORMAT}.`);
  // A view added since the checkpoint was written (such as `den`) is published from the restored tick.
  for (const view of allViews(world)) world.published[view.key] ??= { tick: world.tick, json: JSON.stringify(view.data) };
  return world;
}

function byId<K extends string, T extends { id: K }, V>(items: readonly T[], make: (item: T) => V): Record<K, V> {
  const result = {} as Record<K, V>;
  for (const item of items) result[item.id] = make(item);
  return result;
}

function emission(world: WorldState, view: View, tick: number): Emission {
  return { ...view, topic: TOPICS[view.channel], revision: revisionFor(world.generation, tick) };
}

function collect(world: WorldState): Emission[] {
  const changed: Emission[] = [];
  for (const view of allViews(world)) {
    const json = JSON.stringify(view.data);
    if (world.published[view.key]?.json === json) continue;
    world.published[view.key] = { tick: world.tick, json };
    changed.push(emission(world, view, world.tick));
  }
  return changed;
}

function updateHolts(world: WorldState): void {
  for (const holt of HOLTS) {
    const occupants: (OtterName | PupName)[] = [];
    for (const profile of OTTERS) {
      const otter = world.otters[profile.id];
      if (otter.den === holt.id) occupants.push(profile.name);
      // Pups stay in their mother's holt unless they're out with her.
      if (profile.den === holt.id && profile.pups.length > 0 && !otter.pupsWithHer) occupants.push(...profile.pups);
    }
    const state = world.holts[holt.id];
    const entered = occupants.some(name => !state.occupants.includes(name));
    const left = state.occupants.some(name => !occupants.includes(name));
    if (entered && world.tick > 0) state.lastEntryTick = world.tick;
    if (left) state.lastExitTick = world.tick;
    state.occupants = occupants;
  }
}
