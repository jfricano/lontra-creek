/**
 * The application coverage ledger and recovery guard (LC11-ADR-01), app side.
 *
 * For each bench study the field station keeps a ledger of the scenario runs it
 * publishes: the predetermined domain mutation, the channel instances it can
 * affect (derived by the simulation's own view derivation, never from record
 * bytes), the authoritative watermark at which served state reflects it, the
 * record's publication coordinates, and a coverage status:
 *
 *   withheld ──release──▶ pending ──establish (served state reaches it)──▶ established
 *
 * The recovery guard answers from the ledger: `hold` unless the incident's entry
 * is established for every affected instance at or past the mutation. A
 * recoverable answer carries a cumulative barrier over every obligation in the
 * study, so a second incident never drops the first one's requirement. A snapshot
 * acknowledges a barrier only when the state it serves is at or past it.
 *
 * Everything here is written against these interfaces, not native types:
 * StreamOtter 0.1.0-rc.3 has no recovery guard or barrier. W9b adds the thin
 * adapter to the native types once a published release exports them.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { allViews, revisionFor, type StationId, type View, type WorldState } from '@lontra-creek/sim';
import type { RecordCoordinates, RecoveryAssessment, RecoveryAssessRequest, SnapshotBoundary } from './contract.ts';

/** Ledger bounds per study: a study is one five-minute lease. */
export const MAX_ENTRIES = 32;
export const MAX_OBLIGATIONS = 64;
const MAX_EVIDENCE_REF = 256;

export type CoverageStatus = 'withheld' | 'pending' | 'established';

/** An instrument reading at a stated simulation tick: the predetermined mutation of the LC-03 scenarios. */
export interface StationReading {
  kind: 'station-reading';
  stationId: StationId;
  tick: number;
  reading: Partial<Record<'flowCfs' | 'stageFt' | 'waterTempC' | 'dissolvedOxygenMgL' | 'turbidityNtu', number>>;
}
export type DomainMutation = StationReading;

/** What a mutation does to the views benches serve, by the simulation's own derivation. */
export interface DerivedMutation {
  /** The revision the mutation's records carry. */
  revision: string;
  /** Instance keys (`station:LC-03`) whose bench view changes. */
  affected: string[];
  /** The authoritative views with the mutation applied, at its tick. */
  views: View[];
}

/** Channels a bench serves; holts never reach a bench. */
const BENCH_CHANNELS: ReadonlySet<string> = new Set(['station', 'otter', 'reach', 'creekOverview']);

/**
 * Derives a mutation's affected instances by applying it to a copy of the world
 * and comparing every view the simulation derives, before and after. The tick is
 * held still for the comparison, so only the domain change counts; the views
 * returned are then derived at the mutation's own tick.
 */
export function deriveMutation(world: WorldState, mutation: DomainMutation): DerivedMutation {
  if (!Number.isSafeInteger(mutation.tick) || mutation.tick < world.tick) throw new RangeError('A mutation is at or after the current tick.');
  const entries = Object.entries(mutation.reading);
  if (entries.length === 0 || entries.some(([, value]) => typeof value !== 'number' || !Number.isFinite(value))) throw new RangeError('A reading needs finite values.');
  const changed = structuredClone(world);
  Object.assign(changed.stations[mutation.stationId], mutation.reading);
  const before = new Map(allViews(world).map(view => [view.key, JSON.stringify(view.data)]));
  const affected = allViews(changed).filter(view => BENCH_CHANNELS.has(view.channel) && before.get(view.key) !== JSON.stringify(view.data)).map(view => view.key).sort();
  if (affected.length === 0) throw new RangeError('The mutation changes no bench view.');
  changed.tick = mutation.tick;
  const keys = new Set(affected);
  return { revision: revisionFor(world.generation, mutation.tick), affected, views: allViews(changed).filter(view => keys.has(view.key)) };
}

/** Served state at a tick, per instance revision. */
export interface Watermark { tick: number; revisions: Record<string, string> }

export interface LedgerEntry {
  scenarioId: string;
  runId: string;
  mutation: DomainMutation;
  /** The mutation's revision: served state is at or past the mutation once an affected instance's revision reaches it. */
  revision: string;
  affected: string[];
  status: CoverageStatus;
  watermark: Watermark | null;
  publication: RecordCoordinates | null;
  recordedAt: string;
  establishedAt: string | null;
}

/** An incident the guard answered recoverable for: the study must keep honoring it until discarded. */
export interface Obligation { runId: string; record: RecordCoordinates; assessedAt: string; barrier: string }
/** A cumulative barrier: the maximum, per instance and tick, over every obligation so far. */
export interface Barrier { id: string; seq: number; tick: number; revisions: Record<string, string>; runIds: string[] }

/** What the snapshot service serves for one bench: its state's tick and each instance's revision. */
export interface ServedState { tick(): number; revision(key: string): string | undefined }

