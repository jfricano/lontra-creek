/**
 * The Lab's capability summary (GET /api/lab/capabilities) and the intent parser.
 * See docs/contracts/lab-api.md section 12.
 *
 * The summary is app-owned and safe for anyone: the installed StreamOtter version, the
 * backend mode, and which scenarios this backend can run, with a reason for each one it
 * can't. It never carries a URL, secret, socket path, or operator capability.
 *
 * A new source-failures scenario is offered only when recorded evidence (VERIFIED_WITH)
 * matches what is running: the installed release, the exact StreamOtter packages the
 * lockfile installed (their `integrity`), and this deployment's failure-handling profile,
 * each proven for that scenario by its real-Kafka test. It also needs Lab benches.
 * Nothing here reports a simulated success.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runsUnder } from './bench.ts';
import type { BenchFailureProfile, LabAvailability, LabCapabilities, LabIntent, LabIntentRequest, LabScenarioId } from './contract.ts';
import { LabError } from './errors.ts';

/** The Lab contract revision this backend implements. */
export const LAB_CONTRACT = '2026-10-04 (V1.1 W9b)';
/** Read from the installed package, never hand-typed: the version the field station actually runs. */
export const INSTALLED_STREAMOTTER: string = (createRequire(import.meta.url)('streamotter/package.json') as { version: string }).version;
/** The StreamOtter packages a lockfile installs, each lockfile path (`node_modules/streamotter`, `node_modules/@streamotter/cli`, …) to its `integrity`. */
export type StreamOtterIntegrity = Readonly<Record<string, string>>;
const isStreamOtter = (name: string): boolean => name === 'streamotter' || name.startsWith('@streamotter/');
/** Every StreamOtter package in a parsed package-lock.json, with its integrity (null for one without). */
export function streamOtterIntegrity(lock: { packages?: Record<string, { name?: string; integrity?: string }> }): Record<string, string | null> {
  const found: Record<string, string | null> = {};
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const at = path.lastIndexOf('node_modules/');
    if (at !== -1 && isStreamOtter(entry.name ?? path.slice(at + 'node_modules/'.length))) found[path] = entry.integrity ?? null;
  }
  return found;
}
/**
 * The integrity of the StreamOtter packages installed here, from the lockfile beside the
 * node_modules that holds the loaded `streamotter` (what `npm ci` installed, and checked,
 * exactly). Null when there is no lockfile to read: then nothing counts as verified.
 */
function installedIntegrity(): StreamOtterIntegrity | null {
  try {
    const root = dirname(dirname(dirname(createRequire(import.meta.url).resolve('streamotter/package.json'))));
    const found = streamOtterIntegrity(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as Parameters<typeof streamOtterIntegrity>[0]);
    return Object.values(found).every(value => value !== null) && Object.keys(found).length > 0 ? found as StreamOtterIntegrity : null;
  } catch { return null; }
}
export const INSTALLED_INTEGRITY: StreamOtterIntegrity | null = installedIntegrity();
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
/** What one release's real-Kafka evidence proved. */
export interface Verification {
  /** The exact StreamOtter packages it ran: every lockfile path and `integrity` (StreamOtterIntegrity). */
  packages: StreamOtterIntegrity;
  /** Each scenario it proved, with the failure-handling profiles it was proven under. */
  scenarios: Readonly<Partial<Record<NewScenario, readonly BenchFailureProfile[]>>>;
  /** The run, for readers: the suite, the stack, the date. */
  evidence: string;
}
/**
 * The evidence this backend's Lab was verified with, per installed release (lab-api.md
 * section 12.3). A scenario is recorded only after deploy/test/lab-source-failures.test.ts
 * passes for it on dev:lab, and only for the profiles that run used; until then it is
 * `not-integrated`. A different build of the same version (another tarball, as when the
 * pre-publish pack gave way to the registry release on October 5) matches nothing: the suite is run
 * again on that install and the evidence re-recorded (test/lab-capabilities.test.ts fails
 * until then).
 */
