/**
 * The field station's half of the source-failures intents (Lab contract sections 12.5
 * to 12.7): operations, the incident projection, and its revision.
 *
 * An intent is checked and recorded inside the lease pool's queue: the session's
 * active lease, an idempotent `requestId`, the projection's current `scenarioRevision`
 * and the incident it names, the intent's precondition, then the action budget. It is
 * answered 202 at once and carried out outside the queue, so a library call that waits
 * 15 seconds never holds up heartbeats. The bench carries out everything but
 * `scenario.prepare-coverage` (the field station's own ledger) and the scenario's
 * records, which the field station publishes through the study's gate.
 *
 * The projection is composed from the bench's facts (the installed library's incident,
 * section 8b) and this field station's coverage ledger, never from the feed and never
 * from the intent the visitor sent. Its `scenarioRevision` increments whenever any other
 * field changes, and each revision remembers which library incident and incident
 * revision it showed: the browser never names an incident. Native IDs (failure,
 * boundary, operation, plan) stay between the bench and the field station.
 */
import { randomBytes } from 'node:crypto';
import { StaleMutationError, type LedgerEntry } from './coverage.ts';
import type { BenchId, BenchIncident, BenchIncidentFacts, BenchIntentRequest, BenchOperation, LabIncidentSummary, LabIncidentView, LabIntentRequest, LabOperation, LabScenarioId } from './contract.ts';
import { LabError } from './errors.ts';
import { scenarioRuns, type ScenarioRun } from './scenarios.ts';
import type { LabStudies, ScenarioSink } from './studies.ts';

/** How long an ended lease's operations and last projection stay readable (sections 12.6 and 12.7). */
export const ENDED_KEPT_MS = 60_000;
/** Steps a projection shows, newest kept. */
export const MAX_STEPS = 50;
const MAX_OPERATIONS = 64;
const MAX_REVISIONS = 32;
const POLL_MS = 500;
/** How long the field station follows a bench operation: a same-study gateway restart can take 30 seconds. */
const OPERATION_WAIT_MS = 60_000;
/** inspect-old-reading run alone: how long its bad-projection record may take to be advanced past. */
const ADVANCE_WAIT_MS = 30_000;

const iso = (ms: number): string => new Date(ms).toISOString();
const FINAL: ReadonlySet<LabOperation['status']> = new Set(['succeeded', 'refused', 'failed', 'unknown', 'cancelled']);

/** The session's active lease, as the pool knows it. */
export interface IntentLease { id: string; bench: BenchId; studyId: string | null; expires: number }
/** What intents need of the lease pool (leases.ts). `lease`, `spend`, and `read` run only inside the pool's queue. */
export interface IntentPool {
  /** The session's active (claimed) lease; 409 `no-lease` otherwise. */
  lease(subject: string): IntentLease;
  /** Spends the lease's one-a-second action budget; 429 `too-many-actions` within a second of the last. */
  spend(subject: string): void;
  /** A bench call for the session's lease; a bench that fails ends the lease, as for actions. */
  read<T>(subject: string, path: string): Promise<T>;
  /** A bench call that never touches the pool: for work carried out outside its queue. */
  bench<T>(bench: BenchId, path: string, method?: string, body?: unknown): Promise<T>;
}

interface Operation extends LabOperation { fingerprint: string }
interface Step { at: string; text: string }
interface LeaseState {
  subject: string; leaseId: string; bench: BenchId; studyId: string | null;
  /** The scenario the visitor last started in this lease. */
  scenario: LabScenarioId | null;
  revision: number; digest: string | null; summary: LabIncidentSummary | null;
  /** Which library incident and incident revision each projection revision showed. */
  targets: Map<number, { failureId: string; revision: number }>;
  byRequest: Map<string, Operation>; byId: Map<string, Operation>;
  /** The field station's own application steps: records published, coverage released. */
  steps: Step[];
  ended: number | null;
}
interface Outcome { status: LabOperation['status']; outcome: string }

// ---------------------------------------------------------------------------
// The projection (section 12.7), composed from facts alone so it can be tested
// against an independent expectation.
// ---------------------------------------------------------------------------

