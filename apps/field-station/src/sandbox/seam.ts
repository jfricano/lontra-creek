/**
 * The production slot backend on the published workbench seam (WHC-1, StreamOtter
 * 0.2.0-rc.1): each study gets its own development gateway, built with
 * `createGateway`, and its own `createManagementHandler`, mounted on a private
 * loopback listener inside the sandbox process (LC11-ADR-04, amended for W9a).
 *
 * The handler's only credential is a per-runtime random key that never leaves this
 * process: no native management token exists, and `Authorization` is ignored. It
 * answers only the sandbox allowlist. Requests are rebuilt from the service's checked
 * inputs; nothing from a visitor's request is passed through.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { isPlainObject, WORKBENCH_HOST_CONTRACT, WORKBENCH_REQUEST_HEADER, type Gateway, type Json, type ProjectConfig, type WorkbenchDiscovery, type WorkbenchHostManifest } from 'streamotter/contracts';
import { createGateway, silentLogger } from 'streamotter/gateway';
import { createManagementHandler } from 'streamotter/gateway/management';
import type { SandboxOperation, SandboxRequest, SandboxResponse, SandboxRuntime, SlotId } from './contract.ts';
import { operationRoute, SANDBOX_OPERATIONS } from './operations.ts';
import type { SlotBackend, SlotRuntime } from './service.ts';
import { SLOT_MAXIMA, SLOT_PRINCIPALS, slotConfig, slotRuntimeParts, type SlotChannels } from './slot-project.ts';

/** The header carrying a runtime's private key; only this process sends it. */
const KEY_HEADER = 'x-lc-slot-key';
/** Above the 64 KB candidate limit, which the service checks first. */
const HANDLER_BODY_BYTES = 131_072;
/**
 * How long one call to a slot's handler may take. Below the field station's wait for a
 * slot operation (leases.ts, SANDBOX_OPS_TIMEOUT_MS), so a slow call is answered as
 * StreamOtter's TIMEOUT and keeps the lease, rather than looking like a failed slot.
 */
export const CALL_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5000;

export interface PublishedBackendOptions {
  /** The site origins previews connect from; the slot gateways allow exactly these. */
  siteOrigins: readonly string[];
  /** Where slot gateways listen. Default 0.0.0.0 (the Compose network; Caddy routes only Socket.IO). */
  gatewayHost?: string;
  /** Slot N's gateway listens on portBase + N; 0 lets the system choose (tests). Default 7600. */
  portBase?: number;
  /** Tests only: the manifest of another install, to check the static seam checks. */
  manifest?: unknown;
}

/** The installed workbench's host manifest, resolved through the installed streamotter, or null when it cannot be read. */
function installedSeam(): { manifest: unknown; streamotter: string | null } {
  try {
    const require = createRequire(createRequire(import.meta.url).resolve('streamotter/package.json'));
    const streamotter = (require('streamotter/package.json') as { version?: unknown }).version;
    return { manifest: JSON.parse(readFileSync(require.resolve('@streamotter/workbench/host'), 'utf8')) as unknown, streamotter: typeof streamotter === 'string' ? streamotter : null };
  } catch { return { manifest: null, streamotter: null }; }
}

/** The static checks: a WHC-1 manifest from the published package, and a published handler. */
function checkedManifest(manifest: unknown): WorkbenchHostManifest | null {
  if (!isPlainObject(manifest) || manifest['hostContract'] !== WORKBENCH_HOST_CONTRACT || manifest['package'] !== '@streamotter/workbench' || typeof manifest['version'] !== 'string') return null;
  return typeof createManagementHandler === 'function' ? manifest as unknown as WorkbenchHostManifest : null;
}

/** A StreamOtter error from the slot's management handler, with its public fields; service.ts passes it through. */
export class SlotError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, Json>> | undefined;
  constructor(error: unknown) {
    const e = isPlainObject(error) ? error : {};
    super(typeof e['message'] === 'string' ? e['message'] : 'The slot did not answer.');
    this.code = typeof e['code'] === 'string' ? e['code'] : 'INTERNAL'; this.retryable = e['retryable'] === true;
    this.details = isPlainObject(e['details']) ? e['details'] as Readonly<Record<string, Json>> : undefined;
  }
}

/**
 * One request to a slot's management listener: the handler's `data`, or a SlotError with
 * its public fields. No answer within the timeout is StreamOtter's TIMEOUT (retryable).
 * Each request opens its own connection, as the field station's do (leases.ts, sandboxClient).
 */
export async function slotRequest<T>(url: string, init: RequestInit, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  let result: unknown;
  try { const response = await fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) }); result = await response.json(); }
  catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new SlotError({ code: 'TIMEOUT', message: `The sandbox slot did not answer within ${timeoutMs / 1000} s.`, retryable: true });
    throw error;
  }
  if (isPlainObject(result) && result['ok'] === true) return result['data'] as T;
  throw new SlotError(isPlainObject(result) ? result['error'] : undefined);
}

/**
 * The published backend: the only one sandbox-main.ts constructs. A pre-WHC-1 install
 * reports `seam-unavailable` and opens nothing; it never emulates a runtime.
 */
