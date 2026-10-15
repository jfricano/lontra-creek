/**
 * Kafka authorization probes (LC11-ADR-03, docs/contracts/lab-api.md 10.9): each
 * application principal tries what it may do and what it must not, from its own
 * container, with its own credentials. Run via deploy/test/kafka-acls.test.ts, or
 *
 *   docker compose … exec -T <service> node --input-type=module - <role> < deploy/test/kafka-acl-probes.mjs
 *
 * where <role> is gateway, field-station, or bench. Prints one line per probe and
 * a final JSON summary; exits 1 when any probe's outcome differs from what the
 * contract expects. Allowed writes go only to a bench's own quarantine topic: the
 * gateway's and the field station's own traffic is proved end to end by
 * deploy/test/stack.test.ts, and writing probe records into the creek's topics
 * would reach the production gateway's handlers. The probes also try writes they
 * expect to be denied, so the script first checks that the broker denies what no
 * ACL allows (describing a topic nobody is granted) and refuses to run, exit 2,
 * when it does not: a broker at `none` or `migrate` would accept those writes.
 *
 * Environment: the role's own credentials as its service already holds them, and
 * optionally KAFKA_PROBE_BROKERS, KAFKA_PROBE_CA_FILE, and KAFKA_PROBE_BENCHES
 * (the stack's bench numbers, default 1,2,3; a stack without benches still denies
 * their names).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { Kafka, logLevel } = createRequire(join(process.cwd(), 'probe.cjs'))('kafkajs');
const role = process.argv[2];
const env = process.env;
const benches = (env['KAFKA_PROBE_BENCHES'] ?? '1,2,3').split(',').map(Number);
const DENIED = new Set(['TOPIC_AUTHORIZATION_FAILED', 'GROUP_AUTHORIZATION_FAILED', 'CLUSTER_AUTHORIZATION_FAILED', 'TRANSACTIONAL_ID_AUTHORIZATION_FAILED']);
const WORLD = ['field.gauges', 'field.telemetry', 'field.cameras', 'field.holts', 'field.dens', 'creek.overview'];
const NOTEBOOKS = 'field.notebooks';
const run = randomUUID().slice(0, 8);

function principal() {
  if (role === 'gateway') return { username: env['KAFKA_GATEWAY_USERNAME'], password: env['KAFKA_GATEWAY_PASSWORD'], brokers: 'kafka:9094' };
  if (role === 'field-station') return { username: env['KAFKA_FIELD_STATION_USERNAME'], password: env['KAFKA_FIELD_STATION_PASSWORD'], brokers: env['KAFKA_BROKERS'] ?? 'kafka:9094' };
  if (role === 'bench') {
    const number = Number(env['LAB_BENCH']);
    return { username: env['KAFKA_LAB_USERNAME'], password: env['KAFKA_LAB_PASSWORD'], brokers: env['BENCH_KAFKA_BROKERS'] ?? `lab-${number}-kafka:${9100 + number}` };
  }
  throw new Error('Choose gateway, field-station, or bench.');
}
const own = principal();
if (!own.username || !own.password) throw new Error(`The ${role} container holds no Kafka credentials.`);
// KafkaJS swallows FindCoordinator's GROUP_AUTHORIZATION_FAILED (it tries each broker,
// then reports the coordinator as not found), but logs it at debug level: keep those.
const logged = [];
const logCreator = () => ({ log }) => { if (log?.error?.type) logged.push(log.error.type); };
const kafka = new Kafka({
  clientId: `acl-probe-${role}`, logCreator,
  brokers: (env['KAFKA_PROBE_BROKERS'] ?? own.brokers).split(','),
  ssl: { ca: [readFileSync(env['KAFKA_PROBE_CA_FILE'] ?? env['KAFKA_CA_FILE'] ?? '/etc/lontra/kafka/ca.pem', 'utf8')] },
  sasl: { mechanism: 'scram-sha-512', username: own.username, password: own.password },
  connectionTimeout: 5_000, logLevel: logLevel.DEBUG, retry: { retries: 1, initialRetryTime: 200 }
});
const admin = kafka.admin();
await admin.connect();

/** Runs an attempt: 'allowed' when it succeeds, 'denied' on an authorization error, and anything else is an error. */
async function attempt(fn) {
  logged.length = 0;
  try { await fn(); return { outcome: 'allowed' }; } catch (error) {
    const types = [...errorTypes(error), ...logged];
    const type = types.find(each => DENIED.has(each));
    if (type) return { outcome: 'denied', detail: type };
    return { outcome: 'error', detail: `${error?.name}: ${error?.message}${types.length > 0 ? ` [${types.join(', ')}]` : ''}` };
  }
}
/** KafkaJS nests protocol errors: in `errors` (topic creation), `groups` (group deletion), and `cause`. */
function errorTypes(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 4) return [];
  return [error.type, ...[error.cause, error.originalError, ...(error.errors ?? []), ...(error.groups ?? []).map(group => group.error)].flatMap(each => errorTypes(each, depth + 1))].filter(Boolean);
}