const REASONS: Partial<Record<BenchIncident['failureClass'], string>> = {
  'invalid-json': 'An LC-03 reading arrived garbled: it isn\'t valid JSON, so nothing in it can be read or trusted.',
  'payload-schema': 'The v2 projection turned an LC-03 reading into a payload the station channel refuses: flow written as text.',
  'mapper-error': 'LC-03\'s calibration table is missing, so its readings can\'t be mapped.',
  'mapper-transient': 'LC-03\'s calibration lookup kept timing out, past the bounded retries.',
  'revision-conflict': 'Two different LC-03 readings arrived at the same revision, and nothing says which is true.'
};
const CIRCUIT_OPEN = 'Too many bad readings arrived within a minute, so automatic continuation stopped. The Lab has no action to reopen it: returning the bench discards the study and resets it.';
const EVENTS: Record<BenchIncident['history'][number]['event'], string> = {
  'detected': 'StreamOtter detected the failure', 'retrying': 'StreamOtter retried the record', 'captured': 'The record was captured as evidence',
  'quarantine-unknown': 'The quarantine write\'s outcome is unknown', 'quarantined': 'The quarantine copy was acknowledged', 'held': 'The source is held at the record',
  'advance-pending': 'Advancing past the record', 'advance-confirmed': 'The advance was confirmed; a recovery boundary is in force',
  'snapshot-recovery-required': 'Snapshots must acknowledge the recovery boundary', 'operator': 'An operator action was recorded', 'resolved': 'The incident was resolved'
};
const INELIGIBLE: Record<string, string> = {
  'still-fails': 'it still fails with today\'s handlers',
  'not-advanced': 'the source never advanced past it',
  'evidence-expired': 'the saved record is no longer available',
  'evidence-unavailable': 'the saved record is no longer available',
  'evidence-incomplete': 'the saved record is incomplete'
};

/** An evaluation's reasons that say the saved record itself couldn't be read back. */
const EVIDENCE_GONE: ReadonlySet<string> = new Set(['evidence-expired', 'evidence-unavailable']);
/**
 * The incident's evidence. The library records what it captured; whether the copy can still
 * be read back is learned only when an evaluation tries (LC11-S09), so its finding counts too.
 */
export function evidenceOf(incident: BenchIncident, evaluation: BenchIncidentFacts['evaluation'] = null): LabIncidentSummary['evidence'] {
  if (incident.evidence.completeness === 'expired' || incident.evidence.completeness === 'unavailable' || incident.quarantine === 'failed') return 'unavailable';
  if (evaluation && evaluation.incidentRevision === incident.revision && EVIDENCE_GONE.has(evaluation.ineligibleReason ?? '')) return 'unavailable';
  if (incident.quarantine === 'acknowledged') return 'saved';
  if (incident.quarantine === 'not-required') return 'not-required';
  return 'unknown';
}
export function sourceOf(incident: BenchIncident): LabIncidentSummary['source'] {
  return incident.progress === 'advanced' || incident.progress === 'processed' || incident.progress === 'uncertain' ? incident.progress : 'held';
}
const sameRecord = (entry: LedgerEntry, position: BenchIncident['position']): boolean =>
  position !== null && entry.publication !== null && entry.publication.topic === position.topic && entry.publication.partition === position.partition && entry.publication.offset === position.offset;

