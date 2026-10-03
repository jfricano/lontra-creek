/**
 * The Lab's capability summary (GET /api/lab/capabilities) and the PROPOSED intent
 * parser. See docs/contracts/lab-api.md section 12.
 *
 * The summary is app-owned and safe for anyone: the installed StreamOtter version, the
 * backend mode, and which scenarios this backend can run, with a reason for each one it
 * can't. It never carries a URL, secret, socket path, or operator capability.
 *
 * No published StreamOtter release provides quarantine, a recovery guard, evaluation,
 * or an operator service yet (docs/releases/v1.1/BASELINE.md section 3), so every new
 * source-failures scenario is unavailable and every intent is refused. Nothing here
 * calls an unpublished API or reports a simulated success.
 */
import { createRequire } from 'node:module';
import type { LabAvailability, LabCapabilities, LabIntent, LabIntentRequest, LabScenarioId } from './contract.ts';
import { LabError } from './errors.ts';

/** The Lab contract revision this backend implements. */
export const LAB_CONTRACT = '2026-10-03 (V1.1 W4)';
/** Read from the installed package, never hand-typed: the version the field station actually runs. */
export const INSTALLED_STREAMOTTER: string = (createRequire(import.meta.url)('streamotter/package.json') as { version: string }).version;
/** Releases whose published source was checked and found to provide none of NATIVE (BASELINE.md section 3). */
export const VERIFIED_WITHOUT_FAILURE_HANDLING: ReadonlySet<string> = new Set(['0.1.0-rc.3']);

/** What a new scenario needs from the library, named for visitors. */
type Native = 'quarantine' | 'a recovery guard' | 'incident evaluation' | 'controlled reprocessing' | 'bounded retry for transient mapper errors' | 'an automatic-continuation limit' | 'a durable failure journal';
/** Scenarios the current bench already runs with its LabActions. */
export const EXISTING_SCENARIOS = ['fouled-sensor', 'relay-cut', 'slow-client', 'relay-restart'] as const satisfies readonly LabScenarioId[];
type NewScenario = Exclude<LabScenarioId, (typeof EXISTING_SCENARIOS)[number]>;
/** Companion plan section 4: what each new story depends on in the native library. */
const NEEDS: Record<NewScenario, Native[]> = {
  'garbled-reading': ['quarantine'],
  'bad-projection': ['quarantine', 'a recovery guard'],
  'inspect-old-reading': ['incident evaluation', 'controlled reprocessing'],
  'conflicting-readings': ['quarantine', 'a recovery guard'],
  'calibration-blip': ['bounded retry for transient mapper errors'],
  'too-many-bad-readings': ['quarantine', 'an automatic-continuation limit'],
  'restart-recovery': ['a durable failure journal', 'a recovery guard'],
  'unavailable-evidence': ['quarantine', 'a durable failure journal']
};
export const SCENARIOS = [...EXISTING_SCENARIOS, ...Object.keys(NEEDS) as NewScenario[]] as readonly LabScenarioId[];
/** The source-failures track, LC11-S01 to S09: the scenarios `scenario.start` may name. */
export const SOURCE_SCENARIOS: readonly LabScenarioId[] = ['fouled-sensor', ...Object.keys(NEEDS) as NewScenario[]];
export const INTENTS = ['scenario.start', 'scenario.restore-calibration', 'scenario.prepare-coverage', 'incident.retry-current', 'incident.reassess', 'incident.evaluate', 'incident.approve-reprocess'] as const satisfies readonly LabIntent[];

const list = (items: readonly string[]): string => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} or ${items.at(-1)}`;
/** Unavailable because the library lacks something: certain for a verified release, otherwise only "not integrated". */
function lacking(needs: readonly Native[], version: string): LabAvailability {
  return VERIFIED_WITHOUT_FAILURE_HANDLING.has(version)
    ? { available: false, reason: { code: 'library-lacks-capability', text: `This backend's StreamOtter release (${version}) doesn't provide ${list([...new Set(needs)])}.` } }
    : { available: false, reason: { code: 'not-integrated', text: `This backend's Lab hasn't been verified against StreamOtter ${version}'s failure handling, so it doesn't run this exercise.` } };
}

export function labCapabilities(options: { labEnabled: boolean; now: number; version?: string }): LabCapabilities {
  const version = options.version ?? INSTALLED_STREAMOTTER;
  const bench: LabAvailability = options.labEnabled ? { available: true, reason: null } : { available: false, reason: { code: 'lab-disabled', text: "This backend has no Lab benches." } };
  return {
    now: new Date(options.now).toISOString(), contract: LAB_CONTRACT,
    library: { name: 'streamotter', version },
    backend: { mode: 'real-kafka-synthetic', lab: options.labEnabled ? 'enabled' : 'disabled' },
    scenarios: SCENARIOS.map(id => ({ id, ...(id in NEEDS ? lacking(NEEDS[id as NewScenario], version) : bench) })),
    features: { incidentProjection: lacking(['quarantine'], version), intents: lacking(Object.values(NEEDS).flat(), version) }
  };
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const PLAN_TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
const KEYS = new Set(['intent', 'requestId', 'scenario', 'expectedRevision', 'planToken']);
/** Validates a PROPOSED intent body; 400 `invalid-request` for anything outside section 12's shape. */
export function parseIntent(body: Record<string, unknown>): LabIntentRequest {
  const { intent, requestId, scenario, expectedRevision, planToken } = body;
  const ok = Object.keys(body).every(key => KEYS.has(key))
    && INTENTS.includes(intent as LabIntent)
    && typeof requestId === 'string' && REQUEST_ID.test(requestId)
    && (intent === 'scenario.start' ? SOURCE_SCENARIOS.includes(scenario as LabScenarioId) : scenario === undefined)
    && (expectedRevision === undefined ? intent === 'scenario.start' : Number.isSafeInteger(expectedRevision) && (expectedRevision as number) >= 0)
    && (intent === 'incident.approve-reprocess' ? typeof planToken === 'string' && PLAN_TOKEN.test(planToken) : planToken === undefined);
  if (!ok) throw new LabError('invalid-request', 400);
  return { intent: intent as LabIntent, requestId: requestId as string, ...(scenario === undefined ? {} : { scenario: scenario as LabScenarioId }), ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision as number }), ...(planToken === undefined ? {} : { planToken: planToken as string }) };
}

/** Every intent, today: no installed release supports one, so a well-formed intent is refused, not simulated. */
export function refuseIntent(body: Record<string, unknown>): never {
  parseIntent(body);
  throw new LabError('unsupported-scenario', 409);
}
