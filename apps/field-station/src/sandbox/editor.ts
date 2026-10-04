/**
 * The restricted candidate editor (sandbox contract §5). A candidate is a full
 * ProjectConfig; it may differ from the slot's server-owned base only at the listed
 * JSON pointers, within their bounds. The first difference anywhere else is refused,
 * named by its pointer, before the published validator runs. A candidate is only
 * ever validated or exported: nothing here touches a running gateway.
 */
import { canonicalJson, DEFAULT_LIMITS, isPlainObject, utf8ByteLength, validateProjectConfig, type ConfigIssue, type Limits, type ProjectConfig } from 'streamotter/contracts';
import { CONFIG_BODY_BYTES, SandboxFault } from './operations.ts';

/** The editable limits and the slot's server maximum for each. */
export const EDITABLE_LIMITS = ['receiptTimeoutMs', 'maxSubscriptionsPerConnection', 'maxPendingFramesPerSubscription'] as const;
export type EditableMaxima = Readonly<Record<(typeof EDITABLE_LIMITS)[number], number>>;
export const VERSION_MAX = 99;

const pointer = (path: readonly string[]): string => path.map(key => `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
const same = (a: unknown, b: unknown): boolean => a === b || a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b);
const refuse = (path: readonly string[]): ConfigIssue => ({ path: pointer(path), code: 'FIELD_NOT_EDITABLE', message: `${pointer(path) || 'The document'} is server-owned in the sandbox.` });
const bound = (path: readonly string[], max: number): ConfigIssue => ({ path: pointer(path), code: 'VALUE_OUT_OF_BOUNDS', message: `${pointer(path)} must be an integer from 1 to ${max}.` });
const within = (value: unknown, max: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;

/** The first refused difference, in the base's key order and then the candidate's added keys, or null. */
export function reviewCandidate(base: ProjectConfig, candidate: unknown, maxima: EditableMaxima): ConfigIssue | null {
  const walk = (a: unknown, b: unknown, path: readonly string[]): ConfigIssue | null => {
    const [top, key, leaf] = path;
    if (top === 'schemas' && path.length >= 2 && Object.hasOwn(base.schemas, key!)) return b === undefined ? refuse(path) : null;
    if (top === 'channels' && path.length === 3 && leaf === 'version' && Object.hasOwn(base.channels, key!)) return same(a, b) ? null : within(b, VERSION_MAX) ? null : b === undefined ? refuse(path) : bound(path, VERSION_MAX);
    if (top === 'limits' && path.length === 2 && (EDITABLE_LIMITS as readonly string[]).includes(key!)) {
      const max = maxima[key as keyof EditableMaxima];
      return same(a, b) ? null : within(b ?? DEFAULT_LIMITS[key as keyof Limits], max) ? null : bound(path, max);
    }
    if (path.length === 1 && top === 'limits' && (a === undefined || b === undefined)) {
      if (a === undefined && isPlainObject(b)) return walk({}, b, path);
      if (isPlainObject(a) && b === undefined) return walk(a, {}, path);
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const k of Object.keys(a)) { const issue = walk(a[k], b[k], [...path, k]); if (issue) return issue; }
      for (const k of Object.keys(b)) if (!Object.hasOwn(a, k)) { const issue = walk(undefined, b[k], [...path, k]); if (issue) return issue; }
      return null;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) { const issue = walk(a[i], b[i], [...path, String(i)]); if (issue) return issue; }
      return null;
    }
    return same(a, b) ? null : refuse(path);
  };
  return isPlainObject(candidate) ? walk(base, candidate, []) : refuse([]);
}

/** Size, then the allowlist, then the published validator. */
export function validateCandidate(base: ProjectConfig, candidate: unknown, maxima: EditableMaxima): { valid: boolean; issues: ConfigIssue[]; refused: boolean } {
  if (utf8ByteLength(JSON.stringify(candidate) ?? '') > CONFIG_BODY_BYTES) throw new SandboxFault('candidate-too-large', 'The candidate exceeds 64 KB.');
  const refusal = reviewCandidate(base, candidate, maxima);
  if (refusal) return { valid: false, issues: [refusal], refused: true };
  return { ...validateProjectConfig(candidate), refused: false };
}
