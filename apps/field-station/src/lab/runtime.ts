import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { TENANT_ID } from '@lontra-creek/sim';
import { createGateway } from 'streamotter/gateway';
import { startManagementServer } from 'streamotter/gateway/management';
import type { Gateway, Principal, SourceStatus, Trace, Page } from 'streamotter/contracts';
import { io, type Socket } from 'socket.io-client';
import { Kafka } from 'kafkajs';
import { readFileSync } from 'node:fs';
import { benchConfig, benchHandlers, benchEnvironment } from './bench.ts';
import type { BenchStatus, LabAction, LabBenchState } from './contract.ts';
import { LabFeed } from './feed.ts';
import { ACTIONS, LabError } from './errors.ts';
export function requireNoDevelopmentPrincipals(items: readonly unknown[]): void {
  if (items.length !== 0) throw new Error('Development principals are forbidden.');
}
export class BenchRuntime {
  readonly #env: NodeJS.ProcessEnv;
  readonly #settings: ReturnType<typeof benchEnvironment>;
  readonly #feed = new LabFeed();
  readonly #tokens = new Set<string>();
  readonly #satelliteIds = new Set<string>();
  #lease: { leaseId: string; expiresAt: string } | null = null;
  #state: BenchStatus['state'] = 'starting';
  #scenario: LabBenchState = { gateway: 'restarting', source: { status: 'starting' }, relay: 'up', calibration: 'present', satellite: 'idle', receiptTimeoutMs: 5000 };
  #gateway: Gateway | undefined;
  #management: Awaited<ReturnType<typeof startManagementServer>> | undefined;
  #managementToken = randomBytes(32).toString('base64url');
  #traceCursor: string | null = null;
  #group = `lab-${randomUUID()}`;
  #satellite: Socket | undefined;
  #nextAction = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #timer?: NodeJS.Timeout;
  #principalCount = -1;
  constructor(env: NodeJS.ProcessEnv) { this.#env = env; this.#settings = benchEnvironment(env); }
  run<T>(fn: () => Promise<T>): Promise<T> { const p = this.#tail.then(fn); this.#tail = p.catch(() => undefined); return p; }
  status(): BenchStatus { return { bench: this.#settings.number, state: this.#state, lease: this.#lease, scenario: structuredClone(this.#scenario), checks: { developmentPrincipals: this.#principalCount, fixtureSources: 0, managementHost: '127.0.0.1' } }; }
  authenticate(token: string): Principal | null { const lease = this.#lease; if (!lease || Date.parse(lease.expiresAt) <= Date.now() || !this.#tokens.has(token)) return null; return { tenantId: TENANT_ID, subject: `lab-${lease.leaseId}`, sessionId: lease.leaseId, expiresAt: lease.expiresAt, claims: { role: 'volunteer', bench: this.#settings.number } }; }
  async #managementCall<T>(path: string): Promise<T> {
    if (!this.#management) throw new Error('Management unavailable.');
    const response = await fetch(`${this.#management.origin}/management/v1/${path}`, {
      headers: { authorization: `Bearer ${this.#managementToken}` }, signal: AbortSignal.timeout(3000)
    });
    const envelope = await response.json() as { ok: boolean; data: T; error?: { code?: string } };
    if (!response.ok || !envelope.ok) {
      if (path.startsWith('traces?') && this.#traceCursor && envelope.error?.code === 'TRACE_CURSOR_EXPIRED') {
        this.#traceCursor = null;
        this.#feed.add({ kind: 'bench', event: 'gap' });
        return this.#managementCall<T>('traces?limit=500');
      }
      throw new Error('Management request failed.');
    }
    return envelope.data;
  }
  async #relay(cut: boolean): Promise<void> { const origin = this.#env['LAB_RELAY_ORIGIN'] ?? `http://lab-${this.#settings.number}-kafka:9180`; const response = await fetch(`${origin}/${cut ? 'cut' : 'restore'}`, { method: 'POST', headers: { authorization: `Bearer ${this.#settings.relayToken}` }, signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error('Relay unavailable.'); this.#scenario.relay = cut ? 'cut' : 'up'; }
  #config() { return benchConfig(this.#settings.number, { host: this.#env['BENCH_HOST'] ?? '0.0.0.0', port: Number(this.#env['BENCH_PORT'] ?? 7400), brokers: (this.#env['BENCH_KAFKA_BROKERS'] ?? `lab-${this.#settings.number}-kafka:${9100 + this.#settings.number}`).split(','), caFile: this.#env['KAFKA_CA_FILE'] ?? '/etc/lontra/kafka/ca.pem', consumerGroup: this.#group, allowedOrigins: (this.#env['SITE_ORIGIN'] ?? 'https://streamotter.app').split(',') }); }
  async #startGateway(): Promise<void> {
    const config = this.#config();
    const handlers = benchHandlers(this.#settings.number, { authenticate: token => this.authenticate(token), serviceToken: this.#settings.serviceToken, snapshotOrigin: this.#settings.snapshotOrigin, calibration: () => this.#scenario.calibration === 'present', record: item => this.#feed.add(item) });
    // Validate the exact same config under production rules before development enables traces.
    createGateway({ config, handlers, mode: 'production' });
    const gateway = createGateway({ config, handlers, mode: 'development' }); this.#gateway = gateway;
    await gateway.start();
    this.#management = await startManagementServer({ gateway, host: '127.0.0.1', port: Number(this.#env['BENCH_MANAGEMENT_PORT'] ?? 7401), token: this.#managementToken, workbenchDir: null });
    const principals = await this.#managementCall<{ items: unknown[] }>('dev/principals'); this.#principalCount = principals.items.length;
    requireNoDevelopmentPrincipals(principals.items);
    this.#traceCursor = null; this.#scenario.gateway = 'running';
    await this.#poll(false);
    if (this.#scenario.source.status !== 'healthy') throw new Error('Bench source did not become healthy.');
  }
  async #stopGateway(): Promise<void> { this.#scenario.gateway = 'restarting'; this.#satellite?.disconnect(); this.#satellite = undefined; this.#scenario.satellite = 'idle'; await this.#management?.close(); this.#management = undefined; await this.#gateway?.stop(); this.#gateway = undefined; }
  async #deleteGroup(group: string): Promise<void> { const config = this.#config(); const connection = config.connections['field']!; const kafka = new Kafka({ brokers: [...connection.brokers], ssl: { ca: [readFileSync(this.#env['KAFKA_CA_FILE'] ?? '/etc/lontra/kafka/ca.pem', 'utf8')] }, sasl: { mechanism: 'scram-sha-512', username: this.#env['KAFKA_LAB_USERNAME']!, password: this.#env['KAFKA_LAB_PASSWORD']! }, logLevel: 0 }); const admin = kafka.admin(); try { await admin.connect(); await admin.deleteGroups([group]); } finally { await admin.disconnect(); } }
  async start(): Promise<void> { await this.#relay(false); await this.#startGateway(); this.#state = 'ready'; this.#timer = setInterval(() => { void this.run(async () => { if (this.#lease && Date.parse(this.#lease.expiresAt) <= Date.now()) await this.reset(); else await this.#poll(true); }).catch(() => { this.#state = 'failed'; }); }, 1000); }
  async close(): Promise<void> { clearInterval(this.#timer); await this.run(() => this.#stopGateway()); }
  async #poll(record: boolean): Promise<void> {
    const sources = await this.#managementCall<{ items: SourceStatus[] }>('sources'); const source = sources.items.find(s => s.sourceId === 'field');
    if (source) { const next = { status: source.status, ...(source.reason ? { reason: source.reason } : {}) }; if (record && JSON.stringify(next) !== JSON.stringify(this.#scenario.source)) this.#feed.add({ kind: 'source', sourceId: 'field', ...next }); this.#scenario.source = next; }
    // Drain bounded management pages, retaining the last cursor even on an empty page.
    for (let i = 0; i < 20; i++) { const traces = await this.#managementCall<Page<Trace>>(`traces?limit=500${this.#traceCursor ? `&cursor=${encodeURIComponent(this.#traceCursor)}` : ''}`); for (const trace of traces.items) if (record && this.#lease) this.#feed.trace(trace, this.#satelliteIds); if (traces.nextCursor) this.#traceCursor = traces.nextCursor; if (traces.items.length < 500) break; }
  }
  async lease(leaseId: string, expiresAt: string): Promise<void> { if (this.#state !== 'ready') throw new LabError('not-applicable', 409); if (!/^[\w-]{1,80}$/.test(leaseId) || !(Date.parse(expiresAt) > Date.now()) || Date.parse(expiresAt) > Date.now() + 300_000) throw new LabError('invalid-request', 400); await this.#poll(false); this.#lease = { leaseId, expiresAt }; this.#feed.reset(leaseId); this.#satelliteIds.clear(); this.#state = 'leased'; this.#nextAction = 0; this.#feed.add({ kind: 'bench', event: 'lease-started' }); }
  #check(leaseId: unknown): void { if (!this.#lease || leaseId !== this.#lease.leaseId || Date.parse(this.#lease.expiresAt) <= Date.now()) throw new LabError('no-lease', 409); }
  token(leaseId: unknown): { token: string; expiresAt: string } { this.#check(leaseId); const token = `lab${this.#settings.number}_${randomBytes(32).toString('base64url')}`; if (this.#tokens.size >= 128) return { token: [...this.#tokens][0]!, expiresAt: this.#lease!.expiresAt }; this.#tokens.add(token); return { token, expiresAt: this.#lease!.expiresAt }; }
  feed(leaseId: unknown, after?: string, limit?: number) { this.#check(leaseId); return this.#feed.page(after, limit); }
  async reset(): Promise<void> {
    const lease = this.#lease; this.#lease = null; this.#tokens.clear(); this.#state = 'resetting';
    if (lease) await this.#gateway?.revoke({ kind: 'subject', tenantId: TENANT_ID, subject: `lab-${lease.leaseId}` });
    this.#satellite?.disconnect(); this.#scenario.calibration = 'present'; await this.#relay(false); await this.#stopGateway();
    const previous = this.#group; this.#group = `lab-${this.#settings.number}-${randomUUID()}`;
    try { await this.#startGateway(); await this.#deleteGroup(previous); this.#feed.reset(); this.#state = 'ready'; } catch { this.#state = 'failed'; throw new Error('Bench reset failed.'); }
  }
  async action(leaseId: unknown, action: LabAction): Promise<{ at: string; scenario: LabBenchState }> {
    this.#check(leaseId); if (Date.now() < this.#nextAction) throw new LabError('too-many-actions', 429);
    const s = this.#scenario;
    const allowed = action === 'sensor.foul' ? s.calibration === 'present' : action === 'sensor.restore' ? s.calibration === 'removed' : action === 'source.resume' ? s.source.status === 'paused' : action === 'relay.cut' ? s.relay === 'up' && s.gateway === 'running' : action === 'relay.restore' ? s.relay === 'cut' : action === 'satellite.start' ? s.satellite === 'idle' && s.source.status === 'healthy' && s.gateway === 'running' : action === 'gateway.restart' && s.gateway === 'running' && s.relay === 'up';
    if (!allowed || s.gateway !== 'running') throw new LabError('not-applicable', 409);
    this.#nextAction = Date.now() + 1000;
    if (action === 'sensor.foul') s.calibration = 'removed';
    if (action === 'sensor.restore') s.calibration = 'present';
    if (action === 'source.resume') await this.#gateway!.resumeSource('field');
    if (action === 'relay.cut' || action === 'relay.restore') await this.#relay(action === 'relay.cut');
    if (action === 'gateway.restart') {
      // Return the restarting state promptly. Starting a Kafka gateway can take
      // 30 seconds; keeping that outside the public lease coordinator's lock
      // prevents a restart from starving other visitors' heartbeats.
      s.gateway = 'restarting';
      void this.run(async () => {
        await this.#poll(true); await this.#stopGateway(); this.#feed.add({ kind: 'bench', event: 'gateway-stopped' });
        await this.#startGateway(); this.#feed.add({ kind: 'bench', event: 'gateway-started' }); this.#feed.add({ kind: 'bench', event: 'gap' });
      }).catch(() => { this.#state = 'failed'; });
    }
    if (action === 'satellite.start') {
      const config = this.#config(); const token = this.token(leaseId).token;
      const socket = io(`http://127.0.0.1:${config.gateway.port}`, { path: config.gateway.path, transports: ['websocket'], auth: { token, protocolVersion: 1 }, extraHeaders: { Origin: config.gateway.allowedOrigins[0]! }, reconnection: false }); this.#satellite = socket; s.satellite = 'connected';
      socket.on('so:hello', () => { this.#feed.add({ kind: 'bench', event: 'satellite-connected' }); socket.emit('so:subscribe', { requestId: randomUUID(), subscriptionId: randomUUID(), channel: 'station', channelVersion: 1, params: { stationId: 'LC-02' } }, (result: { ok: boolean; data?: { subscriptionId: string } }) => { if (result.ok && result.data) this.#satelliteIds.add(result.data.subscriptionId); }); });
      socket.on('so:state', (state: { subscriptionId: string }) => this.#satelliteIds.add(state.subscriptionId));
      socket.on('disconnect', () => { s.satellite = 'idle'; this.#feed.add({ kind: 'bench', event: 'satellite-disconnected' }); });
      socket.on('connect_error', () => { s.satellite = 'idle'; socket.disconnect(); });
      // Deliberately no so:receipt handler: the gateway disconnects this one client.
    }
    this.#feed.add({ kind: 'action', action }); return { at: new Date().toISOString(), scenario: structuredClone(s) };
  }
  api(): Server {
    const expected = Buffer.from(`Bearer ${this.#settings.serviceToken}`);
    return createServer(async (request, response) => {
      const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
      const url = new URL(request.url ?? '/', 'http://bench.invalid');
      if (url.pathname === '/healthz') return send(this.#state === 'ready' || this.#state === 'leased' ? 200 : 503, { state: this.#state });
      const provided = Buffer.from(request.headers.authorization ?? '');
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return send(401, { error: 'Unauthorized.' });
      if (request.method === 'GET' && url.pathname === '/bench/v1/status') return send(200, this.status());
      try {
        let text = ''; for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 4096) throw new LabError('invalid-request', 400); }
        const body = text ? JSON.parse(text) as Record<string, unknown> : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LabError('invalid-request', 400);
        if (request.method === 'POST' && url.pathname === '/bench/v1/actions' && this.#scenario.gateway === 'restarting') throw new LabError('not-applicable', 409);
        if (request.method === 'POST' && url.pathname === '/bench/v1/reset') {
          if (body['leaseId'] !== null) this.#check(body['leaseId']);
          if (this.#state !== 'resetting') {
            const previous = this.#lease;
            this.#lease = null; this.#tokens.clear(); this.#state = 'resetting';
            // Invalidate immediately, even when the gateway lifecycle queue is
            // busy restarting. Teardown itself remains serialized.
            if (previous) void this.#gateway?.revoke({ kind: 'subject', tenantId: TENANT_ID, subject: `lab-${previous.leaseId}` }).catch(() => undefined);
            void this.run(() => this.reset()).catch(() => { this.#state = 'failed'; });
          }
          return send(202, this.status());
        }
        // Read-only feed and token renewal must remain available while Kafka
        // rejoins during a gateway restart. Both validate the current lease
        // synchronously before touching lease-owned data.
        if (request.method === 'POST' && url.pathname === '/bench/v1/tokens') return send(200, this.token(body['leaseId']));
        if (request.method === 'GET' && url.pathname === '/bench/v1/feed') {
          const limit = Number(url.searchParams.get('limit') ?? 100);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new LabError('invalid-request', 400);
          return send(200, this.feed(url.searchParams.get('leaseId'), url.searchParams.get('after') ?? undefined, limit));
        }
        await this.run(async () => {
          if (request.method === 'GET' && url.pathname === '/bench/v1/status') return send(200, this.status());
          if (request.method === 'PUT' && url.pathname === '/bench/v1/lease') { if (typeof body['leaseId'] !== 'string' || typeof body['expiresAt'] !== 'string') throw new LabError('invalid-request', 400); await this.lease(body['leaseId'], body['expiresAt']); return send(200, this.status()); }
          if (request.method === 'POST' && url.pathname === '/bench/v1/tokens') return send(200, this.token(body['leaseId']));
          if (request.method === 'GET' && url.pathname === '/bench/v1/feed') { const limit = Number(url.searchParams.get('limit') ?? 100); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new LabError('invalid-request', 400); return send(200, this.feed(url.searchParams.get('leaseId'), url.searchParams.get('after') ?? undefined, limit)); }
          if (request.method === 'POST' && url.pathname === '/bench/v1/actions') { if (!ACTIONS.includes(body['action'] as LabAction)) throw new LabError('invalid-request', 400); return send(200, await this.action(body['leaseId'], body['action'] as LabAction)); }
          if (request.method === 'POST' && url.pathname === '/bench/v1/reset') { if (body['leaseId'] !== null) this.#check(body['leaseId']); this.#state = 'resetting'; const reset = this.reset(); send(202, this.status()); void reset.catch(() => { this.#state = 'failed'; }); await reset; return; }
          send(404, { error: 'Not found.' });
        });
      } catch (error) { if (!response.headersSent) send(error instanceof LabError ? error.status : 400, { error: error instanceof LabError ? error.code : 'Invalid request.', ...(error instanceof LabError ? { code: error.code } : {}) }); }
    });
  }
}
