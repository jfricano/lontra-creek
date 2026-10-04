/**
 * The records each source-failures scenario publishes (Lab contract section 12.5).
 *
 * Every scenario record is an LC-03 (or, for restart-recovery's second run, LC-01)
 * reading the field station predetermines: a domain mutation at the current tick,
 * whose revision and authoritative views the coverage ledger derives with the
 * simulation's own derivation (coverage.ts). The record goes to the bench's own copy of
 * the gauges topic with the station's key, so it shares the creek copies' partition.
 *
 * The mutation is at the current tick, never a future one: a future tick would later
 * collide with the creek's own record for that tick (the same revision with different
 * data, a native integrity hold). A `lab-projection-v2` record carries exactly the
 * derived view, so its later reprocessing finds served state already at that revision
 * (superseded) instead of conflicting with it.
 */
import { randomBytes } from 'node:crypto';
import { TENANT_ID, type View, type WorldState } from '@lontra-creek/sim';
import { topicFor, type FieldRecord } from '../records.ts';
import { PROJECTION_V2, READING_BATCH } from './bench.ts';
import { bench as benchFor } from './benches.ts';
import type { BenchId, LabScenarioId } from './contract.ts';
import type { StationReading } from './coverage.ts';

/** One run of a scenario: what the ledger records first, then the record built from what it derived. */
export interface ScenarioRun {
  scenarioId: LabScenarioId;
  runId: string;
  mutation: StationReading;
  /** `withheld`: S02 and S03 start with snapshot coverage not ready; everything else is established before publication. */
  coverage: 'withheld' | 'pending';
  /** The record to publish, from the run's revision and the views the ledger derived. */
  record(revision: string, views: readonly View[]): { topic: string; key: string; value: string };
  /** The application step the projection shows once it is published. */
  step: string;
}

const runId = (scenario: LabScenarioId): string => `${scenario}.${randomBytes(6).toString('base64url')}`;
/** A reading that differs from the station's current one: the ledger refuses a mutation that changes nothing. */
const shifted = (current: number, by: number): number => Math.round((current + by) * 10) / 10;

function fieldRecord(stationId: string, revision: string, views: readonly View[]): FieldRecord {
  const view = views.find(item => item.key === `station:${stationId}`);
  if (!view) throw new RangeError(`The mutation doesn't change station ${stationId}'s view.`);
  return { tenantId: TENANT_ID, channel: 'station', params: { stationId }, revision, data: view.data as unknown as FieldRecord['data'] };
}

function run(bench: BenchId, scenarioId: LabScenarioId, mutation: StationReading, coverage: ScenarioRun['coverage'], step: string, value: (record: FieldRecord) => string): ScenarioRun {
  const topic = `${benchFor(bench).topicPrefix}${topicFor('station')}`;
  return { scenarioId, runId: runId(scenarioId), mutation, coverage, step,
    record: (revision, views) => ({ topic, key: `station:${mutation.stationId}`, value: value(fieldRecord(mutation.stationId, revision, views)) }) };
}

const v2 = (record: FieldRecord): string => JSON.stringify({ ...record, mapping: PROJECTION_V2 });
const flow = (world: WorldState, by: number): StationReading => ({ kind: 'station-reading', stationId: 'LC-03', tick: world.tick, reading: { flowCfs: shifted(world.stations['LC-03'].flowCfs, by) } });

/**
 * The runs a scenario start publishes, in order. Empty for the scenarios the bench arms
 * alone (fouled-sensor, calibration-blip) and for inspect-old-reading once the study
 * already has an advanced bad-projection incident.
 */
export function scenarioRuns(bench: BenchId, scenario: LabScenarioId, world: WorldState, options: { advancedProjection: boolean }): ScenarioRun[] {
  switch (scenario) {
    case 'garbled-reading':
      // Cut mid-record: no JSON parser accepts it, and nothing in it can be trusted to say what it was.
      return [run(bench, scenario, flow(world, 7.3), 'withheld', 'Published a garbled LC-03 reading', record => { const text = JSON.stringify(record); return text.slice(0, Math.floor(text.length / 2)); })];
    case 'bad-projection':
      return [run(bench, scenario, flow(world, 7.3), 'withheld', 'Published an LC-03 reading through the v2 projection', v2)];
    case 'inspect-old-reading':
      return options.advancedProjection ? [] : [run(bench, 'bad-projection', flow(world, 7.3), 'pending', 'Published an LC-03 reading through the v2 projection', v2)];
    case 'conflicting-readings':
      return [run(bench, scenario, flow(world, 7.3), 'pending', 'Published two different LC-03 readings at one revision', record => {
        const data = record.data as Record<string, unknown>;
        return JSON.stringify({ ...record, mapping: READING_BATCH, readings: [data, { ...data, flowCfs: shifted(Number(data['flowCfs']), 4.2) }] });
      })];
    case 'too-many-bad-readings':
      return [1, 2, 3, 4, 5, 6].map(n => run(bench, scenario, flow(world, n * 1.1), 'pending', `Published bad LC-03 reading ${n} of 6`, v2));
    case 'restart-recovery':
      return [
        run(bench, scenario, flow(world, 7.3), 'pending', 'Published an LC-03 flow reading through the v2 projection', v2),
        run(bench, scenario, { kind: 'station-reading', stationId: 'LC-01', tick: world.tick, reading: { waterTempC: shifted(world.stations['LC-01'].waterTempC, 0.8) } }, 'pending', 'Published an LC-01 water temperature reading through the v2 projection', v2)
      ];
    case 'unavailable-evidence':
      return [run(bench, scenario, flow(world, 7.3), 'pending', 'Published an LC-03 reading through the v2 projection', v2)];
    default:
      return [];
  }
}
