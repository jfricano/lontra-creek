/**
 * A bench's study (LC11-ADR-02): the identity every lease runs under, persisted on
 * the bench's own volume so a gateway restart, a bench process restart, or a
 * container restart with the volume intact resumes the same study.
 *
 *   <stateDir>/lab-N/study.json                 the current study descriptor
 *   <stateDir>/lab-N/studies/<studyId>/         the study's journal directory
 *   <stateDir>/lab-N/summaries/<studyId>.json   bounded metadata of discarded studies
 *
 * A study is `provisioning` until its new gateway has consumed once, then `clean`
 * (eligible for a lease), then `open` once a lease is bound to it. An open study is
 * never handed to another lease: only a reset (study discard) ends it.
 *
 *   <stateDir>/lab-N/studies/<studyId>/journal/ the study's StreamOtter failure journal
 *
 * With failure handling (LAB_FAILURE_HANDLING other than `off`), the bench creates the
 * study's native failure journal under its directory when it provisions the study
 * (journal.ts), and every gateway of the study opens it; it is removed with the
 * study's directory. Nothing here emulates native recovery state.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bench as benchNamed } from './benches.ts';
import type { BenchStudy, StudySummary } from './contract.ts';

const FORMAT = 1;
/** Discarded-study summaries kept per bench; older ones are deleted. */
export const SUMMARIES_KEPT = 20;
const STUDY_ID = /^[A-Za-z0-9_-]{16}$/;

export interface StudyDescriptor extends BenchStudy {
  format: typeof FORMAT;
  bench: number;
  /** The lease bound to an open study, so a restarted bench process keeps serving it. Tokens are never persisted. */
  lease: { leaseId: string; expiresAt: string } | null;
  /** Scenario state the bench's handlers read, restored with the study. */
  calibration: 'present' | 'removed';
  /** Which projection the `lab-projection-v2` records go through: `corrected` once an inspect-old-reading start switched it. */
  mapping: 'broken' | 'corrected';
  /** calibration-blip starts in this study, and the transient failures still armed for the next live LC-03 reading. */
  blips: number;
  blip: number;
}

/** URL-safe and short enough that `lab-N-<studyId>` passes rc.3's identifier rule ([A-Za-z][A-Za-z0-9_-]{0,63}). */
export function newStudyId(): string { return randomBytes(12).toString('base64url'); }
export const generationFor = (bench: number, studyId: string): string => `lab-${bench}-${studyId}`;
/** Inside the prefix bench N's Kafka ACLs allow (`Bench.consumerGroupPrefix`, streamotter-lab-N-). */
export const consumerGroupFor = (bench: number, studyId: string): string => `${benchNamed(bench).consumerGroupPrefix}${studyId}`;

export function newStudy(bench: number, at: number, studyId = newStudyId()): StudyDescriptor {
  return { format: FORMAT, bench, studyId, generation: generationFor(bench, studyId), consumerGroup: consumerGroupFor(bench, studyId), createdAt: new Date(at).toISOString(), phase: 'provisioning', restarts: { gateway: 0, process: 0 }, lease: null, calibration: 'present', mapping: 'broken', blips: 0, blip: 0 };
}

/** A descriptor read back from disk, or null when it is missing, unreadable, or not this bench's. */
export function parseStudy(bench: number, text: string): StudyDescriptor | null {
  let value: Partial<StudyDescriptor>;
  try { value = JSON.parse(text) as Partial<StudyDescriptor>; } catch { return null; }
  if (!value || value.format !== FORMAT || value.bench !== bench || typeof value.studyId !== 'string' || !STUDY_ID.test(value.studyId)) return null;
  if (value.generation !== generationFor(bench, value.studyId) || value.consumerGroup !== consumerGroupFor(bench, value.studyId)) return null;
  if (!['provisioning', 'clean', 'open'].includes(value.phase as string) || typeof value.createdAt !== 'string' || !['present', 'removed'].includes(value.calibration as string)) return null;
  const lease = value.lease;
  if (lease !== null && (typeof lease !== 'object' || typeof lease.leaseId !== 'string' || typeof lease.expiresAt !== 'string')) return null;
  const restarts = value.restarts;
  if (!restarts || !Number.isSafeInteger(restarts.gateway) || !Number.isSafeInteger(restarts.process)) return null;
  // Written before failure handling: its handlers were the broken projection with nothing armed.
  value.mapping ??= 'broken'; value.blips ??= 0; value.blip ??= 0;
  if (!['broken', 'corrected'].includes(value.mapping) || !Number.isSafeInteger(value.blips) || !Number.isSafeInteger(value.blip) || value.blips < 0 || value.blip < 0) return null;
  return value as StudyDescriptor;
}

/** The bench's study files. Every write is write-then-rename. */
export class StudyStore {
  readonly #root: string;
  readonly #bench: number;
  constructor(stateDir: string, bench: number) { this.#root = join(stateDir, `lab-${bench}`); this.#bench = bench; }
  get root(): string { return this.#root; }
  directory(studyId: string): string { if (!STUDY_ID.test(studyId)) throw new Error('Invalid study ID.'); return join(this.#root, 'studies', studyId); }
  /** The study's failure journal directory: the gateway's `stateDirectory`. */
  journal(studyId: string): string { return join(this.directory(studyId), 'journal'); }
  /** The persisted study; `corrupt` when a descriptor exists but cannot be trusted. */
  async load(): Promise<StudyDescriptor | null | 'corrupt'> {
    let text: string;
    try { text = await readFile(join(this.#root, 'study.json'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    return parseStudy(this.#bench, text) ?? 'corrupt';
  }
  async save(study: StudyDescriptor): Promise<void> {
    await mkdir(this.directory(study.studyId), { recursive: true });
    await this.#write(join(this.#root, 'study.json'), study);
  }
  /** Removes a study's journal directory. Missing is fine: removal is idempotent. */
  async remove(studyId: string): Promise<void> { await rm(this.directory(studyId), { recursive: true, force: true }); }
  /** Studies with a directory on the volume, for sweeping strays left by a crash mid-reset. */
  async studies(): Promise<string[]> { try { return (await readdir(join(this.#root, 'studies'))).filter(name => STUDY_ID.test(name)); } catch { return []; } }
  /** Writes a discarded study's summary once: a retried discard never replaces the first, fuller record. */
  async summarize(summary: StudySummary): Promise<void> {
    const dir = join(this.#root, 'summaries'); const path = join(dir, `${summary.studyId}.json`);
    await mkdir(dir, { recursive: true });
    try { await stat(path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.#write(path, summary);
    const files = (await readdir(dir)).filter(name => name.endsWith('.json'));
    if (files.length <= SUMMARIES_KEPT) return;
    const dated = await Promise.all(files.map(async name => { try { return { name, at: (JSON.parse(await readFile(join(dir, name), 'utf8')) as StudySummary).closedAt }; } catch { return { name, at: '' }; } }));
    dated.sort((a, b) => a.at.localeCompare(b.at));
    for (const { name } of dated.slice(0, dated.length - SUMMARIES_KEPT)) await rm(join(dir, name), { force: true });
  }
  async summaries(): Promise<StudySummary[]> {
    const dir = join(this.#root, 'summaries');
    let files: string[]; try { files = await readdir(dir); } catch { return []; }
    return (await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as StudySummary))).sort((a, b) => a.closedAt.localeCompare(b.closedAt));
  }
  async #write(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(value));
    await rename(`${path}.tmp`, path);
  }
}
