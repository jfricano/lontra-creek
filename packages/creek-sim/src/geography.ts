/**
 * Lontra Creek, a fictional 14.2 km watershed, and everything the field station
 * watches on it. Reaches are listed from the headwater (index 0) downstream.
 */

export const TENANT_ID = "lontra-creek";
export const WATERSHED_ID = "lontra";

export type ReachId =
  | "alder-spring"
  | "cedar-riffle"
  | "kestrel-bend"
  | "beaver-flats"
  | "slate-canyon"
  | "heron-marsh"
  | "confluence";

export interface Reach {
  id: ReachId;
  name: string;
  /** Distance from Alder Spring, in kilometres. */
  fromKm: number;
  toKm: number;
  /** The telemetry receiver that hears tagged otters in this reach. */
  receiver: ReceiverId;
  /** Relative prey availability, 0–1. */
  prey: number;
  /** The gauge station whose flow describes conditions here. */
  station: StationId;
}

export type ReceiverId = "RX-01" | "RX-02" | "RX-03" | "RX-04" | "RX-05" | "RX-06" | "RX-07";

export const REACHES: readonly Reach[] = [
  { id: "alder-spring", name: "Alder Spring", fromKm: 0, toKm: 1.6, receiver: "RX-01", prey: 0.55, station: "LC-01" },
  { id: "cedar-riffle", name: "Cedar Riffle", fromKm: 1.6, toKm: 3.9, receiver: "RX-02", prey: 0.8, station: "LC-01" },
  { id: "kestrel-bend", name: "Kestrel Bend", fromKm: 3.9, toKm: 5.8, receiver: "RX-03", prey: 0.9, station: "LC-02" },
  { id: "beaver-flats", name: "Beaver Flats", fromKm: 5.8, toKm: 7.7, receiver: "RX-04", prey: 0.85, station: "LC-02" },
  { id: "slate-canyon", name: "Slate Canyon", fromKm: 7.7, toKm: 9.9, receiver: "RX-05", prey: 0.7, station: "LC-03" },
  { id: "heron-marsh", name: "Heron Marsh", fromKm: 9.9, toKm: 12.6, receiver: "RX-06", prey: 0.95, station: "LC-04" },
  { id: "confluence", name: "Marrow River confluence", fromKm: 12.6, toKm: 14.2, receiver: "RX-07", prey: 0.65, station: "LC-04" }
];

export const REACH_INDEX: Readonly<Record<ReachId, number>> = Object.fromEntries(REACHES.map((reach, index) => [reach.id, index])) as Record<ReachId, number>;

export type StationId = "LC-01" | "LC-02" | "LC-03" | "LC-04";

export interface Station {
  id: StationId;
  name: string;
  reach: ReachId;
  /** Dry-weather flow, in cubic feet per second. Includes everything upstream. */
  baseflowCfs: number;
  /** Local catchment size relative to LC-01; scales storm runoff. */
  area: number;
  /** Stage at baseflow and the rating curve's zero-flow stage, in feet. */
  baseStageFt: number;
  zeroFlowStageFt: number;
  meanWaterTempC: number;
  /** Half the daily water-temperature swing. Shaded canyons swing less than open marsh. */
  tempSwingC: number;
  /** Daily dissolved-oxygen swing from photosynthesis, as a fraction of saturation. */
  oxygenSwing: number;
  /** Standing oxygen deficit below saturation, as a fraction. Marshes run low. */
  oxygenDeficit: number;
  baseTurbidityNtu: number;
}

export const STATIONS: readonly Station[] = [
  { id: "LC-01", name: "Cedar Riffle", reach: "cedar-riffle", baseflowCfs: 38, area: 1.0, baseStageFt: 2.1, zeroFlowStageFt: 0.5, meanWaterTempC: 10.2, tempSwingC: 1.1, oxygenSwing: 0.05, oxygenDeficit: 0, baseTurbidityNtu: 2.8 },
  { id: "LC-02", name: "Kestrel Bend", reach: "kestrel-bend", baseflowCfs: 61, area: 0.45, baseStageFt: 2.4, zeroFlowStageFt: 0.6, meanWaterTempC: 10.9, tempSwingC: 1.4, oxygenSwing: 0.06, oxygenDeficit: 0.01, baseTurbidityNtu: 3.4 },
  { id: "LC-03", name: "Slate Canyon", reach: "slate-canyon", baseflowCfs: 87, area: 0.35, baseStageFt: 3.1, zeroFlowStageFt: 0.9, meanWaterTempC: 11.2, tempSwingC: 0.9, oxygenSwing: 0.04, oxygenDeficit: 0, baseTurbidityNtu: 3.9 },
  { id: "LC-04", name: "Heron Marsh", reach: "heron-marsh", baseflowCfs: 118, area: 0.5, baseStageFt: 1.9, zeroFlowStageFt: 0.4, meanWaterTempC: 12.3, tempSwingC: 2.0, oxygenSwing: 0.12, oxygenDeficit: 0.07, baseTurbidityNtu: 6.5 }
];

export type CameraId = "CT-1" | "CT-2" | "CT-3";
/** The reaches with a camera trap; the `reach` channel covers only these. */
export type CameraReachId = "cedar-riffle" | "beaver-flats" | "heron-marsh";

export interface Camera {
  id: CameraId;
  reach: CameraReachId;
}

export const CAMERAS: readonly Camera[] = [
  { id: "CT-1", reach: "cedar-riffle" },
  { id: "CT-2", reach: "beaver-flats" },
  { id: "CT-3", reach: "heron-marsh" }
];

export type HoltId = "A" | "B";

export interface Holt {
  id: HoltId;
  name: string;
  reach: ReachId;
  /** Survey grid reference on the study's own grid. Restricted to researchers. */
  gridRef: string;
}

export const HOLTS: readonly Holt[] = [
  { id: "A", name: "Holt A", reach: "beaver-flats", gridRef: "LC 4417 2203" },
  { id: "B", name: "Holt B", reach: "heron-marsh", gridRef: "LC 4581 2046" }
];

export type OtterId = "LO-07" | "LO-03" | "LO-11";
export type OtterName = "Pebble" | "Birch" | "Juniper";
export type PupName = "Sprout" | "Skipper";

export interface OtterProfile {
  id: OtterId;
  name: OtterName;
  sex: "female" | "male";
  ageClass: "adult" | "yearling";
  /** Home range as reach indices, inclusive. */
  range: readonly [number, number];
  startReach: number;
  /** The holt this otter dens in, if any. Others rest in bank cover. */
  den: HoltId | null;
  pups: readonly PupName[];
  /** How readily this otter travels, relative to 1. */
  roaming: number;
  /** Dispersers drift downstream and sometimes leave the watershed for a while. */
  disperser: boolean;
}

export const OTTERS: readonly OtterProfile[] = [
  { id: "LO-07", name: "Pebble", sex: "female", ageClass: "adult", range: [2, 4], startReach: 3, den: "A", pups: ["Sprout", "Skipper"], roaming: 0.9, disperser: false },
  { id: "LO-03", name: "Birch", sex: "male", ageClass: "adult", range: [0, 6], startReach: 5, den: "B", pups: [], roaming: 1.5, disperser: false },
  { id: "LO-11", name: "Juniper", sex: "female", ageClass: "yearling", range: [3, 6], startReach: 4, den: null, pups: [], roaming: 1.0, disperser: true }
];
