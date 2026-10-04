/**
 * The Lab's capability summary (GET /api/lab/capabilities) and the intent parser.
 * See docs/contracts/lab-api.md section 12.
 *
 * The summary is app-owned and safe for anyone: the installed StreamOtter version, the
 * backend mode, and which scenarios this backend can run, with a reason for each one it
 * can't. It never carries a URL, secret, socket path, or operator capability.
 *
 * A new source-failures scenario is offered only when the installed release is one this
 * backend's Lab was verified against for that scenario (VERIFIED_WITH, added scenario by
 * scenario after its real-Kafka test passes), the Lab has benches, and this deployment's
 * failure-handling profile can run it. Nothing here reports a simulated success.
 */
import { createRequire } from 'node:module';
import { runsUnder } from './bench.ts';
import type { BenchFailureProfile, LabAvailability, LabCapabilities, LabIntent, LabIntentRequest, LabScenarioId } from './contract.ts';
import { LabError } from './errors.ts';

/** The Lab contract revision this backend implements. */
export const LAB_CONTRACT = '2026-10-04 (V1.1 W9b)';
/** Read from the installed package, never hand-typed: the version the field station actually runs. */
export const INSTALLED_STREAMOTTER: string = (createRequire(import.meta.url)('streamotter/package.json') as { version: string }).version;
/** Releases whose published source was checked and found to provide none of NATIVE (BASELINE.md section 3). */
export const VERIFIED_WITHOUT_FAILURE_HANDLING: ReadonlySet<string> = new Set(['0.1.0-rc.3']);

/** What a new scenario needs from the library, named for visitors. */
type Native = 'quarantine' | 'a recovery guard' | 'incident evaluation' | 'controlled reprocessing' | 'bounded retry for transient mapper errors' | 'an automatic-continuation limit' | 'a durable failure journal';
/** Scenarios the current bench already runs with its LabActions. */
export const EXISTING_SCENARIOS = ['fouled-sensor', 'relay-cut', 'slow-client', 'relay-restart'] as const satisfies readonly LabScenarioId[];
export type NewScenario = Exclude<LabScenarioId, (typeof EXISTING_SCENARIOS)[number]>;
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
export const NEW_SCENARIOS = Object.keys(NEEDS) as NewScenario[];
export const SCENARIOS = [...EXISTING_SCENARIOS, ...NEW_SCENARIOS] as readonly LabScenarioId[];
/** The source-failures track, LC11-S01 to S09: the scenarios `scenario.start` may name. */
export const SOURCE_SCENARIOS: readonly LabScenarioId[] = ['fouled-sensor', ...NEW_SCENARIOS];
/** Exercises that need the CI harness or a restart a visitor can't make on the hosted Lab: offered only with LAB_LOCAL_EXERCISES. */
export const LOCAL_EXERCISES: ReadonlySet<LabScenarioId> = new Set(['too-many-bad-readings', 'restart-recovery', 'unavailable-evidence']);
/**
 * The scenarios this backend's Lab was verified against, per installed release. A
 * scenario is added only after its real-Kafka stack test passes on dev:lab; until then
 * it is `not-integrated` however the release is configured.
 */
export const VERIFIED_WITH: ReadonlyMap<string, ReadonlySet<LabScenarioId>> = new Map([['0.2.0-rc.1', new Set<LabScenarioId>()]]);
export const INTENTS = ['scenario.start', 'scenario.restore-calibration', 'scenario.prepare-coverage', 'incident.retry-current', 'incident.reassess', 'incident.evaluate', 'incident.approve-reprocess'] as const satisfies readonly LabIntent[];

/** The deployment facts the summary depends on, besides the library: read once at startup (leases.ts). */
export interface CapabilityOptions {
  /** LAB_FAILURE_HANDLING: the profile every bench must report. */
  profile: BenchFailureProfile;
  /** LAB_LOCAL_EXERCISES: the local and CI exercises are offered too. */
  localExercises: boolean;
  /** Tests inject the verified scenarios; production uses VERIFIED_WITH. */
  verified?: ReadonlyMap<string, ReadonlySet<LabScenarioId>>;
}

const list = (items: readonly string[]): string => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')}${items.length > 2 ? ',' : ''} or ${items.at(-1)}`;
const unavailable = (code: NonNullable<LabAvailability['reason']>['code'], text: string): LabAvailability => ({ available: false, reason: { code, text } });
const AVAILABLE: LabAvailability = { available: true, reason: null };
/** Unavailable because the library lacks something (a release checked and found lacking), or because this Lab wasn't verified against it. */
function lacking(needs: readonly Native[], version: string): LabAvailability {
  return VERIFIED_WITHOUT_FAILURE_HANDLING.has(version)
    ? unavailable('library-lacks-capability', `This backend's StreamOtter release (${version}) doesn't provide ${list([...new Set(needs)])}.`)
    : unavailable('not-integrated', `This backend's Lab hasn't been verified against StreamOtter ${version}'s failure handling, so it doesn't run this exercise.`);
}
const LAB_DISABLED = unavailable('lab-disabled', 'This backend has no Lab benches.');

/** One new scenario's availability: the first reason that applies, in section 12.3's order. */
function newScenario(id: NewScenario, options: { labEnabled: boolean; version: string } & CapabilityOptions): LabAvailability {
  const verified = (options.verified ?? VERIFIED_WITH).get(options.version);
  if (VERIFIED_WITHOUT_FAILURE_HANDLING.has(options.version) || !verified?.has(id)) return lacking(NEEDS[id], options.version);
  if (!options.labEnabled) return LAB_DISABLED;
  if (!runsUnder(id).includes(options.profile)) return unavailable('deployment-restricted', "This deployment's Kafka authorization isn't verified for this exercise, so its failure handling doesn't run it.");
  if (LOCAL_EXERCISES.has(id) && !options.localExercises) return unavailable('deployment-restricted', 'This exercise runs only on a local Lab and in CI.');
  return AVAILABLE;
}

export function labCapabilities(options: { labEnabled: boolean; now: number; version?: string } & Partial<CapabilityOptions>): LabCapabilities {
  const version = options.version ?? INSTALLED_STREAMOTTER;
  const settings = { labEnabled: options.labEnabled, version, profile: options.profile ?? 'off', localExercises: options.localExercises ?? false, ...(options.verified ? { verified: options.verified } : {}) };
  const scenarios = SCENARIOS.map(id => ({ id, ...(id in NEEDS ? newScenario(id as NewScenario, settings) : options.labEnabled ? AVAILABLE : LAB_DISABLED) }));
  // The incident and intent features are served exactly when some new scenario is: otherwise, the first new scenario's reason.
  const offered = scenarios.filter(s => s.id in NEEDS);
  const feature = (needs: readonly Native[]): LabAvailability => offered.some(s => s.available) ? AVAILABLE
    : VERIFIED_WITHOUT_FAILURE_HANDLING.has(version) || ![...(settings.verified ?? VERIFIED_WITH).get(version) ?? []].length ? lacking(needs, version)
    : { available: false, reason: offered[0]!.reason };
  return {
    now: new Date(options.now).toISOString(), contract: LAB_CONTRACT,
    library: { name: 'streamotter', version },
    backend: { mode: 'real-kafka-synthetic', lab: options.labEnabled ? 'enabled' : 'disabled' },
    scenarios,
    features: { incidentProjection: feature(['quarantine']), intents: feature(Object.values(NEEDS).flat()) }
  };
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const PLAN_TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
const KEYS = new Set(['intent', 'requestId', 'scenario', 'expectedRevision', 'planToken']);
/** Validates an intent body; 400 `invalid-request` for anything outside section 12's shape. */
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
