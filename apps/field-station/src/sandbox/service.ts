/**
 * The sandbox service: the only authority over its slots (LC11-ADR-04). Each slot
 * runs one study at a time on a SlotRuntime; every reset or return revokes the
 * study's previews first, then closes its runtime and opens a fresh one, so nothing
 * of an old study (previews, trace cursors, late results) reaches the next. A slot
 * whose cleanup fails stays `failed` and is never leased until a cleanup succeeds.
 *
 * Its API (sandbox:7620, Compose network only) answers only the field station, with
 * a per-service bearer token. The visitor-facing session, queue, and budget rules
 * are the field station's (leases.ts, routes.ts).
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isErrorCode, isPlainObject, PREVIEW_TOKEN_TTL_MS, streamError, utf8ByteLength, type Json, type ProjectConfig, type StreamError, type Trace } from 'streamotter/contracts';
import type { SandboxOperation, SandboxReproBundle, SandboxReproDownload, SandboxRequest, SandboxResponse, SandboxRuntime, SandboxServiceSlot, SandboxServiceStatus, SlotId } from './contract.ts';
import { validateCandidate, type EditableMaxima } from './editor.ts';
import { checkInput, DOWNLOAD_BYTES, HOST_CONTRACT, invalid, isSandboxOperation, SANDBOX_OPERATIONS, SandboxFault } from './operations.ts';

/** One study's synthetic project on one slot. W9a binds this to the published seam. */
export interface SlotRuntime {
  /** The slot's server-owned project: synthetic fixture sources, server-chosen IDs, handlers, and principal. */
  readonly base: ProjectConfig;
  /** The development principal previews use; the only one visitors may name. */
  readonly principalRef: string;
  /** Server maxima for the editable limits (contract §5). */
  readonly maxima: EditableMaxima;
  /** One management operation on this runtime's own gateway. */
  call<O extends SandboxOperation>(op: O, input: SandboxRequest<O>): Promise<SandboxResponse<O>>;
  /** Closes every preview connection of this study at once. */
  revoke(): Promise<void>;
  /** Stops the gateway and discards its state; throws when cleanup did not complete. */
  close(): Promise<void>;
}

/** Where slot runtimes come from, and the installed packages' identity. */
export interface SlotBackend {
  describe(): { available: true; runtime: SandboxRuntime; operations: readonly SandboxOperation[] } | { available: false; reason: 'seam-unavailable' };
  open(slot: SlotId): Promise<SlotRuntime>;
}

/**
 * The only production backend for streamotter@0.1.0-rc.3: it has no published
 * workbench seam (WHC-1 is defined, not released), so the sandbox reports
 * `seam-unavailable` and never emulates a runtime.
 */
export function publishedBackend(): SlotBackend {
  return { describe: () => ({ available: false, reason: 'seam-unavailable' }), open: async () => { throw new Error('No published workbench seam.'); } };
}

/** The service's settings. Production and other services' secrets are refused, as for Lab benches. */
export function sandboxEnvironment(env: NodeJS.ProcessEnv): { serviceToken: string; slots: SlotId[]; host: string; port: number } {
  for (const key of Object.keys(env)) {
    if (key.startsWith('FIELD_STATION_') || /^KAFKA_.*(PASSWORD|USERNAME)$/.test(key) || /^LAB_BENCH_\d+_(SERVICE|RELAY)_TOKEN$/.test(key)) throw new Error(`Production or Lab secret forbidden: ${key}`);
  }
  const serviceToken = env['SANDBOX_SERVICE_TOKEN'];
  if (!serviceToken || serviceToken.length < 32) throw new Error('SANDBOX_SERVICE_TOKEN needs 32 characters.');
  const count = Number(env['SANDBOX_SLOTS'] ?? 3);
  if (![1, 2, 3].includes(count)) throw new Error('SANDBOX_SLOTS must be 1, 2, or 3.');
  return { serviceToken, slots: Array.from({ length: count }, (_, i) => i + 1 as SlotId), host: env['SANDBOX_API_HOST'] ?? '0.0.0.0', port: Number(env['SANDBOX_API_PORT'] ?? 7620) };
}