/** The current incident's projection, or null when the study has none. Pure: the caller assigns `scenarioRevision`. */
export function compose(input: { facts: BenchIncidentFacts; scenario: LabScenarioId | null; entries: readonly LedgerEntry[]; steps: readonly Step[]; now: number }): Omit<LabIncidentSummary, 'scenarioRevision'> | null {
  const { facts } = input; const incident = facts.incident;
  if (!incident) return null;
  // The ledger's run for the record: by its coordinates, else the scenario's newest run.
  const run = input.entries.find(entry => sameRecord(entry, incident.position)) ?? [...input.entries].reverse().find(entry => entry.scenarioId === input.scenario) ?? null;
  const evaluation = facts.evaluation && facts.evaluation.incidentRevision === incident.revision ? facts.evaluation : null;
  const token = evaluation?.planToken && evaluation.expiresAt !== null && Date.parse(evaluation.expiresAt) > input.now ? evaluation.planToken : null;
  const nextIntent = ((): LabIncidentSummary['nextIntent'] => {
    if (incident.nextAction === 'repair-and-retry') return facts.app.calibration === 'removed' || facts.app.blipArmed ? 'scenario.restore-calibration' : 'incident.retry-current';
    if (incident.nextAction === 'reassess') return run?.status === 'withheld' ? 'scenario.prepare-coverage' : 'incident.reassess';
    if (incident.nextAction === 'evaluate') return token ? 'incident.approve-reprocess' : facts.app.mapping === 'corrected' ? 'incident.evaluate' : null;
    return null;
  })();
  const recovery = ((): LabIncidentSummary['recovery'] => {
    if (incident.policy !== 'quarantine-resync') return 'none';
    if (run?.status !== 'established') return 'coverage-not-ready';
    return facts.resynchronizedAt !== null ? 'view-resynchronized' : 'coverage-established';
  })();
  const reprocess = ((): LabIncidentSummary['reprocess'] => {
    const latest = facts.reprocess;
    if (!latest) return null;
    if (latest.result === 'completed') return latest.outcome === 'reprocessed' || latest.outcome === 'superseded' ? latest.outcome : null;
    return latest.result === 'refused' ? null : latest.result;
  })();
  const steps = [
    ...input.steps.map(step => ({ at: step.at, origin: 'application' as const, text: step.text })),
    ...facts.steps.map(step => ({ at: step.at, origin: 'application' as const, text: step.text })),
    ...incident.history.map(event => ({ at: event.at, origin: 'library' as const, text: EVENTS[event.event] }))
  ].sort((a, b) => a.at.localeCompare(b.at));
  const kept = steps.slice(-MAX_STEPS);
  const position = incident.position ?? run?.publication ?? null;
  const updatedAt = [incident.lastObservedAt, ...kept.map(step => step.at), evaluation?.at ?? '', facts.reprocess?.at ?? ''].reduce((a, b) => (b > a ? b : a));
  return {
    label: `Incident ${incident.ordinal}`,
    scenario: input.scenario ?? 'fouled-sensor',
    reason: facts.circuit?.state === 'open' && incident.nextAction === 'reopen-circuit' ? CIRCUIT_OPEN : REASONS[incident.failureClass] ?? 'A record on the creek\'s source couldn\'t be processed.',
    openedAt: incident.firstObservedAt, updatedAt,
    failure: { stage: incident.stage, class: incident.failureClass },
    policy: incident.policy,
    evidence: evidenceOf(incident, evaluation), source: sourceOf(incident), recovery,
    evaluation: evaluation && {
      result: evaluation.validation === 'valid' ? 'passed' : 'failed', at: evaluation.at,
      expiresAt: token ? evaluation.expiresAt : null,
      // Exactly while the next intent is approval: the token and the offer are one fact.
      planToken: nextIntent === 'incident.approve-reprocess' ? token : null,
      summary: evaluation.validation === 'valid'
        ? evaluation.eligible ? 'The saved record maps and validates with today\'s handlers, and may be reprocessed once.' : `The saved record maps and validates with today's handlers, but can't be reprocessed: ${INELIGIBLE[evaluation.ineligibleReason ?? ''] ?? 'StreamOtter didn\'t offer a plan'}.`
        : EVIDENCE_GONE.has(evaluation.ineligibleReason ?? '') ? `The saved record couldn't be evaluated: ${INELIGIBLE[evaluation.ineligibleReason!]}.`
        : `The saved record still fails with today's handlers${evaluation.errorClass ? ` (${evaluation.errorClass})` : ''}.`
    },
    reprocess, discarded: false, nextIntent,
    detail: { topic: position?.topic ?? '', partition: position?.partition ?? 0, offset: position?.offset ?? '', evidenceFingerprint: incident.evidence.hash || null, handlerIdentity: incident.handlerBuildId, sourceGeneration: incident.generation },
    steps: kept,
    stepsGap: steps.length > kept.length || incident.history[0]?.event !== 'detected'
  };
}

