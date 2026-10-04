/**
 * The sandbox's closed operation allowlist and input bounds (sandbox contract §6),
 * shared by the field station (before forwarding) and the sandbox service (again,
 * before touching a slot). Paths and names are WHC-1 rev 0.1's; shapes are rc.3's
 * `ManagementOperations`.
 */
import { isIdentifier, isPlainObject, streamError, type ErrorCode, type Json, type StreamError } from 'streamotter/contracts';
import type { SandboxErrorCode, SandboxOperation, SandboxRequest, WorkbenchOperation } from './contract.ts';

export const HOST_CONTRACT = 1;
export const API_BASE = '/api/sandbox/wb/v1';
export const CONFIG_BODY_BYTES = 65_536;
export const BODY_BYTES = 4_096;
export const DOWNLOAD_BYTES = 262_144;
/** The most traces one page serves; a larger `limit` (the workbench asks for up to 500) is narrowed to it. */
export const TRACE_LIMIT = 100;
/** The largest `limit` accepted, the native maximum. */
export const TRACE_QUERY_LIMIT = 500;
export const ADVANCE_LIMIT = 10;

export const SANDBOX_OPERATIONS: readonly SandboxOperation[] = ['capabilities', 'health', 'sources', 'channels', 'config', 'config.validate', 'config.export', 'traces', 'source-checks', 'sources.resume', 'preview-sessions', 'dev.principals', 'dev.fixtures.advance', 'dev.disconnect'];

/** Every WHC-1 route, allowlisted or not, so an unlisted operation is 403 and an unknown path 404. */
const ROUTES: Readonly<Record<string, WorkbenchOperation>> = {
  'GET /workbench': 'workbench', 'GET /capabilities': 'capabilities', 'GET /health': 'health', 'GET /sources': 'sources', 'GET /channels': 'channels', 'GET /config': 'config',
  'POST /config/validate': 'config.validate', 'POST /config/export': 'config.export', 'GET /traces': 'traces', 'POST /source-checks': 'source-checks',
  'POST /sources/resume': 'sources.resume', 'POST /preview-sessions': 'preview-sessions', 'GET /dev/principals': 'dev.principals',
  'POST /dev/fixtures/advance': 'dev.fixtures.advance', 'POST /dev/disconnect': 'dev.disconnect', 'GET /operator/status': 'operator.status',
  'GET /failures': 'failures.list', 'POST /failures/export': 'failures.export', 'POST /failures/evaluate': 'failures.evaluate', 'POST /failures/redrive': 'failures.redrive',
  'POST /sources/retry-current': 'sources.retry-current', 'POST /sources/reassess': 'sources.reassess', 'POST /sources/reopen-circuit': 'sources.reopen-circuit'
};
export function routeOperation(method: string, path: string): WorkbenchOperation | null {
  return ROUTES[`${method} ${path}`] ?? (method === 'GET' && /^\/failures\/[^/]+$/.test(path) ? 'failures.show' : null);
}
/** The method and path (relative to the API base) of an allowlisted operation, from the same table. */
export function operationRoute(op: SandboxOperation): { method: 'GET' | 'POST'; path: string } {
  const route = Object.keys(ROUTES).find(key => ROUTES[key] === op);
  if (!route) throw new Error(`No route for ${op}.`);
  const [method, path] = route.split(' ') as ['GET' | 'POST', string];
  return { method, path };
}
export const isSandboxOperation = (op: unknown): op is SandboxOperation => SANDBOX_OPERATIONS.includes(op as SandboxOperation);
export const bodyLimit = (op: SandboxOperation): number => op.startsWith('config.') ? CONFIG_BODY_BYTES : BODY_BYTES;

/** Status on the lifecycle routes, then the WHC-1 code and status the workbench routes use. */
const FAULTS: Readonly<Record<SandboxErrorCode, readonly [number, ErrorCode, number]>> = {
  'invalid-request': [400, 'INVALID_REQUEST', 400], 'field-not-editable': [400, 'CONFIG_INVALID', 400], 'candidate-too-large': [413, 'INVALID_REQUEST', 413],
  'no-session': [401, 'UNAUTHENTICATED', 401], 'origin-not-allowed': [403, 'FORBIDDEN', 403], 'operation-not-allowed': [403, 'FORBIDDEN', 403],
  'no-lease': [409, 'UNAUTHENTICATED', 401], 'stale-study': [409, 'UNAUTHENTICATED', 401], 'too-many-requests': [429, 'OVERLOADED', 429],
  'too-many-places': [429, 'OVERLOADED', 429], 'queue-full': [503, 'OVERLOADED', 503], 'sandbox-unavailable': [503, 'INTERNAL', 503], 'slot-unavailable': [503, 'INTERNAL', 503]
};
const MESSAGES: Readonly<Record<SandboxErrorCode, string>> = {
  'invalid-request': 'The request is malformed.', 'field-not-editable': 'The candidate changes a server-owned field.', 'candidate-too-large': 'The request is too large.',
  'no-session': 'Start a sandbox session first.', 'origin-not-allowed': 'Origin not allowed.', 'operation-not-allowed': 'Not available in this environment.',
  'no-lease': 'This session has no active sandbox.', 'stale-study': 'The sandbox study was reset or ended.', 'too-many-requests': 'Too many requests.',
  'too-many-places': 'This address already holds two places.', 'queue-full': 'The line is full.', 'sandbox-unavailable': 'The sandbox is unavailable.', 'slot-unavailable': 'The sandbox slot is unavailable.'
};

