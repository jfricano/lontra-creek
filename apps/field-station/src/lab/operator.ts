/**
 * The bench's private operator adapter (Lab contract section 8b, LC11-ADR-03).
 *
 * The bench reaches its running gateway's failure handling only through the published
 * in-process operator API (`getGatewayOperator` from `streamotter/gateway/operator`):
 * never a socket, never the management routes, never internals. This module turns the
 * library's incidents into `BenchIncidentFacts` for the field station, carries out the
 * `incident.*` intents with the library's own calls, and keeps the per-study state the
 * library doesn't: operations by the field station's operation ID, single-use plan
 * tokens, the latest evaluation and redrive, the bench's application steps, and when
 * the leaseholder's snapshot last succeeded.
 *
 * Everything reported here is what the library returned. A refusal stays a refusal; an
 * outcome the bench couldn't observe is `unknown`; nothing is inferred from the intent
 * the visitor sent.
 */
import { randomBytes } from 'node:crypto';
import type { IncidentDetail, OperationResult, OperatorApi } from 'streamotter/contracts';
import type { BenchFailureProfile, BenchIncident, BenchIncidentFacts, BenchIntentRequest, BenchOperation, LabOperation } from './contract.ts';
import { LabError } from './errors.ts';

/** The bench's only source. */
export const SOURCE_ID = 'field';
/** Operations kept per study; older final ones are forgotten first. */
export const MAX_OPERATIONS = 64;
/** Application steps kept per study. */
export const MAX_STEPS = 50;
/** Plan tokens kept per study: the library keeps at most 64 plans, and a visitor needs one. */
export const MAX_TOKENS = 8;

const iso = (ms: number): string => new Date(ms).toISOString();
const FINAL: ReadonlySet<LabOperation['status']> = new Set(['succeeded', 'refused', 'failed', 'unknown', 'cancelled']);

/** A library result's status: `completed` succeeded, whatever its outcome (a retry that holds again still ran). */
export function operationStatus(result: OperationResult['result']): LabOperation['status'] {
  return result === 'completed' ? 'succeeded' : result;
}
/** What an intent came to: the status, the library's (or the bench's) outcome word, and the incident revision it produced. */
export interface Outcome { status: LabOperation['status']; outcome: string; incidentRevision: number | null }
const fromResult = (result: OperationResult): Outcome => ({ status: operationStatus(result.result), outcome: result.outcome, incidentRevision: result.incidentRevision });
/** A call that threw. Malformed input changed nothing; anything else may have had an effect the bench can't see. */
function thrown(error: unknown, readOnly = false): Outcome {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'INVALID_REQUEST') return { status: 'refused', outcome: 'invalid-request', incidentRevision: null };
  return { status: readOnly ? 'failed' : 'unknown', outcome: typeof code === 'string' ? code : 'unexpected-error', incidentRevision: null };
}

interface PlanBinding { leaseId: string; studyId: string; failureId: string; incidentRevision: number; planId: string; fingerprint: string; expiresAt: number }

/**
 * Single-use tokens for evaluation plans. A token names a plan the bench holds; it is
 * bound to the lease, the study, the incident and its revision, and expires with the
 * plan or the lease, whichever is first. The browser never sees the plan itself.
 */
