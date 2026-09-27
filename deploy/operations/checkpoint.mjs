// Runs inside the field-station container with its configured environment.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, restore } from '@lontra-creek/sim';

const action = process.argv[1];
const path = join(process.env.FIELD_DATA_DIR ?? '/var/lib/lontra', 'world.json');
const text = readFileSync(action === 'backup' ? path : 0, 'utf8');
if (text.length > 10 * 1024 * 1024) throw new Error('Checkpoint exceeds 10 MiB.');
const checkpoint = JSON.parse(text);
// Server config normalizes epochs to ISO milliseconds; env may use plain Z.
const checkpointEpoch = Date.parse(checkpoint.epoch);
const configuredEpoch = Date.parse(process.env.FIELD_EPOCH ?? '');
if (checkpoint.format !== 1 || !Number.isFinite(checkpointEpoch) || checkpointEpoch !== configuredEpoch ||
    checkpoint.tickMs !== Number(process.env.FIELD_TICK_MS ?? 2000)) {
  throw new Error('Checkpoint format, epoch, or tick length does not match this deployment.');
}
const world = restore(JSON.stringify(checkpoint.world));
if (world.generation !== Number(process.env.FIELD_GENERATION ?? 1) ||
    world.seed !== createWorld({ seed: 'lontra-creek' }).seed) {
  throw new Error('Checkpoint generation or seed does not match this deployment.');
}
if (action === 'backup') process.stdout.write(text);
else if (action === 'verify') console.log(`Checkpoint verified at tick ${world.tick}.`);
else if (action === 'restore') {
  writeFileSync(`${path}.restore`, text, { mode: 0o600 });
  renameSync(`${path}.restore`, path);
  console.log(`Checkpoint restored at tick ${world.tick}.`);
} else throw new Error('Expected backup, verify, or restore.');
