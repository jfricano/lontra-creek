/**
 * A bench study's StreamOtter failure journal (Lab contract section 8b).
 *
 * StreamOtter never creates a journal at startup: a gateway with a `stateDirectory`
 * refuses to start without one, so a lost journal is always a visible error. The only
 * published way to create one is the CLI's `streamotter init --failures`, so the bench
 * runs exactly that, in-process, through `runCli` from `streamotter/cli`. It reads the
 * project configuration as a JSON file; the bench writes the study's configuration
 * (secret references only, never secret values) owner-only next to the journal and
 * removes it afterwards.
 *
 * The journal lives at <stateDir>/lab-N/studies/<studyId>/journal/ (study.ts) and goes
 * with the study's directory at a reset. A bench process or container restart with the
 * volume intact reopens it: the library replaces a lock left by a dead process.
 */
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig } from 'streamotter/contracts';
import { runCli } from 'streamotter/cli';

/** The journal file StreamOtter keeps in its state directory. */
export const JOURNAL_FILE = 'journal.sqlite';

export const hasJournal = (stateDirectory: string): boolean => existsSync(join(stateDirectory, JOURNAL_FILE));

/**
 * Creates the study's journal with `streamotter init --failures`. Refuses (as the CLI
 * does) when one already exists: its decision state is never overwritten. The CLI's
 * own words are kept for the error, which names only paths and the project.
 */
export async function createJournal(config: ProjectConfig, stateDirectory: string, workDirectory: string): Promise<void> {
  const file = join(workDirectory, 'failures-config.json');
  const said: string[] = [];
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  try {
    const code = await runCli(['init', '--failures', '--config', file, '--state-dir', stateDirectory], { out: line => { said.push(line); }, err: line => { said.push(line); }, shutdownSignal: new Promise<string>(() => undefined) });
    if (code !== 0) throw new Error(`streamotter init --failures exited ${code}: ${said.join(' ').slice(0, 500)}`);
  } finally { await rm(file, { force: true }); }
}