/** One refusal, rendered as `SandboxError` on lifecycle routes and as a WHC-1 `Result` error on workbench routes. */
export class SandboxFault extends Error {
  readonly code: SandboxErrorCode;
  readonly status: number;
  readonly wbCode: ErrorCode;
  readonly wbStatus: number;
  readonly details: Readonly<Record<string, Json>>;
  constructor(code: SandboxErrorCode, message?: string, options: { wbCode?: ErrorCode; wbStatus?: number; details?: Readonly<Record<string, Json>> } = {}) {
    super(message ?? MESSAGES[code]); const [status, wbCode, wbStatus] = FAULTS[code];
    this.code = code; this.status = status; this.wbCode = options.wbCode ?? wbCode; this.wbStatus = options.wbStatus ?? wbStatus; this.details = { code, ...options.details };
  }
  stream(requestId: string): StreamError { return streamError(this.wbCode, { message: this.message, requestId, details: this.details }); }
}
export const invalid = (message: string): SandboxFault => new SandboxFault('invalid-request', message);

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalid('The body must be a JSON object.');
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw invalid(`Unknown field "${key.slice(0, 64)}".`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw invalid(`"${key}" is required.`);
  return value;
}
const id = (value: unknown, name: string, max = 64): string => { if (typeof value !== 'string' || value.length === 0 || value.length > max || !/^[\w.:-]+$/.test(value)) throw invalid(`${name} must be an identifier of at most ${max} characters.`); return value; };

/** Bounds every operation's input in its canonical object form; anything else is refused. */
export function checkInput<O extends SandboxOperation>(op: O, input: unknown): SandboxRequest<O> {
  const checked = ((): unknown => {
    switch (op as SandboxOperation) {
      case 'capabilities': case 'health': case 'sources': case 'channels': case 'config': case 'dev.principals':
        if (input !== null) throw invalid('This operation takes no input.'); return null;
      case 'config.validate': case 'config.export': { const { config } = exact(input, ['config']); if (!isPlainObject(config)) throw invalid('config must be a JSON object.'); return { config }; }
      case 'source-checks': case 'sources.resume': return { sourceId: id(exact(input, ['sourceId'])['sourceId'], 'sourceId') };
      case 'preview-sessions': return { fixturePrincipalRef: id(exact(input, ['fixturePrincipalRef'])['fixturePrincipalRef'], 'fixturePrincipalRef') };
      case 'dev.disconnect': return { previewSessionId: id(exact(input, ['previewSessionId'])['previewSessionId'], 'previewSessionId', 128) };
      case 'dev.fixtures.advance': {
        const fields = exact(input, ['sourceId', 'count']); const count = fields['count'];
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > ADVANCE_LIMIT) throw invalid(`count must be an integer from 1 to ${ADVANCE_LIMIT}.`);
        return { sourceId: id(fields['sourceId'], 'sourceId'), count };
      }
      case 'traces': {
        const fields = exact(input, [], ['limit', 'cursor', 'sourceId', 'channel', 'outcome']); const out: Record<string, unknown> = {};
        if (fields['limit'] !== undefined) { const limit = fields['limit']; if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > TRACE_QUERY_LIMIT) throw invalid(`limit must be an integer from 1 to ${TRACE_QUERY_LIMIT}.`); out['limit'] = limit; }
        if (fields['cursor'] !== undefined) { const cursor = fields['cursor']; if (typeof cursor !== 'string' || !/^[\w-]{1,128}$/.test(cursor)) throw invalid('cursor is malformed.'); out['cursor'] = cursor; }
        if (fields['sourceId'] !== undefined) out['sourceId'] = id(fields['sourceId'], 'sourceId');
        if (fields['channel'] !== undefined) { if (!isIdentifier(fields['channel'])) throw invalid('channel must be an identifier.'); out['channel'] = fields['channel']; }
        if (fields['outcome'] !== undefined) { if (!['ok', 'filtered', 'rejected', 'failed'].includes(fields['outcome'] as string)) throw invalid('outcome must be ok, filtered, rejected, or failed.'); out['outcome'] = fields['outcome']; }
        return out;
      }
    }
  })();
  return checked as SandboxRequest<O>;
}

/** Query parameters, checked before the header and body as WHC-1 rev 0.2 §9 orders it: only `traces` takes any. */
export function queryInput(op: SandboxOperation, query: URLSearchParams): Record<string, unknown> | null {
  const keys = [...query.keys()];
  if (op !== 'traces') { if (keys.length) throw invalid(`Unknown query parameter "${keys[0]!.slice(0, 64)}".`); return null; }
  if (new Set(keys).size !== keys.length) throw invalid('Duplicate query parameter.');
  const input: Record<string, unknown> = Object.fromEntries(query);
  if (input['limit'] !== undefined) { if (!/^\d{1,3}$/.test(input['limit'] as string)) throw invalid(`limit must be an integer from 1 to ${TRACE_QUERY_LIMIT}.`); input['limit'] = Number(input['limit']); }
  checkInput(op, input);
  return input;
}

/** The canonical input of a WHC-1 request: GET operations take no query except `traces`; POST operations take their JSON body. */
export function inputFromRequest(op: SandboxOperation, query: URLSearchParams, body: unknown): unknown {
  const fromQuery = queryInput(op, query);
  return checkInput(op, op === 'traces' ? fromQuery : body === undefined ? null : body);
}