export class PlanTokens {
  readonly #tokens = new Map<string, PlanBinding>();
  readonly #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }
  mint(binding: PlanBinding): string {
    for (const [token, plan] of this.#tokens) if (plan.expiresAt <= this.#now()) this.#tokens.delete(token);
    while (this.#tokens.size >= MAX_TOKENS) this.#tokens.delete(this.#tokens.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(token, binding); return token;
  }
  /** The newest live token for an incident at a revision, if any. */
  current(failureId: string, incidentRevision: number): { token: string; expiresAt: number } | null {
    let found: { token: string; expiresAt: number } | null = null;
    for (const [token, plan] of this.#tokens) if (plan.failureId === failureId && plan.incidentRevision === incidentRevision && plan.expiresAt > this.#now()) found = { token, expiresAt: plan.expiresAt };
    return found;
  }
  /**
   * Spends a token: its plan, or why it can't be used. A token from another lease, study, or
   * incident is unknown here; one evaluated at another revision of the incident is stale, and
   * is spent too, since a revision never comes back.
   */
  take(token: string, scope: { leaseId: string; studyId: string; failureId: string; incidentRevision: number }): PlanBinding | 'plan-unknown' | 'plan-expired' | 'stale-revision' {
    const plan = this.#tokens.get(token);
    if (!plan || plan.leaseId !== scope.leaseId || plan.studyId !== scope.studyId || plan.failureId !== scope.failureId) return 'plan-unknown';
    this.#tokens.delete(token);
    if (plan.incidentRevision !== scope.incidentRevision) return 'stale-revision';
    return plan.expiresAt <= this.#now() ? 'plan-expired' : plan;
  }
  clear(): void { this.#tokens.clear(); }
}

/** The incident the projection is about: the source's held one, else the study's newest. Its ordinal counts incidents in order of first observation. */
export async function currentIncident(api: OperatorApi): Promise<{ detail: IncidentDetail; ordinal: number } | null> {
  const status = await api.status();
  const held = status.sources.find(source => source.sourceId === SOURCE_ID)?.heldIncident?.failureId;
  const page = await api.listFailures({ sourceId: SOURCE_ID, state: 'all', limit: 200 });
  const items = [...page.items].sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.failureId.localeCompare(b.failureId));
  const index = held === undefined ? items.length - 1 : items.findIndex(item => item.failureId === held);
  const chosen = items[index === -1 ? items.length - 1 : index];
  if (!chosen) return null;
  return { detail: await api.showFailure({ failureId: chosen.failureId }), ordinal: items.indexOf(chosen) + 1 };
}

/** The facts the projection needs from one incident. Event details are dropped: they may carry native IDs. */
export function benchIncident(detail: IncidentDetail, ordinal: number): BenchIncident {
  const position = detail.position.kind === 'kafka' ? { topic: detail.position.topic, partition: detail.position.partition, offset: detail.position.offset } : null;
  return {
    failureId: detail.failureId, revision: detail.revision, ordinal, failureClass: detail.failureClass, stage: detail.stage, errorCode: detail.errorCode, policy: detail.policy,
    state: detail.state, progress: detail.progress, recovery: detail.recovery, quarantine: detail.quarantine, nextAction: detail.nextAction,
    evidence: { location: detail.evidence.location, completeness: detail.evidence.completeness, hash: detail.evidence.hash },
    position, generation: detail.generation, handlerBuildId: detail.fingerprints.handlerBuildId, firstObservedAt: detail.firstObservedAt, lastObservedAt: detail.lastObservedAt,
    guard: detail.guard ? { decision: detail.guard.decision, reason: detail.guard.reason } : null,
    boundary: detail.boundary?.state ?? null,
    history: detail.history.map(event => ({ at: event.at, event: event.event }))
  };
}

interface Operation extends BenchOperation { leaseId: string; fingerprint: string }
const fingerprintOf = (request: BenchIntentRequest): string => JSON.stringify([request.intent, request.scenario ?? null, request.incident ?? null, request.planToken ?? null]);

/**
 * One study's failure-handling state on the bench. A reset closes it: unfinished
 * operations become `cancelled`, tokens are forgotten, and late results write nothing.
 */
export class BenchFailures {
  readonly studyId: string;
  readonly #number: number;
  readonly #now: () => number;
  readonly #operations = new Map<string, Operation>();
  readonly tokens: PlanTokens;
  #evaluation: (NonNullable<BenchIncidentFacts['evaluation']> & { failureId: string }) | null = null;
  #reprocess: (NonNullable<BenchIncidentFacts['reprocess']> & { failureId: string }) | null = null;
  #snapshots: string[] = [];
  #steps: BenchIncidentFacts['steps'] = [];
  #closed = false;
  constructor(options: { number: number; studyId: string; now?: () => number }) {
    this.#number = options.number; this.studyId = options.studyId; this.#now = options.now ?? Date.now; this.tokens = new PlanTokens(this.#now);
  }
  get closed(): boolean { return this.#closed; }
  /** An application action the bench took, for the projection's steps. */
  step(text: string): void { if (this.#closed) return; this.#steps.push({ at: iso(this.#now()), text }); if (this.#steps.length > MAX_STEPS) this.#steps.shift(); }
  /** A snapshot for the leaseholder succeeded (a `snapshot` `ok` trace not from the satellite). */
  observeSnapshot(at: string): void { if (this.#closed) return; this.#snapshots.push(at); if (this.#snapshots.length > 200) this.#snapshots.shift(); }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.tokens.clear();
    for (const operation of this.#operations.values()) if (!FINAL.has(operation.status)) Object.assign(operation, { status: 'cancelled', outcome: 'study-closed', updatedAt: iso(this.#now()) });
  }
  operation(leaseId: string, operationId: string): BenchOperation | null {
    const operation = this.#operations.get(operationId);
    if (!operation || operation.leaseId !== leaseId) return null;
    const { leaseId: _l, fingerprint: _f, ...visible } = operation; return visible;
  }
  /** The operation already recorded under the request's ID, or null. An ID reused for a different request is not-applicable. */
  recorded(request: BenchIntentRequest): BenchOperation | null {
    const existing = this.#operations.get(request.operationId);
    if (!existing) return null;
    if (existing.leaseId !== request.leaseId || existing.fingerprint !== fingerprintOf(request)) throw new LabError('not-applicable', 409);
    return this.operation(request.leaseId, request.operationId);
  }
  /**
   * Records an intent and runs it in the background. A repeated operation ID answers the
   * recorded operation without running anything.
   */
  accept(request: BenchIntentRequest, work: () => Promise<Outcome>): BenchOperation {
    const recorded = this.recorded(request);
    if (recorded) return recorded;
    if (this.#closed) throw new LabError('no-lease', 409);
    const fingerprint = fingerprintOf(request);
    if (this.#operations.size >= MAX_OPERATIONS) for (const [id, operation] of this.#operations) { if (FINAL.has(operation.status)) { this.#operations.delete(id); break; } }
    if (this.#operations.size >= MAX_OPERATIONS) throw new LabError('too-many-actions', 429);
    const at = iso(this.#now());
    const operation: Operation = { operationId: request.operationId, intent: request.intent, status: 'running', outcome: null, incidentRevision: null, acceptedAt: at, updatedAt: at, leaseId: request.leaseId, fingerprint };
    this.#operations.set(request.operationId, operation);
    void work().catch(error => thrown(error)).then(outcome => {
      // Cancelled by a reset meanwhile: the result belongs to the closed study and changes nothing visible.
      if (operation.status !== 'running') return;
      Object.assign(operation, { status: outcome.status, outcome: outcome.outcome, incidentRevision: outcome.incidentRevision, updatedAt: iso(this.#now()) });
    });
    return this.operation(request.leaseId, request.operationId)!;
  }
  /** Carries out an `incident.*` intent with the library's own call. `leaseEnd` bounds a plan token's life. */
  async incident(api: OperatorApi | null, request: BenchIntentRequest, leaseEnd: number): Promise<Outcome> {
    const incident = request.incident;
    if (!api) return { status: 'refused', outcome: 'gateway-not-running', incidentRevision: null };
    if (!incident) return { status: 'refused', outcome: 'not-applicable', incidentRevision: null };
    const { failureId, revision } = incident;
    switch (request.intent) {
      case 'incident.retry-current':
        try { return fromResult(await api.retryCurrent({ sourceId: SOURCE_ID, failureId, expectedRevision: revision, reason: 'Lab visitor' })); } catch (error) { return thrown(error); }
      case 'incident.reassess':
        try { return fromResult(await api.reassess({ sourceId: SOURCE_ID, failureId, expectedRevision: revision })); } catch (error) { return thrown(error); }
      case 'incident.evaluate': {
        let result;
        try { result = await api.evaluate({ failureId, expectedRevision: revision }); } catch (error) { return thrown(error, true); }
        // Refused before anything was evaluated: the incident or its generation moved on.
        if (result.errors[0]?.stage === 'request') return { status: 'refused', outcome: result.ineligibleReason ?? 'not-applicable', incidentRevision: null };
        if (this.#closed) return { status: 'cancelled', outcome: 'study-closed', incidentRevision: null };
        const plan = result.plan;
        const expiresAt = plan ? Math.min(Date.parse(plan.expiresAt), leaseEnd) : null;
        const planToken = plan && expiresAt! > this.#now() ? this.tokens.mint({ leaseId: request.leaseId, studyId: this.studyId, failureId, incidentRevision: revision, planId: plan.planId, fingerprint: plan.fingerprint, expiresAt: expiresAt! }) : null;
        this.#evaluation = { failureId, at: iso(this.#now()), incidentRevision: revision, validation: result.validation, eligible: result.eligible, ineligibleReason: result.ineligibleReason, errorClass: result.errors[0]?.failureClass ?? null, outputs: result.outputs.length, expiresAt: expiresAt === null ? null : iso(expiresAt), planToken };
        this.step('Evaluation requested');
        return { status: 'succeeded', outcome: 'evaluated', incidentRevision: revision };
      }
      case 'incident.approve-reprocess': {
        const plan = this.tokens.take(request.planToken ?? '', { leaseId: request.leaseId, studyId: this.studyId, failureId, incidentRevision: revision });
        if (typeof plan === 'string') return { status: 'refused', outcome: plan, incidentRevision: null };
        this.step('Reprocessing approved');
        let result;
        // The bench's own operation ID makes a re-sent approval return the library's recorded result instead of running twice.
        // The revision is the one the plan was evaluated at, never one the request carries.
        try { result = await api.redrive({ failureId, planId: plan.planId, planFingerprint: plan.fingerprint, expectedRevision: plan.incidentRevision, operationId: `lab${this.#number}.${this.studyId}.${request.operationId}` }); } catch (error) { return thrown(error); }
        if (!this.#closed) this.#reprocess = { failureId, at: iso(this.#now()), result: result.result, outcome: result.outcome };
        return fromResult(result);
      }
      default:
        return { status: 'refused', outcome: 'not-applicable', incidentRevision: null };
    }
  }
  /** The facts for `GET /bench/v1/incident`. Without an operator service (profile `off`, or the gateway restarting) there is no incident to report. */
  async facts(api: OperatorApi | null, base: { profile: BenchFailureProfile; app: BenchIncidentFacts['app'] }): Promise<BenchIncidentFacts> {
    const current = api ? await currentIncident(api) : null;
    const source = api ? (await api.status()).sources.find(item => item.sourceId === SOURCE_ID) : undefined;
    const incident = current ? benchIncident(current.detail, current.ordinal) : null;
    const evaluation = incident && this.#evaluation?.failureId === incident.failureId ? this.#evaluation : null;
    const live = evaluation ? this.tokens.current(incident!.failureId, evaluation.incidentRevision) : null;
    const reprocess = incident && this.#reprocess?.failureId === incident.failureId ? this.#reprocess : null;
    // Resynchronized: the leaseholder's first successful snapshot after the advance was confirmed.
    const advancedAt = incident?.progress === 'advanced' ? incident.history.findLast(event => event.event === 'advance-confirmed')?.at ?? null : null;
    const resynchronizedAt = advancedAt === null ? null : this.#snapshots.find(at => at >= advancedAt) ?? null;
    return {
      profile: base.profile, studyId: this.studyId, app: base.app, incident,
      circuit: source ? { state: source.circuit.state, recentIncidents: source.circuit.recentIncidents, limit: source.circuit.limit } : null,
      evaluation: evaluation ? { at: evaluation.at, incidentRevision: evaluation.incidentRevision, validation: evaluation.validation, eligible: evaluation.eligible, ineligibleReason: evaluation.ineligibleReason, errorClass: evaluation.errorClass, outputs: evaluation.outputs, expiresAt: evaluation.expiresAt, planToken: live?.token ?? null } : null,
      reprocess: reprocess ? { at: reprocess.at, result: reprocess.result, outcome: reprocess.outcome } : null,
      resynchronizedAt, steps: [...this.#steps]
    };
  }
}