async function produce(topic, { idempotent = false } = {}) {
  const producer = kafka.producer({ idempotent, allowAutoTopicCreation: false, ...(idempotent ? { maxInFlightRequests: 1 } : {}) });
  await producer.connect();
  try { await producer.send({ topic, acks: -1, messages: [{ key: 'acl-probe', value: JSON.stringify({ probe: run, role }) }] }); } finally { await producer.disconnect(); }
}

/** Joins a group, subscribes, and resolves after the first fetch from the topic (empty or not). */
async function consume(topic, groupId) {
  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false, sessionTimeout: 10_000, retry: { retries: 0, restartOnFailure: async () => false } });
  try {
    await consumer.connect();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No fetch from ${topic} within 30 s.`)), 30_000);
      const settle = fn => value => { clearTimeout(timer); fn(value); };
      consumer.on(consumer.events.FETCH, settle(resolve));
      consumer.on(consumer.events.CRASH, event => settle(reject)(event.payload.error));
      consumer.subscribe({ topics: [topic], fromBeginning: true })
        .then(() => consumer.run({ autoCommit: false, eachMessage: async () => undefined }))
        .catch(settle(reject));
    });
  } finally { await consumer.disconnect().catch(() => undefined); }
}

const results = [];
async function probe(name, expected, fn) {
  const result = await attempt(fn);
  const pass = result.outcome === expected;
  results.push({ name, expected, ...result, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${expected.padEnd(7)} ${name}${result.outcome === expected ? '' : ` (got ${result.outcome}${result.detail ? `: ${result.detail}` : ''})`}`);
}
const describeTopic = topic => () => admin.fetchTopicOffsets(topic);
/** Kafka answers DescribeConfigs per resource: KafkaJS reports a refused one as an error in the result, not a rejection. */
const describeConfigs = topic => async () => {
  const { resources } = await admin.describeConfigs({ includeSynonyms: false, resources: [{ type: 2, name: topic, configNames: ['max.message.bytes'] }] });
  const refused = resources.find(resource => resource.errorCode !== 0);
  if (refused) throw Object.assign(new Error(refused.errorMessage ?? 'refused'), { type: refused.errorCode === 29 ? 'TOPIC_AUTHORIZATION_FAILED' : `ERROR_${refused.errorCode}` });
};
const deleteGroup = group => async () => {
  const [result] = await admin.deleteGroups([group]);
  if (result?.error && result.error.type !== 'GROUP_ID_NOT_FOUND') throw result.error;
};

const guard = await attempt(describeTopic(`acl-probe-guard-${run}`));
if (guard.outcome !== 'denied') {
  console.error(`Refusing to probe: the broker did not deny describing a topic nobody is granted (got ${guard.outcome}${guard.detail ? `: ${guard.detail}` : ''}), so it is not enforcing ACLs and the probes' writes would reach real topics.`);
  await admin.disconnect();
  process.exit(2);
}

