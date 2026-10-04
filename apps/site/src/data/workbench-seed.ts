/**
 * The two examples a sandbox session opens with (LC11-ADR-04, decision 4), shown on
 * /workbench/ as a **design fixture**: fixed values written into the page, not read
 * from a running sandbox. test/workbench-seed.test.ts holds them to their sources:
 * the station record is the one the creek simulation (seed "lontra-creek") publishes
 * for LC-03 after its first tick, and its state is what the field station's own Kafka
 * map handler makes of it; the jobProgress record is the first `jobs` fixture record
 * of the pinned `streamotter init` scaffold, and its state is what that scaffold's
 * own map handler returns.
 */
import type { GaugeReading } from "../generated/streamotter.generated.ts";

export interface SeedExample<State> {
  channel: string;
  /** Where the record comes from, in that project's own terms. */
  source: string;
  params: Record<string, string>;
  record: { key: string; value: unknown };
  /** What the channel's map handler returns for the record: the full state of one instance at one revision. */
  state: { tenantId: string; params: Record<string, string>; revision: string; data: State };
}

export const STATION_SEED: SeedExample<GaugeReading> = {
  channel: "station",
  source: "Kafka topic field.gauges, written by the field station",
  params: { stationId: "LC-03" },
  record: {
    key: "station:LC-03",
    value: {
      tenantId: "lontra-creek", channel: "station", params: { stationId: "LC-03" }, revision: "1000000000001",
      data: { stationId: "LC-03", name: "Slate Canyon", reachId: "slate-canyon", observed: { day: 1, time: "05:05" }, stageFt: 3.1, flowCfs: 86.9, waterTempC: 10.3, dissolvedOxygenMgL: 10.5, turbidityNtu: 4, trend: "steady", weather: "clear" }
    }
  },
  state: {
    tenantId: "lontra-creek", params: { stationId: "LC-03" }, revision: "1000000000001",
    data: { stationId: "LC-03", name: "Slate Canyon", reachId: "slate-canyon", observed: { day: 1, time: "05:05" }, stageFt: 3.1, flowCfs: 86.9, waterTempC: 10.3, dissolvedOxygenMgL: 10.5, turbidityNtu: 4, trend: "steady", weather: "clear" }
  }
};

export interface JobProgress { jobId: string; state: "queued" | "running" | "succeeded" | "failed"; percent: number }

export const JOB_SEED: SeedExample<JobProgress> = {
  channel: "jobProgress",
  source: "the scaffold's jobs fixture source (a Kafka topic in your app)",
  params: { jobId: "job_1" },
  record: { key: "job_1", value: { tenantId: "local", revision: "2", job: { jobId: "job_1", state: "running", percent: 25 } } },
  state: { tenantId: "local", params: { jobId: "job_1" }, revision: "2", data: { jobId: "job_1", state: "running", percent: 25 } }
};

/** The In your app note: each creek term beside the scaffold's. */
export const IN_YOUR_APP: readonly { creek: string; app: string; meaning: string }[] = [
  { creek: "station", app: "jobProgress", meaning: "One channel: a named, versioned contract for one kind of live state." },
  { creek: "stationId: \"LC-03\"", app: "jobId: \"job_1\"", meaning: "The parameter that picks one instance. Each instance has its own revisions and access check." },
  { creek: "stageFt, flowCfs, trend", app: "state, percent", meaning: "The full state your map handler returns. Browsers replace it on each revision; they never merge it." },
  { creek: "revision 1000000000001", app: "revision \"2\"", meaning: "Orders the states of one instance. Snapshots and mapped records must describe the same progression." },
  { creek: "tenantId \"lontra-creek\"", app: "tenantId \"local\"", meaning: "Whose data it is. A subscriber sees only instances in its own principal's tenant; your authorize handler decides the rest." },
  { creek: "topic field.gauges", app: "your jobs topic", meaning: "Where the records come from. Your app owns the topic and the record format; the map handler translates." }
];