export function publishedBackend(options: PublishedBackendOptions): SlotBackend {
  const installed = installedSeam();
  const manifest = checkedManifest(Object.hasOwn(options, 'manifest') ? options.manifest : installed.manifest);
  const host = options.gatewayHost ?? '0.0.0.0'; const base = options.portBase ?? 7600;
  // The operations the most recently opened runtime's handler discovered; none before the first.
  let discovered: readonly string[] = [];
  const runtime = (): SandboxRuntime | null => manifest && installed.streamotter
    ? { packages: { streamotter: installed.streamotter, workbench: manifest.version }, mode: 'synthetic-fixture', contractVersion: String(manifest.hostContract) }
    : null;
  return {
    describe() {
      const identity = runtime();
      return identity ? { available: true, runtime: identity, operations: SANDBOX_OPERATIONS.filter(op => discovered.includes(op)) } : { available: false, reason: 'seam-unavailable' };
    },
    async open(slot) {
      if (!runtime()) throw new Error('No published workbench seam.');
      const opened = await PublishedRuntime.open(slot, { host, port: base === 0 ? 0 : base + slot, siteOrigins: options.siteOrigins });
      discovered = opened.discovery.operations;
      return opened;
    }
  };
}

/** One study's gateway and its private management listener. */
export class PublishedRuntime implements SlotRuntime {
  readonly base: ProjectConfig;
  readonly principalRefs = Object.keys(SLOT_PRINCIPALS);
  readonly maxima = SLOT_MAXIMA;
  /** Where the slot's gateway listens. */
  readonly gatewayAddress: { origin: string; path: string };
  readonly #gateway: Gateway;
  readonly #server: Server;
  readonly #origin: string;
  readonly #key: string;
  #discovery: WorkbenchDiscovery = { hostContract: WORKBENCH_HOST_CONTRACT, operations: [], limits: { maxRequestBytes: 0 } };
  #closing: Promise<void> | null = null;
  private constructor(parts: { base: ProjectConfig; gateway: Gateway; gatewayAddress: { origin: string; path: string }; server: Server; key: string }) {
    this.base = parts.base; this.#gateway = parts.gateway; this.gatewayAddress = parts.gatewayAddress; this.#server = parts.server; this.#key = parts.key;
    this.#origin = `http://127.0.0.1:${(parts.server.address() as AddressInfo).port}`;
  }
  /** The private management listener, on loopback; it answers only requests carrying this runtime's key. */
  get managementOrigin(): string { return this.#origin; }
  /** What the slot's own handler answers, read once when the runtime opens. */
  get discovery(): WorkbenchDiscovery { return this.#discovery; }

  static async open(slot: SlotId, options: { host: string; port: number; siteOrigins: readonly string[] }): Promise<PublishedRuntime> {
    const base = slotConfig(slot, options); const { handlers, development } = slotRuntimeParts();
    const gateway = createGateway<SlotChannels>({ config: base, handlers, development, mode: 'development', logger: silentLogger });
    const gatewayAddress = await gateway.start();
    let server: Server | undefined;
    try {
      const key = randomBytes(32).toString('hex'); const expected = Buffer.from(key);
      const authorize = (request: IncomingMessage): boolean => {
        const provided = Buffer.from(String(request.headers[KEY_HEADER] ?? ''));
        return provided.length === expected.length && timingSafeEqual(provided, expected);
      };
      const handler = createManagementHandler({ gateway, operations: SANDBOX_OPERATIONS, authorize, maxBodyBytes: HANDLER_BODY_BYTES });
      const listener = server = createServer((request, response) => void handler(request, response, request.url ?? '/'));
      await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', () => { listener.off('error', reject); resolve(); }); });
      const runtime = new PublishedRuntime({ base, gateway, gatewayAddress, server: listener, key });
      runtime.#discovery = await runtime.#request<WorkbenchDiscovery>('GET', '/workbench');
      return runtime;
    } catch (error) {
      if (server) { server.close(); server.closeAllConnections(); }
      await gateway.stop({ timeoutMs: STOP_TIMEOUT_MS }).catch(() => undefined);
      throw error;
    }
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (this.#closing) throw new Error('Runtime closed.');
    return slotRequest<T>(`${this.#origin}${path}`, {
      method, headers: { [KEY_HEADER]: this.#key, ...(method === 'POST' ? { 'content-type': 'application/json', [WORKBENCH_REQUEST_HEADER]: '1' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    });
  }

  /** One operation, rebuilt from the service's checked input: a GET with a query only for `traces`, a POST with a JSON body otherwise. */
  call<O extends SandboxOperation>(op: O, input: SandboxRequest<O>): Promise<SandboxResponse<O>> {
    const { method, path } = operationRoute(op);
    if (method === 'POST') return this.#request(method, path, input);
    const query = new URLSearchParams();
    if (op === 'traces' && isPlainObject(input)) for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
    return this.#request(method, query.size ? `${path}?${query}` : path);
  }

  async revoke(): Promise<void> {
    for (const principal of Object.values(SLOT_PRINCIPALS)) await this.#gateway.revoke({ kind: 'subject', tenantId: principal.tenantId, subject: principal.subject });
  }

  /** Closes the management listener, then stops the gateway; a failure leaves the runtime to be closed again. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#server.close(); this.#server.closeAllConnections();
      await this.#gateway.stop({ timeoutMs: STOP_TIMEOUT_MS });
    })();
    const closing = this.#closing;
    return closing.catch((error: unknown) => { if (this.#closing === closing) this.#closing = null; throw error; });
  }
}