try {
  if (role === 'gateway') {
    for (const topic of [...WORLD, NOTEBOOKS]) await probe(`describe ${topic}`, 'allowed', describeTopic(topic));
    await probe('read field.gauges in its own group prefix', 'allowed', () => consume('field.gauges', `streamotter-lontra-creek-acl-probe-${run}`));
    await probe('read field.gauges in a group outside its prefix', 'denied', () => consume('field.gauges', `streamotter-lab-1-acl-probe-${run}`));
    for (const topic of [...WORLD, NOTEBOOKS]) await probe(`write ${topic}`, 'denied', () => produce(topic));
    for (const number of benches) {
      await probe(`describe lab-${number}.field.gauges`, 'denied', describeTopic(`lab-${number}.field.gauges`));
      await probe(`write lab-${number}.quarantine`, 'denied', () => produce(`lab-${number}.quarantine`));
    }
    await probe('delete group streamotter-lontra-creek-field', 'denied', deleteGroup('streamotter-lontra-creek-field'));
    await probe('create topic field.acl-probe', 'denied', () => admin.createTopics({ topics: [{ topic: `field.acl-probe-${run}` }] }));
  } else if (role === 'field-station') {
    for (const topic of [...WORLD, NOTEBOOKS]) await probe(`describe ${topic}`, 'allowed', describeTopic(topic));
    const group = `lontra-field-station-read-acl-probe-${run}`;
    await probe(`read ${NOTEBOOKS} in its own group prefix`, 'allowed', () => consume(NOTEBOOKS, group));
    await probe('delete its own read group', 'allowed', deleteGroup(group));
    await probe('read field.gauges (it writes the creek, never reads it)', 'denied', () => consume('field.gauges', `lontra-field-station-read-acl-probe-${run}-2`));
    await probe(`read ${NOTEBOOKS} in a group outside its prefix`, 'denied', () => consume(NOTEBOOKS, `streamotter-lontra-creek-acl-probe-${run}`));
    const labBenches = Number(env['FIELD_LAB_BENCHES'] ?? 0);
    for (const number of benches) {
      if (number <= labBenches) {
        await probe(`describe lab-${number}.field.gauges`, 'allowed', describeTopic(`lab-${number}.field.gauges`));
        await probe(`read lab-${number}.field.gauges`, 'denied', () => consume(`lab-${number}.field.gauges`, `lontra-field-station-read-acl-probe-${run}-${number}`));
      }
      await probe(`write lab-${number}.quarantine`, 'denied', () => produce(`lab-${number}.quarantine`));
    }
    await probe('delete group streamotter-lontra-creek-field', 'denied', deleteGroup('streamotter-lontra-creek-field'));
    await probe('create topic acl-probe (outside its prefixes)', 'denied', () => admin.createTopics({ topics: [{ topic: `acl-probe-${run}` }] }));
  } else {
    const number = Number(env['LAB_BENCH']);
    const mine = `lab-${number}.`;
    const quarantine = `${mine}quarantine`;
    const visible = await admin.listTopics();
    await probe(`lists only ${mine}* topics (${visible.length} visible)`, 'allowed', async () => {
      const foreign = visible.filter(topic => !topic.startsWith(mine) && !topic.startsWith('__'));
      if (foreign.length > 0) throw new Error(`Visible: ${foreign.join(', ')}`);
      if (!visible.includes(quarantine)) throw new Error(`${quarantine} is missing.`);
    });
    await probe(`describe ${mine}field.gauges`, 'allowed', describeTopic(`${mine}field.gauges`));
    const group = `streamotter-lab-${number}-acl-probe-${run}`;
    await probe(`read ${mine}field.gauges in its own group prefix`, 'allowed', () => consume(`${mine}field.gauges`, group));
    await probe('delete its own group', 'allowed', deleteGroup(group));
    await probe(`write ${quarantine}`, 'allowed', () => produce(quarantine));
    await probe(`write ${quarantine} (idempotent producer)`, 'allowed', () => produce(quarantine, { idempotent: true }));
    await probe(`read ${quarantine}`, 'allowed', () => consume(quarantine, `${group}-q`));
    await probe('delete its own quarantine read group', 'allowed', deleteGroup(`${group}-q`));
    // StreamOtter 0.2.0-rc.1's quarantine writer and reader: the topic's settings, and throwaway groups named for the bench's project.
    const evidenceGroup = `streamotter-lontra-creek-lab-${number}-quarantine-read-acl-probe-${run}`;
    await probe(`describe ${quarantine}'s configuration`, 'allowed', describeConfigs(quarantine));
    await probe(`read ${quarantine} in a quarantine-read group`, 'allowed', () => consume(quarantine, evidenceGroup));
    await probe('delete that quarantine-read group', 'allowed', deleteGroup(evidenceGroup));
    await probe(`describe ${mine}field.gauges's configuration`, 'denied', describeConfigs(`${mine}field.gauges`));
    for (const topic of WORLD.filter(topic => topic !== 'field.holts' && topic !== 'field.dens').map(topic => `${mine}${topic}`)) await probe(`write ${topic} (its own source)`, 'denied', () => produce(topic));
    await probe(`read ${mine}field.gauges in another bench's group`, 'denied', () => consume(`${mine}field.gauges`, `streamotter-lab-${number % 3 + 1}-acl-probe-${run}`));
    await probe(`read ${mine}field.gauges in the production gateway's group`, 'denied', () => consume(`${mine}field.gauges`, 'streamotter-lontra-creek-field'));
    for (const topic of [...WORLD, NOTEBOOKS]) {
      await probe(`describe ${topic}`, 'denied', describeTopic(topic));
      await probe(`read ${topic}`, 'denied', () => consume(topic, `streamotter-lab-${number}-acl-probe-${run}-x`));
      await probe(`write ${topic}`, 'denied', () => produce(topic));
    }
    for (const other of benches.filter(other => other !== number)) {
      await probe(`describe lab-${other}.quarantine's configuration`, 'denied', describeConfigs(`lab-${other}.quarantine`));
      await probe(`read lab-${other}.quarantine in its quarantine-read group`, 'denied', () => consume(`lab-${other}.quarantine`, `streamotter-lontra-creek-lab-${other}-quarantine-read-acl-probe-${run}`));
      for (const topic of [`lab-${other}.field.gauges`, `lab-${other}.quarantine`]) {
        await probe(`read ${topic}`, 'denied', () => consume(topic, `streamotter-lab-${number}-acl-probe-${run}-${other}`));
        await probe(`write ${topic}`, 'denied', () => produce(topic));
      }
      await probe(`delete group streamotter-lab-${other}-acl-probe`, 'denied', deleteGroup(`streamotter-lab-${other}-acl-probe-${run}`));
    }
    await probe('delete group streamotter-lontra-creek-field', 'denied', deleteGroup('streamotter-lontra-creek-field'));
    await probe(`create topic ${mine}acl-probe`, 'denied', () => admin.createTopics({ topics: [{ topic: `${mine}acl-probe-${run}` }] }));
    await probe(`delete topic ${quarantine}`, 'denied', () => admin.deleteTopics({ topics: [quarantine], timeout: 5_000 }));
  }
} finally {
  await admin.disconnect();
}
const failed = results.filter(result => !result.pass);
console.log(JSON.stringify({ role, principal: own.username, probes: results.length, failed: failed.length }));
process.exit(failed.length === 0 ? 0 : 1);
