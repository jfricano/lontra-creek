/**
 * Study time. Tick 0 is day 1 at 05:00, just before dawn, and each tick is five
 * simulated minutes. Study time is deliberately not a calendar date, so nobody
 * mistakes it for when a reading really happened.
 */

export const MINUTES_PER_TICK = 5;
export const TICKS_PER_HOUR = 60 / MINUTES_PER_TICK;
export const TICKS_PER_DAY = 24 * TICKS_PER_HOUR;
const START_MINUTE = 5 * 60;

export type Daylight = "dawn" | "day" | "dusk" | "night";

export interface StudyTime {
  /** Study day, starting at 1. */
  day: number;
  /** Fractional hour of the day, 0–24. */
  hour: number;
  /** "HH:MM". */
  clock: string;
  daylight: Daylight;
}

function minutes(tick: number): number {
  return START_MINUTE + tick * MINUTES_PER_TICK;
}

export function studyTime(tick: number): StudyTime {
  const total = minutes(tick);
  const minuteOfDay = total % 1440;
  const hour = minuteOfDay / 60;
  return {
    day: Math.floor(total / 1440) + 1,
    hour,
    clock: `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`,
    daylight: daylight(hour)
  };
}

export function daylight(hour: number): Daylight {
  if (hour >= 5.5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 19) return "day";
  if (hour >= 19 && hour < 20.5) return "dusk";
  return "night";
}

/** Whole study hours since tick 0's hour; changes exactly when the clock's hour does. */
export function hourIndex(tick: number): number {
  return Math.floor(minutes(tick) / 60);
}

/** Whole study days since the start, 0-based. */
export function dayIndex(tick: number): number {
  return Math.floor(minutes(tick) / 1440);
}

/** A daily cycle from -1 to 1 that peaks at `peakHour`. */
export function daily(hour: number, peakHour: number): number {
  return Math.cos((2 * Math.PI * (hour - peakHour)) / 24);
}
