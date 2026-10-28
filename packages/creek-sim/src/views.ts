/**
 * What the field station publishes: one full-state view per channel instance.
 * These are the payloads StreamOtter delivers, so each view must match its
 * channel's schema in the field station's streamotter.json. That schema dialect
 * has no nullable types, so "nothing yet" is spelled out (day 0, "--:--", "none").
 *
 * Den sites are protected. While an otter is in a holt, its public view withholds
 * where it is; only the restricted holt channel has the location.
 */
import type { Species } from "./cameras.ts";
import { studyTime, type Daylight } from "./clock.ts";
import {
  CAMERAS, HOLTS, OTTERS, REACHES, STATIONS, WATERSHED_ID,
  type CameraId, type CameraReachId, type HoltId, type OtterId, type OtterName, type OtterProfile, type PupName, type ReachId,
  type ReceiverId, type StationId
} from "./geography.ts";
import { weatherLabel, type Weather } from "./hydrology.ts";
import type { Activity, OtterState } from "./otters.ts";
import type { WorldState } from "./world.ts";

/** A study time; day 0 means "never". */
export interface StudyStamp {
  day: number;
  time: string;
}

/** Flow direction since the previous tick: rising or falling when true flow changed by more than 0.3%. */
export type Trend = "rising" | "falling" | "steady";
/** Where the public may see an otter: its reach, "withheld" while it dens, or "outside" when it has left the watershed. */
export type PublicReach = ReachId | "withheld" | "outside";
/** An otter's activity as the public sees it; "away" while outside the watershed. */
export type PublicActivity = Activity | "away";

/** The `station` channel's payload: one gauge's rounded readings at the current tick. */
export interface StationView {
  stationId: StationId;
  name: string;
  reachId: ReachId;
  observed: StudyStamp;
  stageFt: number;
  flowCfs: number;
  waterTempC: number;
  dissolvedOxygenMgL: number;
  turbidityNtu: number;
  trend: Trend;
  weather: Weather;
}

/** The `otter` channel's payload. While the otter dens, its reach and its last detection's receiver are withheld. */
export interface OtterView {
  otterId: OtterId;
  name: OtterName;
  sex: "female" | "male";
  ageClass: "adult" | "yearling";
  status: "in-watershed" | "left-watershed";
  reachId: PublicReach;
  reachName: string;
  activity: PublicActivity;
  divesThisHour: number;
  lastDetection: { at: StudyStamp; receiver: ReceiverId | "withheld" | "none" };
  note: string;
}

/** The `reach` channel's payload: a camera trap's last frame and today's tallies. */
export interface ReachView {
  reachId: CameraReachId;
  name: string;
  cameraId: CameraId;
  lastFrame: { frame: string; at: StudyStamp; species: Species | "none"; count: number };
  framesToday: number;
  otterFramesToday: number;
}

/** The researcher-only `holt` channel's payload, with the den's grid reference. */
export interface HoltView {
  holtId: HoltId;
  name: string;
  reachId: ReachId;
  gridRef: string;
  occupied: boolean;
  occupants: (OtterName | PupName)[];
  lastEntry: StudyStamp;
  lastExit: StudyStamp;
}

/** The `creekOverview` channel's payload: time, weather, and every station and otter in brief. */
export interface OverviewView {
  watershed: typeof WATERSHED_ID;
  observed: StudyStamp;
  daylight: Daylight;
  weather: Weather;
  stations: { stationId: StationId; name: string; flowCfs: number; trend: Trend }[];
  otters: { otterId: OtterId; name: OtterName; reachId: PublicReach; activity: PublicActivity }[];
}

/** Each simulation channel's payload type, by channel name. */
export interface ChannelViews {
  station: StationView;
  otter: OtterView;
  reach: ReachView;
  holt: HoltView;
  creekOverview: OverviewView;
}

/** Each simulation channel's parameters, by channel name. */
export interface ChannelParams {
  station: { stationId: StationId };
  otter: { otterId: OtterId };
  reach: { reachId: CameraReachId };
  holt: { holtId: HoltId };
  creekOverview: { watershed: typeof WATERSHED_ID };
}

/** The channels the simulation publishes; notebooks belong to the field station. */
export type ChannelName = keyof ChannelViews;

/** The Kafka topic each channel's records are published to. */
export const TOPICS: Readonly<Record<ChannelName, string>> = {
  station: "field.gauges",
  otter: "field.telemetry",
  reach: "field.cameras",
  holt: "field.holts",
  creekOverview: "creek.overview"
};

/** One channel instance's current view. */
export type View = { [K in ChannelName]: { channel: K; key: string; params: ChannelParams[K]; data: ChannelViews[K] } }[ChannelName];

/** The stamp for something that hasn't happened. */
export const NEVER: StudyStamp = { day: 0, time: "--:--" };

/** A tick's study day and "HH:MM" time, or NEVER for null. */
export function stamp(tick: number | null): StudyStamp {
  if (tick === null) return NEVER;
  const time = studyTime(tick);
  return { day: time.day, time: time.clock };
}

/** Flow to three significant figures, the way gauging agencies report it. */
function flow(value: number): number {
  if (value >= 100) return Math.round(value);
  if (value >= 10) return Math.round(value * 10) / 10;
  return Math.round(value * 100) / 100;
}