export const VERIFIED_WITH: ReadonlyMap<string, Verification> = new Map([['0.2.0-rc.1', {
  // The registry release, as package-lock.json installs it (published October 5, 2026).
  packages: {
    'node_modules/@streamotter/cli': 'sha512-y8It80MUcxh8d7XtnJdeO5Rpswy1AQ/wE8jvFO92mZPAeKV+CzNnab/TiaknIVssXAA12X4B7s5E3qiZo9ovQQ==',
    'node_modules/@streamotter/client': 'sha512-SnsFBGSEKgOPEZOxgpD/viUw5BXwZLtEOYWj4R19RZxgQyXCTpPt/HAsbsPr7YgHKCBB+BMivSiq+N0fw5ECyw==',
    'node_modules/@streamotter/contracts': 'sha512-7aCW7zBOenyS0b8j5Jjrr0tk5NW6XjBjtcjdRC1qyYtOka60Wt/5DlVYjVHSO0+sTE4BYKAp9KbdmTBQb9LRTQ==',
    'node_modules/@streamotter/gateway': 'sha512-ep6W92ZYpsdH5eommxIv5vQaKyCujyO6vy1/MDbqUJ2n/EZipceGpZ1vEUectNRQcS9o0hdtHmICf5doJv4tFQ==',
    'node_modules/@streamotter/workbench': 'sha512-Yn8gCDuho4JAayHVDzekx9DubhPAnn1PlrQ4rmTcEE0ljpIfz2X00A492Y+wCv2zs+l5Sj/17lidxJBjaTao9A==',
    'node_modules/streamotter': 'sha512-Xw9sObzC1vmptYpEDDBOOeaQAkJxbV3oCh8FGpF5/UEGlmSuMbyC7IUSdgpcjTY8AQldhsL5Xe1u916G6K2xNA=='
  },
  scenarios: {
    'garbled-reading': ['quarantine'], 'bad-projection': ['quarantine'], 'inspect-old-reading': ['quarantine'], 'conflicting-readings': ['quarantine'],
    'calibration-blip': ['quarantine', 'retry'],
    'too-many-bad-readings': ['quarantine'], 'restart-recovery': ['quarantine'], 'unavailable-evidence': ['quarantine']
  },
  evidence: 'deploy/test/lab-source-failures.test.ts on npm run dev:lab built from the registry lockfile, October 5, 2026: all eight under quarantine with KAFKA_AUTHORIZATION=acl (11/11); calibration-blip also under retry with KAFKA_AUTHORIZATION=none (S01, S06 and A32 passed); deploy/test/sandbox.test.ts 7/7 on the same stack'
}]]);
export const INTENTS = ['scenario.start', 'scenario.restore-calibration', 'scenario.prepare-coverage', 'incident.retry-current', 'incident.reassess', 'incident.evaluate', 'incident.approve-reprocess'] as const satisfies readonly LabIntent[];

/** The deployment facts the summary depends on, besides the library: read once at startup (leases.ts). */
export interface CapabilityOptions {
  /** LAB_FAILURE_HANDLING: the profile every bench must report. */
  profile: BenchFailureProfile;
  /** LAB_LOCAL_EXERCISES: the local and CI exercises are offered too. */
  localExercises: boolean;
  /** Tests inject the evidence; production uses VERIFIED_WITH. */
  verified?: ReadonlyMap<string, Verification>;
  /** Tests inject the installed packages' integrity; production reads INSTALLED_INTEGRITY. */
  integrity?: StreamOtterIntegrity | null;
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

/** True when the installed packages are exactly the ones the evidence ran. */
function samePackages(recorded: StreamOtterIntegrity, installed: StreamOtterIntegrity | null): boolean {
  if (!installed) return false;
  const paths = Object.keys(recorded);
  return paths.length === Object.keys(installed).length && paths.every(path => installed[path] === recorded[path]);
}
/** One new scenario's availability: the first reason that applies, in section 12.3's order. */
function newScenario(id: NewScenario, options: { labEnabled: boolean; version: string; integrity: StreamOtterIntegrity | null } & CapabilityOptions): LabAvailability {
  const verified = (options.verified ?? VERIFIED_WITH).get(options.version);
  const profiles = verified?.scenarios[id];
  if (VERIFIED_WITHOUT_FAILURE_HANDLING.has(options.version) || !verified || !profiles?.length) return lacking(NEEDS[id], options.version);
  if (!samePackages(verified.packages, options.integrity)) return unavailable('not-integrated', `This backend's Lab was verified against another build of StreamOtter ${options.version}, not the one installed here, so it doesn't run this exercise.`);
  if (!options.labEnabled) return LAB_DISABLED;
  if (!runsUnder(id).includes(options.profile)) return unavailable('deployment-restricted', "This deployment's Kafka authorization isn't verified for this exercise, so its failure handling doesn't run it.");
  if (!profiles.includes(options.profile)) return unavailable('not-integrated', `This backend's Lab hasn't been verified with this deployment's failure handling (${options.profile}) for this exercise, so it doesn't run it.`);
  if (LOCAL_EXERCISES.has(id) && !options.localExercises) return unavailable('deployment-restricted', 'This exercise runs only on a local Lab and in CI.');
  return AVAILABLE;
}

export function labCapabilities(options: { labEnabled: boolean; now: number; version?: string } & Partial<CapabilityOptions>): LabCapabilities {
  const version = options.version ?? INSTALLED_STREAMOTTER;
  const settings = { labEnabled: options.labEnabled, version, profile: options.profile ?? 'off', localExercises: options.localExercises ?? false, integrity: options.integrity === undefined ? INSTALLED_INTEGRITY : options.integrity, ...(options.verified ? { verified: options.verified } : {}) };
  const scenarios = SCENARIOS.map(id => ({ id, ...(id in NEEDS ? newScenario(id as NewScenario, settings) : options.labEnabled ? AVAILABLE : LAB_DISABLED) }));
  // The incident and intent features are served exactly when some new scenario is: otherwise, the first new scenario's reason.
  const offered = scenarios.filter(s => s.id in NEEDS);
  const feature = (needs: readonly Native[]): LabAvailability => offered.some(s => s.available) ? AVAILABLE
    : VERIFIED_WITHOUT_FAILURE_HANDLING.has(version) || !Object.values((settings.verified ?? VERIFIED_WITH).get(version)?.scenarios ?? {}).some(profiles => profiles?.length) ? lacking(needs, version)
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
