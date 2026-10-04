/**
 * A design fixture for the sandbox session layer: an in-memory SlotBackend whose
 * runtimes answer the allowlisted operations with rc.3 management shapes. It is for
 * tests only. Nothing under src/ imports it, and sandbox-main.ts constructs only the
 * published backend, so no production configuration can select it.
 */
import { CAPABILITIES, canonicalJsonPretty, StreamOtterError, type ProjectConfig, type Trace } from 'streamotter/contracts';
import type { SandboxOperation, SandboxRequest, SandboxResponse, SlotId } from '../../src/sandbox/contract.ts';
import type { SlotBackend, SlotRuntime } from '../../src/sandbox/service.ts';

export function fixtureBase(slot: SlotId): ProjectConfig {
  const string = { type: 'string', minLength: 1, maxLength: 64 } as const;
  return {
    configVersion: 1, projectId: `lontra-creek-sandbox-${slot}`,
    gateway: { host: '0.0.0.0', port: 7600 + slot * 10, path: `/sandbox/${slot}/socket.io`, allowedOrigins: ['https://streamotter.app'] },
    connections: {},
    sources: { creek: { kind: 'fixture', generation: 'creek-1', fixtureRef: 'creek' }, jobs: { kind: 'fixture', generation: 'jobs-1', fixtureRef: 'jobs' } },
    schemas: {
      stationParams: { type: 'object', properties: { stationId: string }, required: ['stationId'], additionalProperties: false },
      station: { type: 'object', properties: { stage: { type: 'number', minimum: 0, maximum: 10 } }, required: ['stage'], additionalProperties: false },
      jobParams: { type: 'object', properties: { jobId: string }, required: ['jobId'], additionalProperties: false },
      jobProgress: { type: 'object', properties: { percent: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['percent'], additionalProperties: false }
    },
    channels: {
      station: { version: 1, source: 'creek', paramsSchema: 'stationParams', payloadSchema: 'station', handlersRef: 'station', delivery: { kind: 'state', overflow: 'resync' } },
      jobProgress: { version: 1, source: 'jobs', paramsSchema: 'jobParams', payloadSchema: 'jobProgress', handlersRef: 'jobProgress', delivery: { kind: 'state', overflow: 'resync' } }
    },
    limits: { maxConnections: 4, maxSubscriptionsPerConnection: 8 }
  };
}

export const FIXTURE_RUNTIME = { packages: { streamotter: '0.1.0-rc.3', workbench: '0.1.0-rc.3' }, mode: 'synthetic-fixture', contractVersion: null } as const;

export class FixtureRuntime implements SlotRuntime {
  readonly base: ProjectConfig;
  readonly principalRef = 'visitor';
  readonly maxima = { receiptTimeoutMs: 10_000, maxSubscriptionsPerConnection: 8, maxPendingFramesPerSubscription: 100 };
  readonly slot: SlotId;
  readonly traces: Trace[] = [];
  readonly previews = new Map<string, string>();
  readonly calls: { op: SandboxOperation; input: unknown }[] = [];
  revoked = 0;
  closed = false;
  /** Set to hold the next call until released, to test late answers. */
  hold: { release: () => void } | null = null;
  holdNext = false;
  #fail: ((error: unknown) => void) | null = null;
  /** Overrides the export content, to test the download guard. */
  exportContent: string | null = null;
  readonly #backend: FixtureBackend;
  #n = 0;
  constructor(backend: FixtureBackend, slot: SlotId) { this.#backend = backend; this.slot = slot; this.base = fixtureBase(slot); }
  #trace(fields: Partial<Trace>): void { this.traces.push({ id: `t${++this.#n}`, requestId: `req-${this.slot}-${this.#n}`, at: new Date(this.#backend.now()).toISOString(), stage: 'source', outcome: 'ok', ...fields }); }
  async call<O extends SandboxOperation>(op: O, input: SandboxRequest<O>): Promise<SandboxResponse<O>> {
    if (this.closed) throw new Error('Runtime closed.');
    this.calls.push({ op, input });
    if (this.holdNext) { this.holdNext = false; await new Promise<void>((release, fail) => { this.hold = { release }; this.#fail = fail; }); }
    const sources = Object.entries(this.base.sources).map(([sourceId, s]) => ({ sourceId, kind: s.kind, status: 'healthy' as const }));
    const answer = ((): unknown => {
      switch (op as SandboxOperation) {
        case 'capabilities': return CAPABILITIES;
        case 'health': return { ready: true, sources };
        case 'sources': return { items: sources };
        case 'channels': return { items: Object.entries(this.base.channels).map(([name, c]) => ({ name, version: c.version, source: c.source, delivery: 'state', paramsSchema: c.paramsSchema, payloadSchema: c.payloadSchema })) };
        case 'config': return { config: this.base, fingerprint: `fixture-${this.slot}` };
        case 'config.validate': return { valid: true, issues: [] };
        case 'config.export': { const { config } = input as { config: unknown }; return { filename: 'streamotter.json', content: this.exportContent ?? canonicalJsonPretty(config), fingerprint: 'fixture' }; }
        case 'source-checks': return { steps: [{ stage: 'resolve', outcome: 'skipped', message: 'Fixture sources need no broker.' }] };
        case 'sources.resume': return sources.find(s => s.sourceId === (input as { sourceId: string }).sourceId);
        case 'preview-sessions': { const id = `preview-${this.slot}-${++this.#n}`; const token = `sop_fixture_${this.slot}_${this.#n}_secret`; this.previews.set(id, token); return { token, expiresAt: new Date(this.#backend.now() + 300_000).toISOString(), previewSessionId: id }; }
        case 'dev.principals': return { items: [{ ref: 'visitor', tenantId: 'lontra', subject: 'visitor' }, { ref: 'operator-only', tenantId: 'lontra', subject: 'operator' }] };
        case 'dev.fixtures.advance': { const { sourceId, count } = input as { sourceId: string; count: number }; for (let i = 0; i < count; i++) this.#trace({ sourceId, stage: 'map', channel: sourceId === 'creek' ? 'station' : 'jobProgress', subscriptionId: `sub-${this.slot}` }); return { advanced: count }; }
        case 'dev.disconnect': { const { previewSessionId } = input as { previewSessionId: string }; if (!this.previews.delete(previewSessionId)) throw new StreamOtterError('INVALID_REQUEST', { message: 'Unknown preview session.' }); return null; }
        case 'traces': {
          const { limit = 100, cursor } = input as { limit?: number; cursor?: string }; const start = cursor ? Number(cursor) : 0;
          const items = this.traces.slice(start, start + limit); const end = start + items.length;
          return { items, nextCursor: end < this.traces.length || items.length ? String(end) : null };
        }
      }
    })();
    return answer as SandboxResponse<O>;
  }
  async revoke(): Promise<void> { this.revoked++; this.previews.clear(); }
  async close(): Promise<void> { if (this.#backend.failClose > 0) { this.#backend.failClose--; throw new Error('Cleanup failed.'); } this.closed = true; if (this.#backend.failPending !== null) this.#fail?.(this.#backend.failPending); }
}

export class FixtureBackend implements SlotBackend {
  readonly opened: FixtureRuntime[] = [];
  failClose = 0;
  failOpen = 0;
  /** When set, closing a runtime fails its held call with this error, as a real gateway's pending calls fail when it stops. */
  failPending: unknown = null;
  /** While set, opening a runtime waits for it, to observe a slot mid-reset. */
  gate: Promise<void> | null = null;
  operations: readonly SandboxOperation[] | null = null;
  readonly now: () => number;
  constructor(now: () => number) { this.now = now; }
  describe() { return { available: true as const, runtime: structuredClone(FIXTURE_RUNTIME) as { packages: { streamotter: string; workbench: string }; mode: 'synthetic-fixture'; contractVersion: null }, operations: this.operations ?? ['capabilities', 'health', 'sources', 'channels', 'config', 'config.validate', 'config.export', 'traces', 'source-checks', 'sources.resume', 'preview-sessions', 'dev.principals', 'dev.fixtures.advance', 'dev.disconnect'] as const }; }
  async open(slot: SlotId): Promise<FixtureRuntime> { if (this.gate) await this.gate; if (this.failOpen > 0) { this.failOpen--; throw new Error('Open failed.'); } const runtime = new FixtureRuntime(this, slot); this.opened.push(runtime); return runtime; }
  /** The live runtime of a slot (the latest opened and not closed). */
  current(slot: SlotId): FixtureRuntime { return this.opened.filter(r => r.slot === slot && !r.closed).at(-1)!; }
}