/** Rounds to `digits` decimal places. */
function fixed(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Classifies the relative change from previous to current; within 0.3% either way is steady. */
function trend(current: number, previous: number): Trend {
  const change = (current - previous) / previous;
  if (change > 0.003) return "rising";
  if (change < -0.003) return "falling";
  return "steady";
}

/** A gauge's view: readings rounded for display, trend from noise-free flow. */
function stationView(world: WorldState, id: StationId): StationView {
  const station = STATIONS.find(candidate => candidate.id === id)!;
  const state = world.stations[id];
  return {
    stationId: id,
    name: station.name,
    reachId: station.reach,
    observed: stamp(world.tick),
    stageFt: fixed(state.stageFt, 2),
    flowCfs: flow(state.flowCfs),
    waterTempC: fixed(state.waterTempC, 1),
    dissolvedOxygenMgL: fixed(state.dissolvedOxygenMgL, 1),
    turbidityNtu: fixed(state.turbidityNtu, 1),
    trend: trend(state.trueFlowCfs, state.previousTrueFlowCfs),
    weather: weatherLabel(world.weather)
  };
}

/** An otter's reach and activity as the public may see them. */
function publicPlace(state: OtterState): { reachId: PublicReach; reachName: string; activity: PublicActivity } {
  if (state.away) return { reachId: "outside", reachName: "Outside the watershed", activity: "away" };
  if (state.activity === "denning") return { reachId: "withheld", reachName: "Location withheld", activity: "denning" };
  const reach = REACHES[state.reach]!;
  return { reachId: reach.id, reachName: reach.name, activity: state.activity };
}

/** A one-line field note on what the otter is doing. */
function otterNote(profile: OtterProfile, state: OtterState): string {
  const pups = profile.pups.join(" and ");
  if (state.away) return "Last heard at the confluence, heading into the Marrow River.";
  switch (state.activity) {
    case "denning":
      return "At a den site. Den locations are shared only with researchers.";
    case "resting":
      return "Resting in bank cover.";
    case "foraging":
      return state.pupsWithHer ? `Foraging with ${pups}.` : "Diving for crayfish and sculpin.";
    case "traveling":
      return state.targetReach === state.reach ? "Moving along the reach." : `Heading toward ${REACHES[state.targetReach]!.name}.`;
    case "grooming":
      return "Grooming on the bank.";
    case "playing":
      return state.pupsWithHer ? `Sliding down the mudbank with ${pups}.` : "Playing in the shallows.";
  }
}

/** An otter's public view; a detection keeps its time but hides its receiver while the otter dens. */
function otterView(world: WorldState, id: OtterId): OtterView {
  const profile = OTTERS.find(candidate => candidate.id === id)!;
  const state = world.otters[id];
  const place = publicPlace(state);
  const detection = state.lastDetection;
  return {
    otterId: id,
    name: profile.name,
    sex: profile.sex,
    ageClass: profile.ageClass,
    status: state.away ? "left-watershed" : "in-watershed",
    ...place,
    divesThisHour: state.divesThisHour,
    lastDetection: {
      at: stamp(detection?.tick ?? null),
      receiver: detection === null ? "none" : state.activity === "denning" && !state.away ? "withheld" : detection.receiver
    },
    note: otterNote(profile, state)
  };
}

/** A camera's view, with a "none" frame until its first trigger. */
function reachView(world: WorldState, id: CameraId): ReachView {
  const camera = CAMERAS.find(candidate => candidate.id === id)!;
  const reach = REACHES.find(candidate => candidate.id === camera.reach)!;
  const state = world.cameras[id];
  const frame = state.lastFrame;
  return {
    reachId: camera.reach,
    name: reach.name,
    cameraId: id,
    lastFrame: frame === null
      ? { frame: "none", at: NEVER, species: "none", count: 0 }
      : { frame: `${id} ${String(frame.number).padStart(5, "0")}`, at: stamp(frame.tick), species: frame.species, count: frame.count },
    framesToday: state.framesToday,
    otterFramesToday: state.otterFramesToday
  };
}

/** A holt's restricted view. */
function holtView(world: WorldState, id: HoltId): HoltView {
  const holt = HOLTS.find(candidate => candidate.id === id)!;
  const state = world.holts[id];
  return {
    holtId: id,
    name: holt.name,
    reachId: holt.reach,
    gridRef: holt.gridRef,
    occupied: state.occupants.length > 0,
    occupants: [...state.occupants],
    lastEntry: stamp(state.lastEntryTick),
    lastExit: stamp(state.lastExitTick)
  };
}

/** The watershed in brief, built from the station views and the otters' public places. */
function overviewView(world: WorldState): OverviewView {
  const time = studyTime(world.tick);
  return {
    watershed: WATERSHED_ID,
    observed: stamp(world.tick),
    daylight: time.daylight,
    weather: weatherLabel(world.weather),
    stations: STATIONS.map(station => {
      const view = stationView(world, station.id);
      return { stationId: station.id, name: station.name, flowCfs: view.flowCfs, trend: view.trend };
    }),
    otters: OTTERS.map(profile => {
      const place = publicPlace(world.otters[profile.id]);
      return { otterId: profile.id, name: profile.name, reachId: place.reachId, activity: place.activity };
    })
  };
}

/** Every channel instance's current view, in a stable order. */
export function allViews(world: WorldState): View[] {
  return [
    { channel: "creekOverview", key: `creekOverview:${WATERSHED_ID}`, params: { watershed: WATERSHED_ID }, data: overviewView(world) },
    ...STATIONS.map((station): View => ({ channel: "station", key: `station:${station.id}`, params: { stationId: station.id }, data: stationView(world, station.id) })),
    ...OTTERS.map((otter): View => ({ channel: "otter", key: `otter:${otter.id}`, params: { otterId: otter.id }, data: otterView(world, otter.id) })),
    ...CAMERAS.map((camera): View => ({ channel: "reach", key: `reach:${camera.reach}`, params: { reachId: camera.reach }, data: reachView(world, camera.id) })),
    ...HOLTS.map((holt): View => ({ channel: "holt", key: `holt:${holt.id}`, params: { holtId: holt.id }, data: holtView(world, holt.id) }))
  ];
}
