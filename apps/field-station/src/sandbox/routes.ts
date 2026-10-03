/**
 * The public sandbox routes (sandbox contract §§2, 4, 6): the session lifecycle at
 * /api/sandbox/{status,session,...} and the WHC-1 host API at /api/sandbox/wb/v1.
 * Called by publicApi after CORS and the Lab request budget, which the sandbox
 * shares; the same Lab rules apply (exact Origin, lc_session, every request a
 * heartbeat, no slot in requests, bounded bodies).
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { badgeFor, readSession, type SessionClaims } from '../sessions.ts';
import type { SandboxStatus } from './contract.ts';
import type { SandboxPool } from './leases.ts';
import { WorkbenchFailure } from './leases.ts';
import { API_BASE, BODY_BYTES, bodyLimit, checkInput, CONFIG_BODY_BYTES, HOST_CONTRACT, invalid, isSandboxOperation, queryInput, routeOperation, SandboxFault } from './operations.ts';

type Headers = Record<string, string>;
export interface SandboxRouteContext { pool: SandboxPool | undefined; siteOrigins: readonly string[]; secret: string; secure: boolean; cors: Headers; address: string; /** Seconds until the shared Lab request budget allows this client again; 0 when it does now. */ wait: number; }

function send(response: ServerResponse, status: number, body: unknown, headers: Headers): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > limit) throw new SandboxFault('candidate-too-large');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += (chunk as Buffer).length; if (size > limit) throw new SandboxFault('candidate-too-large'); chunks.push(chunk as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}
const LIFECYCLE = ['GET /api/sandbox/status', 'POST /api/sandbox/session', 'GET /api/sandbox/session', 'POST /api/sandbox/session/claim', 'POST /api/sandbox/session/reset', 'POST /api/sandbox/session/return', 'POST /api/sandbox/session/repro'];
export const DISABLED = (now: number): SandboxStatus => ({ now: new Date(now).toISOString(), availability: 'unavailable', reason: 'disabled', runtime: null, slots: [], queueLength: 0, nextFreeAt: null });

export async function sandboxRoute(request: IncomingMessage, response: ServerResponse, url: URL, context: SandboxRouteContext): Promise<void> {
  if (url.pathname === API_BASE || url.pathname.startsWith(`${API_BASE}/`)) return workbenchRoute(request, response, url, context);
  const { pool, cors } = context; const origin = request.headers.origin;
  try {
    if (context.wait > 0) return send(response, 429, { error: 'Too many requests.', code: 'too-many-requests' }, { ...cors, 'retry-after': String(context.wait) });
    const route = `${request.method} ${url.pathname}`;
    if (!LIFECYCLE.includes(route)) return send(response, 404, { error: 'Not found.' }, cors);
    if (request.method === 'POST' && origin !== undefined && !context.siteOrigins.includes(origin)) throw new SandboxFault('origin-not-allowed');
    if ([...url.searchParams.keys()].length) throw invalid('No query parameters are accepted.');
    let session = readSession(request.headers.cookie, context.secret);
    if (!session && route === 'POST /api/sandbox/session' && pool) {
      const badge = badgeFor({ cookieHeader: undefined, role: 'volunteer', secret: context.secret, secure: context.secure });
      cors['set-cookie'] = badge.setCookie!; session = readSession(badge.setCookie!, context.secret);
    }
    if (!pool && route !== 'GET /api/sandbox/status') throw new SandboxFault('sandbox-unavailable');
    if (route !== 'GET /api/sandbox/status' && !session) throw new SandboxFault('no-session');
    // Lifecycle bodies are empty (return is keepalive-safe) or `{}`.
    if (request.method === 'POST') { const text = await readBody(request, BODY_BYTES); if (text !== '' && text.trim() !== '{}') throw invalid('This route takes no body.'); }
    if (!pool) return send(response, 200, DISABLED(Date.now()), cors);
    if (session) pool.heartbeat(session);
    if (route === 'POST /api/sandbox/session/repro') return send(response, 200, await pool.repro(session!), cors);
    const s = session as SessionClaims;
    const result = await pool.run(async () => {
      await pool.sweep(); if (session) pool.heartbeat(session);
      if (route === 'GET /api/sandbox/status') return pool.status();
      if (route === 'POST /api/sandbox/session') return pool.join(s, context.address);
      if (route === 'GET /api/sandbox/session') return pool.view(s);
      if (route === 'POST /api/sandbox/session/claim') return pool.claim(s);
      if (route === 'POST /api/sandbox/session/reset') return pool.reset(s);
      return pool.leave(s);
    });
    return send(response, route === 'POST /api/sandbox/session/reset' ? 202 : 200, result, cors);
  } catch (error) {
    const problem = error instanceof SandboxFault ? error : invalid('The request is malformed.');
    return send(response, problem.status, { error: problem.message, code: problem.code }, { ...cors, ...(problem.status === 429 ? { 'retry-after': '1' } : {}) });
  }
}