export interface CoverageLedger {
  readonly bench: number;
  readonly studyId: string;
  entries(): readonly LedgerEntry[];
  obligations(): readonly Obligation[];
  barriers(): readonly Barrier[];
  record(input: { scenarioId: string; runId: string; mutation: DomainMutation; derived: DerivedMutation; coverage: 'withheld' | 'pending' }): Promise<LedgerEntry>;
  published(runId: string, at: RecordCoordinates): Promise<void>;
  /** withheld → pending: the scenario releases its predetermined authoritative update. */
  release(runId: string): Promise<LedgerEntry>;
  /** pending → established, only when the served state has reached the mutation for every affected instance. */
  establish(runId: string, served: ServedState): Promise<LedgerEntry>;
}
export interface RecoveryAssessor { assess(request: RecoveryAssessRequest): Promise<RecoveryAssessment> }
export interface SnapshotAcknowledger { acknowledge(input: { barrier: string; key: string; served: { tick: number; revision: string } }): SnapshotBoundary }

interface LedgerFile { format: 1; bench: number; studyId: string; entries: LedgerEntry[]; obligations: Obligation[]; barriers: Barrier[] }

const atOrPast = (served: string | undefined, required: string): boolean => {
  if (served === undefined || !/^\d{1,30}$/.test(served) || !/^\d{1,30}$/.test(required)) return false;
  return BigInt(served) >= BigInt(required);
};
const sameRecord = (a: RecordCoordinates | null, b: RecordCoordinates): boolean => a !== null && a.topic === b.topic && a.partition === b.partition && a.offset === b.offset;
export const barrierId = (studyId: string, seq: number): string => `lcb1.${studyId}.${seq}`;
const BARRIER = /^lcb1\.([A-Za-z0-9_-]{16})\.([1-9]\d{0,5})$/;

/**
 * A study's ledger, persisted as one JSON file (write, then rename). Writes are
 * serialized. Once discarded it never writes again, so a late callback can't
 * recreate a removed study's ledger.
 */
