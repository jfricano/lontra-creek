/**
 * The field station's view of each bench's study (LC11-ADR-01, LC11-ADR-02): the
 * publisher gate, the coverage ledger, and the study's authoritative scenario
 * state that the bench's snapshots are served from.
 *
 * Gate. A study is open for scenario publication from the moment the field
 * station grants a lease on it until either the lease pool or the bench closes
 * it, which is the first thing a reset does after revoking the lease. A closed
 * study never reopens. Closing waits, bounded, for the study's in-flight
 * publications; any that complete later are recorded only in the old study's
 * ledger, and not at all once it is discarded.
 *
 * Ledger. One file per study under <dataDir>/lab/lab-N/studies/<studyId>/. A
 * discard writes a bounded summary (no payloads) to
 * <dataDir>/lab/lab-N/summaries/<studyId>.json and removes the study's directory.
 * Leases live in memory, so a field station restart resets every bench, which
 * discards every study; ledgers on disk only bridge bench restarts.
 *
 * Served state. A bench's snapshot of an instance is the shared creek's view or
 * the open study's own authoritative write for it, whichever has the higher
 * revision: full-state channels supersede by revision.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Emission, View, WorldState } from '@lontra-creek/sim';
import { CREEK_TOPICS, bench as benchFor } from './benches.ts';
import type { BenchId, BenchSnapshot, LedgerSummary, RecordCoordinates, RecoveryAssessment, RecoveryAssessRequest, StudyClosed } from './contract.ts';
import { deriveMutation, FileCoverageLedger, type DomainMutation, type LedgerEntry, type ServedState } from './coverage.ts';

const STUDY_ID = /^[A-Za-z0-9_-]{16}$/;
/** How long closing a study waits for its in-flight publications. */
export const CLOSE_WAIT_MS = 5_000;
export const LEDGER_SUMMARIES_KEPT = 20;
/** Closed study IDs remembered per bench, so none is reopened. */
const CLOSED_KEPT = 64;

/** Refused: the study isn't the bench's open study. */
export class StudyClosedError extends Error { constructor() { super('The study is not open.'); } }

/** What the registry needs of the field station's world. */
export interface WorldSource { readonly tick: number; view(key: string): Emission | undefined; world(): WorldState | null }
/** Publishes one record and reports where it landed (kafka.ts). */
export interface ScenarioSink { send(record: { topic: string; key: string; value: string }): Promise<RecordCoordinates> }

interface Study {
  bench: BenchId;
  studyId: string;
  state: 'open' | 'closed';
  ledger: Promise<FileCoverageLedger> | null;
  /** The study's authoritative writes, by instance key. */
  views: Map<string, { revision: string; data: unknown }>;
  /** Each run's predetermined authoritative update, derived once when the run began. */
  prepared: Map<string, View[]>;
  inFlight: Set<Promise<unknown>>;
}