interface Study { id: string; startedAt: number; cursors: Map<string, string | null>; previews: Set<string>; tokens: Set<string>; counts: Partial<Record<SandboxOperation, number>>; }
interface Slot {
  id: SlotId;
  state: SandboxServiceSlot['state'];
  runtime: SlotRuntime | null;
  /** A runtime whose cleanup failed; closed again before the slot is reused. */
  dirty: SlotRuntime | null;
  lease: { leaseId: string; expiresAt: number; claimed: boolean } | null;
  study: Study | null;
  tail: Promise<unknown>;
}
const CURSORS_PER_STUDY = 256;
const iso = (n: number): string => new Date(n).toISOString();
const PATHS = /(?:^|[\s"'=:(])(?:\/(?:etc|home|root|var|tmp|usr|opt|srv|mnt|run|proc|Users|private)\/|file:|[A-Za-z]:\\)/;

export class SandboxService {
  readonly bootId = randomUUID();
  readonly #backend: SlotBackend;
  readonly #token: string;
  readonly #now: () => number;
  readonly #slots = new Map<SlotId, Slot>();
  constructor(options: { backend: SlotBackend; slots: readonly SlotId[]; serviceToken: string; now?: () => number }) {
    this.#backend = options.backend; this.#token = options.serviceToken; this.#now = options.now ?? Date.now;
    for (const id of options.slots) this.#slots.set(id, { id, state: 'starting', runtime: null, dirty: null, lease: null, study: null, tail: Promise.resolve() });
  }
  #run<T>(slot: Slot, fn: () => Promise<T>): Promise<T> { const next = slot.tail.then(fn); slot.tail = next.catch(() => undefined); return next; }
  #slot(id: unknown): Slot { const slot = this.#slots.get(Number(id) as SlotId); if (!slot) throw invalid('Unknown slot.'); return slot; }
  /** Settles once every slot's queued lifecycle work has finished (tests and shutdown). */
  async settled(): Promise<void> { for (const slot of this.#slots.values()) await slot.tail; }

  async start(): Promise<void> { await Promise.all([...this.#slots.values()].map(slot => this.#run(slot, () => this.#clean(slot)))); }
  async close(): Promise<void> { await Promise.all([...this.#slots.values()].map(slot => this.#run(slot, async () => { slot.lease = null; slot.study = null; await this.#teardown(slot).catch(() => undefined); }))); }

  /** Revoke, then close; a failed close keeps the runtime as `dirty` and the slot `failed`. */
  async #teardown(slot: Slot): Promise<void> {
    const runtime = slot.runtime; slot.runtime = null;
    if (runtime) { slot.dirty = runtime; await runtime.revoke().catch(() => undefined); }
    if (slot.dirty) { await slot.dirty.close(); slot.dirty = null; }
  }
  /** Cleans the slot and opens a fresh runtime; `ready` only when both succeed. */
  async #clean(slot: Slot, next: 'ready' | 'leased' = 'ready'): Promise<void> {
    slot.state = 'resetting';
    try {
      await this.#teardown(slot);
      if (!this.#backend.describe().available) { slot.state = 'failed'; return; }
      slot.runtime = await this.#backend.open(slot.id); slot.state = slot.lease ? next : 'ready';
    } catch { slot.state = 'failed'; if (next === 'leased') { slot.lease = null; slot.study = null; } }
  }

  status(): SandboxServiceStatus {
    const described = this.#backend.describe();
    const slots = [...this.#slots.values()].map(slot => ({ slot: slot.id, state: slot.state, lease: slot.lease && slot.study ? { leaseId: slot.lease.leaseId, studyId: slot.study.id, expiresAt: iso(slot.lease.expiresAt), claimed: slot.lease.claimed } : null }));
    return described.available
      ? { bootId: this.bootId, availability: 'available', runtime: described.runtime, operations: SANDBOX_OPERATIONS.filter(op => described.operations.includes(op)), slots }
      : { bootId: this.bootId, availability: 'unavailable', reason: described.reason, runtime: null, operations: [], slots };
  }

  async lease(id: SlotId, input: { leaseId: string; studyId: string; expiresAt: string }): Promise<SandboxServiceStatus> {
    const slot = this.#slot(id); const expires = Date.parse(input.expiresAt);
    if (!/^[\w-]{1,80}$/.test(input.leaseId) || !/^[\w-]{1,80}$/.test(input.studyId) || !(expires > this.#now())) throw invalid('Invalid lease.');
    return this.#run(slot, async () => {
      if (slot.state !== 'ready' || !slot.runtime) throw new SandboxFault('slot-unavailable');
      slot.lease = { leaseId: input.leaseId, expiresAt: expires, claimed: false }; slot.study = this.#study(input.studyId); slot.state = 'leased';
      return this.status();
    });
  }
  #study(id: string): Study { return { id, startedAt: this.#now(), cursors: new Map(), previews: new Set(), tokens: new Set(), counts: {} }; }
  /** The slot's current study, only for its own lease and study. */
  #current(slot: Slot, leaseId: unknown, studyId: unknown): Study {
    if (!slot.lease || slot.lease.leaseId !== leaseId || slot.lease.expiresAt <= this.#now() || !slot.study) throw new SandboxFault('no-lease');
    if (slot.study.id !== studyId) throw new SandboxFault('stale-study');
    return slot.study;
  }
  claim(id: SlotId, input: { leaseId: unknown; studyId: unknown }): SandboxServiceStatus { const slot = this.#slot(id); this.#current(slot, input.leaseId, input.studyId); slot.lease!.claimed = true; return this.status(); }

  /** A new study on the same lease. The old study stops counting at once; cleanup follows in order. */
  reset(id: SlotId, input: { leaseId: unknown; studyId: unknown }): SandboxServiceStatus {
    const slot = this.#slot(id);
    if (!slot.lease || slot.lease.leaseId !== input.leaseId) throw new SandboxFault('no-lease');
    if (typeof input.studyId !== 'string' || !/^[\w-]{1,80}$/.test(input.studyId)) throw invalid('Invalid study.');
    if (slot.study?.id === input.studyId) return this.status();
    slot.study = this.#study(input.studyId); slot.state = 'resetting';
    void this.#run(slot, () => this.#clean(slot, 'leased'));
    return this.status();
  }
  /** Ends the lease. With `null`, the field station holds no lease on this slot: any lease here is reclaimed, and a failed slot's cleanup is retried. Idempotent. */
  return(id: SlotId, input: { leaseId: unknown }): SandboxServiceStatus {
    const slot = this.#slot(id);
    if (input.leaseId !== null && slot.lease && slot.lease.leaseId !== input.leaseId) throw new SandboxFault('no-lease');
    if (slot.state === 'resetting' && !slot.lease) return this.status();
    slot.lease = null; slot.study = null; slot.state = 'resetting';
    void this.#run(slot, () => this.#clean(slot));
    return this.status();
  }
  /** Ends leases past their end even if the field station never says so. */
  sweep(): void { for (const slot of this.#slots.values()) if (slot.lease && slot.lease.expiresAt <= this.#now()) this.return(slot.id, { leaseId: slot.lease.leaseId }); }

  /** One allowlisted operation in the current study. A result or failure that arrives after a reset or return is discarded as `stale-study`. */
  async operate(id: SlotId, request: { leaseId: unknown; studyId: unknown; op: unknown; input: unknown }): Promise<unknown> {
    const slot = this.#slot(id); const study = this.#current(slot, request.leaseId, request.studyId);
    if (!slot.lease!.claimed) throw new SandboxFault('no-lease');
    const op = request.op; const runtime = slot.runtime;
    if (!isSandboxOperation(op) || !this.status().operations.includes(op)) throw new SandboxFault('operation-not-allowed');
    if (slot.state !== 'leased' || !runtime) throw new SandboxFault('stale-study');
    const input = checkInput(op, request.input);
    study.counts[op] = (study.counts[op] ?? 0) + 1;
    // Closing the old study's runtime may fail its pending calls; that failure is the old study's, not the slot's.
    const stale = () => slot.study !== study || slot.runtime !== runtime ? new SandboxFault('stale-study', undefined, op === 'traces' ? { wbCode: 'TRACE_CURSOR_EXPIRED', wbStatus: 410 } : {}) : null;
    const result = await this.#execute(slot, study, runtime, op, input).catch((error: unknown) => { throw stale() ?? error; });
    const late = stale(); if (late) throw late;
    return result;
  }
  #source(runtime: SlotRuntime, sourceId: string, fixtureOnly = false): void {
    const source = Object.hasOwn(runtime.base.sources, sourceId) ? runtime.base.sources[sourceId] : undefined;
    if (!source || fixtureOnly && source.kind !== 'fixture') throw invalid('sourceId must be one of this sandbox\'s fixture sources.');
  }
  async #execute(slot: Slot, study: Study, runtime: SlotRuntime, op: SandboxOperation, input: unknown): Promise<unknown> {
    switch (op) {
      case 'config.validate': { const { valid, issues } = validateCandidate(runtime.base, (input as { config: unknown }).config, runtime.maxima); return { valid, issues }; }
      case 'config.export': {
        const { valid, issues, refused } = validateCandidate(runtime.base, (input as { config: unknown }).config, runtime.maxima);
        if (!valid) throw new SandboxFault(refused ? 'field-not-editable' : 'invalid-request', refused ? issues[0]!.message : 'The configuration is invalid and was not exported.', { wbCode: 'CONFIG_INVALID', details: { issues: issues.map(i => ({ path: i.path, code: i.code, message: i.message })) } });
        const result = await runtime.call('config.export', input as SandboxRequest<'config.export'>);
        this.#download(slot, study, result.content);
        return result;
      }
      case 'source-checks': this.#source(runtime, (input as { sourceId: string }).sourceId); break;
      case 'sources.resume': case 'dev.fixtures.advance': this.#source(runtime, (input as { sourceId: string }).sourceId, true); break;
      case 'preview-sessions': {
        if ((input as { fixturePrincipalRef: string }).fixturePrincipalRef !== runtime.principalRef) throw invalid('Only this sandbox\'s own principal can preview.');
        const session = await runtime.call('preview-sessions', input as SandboxRequest<'preview-sessions'>);
        study.previews.add(session.previewSessionId); study.tokens.add(session.token);
        const end = Math.min(Date.parse(session.expiresAt) || this.#now() + PREVIEW_TOKEN_TTL_MS, slot.lease?.expiresAt ?? this.#now());
        return { ...session, expiresAt: iso(end) };
      }
      case 'dev.disconnect': {
        const previewSessionId = (input as { previewSessionId: string }).previewSessionId;
        if (!study.previews.has(previewSessionId)) throw invalid('previewSessionId was not minted in this study.');
        const result = await runtime.call('dev.disconnect', { previewSessionId }); study.previews.delete(previewSessionId); return result;
      }
      case 'dev.principals': { const result = await runtime.call('dev.principals', null); return { items: result.items.filter(item => item.ref === runtime.principalRef) }; }
      case 'traces': {
        const { cursor, ...rest } = input as SandboxRequest<'traces'>;
        if (rest.sourceId !== undefined) this.#source(runtime, rest.sourceId);
        if (rest.channel !== undefined && !Object.hasOwn(runtime.base.channels, rest.channel)) throw invalid('channel must be one of this sandbox\'s channels.');
        let native: string | null | undefined;
        if (cursor !== undefined) { native = study.cursors.get(cursor); if (native === undefined) throw new SandboxFault('stale-study', 'The trace cursor is not from this study.', { wbCode: 'TRACE_CURSOR_EXPIRED', wbStatus: 410 }); }
        const page = await runtime.call('traces', { ...rest, ...(native ? { cursor: native } : {}) });
        let nextCursor: string | null = null;
        if (page.nextCursor !== null) { nextCursor = randomUUID(); study.cursors.set(nextCursor, page.nextCursor); if (study.cursors.size > CURSORS_PER_STUDY) study.cursors.delete(study.cursors.keys().next().value!); }
        return { items: page.items, nextCursor };
      }
      default: break;
    }
    return runtime.call(op, input as SandboxRequest<typeof op>);
  }
  /** Downloads carry only this study's data: capped, and withheld if they contain a secret or a host path. */
  #download(slot: Slot, study: Study, content: string): void {
    if (utf8ByteLength(content) > DOWNLOAD_BYTES) throw new SandboxFault('candidate-too-large', 'The download exceeds 256 KB.');
    const secrets = [this.#token, ...study.tokens, ...(slot.lease ? [slot.lease.leaseId] : [])];
    if (PATHS.test(content) || secrets.some(secret => secret && content.includes(secret))) throw new SandboxFault('invalid-request', 'The download was withheld because it contained private material.', { wbCode: 'INTERNAL', wbStatus: 500 });
  }

  /** The Lontra reproduction bundle: this study's metadata only (contract §7). */
  async repro(id: SlotId, request: { leaseId: unknown; studyId: unknown }): Promise<SandboxReproDownload> {
    const slot = this.#slot(id); const study = this.#current(slot, request.leaseId, request.studyId); const runtime = slot.runtime;
    const described = this.#backend.describe();
    if (!slot.lease!.claimed || !runtime || !described.available || slot.state !== 'leased') throw new SandboxFault('no-lease');
    // At most 500 traces, oldest first; more is flagged rather than fetched.
    const traces: SandboxReproBundle['traces'] = []; let unavailable = false; let truncated = false;
    try {
      let cursor: string | undefined;
      for (let i = 0; ; i++) {
        const page = await runtime.call('traces', { limit: 100, ...(cursor ? { cursor } : {}) });
        if (i === 5) { truncated = page.items.length > 0; break; }
        for (const t of page.items as readonly Trace[]) traces.push({ at: t.at, stage: t.stage, outcome: t.outcome, ...(t.sourceId ? { sourceId: t.sourceId } : {}), ...(t.channel ? { channel: t.channel } : {}), ...(t.errorCode ? { errorCode: t.errorCode } : {}) });
        if (!page.nextCursor || page.items.length < 100) break; cursor = page.nextCursor;
      }
    } catch { unavailable = true; }
    if (slot.study !== study || slot.runtime !== runtime) throw new SandboxFault('stale-study');
    const base = runtime.base;
    const bundle: SandboxReproBundle = {
      format: 'lontra-creek.sandbox-repro', formatVersion: 1, generatedAt: iso(this.#now()), mode: described.runtime.mode, packages: described.runtime.packages,
      contractVersion: described.runtime.contractVersion, hostContract: HOST_CONTRACT,
      scenario: { projectId: base.projectId, channels: Object.entries(base.channels).map(([name, channel]) => ({ name, version: channel.version })), sources: Object.entries(base.sources).map(([sourceId, source]) => ({ sourceId, kind: source.kind })) },
      study: { startedAt: iso(study.startedAt), operations: { ...study.counts } }, traces, gaps: { tracesTruncated: truncated, tracesUnavailable: unavailable }
    };
    let content = JSON.stringify(bundle, null, 2);
    while (utf8ByteLength(content) > DOWNLOAD_BYTES && bundle.traces.length) { bundle.traces.splice(0, Math.max(1, Math.ceil(bundle.traces.length / 4))); bundle.gaps.tracesTruncated = true; content = JSON.stringify(bundle, null, 2); }
    this.#download(slot, study, content);
    return { filename: 'lontra-creek-sandbox-repro.json', content };
  }

  /** The private API, as one function so tests can call it without a socket. */
  async dispatch(method: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    try {
      if (method === 'GET' && path === '/sandbox/v1/status') return { status: 200, body: this.status() };
      const match = /^\/sandbox\/v1\/slots\/(\d)\/(lease|claim|reset|return|ops|repro)$/.exec(path);
      if (!match) return { status: 404, body: { error: 'Not found.' } };
      const slot = Number(match[1]) as SlotId; const action = match[2]!;
      if (action === 'lease' && method === 'PUT') {
        if (typeof body['leaseId'] !== 'string' || typeof body['studyId'] !== 'string' || typeof body['expiresAt'] !== 'string') throw invalid('Invalid lease.');
        return { status: 200, body: await this.lease(slot, { leaseId: body['leaseId'], studyId: body['studyId'], expiresAt: body['expiresAt'] }) };
      }
      if (method !== 'POST') return { status: 404, body: { error: 'Not found.' } };
      if (action === 'claim') return { status: 200, body: this.claim(slot, { leaseId: body['leaseId'], studyId: body['studyId'] }) };
      if (action === 'reset') return { status: 202, body: this.reset(slot, { leaseId: body['leaseId'], studyId: body['studyId'] }) };
      if (action === 'return') return { status: 202, body: this.return(slot, { leaseId: body['leaseId'] ?? null }) };
      if (action === 'repro') return { status: 200, body: await this.repro(slot, { leaseId: body['leaseId'], studyId: body['studyId'] }) };
      return { status: 200, body: { ok: true, data: await this.operate(slot, { leaseId: body['leaseId'], studyId: body['studyId'], op: body['op'], input: body['input'] ?? null }) } };
    } catch (error) {
      const wb = path.endsWith('/ops');
      if (error instanceof SandboxFault) return { status: wb ? error.wbStatus : error.status, body: wb ? { ok: false, error: error.stream('') } : { error: error.message, code: error.code } };
      const native = nativeError(error);
      if (wb && native) return { status: native.status, body: { ok: false, error: native.error } };
      return { status: wb ? 503 : 500, body: wb ? { ok: false, error: new SandboxFault('slot-unavailable').stream('') } : { error: 'Sandbox operation failed.', code: 'slot-unavailable' } };
    }
  }

  api(): Server {
    const expected = Buffer.from(`Bearer ${this.#token}`);
    return createServer(async (request, response) => {
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
      const url = new URL(request.url ?? '/', 'http://sandbox.invalid');
      if (url.pathname === '/healthz') return send(200, { availability: this.status().availability });
      const provided = Buffer.from(request.headers.authorization ?? '');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return send(401, { error: 'Unauthorized.' });
      try {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 73_728) return send(413, { error: 'Too large.', code: 'candidate-too-large' }); chunks.push(chunk as Buffer); }
        const value: unknown = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!isPlainObject(value)) return send(400, { error: 'Invalid request.', code: 'invalid-request' });
        const result = await this.dispatch(request.method ?? 'GET', url.pathname, value);
        send(result.status, result.body);
      } catch { if (!response.headersSent) send(400, { error: 'Invalid request.', code: 'invalid-request' }); }
    });
  }
}

const NATIVE_STATUS: Partial<Record<string, number>> = { INVALID_REQUEST: 400, INVALID_PARAMS: 400, CONFIG_INVALID: 400, UNSUPPORTED_CAPABILITY: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, CHANNEL_NOT_FOUND: 404, TRACE_CURSOR_EXPIRED: 410, OVERLOADED: 429, SOURCE_UNAVAILABLE: 503, TIMEOUT: 504 };
/** A StreamOtter error from the slot's own management service, passed through with only its public fields. */
function nativeError(error: unknown): { status: number; error: StreamError } | null {
  if (!isPlainObject(error) && !(error instanceof Error)) return null;
  const e = error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
  if (!isErrorCode(e.code) || e.code === 'INTERNAL') return null;
  const details = isPlainObject(e.details) && e.details['issues'] !== undefined ? { issues: e.details['issues'] as Json } : undefined;
  return { status: NATIVE_STATUS[e.code] ?? 500, error: streamError(e.code, { message: typeof e.message === 'string' ? e.message.slice(0, 300) : e.code, ...(typeof e.retryable === 'boolean' ? { retryable: e.retryable } : {}), ...(details ? { details } : {}) }) };
}