/**
 * WHC-1 in session mode: the lc_session cookie, exact Origin, and on every POST
 * `X-StreamOtter-Workbench: 1`. Checks follow createManagementHandler's order (WHC-1
 * rev 0.2 §9) after the host's own budget and Origin checks: session 401, route 404,
 * allowlist 403, query 400, POST header 403, body 413/400; then the lease (401).
 * Authorization headers are ignored, as the handler does, and never forwarded.
 */
async function workbenchRoute(request: IncomingMessage, response: ServerResponse, url: URL, context: SandboxRouteContext): Promise<void> {
  const requestId = randomUUID(); const headers = { ...context.cors, 'x-request-id': requestId };
  const fail = (status: number, error: unknown) => send(response, status, { ok: false, requestId, error: { ...(error as object), requestId } }, { ...headers, ...(status === 429 ? { 'retry-after': '1' } : {}) });
  try {
    if (context.wait > 0) return send(response, 429, { ok: false, requestId, error: new SandboxFault('too-many-requests').stream(requestId) }, { ...headers, 'retry-after': String(context.wait) });
    const origin = request.headers.origin;
    if (origin !== undefined && !context.siteOrigins.includes(origin)) throw new SandboxFault('origin-not-allowed');
    const session = readSession(request.headers.cookie, context.secret);
    if (!session) throw new SandboxFault('no-session');
    const method = request.method ?? 'GET'; const path = url.pathname.slice(API_BASE.length);
    const op = routeOperation(method, path);
    if (op === null) return fail(404, new SandboxFault('invalid-request', 'Unknown workbench route.').stream(requestId));
    if (op === 'workbench') {
      if ([...url.searchParams.keys()].length) throw invalid('No query parameters are accepted.');
      const pool = context.pool;
      const discovery = pool ? await pool.run(async () => { await pool.sweep(); pool.heartbeat(session); return pool.discovery(); }) : { hostContract: HOST_CONTRACT, operations: ['workbench'], limits: { maxRequestBytes: CONFIG_BODY_BYTES } };
      return send(response, 200, { ok: true, requestId, data: discovery }, headers);
    }
    if (!isSandboxOperation(op)) throw new SandboxFault('operation-not-allowed', `The "${op}" operation is not available in this environment.`);
    const fromQuery = queryInput(op, url.searchParams);
    let body: unknown = null;
    if (method === 'POST') {
      if (request.headers['x-streamotter-workbench'] !== '1') throw new SandboxFault('origin-not-allowed', 'Requests that change state must carry the X-StreamOtter-Workbench: 1 header.');
      const text = await readBody(request, bodyLimit(op));
      if (text === '') throw invalid('A JSON body is required.');
      if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) throw invalid('Content-Type must be application/json.');
      try { body = JSON.parse(text); } catch { throw invalid('The body is not valid JSON.'); }
    }
    const input = checkInput(op, op === 'traces' ? fromQuery : body);
    if (!context.pool) throw new SandboxFault('sandbox-unavailable');
    context.pool.heartbeat(session);
    const data = await context.pool.operate(session, op, input);
    return send(response, 200, { ok: true, requestId, data }, headers);
  } catch (error) {
    if (error instanceof WorkbenchFailure) return fail(error.status, error.error);
    const problem = error instanceof SandboxFault ? error : invalid('The request is malformed.');
    return fail(problem.wbStatus, problem.stream(requestId));
  }
}
