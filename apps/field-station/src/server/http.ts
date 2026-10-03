/**
 * The field station's two HTTP listeners.
 *
 * Public, behind Caddy at /api: where the gateway is, sign-in badges, the study's
 * status, and sightings for the visitor's own notebook, with CORS for the site's
 * origin and credentials, and a request budget per client. GET /healthz is for the
 * container's health check; Caddy doesn't route it.
 *
 * Internal, on the compose network only: GET /internal/views/:channel/:id, the
 * current view or notebook the gateway's snapshot handler asks for, with the
 * service token. Under /lab-internal/N/, with bench N's own token only: that
 * bench's snapshots (Lab contract section 8) and its study and recovery routes
 * (section 8a).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { stamp } from "@lontra-creek/sim";
import type { Role } from "../identity.ts";
import { badgeFor, readSession } from "../sessions.ts";
import type { ServerConfig } from "./config.ts";
import { NotebookError, parseSighting, type Notebooks } from "./notebooks.ts";
import type { FieldStation } from "./station.ts";

import { LeasePool } from '../lab/leases.ts';
import { LabError, ACTIONS } from '../lab/errors.ts';
import type { BenchId, LabAction, RecoveryAssessRequest } from '../lab/contract.ts';
import { StudyClosedError, type LabStudies } from '../lab/studies.ts';

type Headers = Record<string, string>;

function send(response: ServerResponse, status: number, body: unknown, headers: Headers = {}): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 4_096) throw new Error("Body too large");
  }
  const value: unknown = text === "" ? {} : JSON.parse(text);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A token bucket per client: `burst` requests at once, refilled at `perSecond`.
 * Clients are told apart by the X-Client-IP header Caddy sets (the app's port is
 * reachable only through Caddy), or by the socket address when there's no proxy.
 */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #burst: number;
  readonly #perSecond: number;
  readonly #now: () => number;

  constructor(options: { burst: number; perSecond: number; now?: () => number }) {
    this.#burst = options.burst;
    this.#perSecond = options.perSecond;
    this.#now = options.now ?? Date.now;
  }

  /** Takes one token; returns 0 if allowed, or the seconds to wait. */
  take(client: string): number {
    const now = this.#now();
    const bucket = this.#buckets.get(client) ?? { tokens: this.#burst, at: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + ((now - bucket.at) / 1_000) * this.#perSecond);
    bucket.at = now;
    this.#buckets.set(client, bucket);
    if (this.#buckets.size > 10_000) this.#sweep(now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.#perSecond);
  }

  #sweep(now: number): void {
    const full = (this.#burst / this.#perSecond) * 1_000;
    for (const [client, bucket] of this.#buckets) if (now - bucket.at > full) this.#buckets.delete(client);
  }
}

export function clientAddress(request: IncomingMessage): string {
  const header = request.headers["x-client-ip"];
  return (typeof header === "string" && header !== "" ? header : request.socket.remoteAddress) ?? "unknown";
}

export function publicApi(options: { config: ServerConfig; station: FieldStation; notebooks: Notebooks; lab?: LeasePool; limiter?: RateLimiter; log?: (message: string) => void }): Server {
  const { config, station, notebooks } = options;
  const limiter = options.limiter ?? new RateLimiter({ burst: 30, perSecond: 1 });
  const labLimiter = new RateLimiter({ burst: 20, perSecond: 3 });
  const log = options.log ?? (message => console.error(message));

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://field-station.invalid");
    // Set once the request is under /api/, so an error answer still carries CORS and the page can read it.
    let cors: Headers = {};
    try {
      if (url.pathname === "/healthz") {
        const healthy = station.ready && station.kafkaHealthy && notebooks.ready;
        return send(response, healthy ? 200 : 503, {
          ready: station.ready,
          kafka: station.kafkaHealthy ? "connected" : "unavailable",
          notebooks: notebooks.ready ? "ready" : "loading",
          tick: station.tick,
          target: station.targetTick()
        });
      }
      if (!url.pathname.startsWith("/api/")) return send(response, 404, { error: "Not found." });

      const origin = request.headers.origin;
      cors = { vary: "Origin" };
      if (origin !== undefined && config.siteOrigins.includes(origin)) {
        cors["access-control-allow-origin"] = origin;
        cors["access-control-allow-credentials"] = "true";
      }
      if (request.method === "OPTIONS") {
        if (cors["access-control-allow-origin"] === undefined) return send(response, 403, { error: "Origin not allowed." }, cors);
        response.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
        return response.end();
      }

      const isLab = url.pathname.startsWith('/api/lab/');
      const wait = (isLab ? labLimiter : limiter).take(clientAddress(request));
      if (wait > 0) return send(response, 429, { error: "Too many requests.", ...(isLab ? { code: "too-many-requests" } : {}) }, { ...cors, "retry-after": String(wait) });

      if (isLab) {
        try {
          if (request.method === 'POST' && origin !== undefined && !config.siteOrigins.includes(origin)) throw new LabError('origin-not-allowed', 403);
          const lab = options.lab;
          const route = `${request.method} ${url.pathname}`;
          if (!['GET /api/lab/status', 'POST /api/lab/lease', 'GET /api/lab/lease', 'POST /api/lab/lease/return', 'POST /api/lab/lease/token', 'POST /api/lab/actions', 'GET /api/lab/trace'].includes(route)) return send(response, 404, { error: 'Not found.' }, cors);
          let session = readSession(request.headers.cookie, config.secret);
          if (!session && route === 'POST /api/lab/lease') {
            const badge = badgeFor({ cookieHeader: undefined, role: 'volunteer', secret: config.secret, secure: config.production });
            cors['set-cookie'] = badge.setCookie!; session = readSession(badge.setCookie!, config.secret);
          }
          if (route !== 'GET /api/lab/status' && !session) throw new LabError('no-session', 401);
          const body = request.method === 'POST' ? await readJson(request) : {};
          const keys = Object.keys(body);
          if (keys.some(key => route !== 'POST /api/lab/actions' || key !== 'action') || [...url.searchParams.keys()].some(key => route !== 'GET /api/lab/trace' || key !== 'after')) throw new LabError('invalid-request', 400);
          if (!lab) {
            if (route === 'GET /api/lab/status') return send(response, 200, { enabled: false, now: new Date().toISOString(), benches: [], queueLength: 0, nextFreeAt: null }, cors);
            throw new LabError('lab-unavailable', 503);
          }
          // Record an on-time heartbeat at arrival, even if another RPC is queued.
          if (session) lab.heartbeat(session);
          const result = await lab.run(async () => {
            await lab.sweep();
            if (session) lab.heartbeat(session);
            if (route === 'GET /api/lab/status') return lab.status();
            if (route === 'POST /api/lab/lease') return lab.join(session!, clientAddress(request));
            if (route === 'GET /api/lab/lease') return lab.view(session!);
            if (route === 'POST /api/lab/lease/return') return lab.leave(session!);
            if (route === 'POST /api/lab/lease/token') return lab.token(session!);
            if (route === 'GET /api/lab/trace') return lab.feed(session!, url.searchParams.get('after') ?? undefined);
            if (!ACTIONS.includes(body['action'] as LabAction)) throw new LabError('invalid-request', 400);
            return lab.action(session!, body['action'] as LabAction);
          });
          return send(response, 200, result, cors);
        } catch (error) {
          const problem = error instanceof LabError ? error : new LabError('invalid-request', 400);
          return send(response, problem.status, { error: problem.message, code: problem.code }, { ...cors, ...(problem.status === 429 ? { 'retry-after': '1' } : {}) });
        }
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        return send(response, 200, { gatewayOrigin: config.gatewayOrigin, gatewayPath: config.gatewayPath, mode: "kafka", tickMs: config.tickMs }, cors);
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return send(response, 200, { mode: "kafka", ...station.status() }, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/badge") {
        // Browsers send Origin on every POST; refusing others keeps other sites from minting badges with a visitor's cookie.
        if (origin !== undefined && cors["access-control-allow-origin"] === undefined) return send(response, 403, { error: "Origin not allowed." }, cors);
        const body = await readJson(request);
        const role: Role = body["role"] === "researcher" ? "researcher" : "volunteer";
        const result = badgeFor({ cookieHeader: request.headers.cookie, role, secret: config.secret, secure: config.production });
        return send(response, 200, { badge: result.badge, token: result.token.token, expiresAt: result.token.expiresAt },
          result.setCookie === null ? cors : { ...cors, "set-cookie": result.setCookie });
      }
      if (request.method === "POST" && url.pathname === "/api/notebook/sightings") {
        if (origin !== undefined && cors["access-control-allow-origin"] === undefined) return send(response, 403, { error: "Origin not allowed." }, cors);
        // The notebook is the session's own: its owner is the badge subject the cookie names.
        const session = readSession(request.headers.cookie, config.secret);
        if (session === null) return send(response, 401, { error: "Sign in first." }, cors);
        const sighting = parseSighting(await readJson(request));
        if (sighting === null) return send(response, 400, { error: "Choose an otter, a reach, and an activity from the lists." }, cors);
        try {
          const result = notebooks.add(session.subject, session.exp, sighting, stamp(station.tick));
          void notebooks.flush();
          return send(response, 200, { observerId: session.subject, ...result }, cors);
        } catch (error) {
          if (error instanceof NotebookError) return send(response, error.status, { error: error.message }, cors);
          throw error;
        }
      }
      send(response, 404, { error: "Not found." }, cors);
    } catch (error) {
      log(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) send(response, 400, { error: "Bad request." }, cors);
    }
  });
}