const DETAIL: Record<string, string> = {
  'stale-revision': 'The incident changed before this ran: look at it again.',
  'integrity-class': 'StreamOtter never advances past an integrity fault: only discarding the study ends it.',
  'policy-not-resync': 'This incident\'s policy keeps the source held at the record: it is never advanced past.',
  'circuit-open': CIRCUIT_OPEN,
  'not-held': 'The source isn\'t holding that record any more.',
  'in-progress': 'Another action on this incident is still running.',
  'advance-unresolved': 'An earlier advance hasn\'t been confirmed yet.',
  'gateway-not-running': 'The bench\'s gateway is restarting: try again in a moment.',
  'plan-unknown': 'That evaluation can\'t be approved: it was already used, or it belongs to another incident.',
  'plan-expired': 'That evaluation expired: evaluate the record again.',
  'fingerprint-changed': 'The handlers changed since that evaluation: evaluate the record again.',
  'not-advanced': 'The source never advanced past this record, so there is nothing to reprocess.',
  'evidence-expired': 'The saved record is no longer available.',
  'integrity-fault-open': 'An integrity fault is still open on this source.',
  'study-closed': 'The lease ended before this finished.',
  'publish-failed': 'The scenario\'s records couldn\'t be published.',
  'advance-timeout': 'StreamOtter didn\'t advance past the bad-projection record in time.',
  'not-applicable': 'That doesn\'t apply to the bench\'s current state.'
};
function detailFor(status: LabOperation['status'], outcome: string): string | null {
  if (status === 'succeeded' || status === 'accepted' || status === 'running') return null;
  if (status === 'cancelled') return DETAIL['study-closed']!;
  return DETAIL[outcome] ?? (status === 'refused' ? 'StreamOtter refused it; nothing changed.' : status === 'failed' ? 'It was attempted and failed.' : 'Its outcome couldn\'t be observed. It is not repeated: look at the incident again.');
}

