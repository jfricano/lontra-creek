/**
 * The tagged otters. River otters are most active around dawn and dusk, somewhat
 * active at night, and mostly rest through the middle of the day. They forage
 * more when hungry and where prey is good, shelter during high water, and den in
 * a holt when one is close. Juniper, a dispersing yearling, drifts downstream and
 * sometimes leaves the watershed for a day or three.
 */
import { hourIndex, TICKS_PER_DAY } from "./clock.ts";
import { HOLTS, REACH_INDEX, REACHES, type HoltId, type OtterProfile, type ReceiverId } from "./geography.ts";
import { chance, int, next, weighted, type Rng } from "./random.ts";

export type Activity = "denning" | "resting" | "foraging" | "traveling" | "grooming" | "playing";

export interface OtterState {
  /** Index into REACHES. */
  reach: number;
  activity: Activity;
  ticksLeft: number;
  targetReach: number;
  /** 0 (fed) to 1 (hungry). */
  hunger: number;
  divesThisHour: number;
  hourIndex: number;
  lastDetection: { tick: number; receiver: ReceiverId } | null;
  /** Outside the watershed, beyond the confluence. */
  away: boolean;
  awayTicksLeft: number;
  /** The holt this otter is in while denning. */
  den: HoltId | null;
  /** For a mother: whether her pups are with her instead of in the holt. */
  pupsWithHer: boolean;
}

export interface OtterContext {
  tick: number;
  hour: number;
  rng: Rng;
  highFlow(reach: number): boolean;
}

const LEAVE_CHANCE = 0.01;
const DETECTION_CHANCE = 0.5;

export function initialOtter(profile: OtterProfile, tick: number): OtterState {
  return {
    reach: profile.startReach,
    activity: "resting",
    ticksLeft: 1,
    targetReach: profile.startReach,
    hunger: 0.4,
    divesThisHour: 0,
    hourIndex: hourIndex(tick),
    lastDetection: null,
    away: false,
    awayTicksLeft: 0,
    den: null,
    pupsWithHer: false
  };
}

function around(hour: number, peak: number, width: number): number {
  const distance = Math.min(Math.abs(hour - peak), 24 - Math.abs(hour - peak));
  return Math.exp(-(distance * distance) / (2 * width * width));
}

/** How active otters are at this hour, from 0.12 (midday) to 1 (dawn and dusk). */
export function activityLevel(hour: number): number {
  const crepuscular = Math.max(around(hour, 6.5, 1.5), around(hour, 20, 1.8));
  const nocturnal = 0.5 * around(hour, 1, 3);
  return 0.12 + 0.88 * Math.max(crepuscular, nocturnal);
}

function denReach(profile: OtterProfile): number {
  const holt = HOLTS.find(candidate => candidate.id === profile.den);
  return holt === undefined ? -1 : REACH_INDEX[holt.reach];
}

export function stepOtter(profile: OtterProfile, state: OtterState, context: OtterContext): void {
  const hour = hourIndex(context.tick);
  if (hour !== state.hourIndex) {
    state.hourIndex = hour;
    state.divesThisHour = 0;
  }

  if (state.away) {
    state.awayTicksLeft -= 1;
    if (state.awayTicksLeft > 0) return;
    // Back up the Marrow River and into the creek at the confluence.
    state.away = false;
    state.reach = profile.range[1];
    beginTravel(profile, state, context);
  }

  const reach = REACHES[state.reach]!;
  switch (state.activity) {
    case "foraging":
      state.divesThisHour += Math.round((3 + 5 * next(context.rng)) * reach.prey);
      state.hunger = Math.max(0, state.hunger - 0.06 * reach.prey);
      break;
    case "traveling":
      state.hunger = Math.min(1, state.hunger + 0.012);
      if (state.reach !== state.targetReach) {
        if (chance(context.rng, 0.55)) state.reach += Math.sign(state.targetReach - state.reach);
      } else if (profile.disperser && state.reach === REACHES.length - 1 && chance(context.rng, LEAVE_CHANCE)) {
        state.away = true;
        state.awayTicksLeft = int(context.rng, Math.round(TICKS_PER_DAY / 3), TICKS_PER_DAY);
        state.den = null;
        state.pupsWithHer = false;
        return;
      } else if (!profile.disperser) {
        state.ticksLeft = Math.min(state.ticksLeft, 1);
      }
      break;
    case "denning":
    case "resting":
      state.hunger = Math.min(1, state.hunger + 0.005);
      break;
    default:
      state.hunger = Math.min(1, state.hunger + 0.01);
  }

  // Receivers can't hear a tag inside a holt.
  if (state.activity !== "denning" && chance(context.rng, DETECTION_CHANCE)) {
    state.lastDetection = { tick: context.tick, receiver: REACHES[state.reach]!.receiver };
  }

  state.ticksLeft -= 1;
  if (state.ticksLeft <= 0) choose(profile, state, context);
}

function choose(profile: OtterProfile, state: OtterState, context: OtterContext): void {
  const level = activityLevel(context.hour);
  const high = context.highFlow(state.reach);
  const prey = REACHES[state.reach]!.prey;
  const hasPups = profile.pups.length > 0;
  const choice = weighted(context.rng, {
    rest: (1 - level) * 1.6 + (high ? 1.5 : 0),
    forage: level * (0.6 + 2 * state.hunger) * prey * (high ? 0.3 : 1),
    travel: level * profile.roaming * (high ? 0.5 : 1),
    groom: 0.2,
    play: level * (hasPups ? 0.35 : 0.1)
  });

  const holtReach = denReach(profile);
  const nearHolt = profile.den !== null && Math.abs(state.reach - holtReach) <= 1;
  state.den = null;
  state.pupsWithHer = false;

  switch (choice) {
    case "rest":
      if (profile.den !== null && nearHolt) {
        state.reach = holtReach;
        state.activity = "denning";
        state.den = profile.den;
        // Long sleeps through the day, shorter rests between night-time bouts.
        state.ticksLeft = level < 0.4 ? int(context.rng, 12, 30) : int(context.rng, 6, 14);
      } else {
        state.activity = "resting";
        state.ticksLeft = int(context.rng, 4, 12);
      }
      break;
    case "forage":
      state.activity = "foraging";
      state.ticksLeft = int(context.rng, 6, 24);
      state.pupsWithHer = hasPups && nearHolt && chance(context.rng, 0.5);
      break;
    case "travel":
      beginTravel(profile, state, context);
      break;
    case "groom":
      state.activity = "grooming";
      state.ticksLeft = int(context.rng, 1, 4);
      break;
    case "play":
      state.activity = "playing";
      state.ticksLeft = int(context.rng, 2, 6);
      state.pupsWithHer = hasPups && nearHolt;
      break;
  }
}

function beginTravel(profile: OtterProfile, state: OtterState, context: OtterContext): void {
  const [low, high] = profile.range;
  const span = high - low + 1;
  // Dispersers lean downstream; residents pick another reach in their range.
  const drift = int(context.rng, -2, 2) + (chance(context.rng, 0.15) ? 1 : 0);
  state.targetReach = profile.disperser
    ? Math.min(high, Math.max(low, state.reach + drift))
    : low + ((state.reach - low + int(context.rng, 1, span - 1)) % span);
  state.activity = "traveling";
  state.ticksLeft = int(context.rng, 3, 10);
  state.den = null;
  state.pupsWithHer = false;
}