/** Reads a bench's small JSON body: an object of at most 4 KB, or null. */
async function benchBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    let text = "";
    for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 4_096) return null; }
    const value: unknown = text === "" ? {} : JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** A recovery request as the contract types it, or null. Coordinates only; a record's bytes are never accepted. */
function assessRequest(body: Record<string, unknown>): RecoveryAssessRequest | null {
  const { studyId, sourceId, record } = body;
  if (typeof studyId !== "string" || typeof sourceId !== "string" || Object.keys(body).some(key => !["studyId", "sourceId", "record"].includes(key))) return null;
  if (record === undefined) return { studyId, sourceId };
  const r = record as Record<string, unknown>;
  if (typeof r !== "object" || r === null || Object.keys(r).length !== 3 || typeof r["topic"] !== "string" || !Number.isSafeInteger(r["partition"]) || typeof r["offset"] !== "string" || !/^\d{1,20}$/.test(r["offset"])) return null;
  return { studyId, sourceId, record: { topic: r["topic"], partition: r["partition"] as number, offset: r["offset"] } };
}

export function internalApi(options: { serviceToken: string; station: FieldStation; notebooks: Notebooks; labTokens?: readonly string[]; studies?: LabStudies }): Server {
  const expected = Buffer.from(`Bearer ${options.serviceToken}`);
  const authorized = (request: IncomingMessage): boolean => {
    const provided = Buffer.from(request.headers.authorization ?? "");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };

  const benchAuthorized = (bench: number, request: IncomingMessage): boolean => {
    const token = options.labTokens?.[bench - 1];
    const expectedLab = Buffer.from(`Bearer ${token ?? ''}`);
    const provided = Buffer.from(request.headers.authorization ?? '');
    return token !== undefined && provided.length === expectedLab.length && timingSafeEqual(provided, expectedLab);
  };

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://field-station.invalid");
    // The private study and recovery surface (Lab contract section 8a): bench N's own token, POST only.
    const study = /^\/lab-internal\/([123])\/(?:studies\/([A-Za-z0-9_-]{16})\/(close|discard)|recovery\/(assess))$/.exec(url.pathname);
    if (study) {
      const bench = Number(study[1]) as BenchId;
      if (!benchAuthorized(bench, request)) return send(response, 401, { error: 'Unauthorized.' });
      const studies = options.studies;
      if (request.method !== 'POST' || !studies) return send(response, 404, { error: 'Not found.' });
      try {
        if (study[3] === 'close') return send(response, 200, await studies.close(bench, study[2]!));
        if (study[3] === 'discard') return send(response, 200, await studies.discard(bench, study[2]!));
        const body = await benchBody(request); const input = body && assessRequest(body);
        if (!input) return send(response, 400, { error: 'Invalid request.' });
        return send(response, 200, await studies.assess(bench, input));
      } catch (error) {
        if (error instanceof StudyClosedError) return send(response, 409, { error: 'The study is not open.', code: 'study-closed' });
        if (error instanceof RangeError) return send(response, 400, { error: 'Invalid request.' });
        return send(response, 500, { error: 'Study operation failed.' });
      }
    }
    const restricted = /^\/lab-internal\/([123])\/views\/(station|otter|reach|creekOverview)\/([^/]+)$/.exec(url.pathname);
    if (restricted) {
      const bench = Number(restricted[1]) as BenchId;
      if (!benchAuthorized(bench, request)) return send(response, 401, { error: 'Unauthorized.' });
      if (request.method !== 'GET') return send(response, 404, { error: 'Not found.' });
      if (!options.station.ready) return send(response, 503, { error: 'Catching up.' });
      let id: string; try { id = decodeURIComponent(restricted[3]!); } catch { return send(response, 400, { error: 'Invalid request.' }); }
      // With studies, the bench's served state: the shared creek or its open study's own
      // writes, and a boundary acknowledgment only when one is asked for (section 8a).
      if (options.studies) {
        const boundary = url.searchParams.get('boundary');
        if (boundary !== null && boundary.length > 96) return send(response, 400, { error: 'Invalid request.' });
        try {
          const snapshot = await options.studies.snapshot(bench, `${restricted[2]}:${id}`, boundary);
          return snapshot ? send(response, 200, snapshot) : send(response, 404, { error: 'Not found.' });
        } catch { return send(response, 500, { error: 'Snapshot failed.' }); }
      }
      const view = options.station.view(`${restricted[2]}:${id}`);
      return view ? send(response, 200, { revision: view.revision, data: view.data }) : send(response, 404, { error: 'Not found.' });
    }
    if (!authorized(request)) return send(response, 401, { error: "Unauthorized." });
    const match = /^\/internal\/views\/([A-Za-z]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "GET" || match === null) return send(response, 404, { error: "Not found." });
    let id: string;
    try {
      id = decodeURIComponent(match[2]!);
    } catch {
      return send(response, 404, { error: "Not found." });
    }
    if (match[1] === "notebook") {
      if (!options.notebooks.ready) return send(response, 503, { error: "Loading notebooks." });
      return send(response, 200, options.notebooks.view(id));
    }
    if (!options.station.ready) return send(response, 503, { error: "Catching up." });
    const view = options.station.view(`${match[1]}:${id}`);
    if (view === undefined) return send(response, 404, { error: "No such view." });
    send(response, 200, { revision: view.revision, data: view.data });
  });
}