export class FileCoverageLedger implements CoverageLedger, RecoveryAssessor, SnapshotAcknowledger {
  readonly bench: number;
  readonly studyId: string;
  readonly #path: string;
  readonly #now: () => number;
  #file: LedgerFile;
  #tail: Promise<unknown> = Promise.resolve();
  #discarded = false;
  private constructor(path: string, file: LedgerFile, now: () => number) { this.#path = path; this.#file = file; this.bench = file.bench; this.studyId = file.studyId; this.#now = now; }
  /** Opens the study's ledger, or starts an empty one. An unreadable file is an error, never silently emptied. */
  static async open(path: string, bench: number, studyId: string, now: () => number = Date.now): Promise<FileCoverageLedger> {
    let file: LedgerFile = { format: 1, bench, studyId, entries: [], obligations: [], barriers: [] };
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as LedgerFile;
      if (parsed.format !== 1 || parsed.bench !== bench || parsed.studyId !== studyId || !Array.isArray(parsed.entries) || !Array.isArray(parsed.obligations) || !Array.isArray(parsed.barriers)) throw new Error('The coverage ledger does not belong to this study.');
      file = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return new FileCoverageLedger(path, file, now);
  }
  entries(): readonly LedgerEntry[] { return structuredClone(this.#file.entries); }
  obligations(): readonly Obligation[] { return structuredClone(this.#file.obligations); }
  barriers(): readonly Barrier[] { return structuredClone(this.#file.barriers); }
  get discarded(): boolean { return this.#discarded; }
  /** Stops all further writes. The registry removes the file. */
  discard(): Promise<void> { this.#discarded = true; return this.#tail.then(() => undefined); }
  #iso(): string { return new Date(this.#now()).toISOString(); }
  #entry(runId: string): LedgerEntry { const entry = this.#file.entries.find(item => item.runId === runId); if (!entry) throw new RangeError('No such scenario run.'); return entry; }
  #change<T>(fn: () => T): Promise<T> {
    const next = this.#tail.then(async () => {
      if (this.#discarded) throw new Error('The study was discarded.');
      const before = structuredClone(this.#file);
      try { const result = fn(); await this.#persist(); return result; } catch (error) { this.#file = before; throw error; }
    });
    this.#tail = next.catch(() => undefined); return next;
  }
  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(`${this.#path}.tmp`, JSON.stringify(this.#file));
    await rename(`${this.#path}.tmp`, this.#path);
  }
  record(input: { scenarioId: string; runId: string; mutation: DomainMutation; derived: DerivedMutation; coverage: 'withheld' | 'pending' }): Promise<LedgerEntry> {
    return this.#change(() => {
      if (!/^[\w.-]{1,64}$/.test(input.scenarioId) || !/^[\w.-]{1,64}$/.test(input.runId)) throw new RangeError('Scenario and run IDs are short identifiers.');
      if (this.#file.entries.some(entry => entry.runId === input.runId)) throw new RangeError('That run is already recorded.');
      if (this.#file.entries.length >= MAX_ENTRIES) throw new RangeError('The study has recorded as many runs as it may.');
      const entry: LedgerEntry = { scenarioId: input.scenarioId, runId: input.runId, mutation: structuredClone(input.mutation), revision: input.derived.revision, affected: [...input.derived.affected], status: input.coverage, watermark: null, publication: null, recordedAt: this.#iso(), establishedAt: null };
      this.#file.entries.push(entry); return structuredClone(entry);
    });
  }
  published(runId: string, at: RecordCoordinates): Promise<void> {
    return this.#change(() => { const entry = this.#entry(runId); if (entry.publication && !sameRecord(entry.publication, at)) throw new RangeError('That run was already published elsewhere.'); entry.publication = { ...at }; });
  }
  release(runId: string): Promise<LedgerEntry> {
    return this.#change(() => { const entry = this.#entry(runId); if (entry.status === 'withheld') entry.status = 'pending'; return structuredClone(entry); });
  }
  establish(runId: string, served: ServedState): Promise<LedgerEntry> {
    return this.#change(() => {
      const entry = this.#entry(runId);
      if (entry.status !== 'pending') return structuredClone(entry);
      const revisions: Record<string, string> = {};
      for (const key of entry.affected) { const revision = served.revision(key); if (!atOrPast(revision, entry.revision)) return structuredClone(entry); revisions[key] = revision!; }
      entry.status = 'established'; entry.watermark = { tick: served.tick(), revisions }; entry.establishedAt = this.#iso();
      return structuredClone(entry);
    });
  }
  #evidence(runIds: readonly string[], seq: number): string {
    const named = `ledger:lab-${this.bench}/${this.studyId}#${runIds.join(',')}`;
    return named.length <= MAX_EVIDENCE_REF ? named : `ledger:lab-${this.bench}/${this.studyId}#barrier-${seq}`;
  }
  /**
   * The guard. The incident's record is matched by its publication coordinates,
   * never by its bytes. Unknown records hold: nothing in the ledger can attest
   * what they carried.
   */
  assess(request: RecoveryAssessRequest): Promise<RecoveryAssessment> {
    const studyId = this.studyId;
    const hold = (reason: Extract<RecoveryAssessment, { decision: 'hold' }>['reason'], entry?: LedgerEntry): RecoveryAssessment => ({ decision: 'hold', studyId, reason, evidenceRef: entry ? this.#evidence([entry.runId], 0) : null });
    const record = request.record;
    if (!record) return Promise.resolve(hold('no-coordinates'));
    return this.#change((): RecoveryAssessment => {
      const entry = this.#file.entries.find(item => sameRecord(item.publication, record));
      if (!entry) return hold('unknown-record');
      if (entry.status === 'withheld') return hold('coverage-withheld', entry);
      if (entry.status === 'pending' || !entry.watermark || entry.affected.some(key => !atOrPast(entry.watermark!.revisions[key], entry.revision))) return hold('coverage-pending', entry);
      let barrier = this.#file.barriers.at(-1);
      if (!this.#file.obligations.some(item => sameRecord(item.record, record))) {
        if (this.#file.obligations.length >= MAX_OBLIGATIONS) return hold('coverage-pending', entry);
        // Cumulative: every earlier obligation's watermark, and this one's.
        const runIds = [...new Set([...this.#file.obligations.map(item => item.runId), entry.runId])];
        const revisions: Record<string, string> = {}; let tick = 0;
        for (const runId of runIds) {
          const watermark = this.#entry(runId).watermark!; tick = Math.max(tick, watermark.tick);
          for (const [key, revision] of Object.entries(watermark.revisions)) if (!revisions[key] || BigInt(revision) > BigInt(revisions[key]!)) revisions[key] = revision;
        }
        const seq = this.#file.barriers.length + 1;
        barrier = { id: barrierId(studyId, seq), seq, tick, revisions, runIds };
        this.#file.barriers.push(barrier);
        this.#file.obligations.push({ runId: entry.runId, record: { ...record }, assessedAt: this.#iso(), barrier: barrier.id });
      }
      return { decision: 'recoverable', studyId, barrier: barrier!.id, covers: Object.keys(barrier!.revisions).sort(), evidenceRef: this.#evidence(barrier!.runIds, barrier!.seq) };
    });
  }
  /** Acknowledges only a barrier this study issued, and only when the served state is at or past it. */
  acknowledge(input: { barrier: string; key: string; served: { tick: number; revision: string } }): SnapshotBoundary {
    const no = (reason: NonNullable<SnapshotBoundary['reason']>): SnapshotBoundary => ({ barrier: input.barrier, acknowledged: false, reason });
    const match = BARRIER.exec(input.barrier);
    if (!match) return no('malformed');
    if (match[1] !== this.studyId) return no('wrong-study');
    const barrier = this.#file.barriers.find(item => item.id === input.barrier);
    if (!barrier) return no('unknown-barrier');
    const required = barrier.revisions[input.key];
    if (!(input.served.tick >= barrier.tick) || required !== undefined && !atOrPast(input.served.revision, required)) return no('lagging');
    return { barrier: input.barrier, acknowledged: true };
  }
}
