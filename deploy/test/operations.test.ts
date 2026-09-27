import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const operations = fileURLToPath(new URL('../operations/', import.meta.url));
const sha = '1'.repeat(40);
const bad = '2'.repeat(40);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lontra-operations-'));
  mkdirSync(join(dir, 'releases'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'stack.env'), 'FIELD_STATION_SECRET=fixture-only\n');
  // Exercise the deployment orchestration without root or Docker. Only the root
  // guard and fixed host path are replaced; CI rehearses the unmodified script.
  const source = readFileSync(join(operations, 'deploy.sh'), 'utf8')
    .replace('[ "$EUID" -eq 0 ] || { echo \'Run as root.\' >&2; exit 2; }', ':')
    .replace('root=/srv/lontra', `root="${dir}"`);
  writeFileSync(join(dir, 'deploy.sh'), source);
  writeFileSync(join(dir, 'bin/flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(dir, 'bin/docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args.includes('up')) {
  const env = fs.readFileSync(args[args.indexOf('--env-file') + 1], 'utf8');
  if (env.includes('${bad}') || process.env.FAIL_ALL === '1') process.exit(1);
}
`, { mode: 0o755 });
  const run = (tag: string, extra = {}) => spawnSync('bash', [join(dir, 'deploy.sh'), tag], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, CALLS: join(dir, 'calls'), ...extra },
  });
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
  return { dir, run, calls, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('successful deploy records a release; failed candidate restores it and fails the command', () => {
  const f = fixture();
  try {
    assert.equal(f.run(sha).status, 0);
    const current = readFileSync(join(f.dir, 'current.env'), 'utf8');
    assert.ok(current.includes(`LONTRA_IMAGE=ghcr.io/jfricano/lontra-creek:${sha}`));
    const failed = f.run(bad);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Previous release restored/);
    assert.equal(readFileSync(join(f.dir, 'current.env'), 'utf8'), current);
    assert.equal(readFileSync(join(f.dir, 'current.sha'), 'utf8').trim(), sha);
    assert.equal(f.calls().filter(args => args.includes('up')).length, 3);
    assert.ok(!failed.stdout.includes('fixture-only'));
  } finally { f.close(); }
});

test('first deployment failure stops services without deleting volumes or recording success', () => {
  const f = fixture();
  try {
    assert.equal(f.run(bad).status, 1);
    assert.ok(!existsSync(join(f.dir, 'current.env')));
    assert.ok(f.calls().some(args => args.includes('down') && !args.includes('--volumes')));
  } finally { f.close(); }
});

test('rollback failure is explicit and keeps the last release record', () => {
  const f = fixture();
  try {
    assert.equal(f.run(sha).status, 0);
    const result = f.run(bad, { FAIL_ALL: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ROLLBACK FAILED/);
    assert.equal(readFileSync(join(f.dir, 'current.sha'), 'utf8').trim(), sha);
  } finally { f.close(); }
});

test('deployment and SSH entrypoints refuse tags and command injection before Docker or sudo', () => {
  const f = fixture();
  try {
    for (const value of ['latest', `deploy ${sha}; id`, '-x', sha.toUpperCase().replace('1', 'A')]) {
      assert.equal(f.run(value).status, 2);
      const ssh = spawnSync('bash', [join(operations, 'ssh-command.sh')], {
        encoding: 'utf8', env: { ...process.env, SSH_ORIGINAL_COMMAND: value },
      });
      assert.equal(ssh.status, 2);
    }
    assert.ok(!existsSync(join(f.dir, 'calls')));
  } finally { f.close(); }
});

test('checkpoint backup, verify and restore preserve the world and refuse mismatched study settings', async () => {
  const { createWorld } = await import('@lontra-creek/sim');
  const dir = mkdtempSync(join(tmpdir(), 'lontra-checkpoint-'));
  const helper = readFileSync(join(operations, 'checkpoint.mjs'), 'utf8');
  const epoch = '2026-09-27T00:00:00Z';
  const checkpoint = JSON.stringify({ format: 1, epoch, tickMs: 2000, world: createWorld({ seed: 'lontra-creek' }) });
  const run = (action: string, text = checkpoint, extra = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', helper, action], {
    encoding: 'utf8', input: text,
    cwd: fileURLToPath(new URL('../../apps/field-station/', import.meta.url)),
    env: { ...process.env, FIELD_DATA_DIR: dir, FIELD_EPOCH: epoch, FIELD_GENERATION: '1', FIELD_TICK_MS: '2000', ...extra },
  });
  try {
    writeFileSync(join(dir, 'world.json'), checkpoint);
    assert.equal(run('backup').stdout, checkpoint);
    assert.equal(run('verify').status, 0);
    assert.notEqual(run('verify', checkpoint, { FIELD_GENERATION: '2' }).status, 0);
    assert.notEqual(run('verify', checkpoint, { FIELD_EPOCH: '2026-09-26T00:00:00Z' }).status, 0);
    assert.notEqual(run('verify', '{broken').status, 0);
    writeFileSync(join(dir, 'world.json'), 'previous-file');
    assert.equal(run('restore').status, 0);
    assert.equal(readFileSync(join(dir, 'world.json'), 'utf8'), checkpoint);
    assert.ok(!existsSync(join(dir, 'world.json.restore')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('alarm generator writes disabled, instance-scoped definitions and refuses overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lontra-alarms-'));
  const args = [join(operations, 'alarm-definitions.mjs'), 'ocid1.compartment.oc1..test', 'ocid1.instance.oc1..test', 'ocid1.onstopic.oc1..test', dir];
  try {
    assert.equal(spawnSync(process.execPath, args).status, 0);
    for (const name of ['memory-low', 'instance-unavailable', 'instance-telemetry-absent']) {
      const alarm = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
      assert.equal(alarm.isEnabled, false);
      assert.match(alarm.query, /resourceId="ocid1\.instance\.oc1\.\.test"/);
      assert.deepEqual(alarm.destinations, ['ocid1.onstopic.oc1..test']);
    }
    assert.notEqual(spawnSync(process.execPath, args).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
