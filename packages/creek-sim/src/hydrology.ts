/**
 * Weather and the four gauge stations. Storm runoff is routed downstream through a
 * chain of linear reservoirs, one per station, with travel time between them, so a
 * storm's crest reaches LC-01 first and arrives later, broader, and larger at LC-04. Stage comes from a rating curve,
 * dissolved oxygen from temperature-dependent saturation, and turbidity rises
 * fastest on a storm's rising limb.
 */
import { daily, MINUTES_PER_TICK, TICKS_PER_DAY } from "./clock.ts";
import { STATIONS, type Station, type StationId } from "./geography.ts";
import { int, next, normal, range, type Rng } from "./random.ts";

export type Weather = "clear" | "rain" | "storm";

export interface WeatherState {
  raining: boolean;
  /** Rainfall intensity, 0–1. */
  intensity: number;
  rainTicksLeft: number;
  nextRainTick: number;
}

export interface StationState {
  /** Quickflow storage above this station, in cfs·hours. */
  storage: number;
  /** Quickflow released toward the next station, oldest first, still in transit. */
  transit: number[];
  /** Noise-free flow now and one tick ago; trends and turbidity use these. */
  trueFlowCfs: number;
  previousTrueFlowCfs: number;
  trueTurbidityNtu: number;
  /** Slow, weather-driven drift in water temperature. */
  tempDriftC: number;
  /** What the instruments report, including measurement noise. */
  flowCfs: number;
  stageFt: number;
  waterTempC: number;
  dissolvedOxygenMgL: number;
  turbidityNtu: number;
}

const DT_HOURS = MINUTES_PER_TICK / 60;
const RESERVOIR_HOURS = 1.6;
/** Quickflow input per unit of catchment area at full storm intensity, in cfs. */
const RUNOFF_CFS = 130;
/** Travel time between neighbouring stations: about an hour at storm velocities. */
const TRANSIT_TICKS = 12;
const RATING_EXPONENT = 1.6;
/** Flow above this multiple of baseflow counts as high water for otters. */
export const HIGH_FLOW_RATIO = 1.8;

export function initialWeather(rng: Rng): WeatherState {
  // The first rain comes a few study hours in, so a fresh world shows a storm early.
  return { raining: false, intensity: 0, rainTicksLeft: 0, nextRainTick: int(rng, 60, 110) };
}

export function stepWeather(weather: WeatherState, tick: number, rng: Rng): void {
  if (weather.raining) {
    weather.rainTicksLeft -= 1;
    if (weather.rainTicksLeft <= 0) {
      weather.raining = false;
      weather.intensity = 0;
      weather.nextRainTick = tick + int(rng, Math.round(1.2 * TICKS_PER_DAY), Math.round(3.5 * TICKS_PER_DAY));
    }
  } else if (tick >= weather.nextRainTick) {
    weather.raining = true;
    weather.intensity = range(rng, 0.35, 1);
    weather.rainTicksLeft = int(rng, 18, 48);
  }
}

export function weatherLabel(weather: WeatherState): Weather {
  if (!weather.raining) return "clear";
  return weather.intensity >= 0.7 ? "storm" : "rain";
}

export function initialStations(hour: number, rng: Rng): Record<StationId, StationState> {
  const stations = {} as Record<StationId, StationState>;
  for (const station of STATIONS) {
    const state: StationState = {
      storage: 0,
      transit: Array.from({ length: TRANSIT_TICKS }, () => 0),
      trueFlowCfs: station.baseflowCfs,
      previousTrueFlowCfs: station.baseflowCfs,
      trueTurbidityNtu: station.baseTurbidityNtu,
      tempDriftC: 0,
      flowCfs: 0,
      stageFt: 0,
      waterTempC: 0,
      dissolvedOxygenMgL: 0,
      turbidityNtu: 0
    };
    measure(station, state, hour, rng);
    state.previousTrueFlowCfs = state.trueFlowCfs;
    stations[station.id] = state;
  }
  return stations;
}

export function stepStations(stations: Record<StationId, StationState>, weather: WeatherState, hour: number, rng: Rng): void {
  // One cloud over a small watershed: every station shares this tick's rainfall.
  const rainfall = weather.raining ? weather.intensity * (0.6 + 0.8 * next(rng)) : 0;
  // Each station releases quickflow downstream; its neighbour receives what was released TRANSIT_TICKS ago.
  const arriving = STATIONS.map(station => {
    const state = stations[station.id];
    state.transit.push(state.storage / RESERVOIR_HOURS);
    return state.transit.shift()!;
  });
  STATIONS.forEach((station, index) => {
    const state = stations[station.id];
    const inflow = rainfall * station.area * RUNOFF_CFS + (index > 0 ? arriving[index - 1]! : 0);
    state.storage = Math.max(0, state.storage + DT_HOURS * (inflow - state.storage / RESERVOIR_HOURS));
    measure(station, state, hour, rng);
  });
}

function measure(station: Station, state: StationState, hour: number, rng: Rng): void {
  const quick = state.storage / RESERVOIR_HOURS;
  const quickShare = quick / station.baseflowCfs;

  // Riparian plants draw baseflow down a little on warm afternoons.
  const evapotranspiration = 1 - 0.03 * Math.max(0, daily(hour, 15));
  state.previousTrueFlowCfs = state.trueFlowCfs;
  state.trueFlowCfs = station.baseflowCfs * evapotranspiration + quick;
  state.flowCfs = state.trueFlowCfs * (1 + 0.004 * normal(rng));

  // Rating curve Q = C (h - h0)^b, fitted so baseflow sits at the station's base stage.
  const c = station.baseflowCfs / Math.pow(station.baseStageFt - station.zeroFlowStageFt, RATING_EXPONENT);
  state.stageFt = station.zeroFlowStageFt + Math.pow(state.flowCfs / c, 1 / RATING_EXPONENT);

  state.tempDriftC = Math.min(1.5, Math.max(-1.5, state.tempDriftC * 0.998 + 0.012 * normal(rng)));
  const temperature = station.meanWaterTempC + state.tempDriftC + station.tempSwingC * daily(hour, 16.5) - Math.min(1.2, 0.8 * quickShare);
  state.waterTempC = temperature + 0.03 * normal(rng);

  // Oxygen saturation in fresh water (a common cubic fit), about 3% lower for elevation,
  // pushed above saturation by afternoon photosynthesis and a little by storm turbulence.
  const saturation = 14.652 - 0.41022 * temperature + 0.007991 * temperature ** 2 - 0.000077774 * temperature ** 3;
  const percent = 1 + station.oxygenSwing * daily(hour, 14) - station.oxygenDeficit + Math.min(0.03, 0.02 * quickShare);
  state.dissolvedOxygenMgL = saturation * 0.97 * percent + 0.03 * normal(rng);

  const risePerHour = Math.max(0, state.trueFlowCfs - state.previousTrueFlowCfs) / DT_HOURS;
  const target = station.baseTurbidityNtu + 0.15 * quick + 0.25 * risePerHour;
  state.trueTurbidityNtu = state.trueTurbidityNtu * 0.65 + target * 0.35;
  state.turbidityNtu = Math.max(0.1, state.trueTurbidityNtu * (1 + 0.02 * normal(rng)));
}

/** True when a station's flow is high enough that otters shelter instead of foraging. */
export function isHighFlow(station: Station, state: StationState): boolean {
  return state.trueFlowCfs > HIGH_FLOW_RATIO * station.baseflowCfs;
}