export class LabStudies {
  readonly #root: string;
  readonly #world: WorldSource;
  readonly #now: () => number;
  readonly #closeWaitMs: number;
  readonly #log: (message: string) => void;
  readonly #current = new Map<BenchId, Study>();
  readonly #closed = new Map<BenchId, string[]>();
  /** Discards under way, by bench and study, so a repeated call joins the first. */
  readonly #discarding = new Map<string, Promise<LedgerSummary>>();
  constructor(options: { dataDir: string; world: WorldSource; now?: () => number; closeWaitMs?: number; log?: (message: string) => void }) {
    this.#root = join(options.dataDir, 'lab'); this.#world = options.world; this.#now = options.now ?? Date.now; this.#closeWaitMs = options.closeWaitMs ?? CLOSE_WAIT_MS; this.#log = options.log ?? (() => undefined);
  }
  #dir(bench: BenchId, studyId: string): string { if (!STUDY_ID.test(studyId)) throw new RangeError('Invalid study ID.'); return join(this.#root, `lab-${bench}`, 'studies', studyId); }
  #isClosed(bench: BenchId, studyId: string): boolean { return this.#closed.get(bench)?.includes(studyId) ?? false; }
  #remember(bench: BenchId, studyId: string): void { const list = this.#closed.get(bench) ?? []; if (!list.includes(studyId)) list.push(studyId); if (list.length > CLOSED_KEPT) list.shift(); this.#closed.set(bench, list); }
  /** The bench's open study, or null. */
  current(bench: BenchId): string | null { const study = this.#current.get(bench); return study?.state === 'open' ? study.studyId : null; }
  publishable(bench: BenchId, studyId: string): boolean { return this.current(bench) === studyId; }

  /** Opens a newly leased study. Any other study left on disk for the bench is a stray from a crash: summarized and removed. */
  open(bench: BenchId, studyId: string): void {
    if (!STUDY_ID.test(studyId) || this.#isClosed(bench, studyId)) throw new StudyClosedError();
    const current = this.#current.get(bench);
    if (current?.studyId === studyId) return;
    if (current) { current.state = 'closed'; this.#remember(bench, current.studyId); }
    this.#current.set(bench, { bench, studyId, state: 'open', ledger: null, views: new Map(), prepared: new Map(), inFlight: new Set() });
    // A superseded study is discarded through its own ledger instance, so its in-flight publications see it discarded and write nothing.
    void (async () => { if (current) await this.#discard(bench, current.studyId, current); await this.#sweep(bench, studyId); })()
      .catch(error => this.#log(`Lab ${bench}: sweeping stray studies failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  async #sweep(bench: BenchId, keep: string): Promise<void> {
    let names: string[]; try { names = await readdir(join(this.#root, `lab-${bench}`, 'studies')); } catch { return; }
    for (const name of names) if (name !== keep && STUDY_ID.test(name)) { this.#remember(bench, name); await this.discard(bench, name); }
  }
  /** LC11-ADR-02 step 3: no scenario publication for the study from now on. Idempotent, and fine for a study never opened here. */
  async close(bench: BenchId, studyId: string): Promise<StudyClosed> {
    if (!STUDY_ID.test(studyId)) throw new RangeError('Invalid study ID.');
    this.#remember(bench, studyId);
    const study = this.#current.get(bench);
    if (study?.studyId !== studyId) return { studyId, state: 'closed', inFlight: 0 };
    study.state = 'closed';
    if (study.inFlight.size) await Promise.race([Promise.allSettled([...study.inFlight]), sleep(this.#closeWaitMs, undefined, { ref: false })]);
    return { studyId, state: 'closed', inFlight: study.inFlight.size };
  }
  /** LC11-ADR-02 step 6, field station half: the ledger's bounded summary, then its entries are removed. Only a closed study. */
  async discard(bench: BenchId, studyId: string): Promise<LedgerSummary> {
    if (!STUDY_ID.test(studyId)) throw new RangeError('Invalid study ID.');
    if (this.current(bench) === studyId) throw new StudyClosedError();
    const study = this.#current.get(bench)?.studyId === studyId ? this.#current.get(bench)! : null;
    return this.#discard(bench, studyId, study);
  }
  #discard(bench: BenchId, studyId: string, study: Study | null): Promise<LedgerSummary> {
    const key = `${bench}/${studyId}`;
    const running = this.#discarding.get(key);
    if (running) return running;
    const discarding = this.#discardOnce(bench, studyId, study).finally(() => this.#discarding.delete(key));
    this.#discarding.set(key, discarding); return discarding;
  }
  async #discardOnce(bench: BenchId, studyId: string, study: Study | null): Promise<LedgerSummary> {
    const path = join(this.#dir(bench, studyId), 'ledger.json');
    // An unreadable ledger doesn't stop the discard: the study is going either way.
    const ledger = await (study?.ledger ?? FileCoverageLedger.open(path, bench, studyId, this.#now)).catch(() => null);
    await ledger?.discard();
    const dir = join(this.#root, `lab-${bench}`, 'summaries'); const file = join(dir, `${studyId}.json`);
    // Written once: a retried discard, when the ledger is already gone, never replaces the first record with an empty one.
    let summary = await readFile(file, 'utf8').then(text => JSON.parse(text) as LedgerSummary, () => null);
    if (!summary) {
      const entries = ledger?.entries() ?? [];
      summary = { bench, studyId, closedAt: new Date(this.#now()).toISOString(), entries: entries.map(entry => ({ scenarioId: entry.scenarioId, runId: entry.runId, status: entry.status, affected: [...entry.affected], published: entry.publication !== null })), obligations: ledger?.obligations().length ?? 0, barriers: ledger?.barriers().length ?? 0 };
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(summary)); await rename(`${file}.tmp`, file);
      const files = (await readdir(dir)).filter(name => name.endsWith('.json'));
      if (files.length > LEDGER_SUMMARIES_KEPT) {
        const dated = await Promise.all(files.map(async name => { try { return { name, at: (JSON.parse(await readFile(join(dir, name), 'utf8')) as LedgerSummary).closedAt }; } catch { return { name, at: '' }; } }));
        dated.sort((a, b) => a.at.localeCompare(b.at));
        for (const { name } of dated.slice(0, dated.length - LEDGER_SUMMARIES_KEPT)) await rm(join(dir, name), { force: true });
      }
    }
    await rm(this.#dir(bench, studyId), { recursive: true, force: true });
    if (study) { study.views.clear(); study.prepared.clear(); if (this.#current.get(bench) === study) this.#current.delete(bench); }
    return summary;
  }
  /** The open study's ledger; refused for any other study, which confines late calls to nothing. */
  ledger(bench: BenchId, studyId: string): Promise<FileCoverageLedger> {
    const study = this.#current.get(bench);
    if (!study || study.studyId !== studyId || study.state !== 'open') return Promise.reject(new StudyClosedError());
    if (!study.ledger) {
      const opening = FileCoverageLedger.open(join(this.#dir(bench, studyId), 'ledger.json'), bench, studyId, this.#now);
      // A failed open isn't kept: the next call tries the file again.
      study.ledger = opening; opening.catch(() => { if (study.ledger === opening) study.ledger = null; });
    }
    return study.ledger;
  }
  /** What bench N's snapshots serve: the higher revision of the shared view and the open study's own write. */
  served(bench: BenchId): ServedState & { view(key: string): { revision: string; data: unknown } | undefined } {
    const view = (key: string): { revision: string; data: unknown } | undefined => {
      const shared = this.#world.view(key); const study = this.#current.get(bench);
      const own = study?.state === 'open' ? study.views.get(key) : undefined;
      if (!own) return shared && { revision: shared.revision, data: shared.data };
      if (!shared || BigInt(own.revision) >= BigInt(shared.revision)) return own;
      return { revision: shared.revision, data: shared.data };
    };
    return { tick: () => this.#world.tick, revision: key => view(key)?.revision, view };
  }
  /** A bench snapshot, with the boundary acknowledgment when one was asked for. */
  async snapshot(bench: BenchId, key: string, boundary: string | null): Promise<BenchSnapshot | undefined> {
    const served = this.served(bench); const view = served.view(key);
    if (!view) return undefined;
    if (boundary === null) return { revision: view.revision, data: view.data };
    const studyId = this.current(bench);
    if (!studyId) return { revision: view.revision, data: view.data, boundary: { barrier: boundary, acknowledged: false, reason: 'wrong-study' } };
    const ledger = await this.ledger(bench, studyId);
    return { revision: view.revision, data: view.data, boundary: ledger.acknowledge({ barrier: boundary, key, served: { tick: served.tick(), revision: view.revision } }) };
  }
  /** The recovery guard for bench N. Only the open study may be assessed. */
  async assess(bench: BenchId, request: RecoveryAssessRequest): Promise<RecoveryAssessment> {
    if (request.sourceId !== 'field') throw new RangeError('Unknown source.');
    return (await this.ledger(bench, request.studyId)).assess(request);
  }

  // --- Scenario runs: the interface W9b's scenarios drive. ---

  /**
   * Records a scenario run before anything is published. With coverage `pending`
   * (the normal rule) the authoritative update is written first and coverage
   * established before publication; with `withheld` (S03's teaching state,
   * "Snapshot coverage not ready") nothing is written until prepareCoverage.
   */
  async beginRun(bench: BenchId, studyId: string, input: { scenarioId: string; runId: string; mutation: DomainMutation; coverage: 'withheld' | 'pending' }): Promise<{ entry: LedgerEntry; views: View[] }> {
    const ledger = await this.ledger(bench, studyId);
    const world = this.#world.world();
    if (!world) throw new Error('The world has not started.');
    const derived = deriveMutation(world, input.mutation);
    let entry = await ledger.record({ ...input, derived });
    this.#current.get(bench)!.prepared.set(entry.runId, derived.views);
    if (input.coverage === 'pending') entry = await this.#write(bench, studyId, ledger, entry.runId, derived.views, derived.revision);
    return { entry, views: derived.views };
  }
  /** `scenario.prepare-coverage`: releases the predetermined authoritative update, then establishes coverage if served state reflects it. */
  async prepareCoverage(bench: BenchId, studyId: string, runId: string): Promise<LedgerEntry> {
    const ledger = await this.ledger(bench, studyId);
    const entry = ledger.entries().find(item => item.runId === runId);
    // The update derived when the run began, never anything read back from a published record.
    const views = this.#current.get(bench)?.prepared.get(runId);
    if (!entry || !views) throw new RangeError('No such scenario run.');
    // Established coverage is final: preparing it again writes nothing.
    if (entry.status === 'established') return entry;
    await ledger.release(runId);
    return this.#write(bench, studyId, ledger, runId, views, entry.revision);
  }
  async #write(bench: BenchId, studyId: string, ledger: FileCoverageLedger, runId: string, views: View[], revision: string): Promise<LedgerEntry> {
    const study = this.#current.get(bench);
    if (!study || study.studyId !== studyId || study.state !== 'open') throw new StudyClosedError();
    // Full-state writes supersede by revision: a run with an earlier mutation never takes served state backwards.
    for (const view of views) { const own = study.views.get(view.key); if (!own || BigInt(revision) >= BigInt(own.revision)) study.views.set(view.key, { revision, data: view.data }); }
    return ledger.establish(runId, this.served(bench));
  }
  /** Publishes a run's record to the bench's own copy of a creek topic, through the gate, and records where it landed. */
  async publish(bench: BenchId, studyId: string, runId: string, record: { topic: string; key: string; value: string }, sink: ScenarioSink): Promise<RecordCoordinates> {
    const prefix = benchFor(bench).topicPrefix;
    if (!record.topic.startsWith(prefix) || !CREEK_TOPICS.includes(record.topic.slice(prefix.length))) throw new RangeError('A scenario record goes to its bench\'s copy of a creek topic.');
    const study = this.#current.get(bench);
    if (!study || study.studyId !== studyId || study.state !== 'open') throw new StudyClosedError();
    const ledger = await this.ledger(bench, studyId);
    // close() may have run while the ledger opened: check again in the same step that starts the send and registers it.
    if (study.state !== 'open' || this.#current.get(bench) !== study) throw new StudyClosedError();
    const sending = sink.send(record);
    study.inFlight.add(sending);
    try {
      const at = await sending;
      // A late completion is confined to the old study's ledger, and dropped once that is discarded.
      if (!ledger.discarded) await ledger.published(runId, at).catch(() => undefined);
      return at;
    } finally { study.inFlight.delete(sending); }
  }
}