export class LabIntents {
  readonly #pool: IntentPool;
  readonly #studies: LabStudies | undefined;
  readonly #sink: ScenarioSink | undefined;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #leases = new Map<string, LeaseState>();
  /** Ended leases by session subject, for ENDED_KEPT_MS. */
  readonly #ended = new Map<string, LeaseState>();
  constructor(options: { pool: IntentPool; studies?: LabStudies; sink?: ScenarioSink; now?: () => number; pollMs?: number }) {
    this.#pool = options.pool; this.#studies = options.studies; this.#sink = options.sink; this.#now = options.now ?? Date.now; this.#pollMs = options.pollMs ?? POLL_MS;
  }
  #state(subject: string, lease: IntentLease): LeaseState {
    let state = this.#leases.get(lease.id);
    if (!state) {
      state = { subject, leaseId: lease.id, bench: lease.bench, studyId: lease.studyId, scenario: null, revision: 1, digest: null, summary: null, targets: new Map(), byRequest: new Map(), byId: new Map(), steps: [], ended: null };
      this.#leases.set(lease.id, state);
    }
    return state;
  }
  #sweep(): void { for (const [subject, state] of this.#ended) if (this.#now() - state.ended! >= ENDED_KEPT_MS) this.#ended.delete(subject); }
  /** The pool ended a lease: unfinished operations are cancelled, and its operations and last projection stay readable for ENDED_KEPT_MS. */
  ended(subject: string, leaseId: string): void {
    this.#sweep();
    const state = this.#leases.get(leaseId);
    if (!state) return;
    this.#leases.delete(leaseId); state.ended = this.#now(); this.#ended.set(subject, state);
    for (const operation of state.byId.values()) if (!FINAL.has(operation.status)) this.#settle(operation, { status: 'cancelled', outcome: 'study-closed' }, true);
  }
  #settle(operation: Operation, outcome: Outcome, force = false): void {
    if (FINAL.has(operation.status) && !force) return;
    Object.assign(operation, { status: outcome.status, detail: detailFor(outcome.status, outcome.outcome), updatedAt: iso(this.#now()) });
  }
  #step(state: LeaseState, text: string): void { if (state.ended !== null) return; state.steps.push({ at: iso(this.#now()), text }); if (state.steps.length > MAX_STEPS) state.steps.shift(); }
  static #view(operation: Operation): LabOperation { const { fingerprint: _f, ...visible } = operation; return visible; }

  /** Composes the projection from fresh facts and moves `scenarioRevision` on when anything in it changed. */
  async #project(state: LeaseState, facts: BenchIncidentFacts): Promise<LabIncidentView> {
    const entries = this.#studies && state.studyId ? await this.#studies.runs(state.bench, state.studyId) : [];
    const summary = compose({ facts, scenario: state.scenario, entries, steps: state.steps, now: this.#now() });
    const digest = JSON.stringify(summary);
    if (state.ended === null && digest !== state.digest) {
      if (state.digest !== null) state.revision++;
      state.digest = digest;
      if (facts.incident) { state.targets.set(state.revision, { failureId: facts.incident.failureId, revision: facts.incident.revision }); if (state.targets.size > MAX_REVISIONS) state.targets.delete(state.targets.keys().next().value!); }
    }
    if (summary && state.ended === null) state.summary = { ...summary, scenarioRevision: state.revision };
    return summary ? { status: 'open', now: iso(this.#now()), incident: { ...summary, scenarioRevision: state.revision } } : { status: 'none', now: iso(this.#now()) };
  }
  /** The bench's facts for the lease; null while its gateway restarts (409), when there is no operator to ask. */
  async #facts(read: () => Promise<BenchIncidentFacts>): Promise<BenchIncidentFacts | null> {
    try { return await read(); } catch (error) { if (error instanceof LabError && error.code === 'not-applicable') return null; throw error; }
  }

  /** `GET /api/lab/incident`, inside the pool's queue. */
  async incident(subject: string): Promise<LabIncidentView> {
    this.#sweep();
    let lease: IntentLease;
    try { lease = this.#pool.lease(subject); }
    catch (error) {
      // A lease that ended within the last minute: its last projection, marked discarded. The incident was not fixed.
      const ended = this.#ended.get(subject);
      if (ended?.summary) return { status: 'open', now: iso(this.#now()), incident: { ...ended.summary, discarded: true } };
      throw error;
    }
    const state = this.#state(subject, lease);
    const facts = await this.#facts(() => this.#pool.read<BenchIncidentFacts>(subject, `/bench/v1/incident?leaseId=${encodeURIComponent(lease.id)}`));
    if (!facts) return state.summary ? { status: 'open', now: iso(this.#now()), incident: state.summary } : { status: 'none', now: iso(this.#now()) };
    return this.#project(state, facts);
  }

  /** `GET /api/lab/operations/<operationId>`: the session's current lease's, or one that ended within the last minute; null otherwise. */
  operation(subject: string, operationId: string): LabOperation | null {
    this.#sweep();
    const current = [...this.#leases.values()].find(state => state.subject === subject);
    const found = current?.byId.get(operationId) ?? this.#ended.get(subject)?.byId.get(operationId);
    return found ? LabIntents.#view(found) : null;
  }

  /** `POST /api/lab/actions` with an intent, inside the pool's queue (section 12.5's answers, in order). */
  async submit(subject: string, request: LabIntentRequest): Promise<LabOperation> {
    const lease = this.#pool.lease(subject);
    const state = this.#state(subject, lease);
    const fingerprint = JSON.stringify([request.intent, request.scenario ?? null, request.expectedRevision ?? null, request.planToken ?? null]);
    const existing = state.byRequest.get(request.requestId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new LabError('not-applicable', 409); return LabIntents.#view(existing); }
    if (!state.studyId) throw new LabError('not-applicable', 409);
    // The projection as it is now: a stale revision, and the incident it names, are judged against the truth, not the last poll.
    const facts = await this.#facts(() => this.#pool.read<BenchIncidentFacts>(subject, `/bench/v1/incident?leaseId=${encodeURIComponent(lease.id)}`));
    if (facts) await this.#project(state, facts);
    if (request.expectedRevision !== undefined && request.expectedRevision !== state.revision) throw new LabError('not-applicable', 409);
    const target = state.targets.get(state.revision);
    const current = facts?.incident && target?.failureId === facts.incident.failureId ? target : null;
    const applies = await (async (): Promise<boolean> => {
      if (!facts) return false;
      switch (request.intent) {
        case 'scenario.start': return facts.incident?.state !== 'open';
        case 'scenario.restore-calibration': return facts.app.calibration === 'removed' || facts.app.blipArmed;
        case 'scenario.prepare-coverage': return (await this.#studies?.runs(state.bench, state.studyId!) ?? []).some(entry => entry.status === 'withheld');
        case 'incident.approve-reprocess': return current !== null && request.planToken === state.summary?.evaluation?.planToken;
        default: return current !== null;
      }
    })();
    if (!applies) throw new LabError('not-applicable', 409);
    this.#pool.spend(subject);
    if (state.byId.size >= MAX_OPERATIONS) for (const [id, operation] of state.byId) if (FINAL.has(operation.status)) { state.byId.delete(id); state.byRequest.delete(operation.requestId); break; }
    const at = iso(this.#now());
    const operation: Operation = { operationId: `lop_${randomBytes(16).toString('base64url').slice(0, 22)}`, intent: request.intent, requestId: request.requestId, status: 'accepted', acceptedAt: at, updatedAt: at, scenarioRevision: null, detail: null, fingerprint };
    state.byRequest.set(request.requestId, operation); state.byId.set(operation.operationId, operation);
    if (request.intent === 'scenario.start') state.scenario = request.scenario!;
    const answer = LabIntents.#view(operation);
    void this.#carryOut(state, operation, request, current, facts!);
    return answer;
  }

  /** Outside the pool's queue: the work, then the projection revision it produced. */
  async #carryOut(state: LeaseState, operation: Operation, request: LabIntentRequest, target: { failureId: string; revision: number } | null, facts: BenchIncidentFacts): Promise<void> {
    if (state.ended !== null) return;
    Object.assign(operation, { status: 'running', updatedAt: iso(this.#now()) });
    let outcome: Outcome;
    try {
      if (request.intent === 'scenario.prepare-coverage') outcome = await this.#prepare(state);
      else if (request.intent === 'scenario.start') outcome = await this.#start(state, operation, request.scenario!, facts);
      // Only incident intents name the incident (section 8b): the bench refuses one on scenario.restore-calibration.
      else outcome = await this.#bench(state, operation, { intent: request.intent, ...(target && request.intent.startsWith('incident.') ? { incident: target } : {}), ...(request.planToken ? { planToken: request.planToken } : {}) });
    } catch { outcome = { status: 'unknown', outcome: 'unexpected-error' }; }
    if (state.ended !== null) return;
    // The revision the outcome produced: the projection after it, read without touching the pool.
    const after = await this.#facts(() => this.#pool.bench<BenchIncidentFacts>(state.bench, `/bench/v1/incident?leaseId=${encodeURIComponent(state.leaseId)}`)).catch(() => null);
    if (after && state.ended === null) await this.#project(state, after).catch(() => undefined);
    if (state.ended !== null) return;
    operation.scenarioRevision = state.revision;
    this.#settle(operation, outcome);
  }
  async #prepare(state: LeaseState): Promise<Outcome> {
    const run = (await this.#studies!.runs(state.bench, state.studyId!)).find(entry => entry.status === 'withheld');
    if (!run) return { status: 'refused', outcome: 'not-applicable' };
    try { await this.#studies!.prepareCoverage(state.bench, state.studyId!, run.runId); }
    catch { return { status: state.ended !== null ? 'cancelled' : 'failed', outcome: 'study-closed' }; }
    this.#step(state, 'Snapshot coverage released: the study\'s authoritative update for the reading is served');
    return { status: 'succeeded', outcome: 'prepared' };
  }
  /** A bench intent, followed until the bench reports a final status. A lost answer is re-sent once with the same operation ID. */
  async #bench(state: LeaseState, operation: Operation, body: Omit<BenchIntentRequest, 'leaseId' | 'operationId'>): Promise<Outcome> {
    const request: BenchIntentRequest = { leaseId: state.leaseId, operationId: operation.operationId, ...body };
    let accepted: BenchOperation | null = null;
    for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
      try { accepted = await this.#pool.bench<BenchOperation>(state.bench, '/bench/v1/intents', 'POST', request); }
      catch (error) { if (error instanceof LabError && error.status < 500) return { status: error.code === 'no-lease' ? 'cancelled' : 'refused', outcome: error.code }; }
    }
    if (!accepted) return { status: 'unknown', outcome: 'bench-unavailable' };
    const deadline = this.#now() + OPERATION_WAIT_MS;
    let seen = accepted;
    while (!FINAL.has(seen.status)) {
      if (state.ended !== null) return { status: 'cancelled', outcome: 'study-closed' };
      if (this.#now() >= deadline) return { status: 'unknown', outcome: 'timeout' };
      await new Promise(resolve => setTimeout(resolve, this.#pollMs));
      seen = await this.#pool.bench<BenchOperation>(state.bench, `/bench/v1/operations/${operation.operationId}?leaseId=${encodeURIComponent(state.leaseId)}`).catch(() => seen);
    }
    return { status: seen.status, outcome: seen.outcome ?? '' };
  }
  /** `scenario.start`: the bench arms, the field station publishes (inspect-old-reading alone: publish, wait for the advance, then arm). */
  async #start(state: LeaseState, operation: Operation, scenario: LabScenarioId, facts: BenchIncidentFacts): Promise<Outcome> {
    const advancedProjection = facts.incident?.failureClass === 'payload-schema' && facts.incident.progress === 'advanced';
    // A run's reading is at the world's current tick, which moves on every few seconds: each run is built
    // from the world as it is when it is published, and rebuilt if the tick moved before the ledger recorded it.
    const runsNow = (): ScenarioRun[] => { const world = this.#studies?.world() ?? null; return world ? scenarioRuns(state.bench, scenario, world, { advancedProjection }) : []; };
    const runs = runsNow().length;
    if (runs && (!this.#studies || !this.#sink)) return { status: 'failed', outcome: 'publish-failed' };
    const publish = async (): Promise<Outcome | null> => {
      for (let index = 0; index < runs; index++) {
        for (let attempt = 1; ; attempt++) {
          if (state.ended !== null) return { status: 'cancelled', outcome: 'study-closed' };
          const run = runsNow()[index];
          try {
            if (!run) throw new Error('The world has not started.');
            await this.#studies!.publishRun(state.bench, state.studyId!, run, this.#sink!);
            this.#step(state, run.step); break;
          } catch (error) {
            if (state.ended !== null) return { status: 'cancelled', outcome: 'study-closed' };
            // Nothing was recorded or published: the reading is built again at the new tick.
            if (error instanceof StaleMutationError && attempt < 3) continue;
            // The visitor sees only that publishing failed; the operator needs the cause.
            console.error(`${iso(this.#now())} Lab bench ${state.bench}: publishing a ${scenario} record failed: ${(error as Error).message}`);
            return { status: 'failed', outcome: 'publish-failed' };
          }
        }
      }
      return null;
    };
    if (scenario === 'inspect-old-reading') {
      const failed = await publish(); if (failed) return failed;
      if (runs) {
        const deadline = this.#now() + ADVANCE_WAIT_MS;
        for (;;) {
          if (state.ended !== null) return { status: 'cancelled', outcome: 'study-closed' };
          const now = await this.#facts(() => this.#pool.bench<BenchIncidentFacts>(state.bench, `/bench/v1/incident?leaseId=${encodeURIComponent(state.leaseId)}`)).catch(() => null);
          if (now?.incident?.failureClass === 'payload-schema' && now.incident.progress === 'advanced') break;
          if (this.#now() >= deadline) return { status: 'failed', outcome: 'advance-timeout' };
          await new Promise(resolve => setTimeout(resolve, this.#pollMs));
        }
      }
      return this.#bench(state, operation, { intent: 'scenario.start', scenario });
    }
    const armed = await this.#bench(state, operation, { intent: 'scenario.start', scenario });
    if (armed.status !== 'succeeded') return armed;
    return await publish() ?? { status: 'succeeded', outcome: 'started' };
  }
}
