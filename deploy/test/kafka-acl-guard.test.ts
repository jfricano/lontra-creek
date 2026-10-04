/**
 * The Kafka ACL probes must never write against a broker that does not deny what no
 * ACL allows: their expected-denied writes would land in the creek's topics. Checks
 * both guards without Docker or Kafka: deploy/test/kafka-acls.test.ts with a fake
 * STACK_KAFKA_EXEC, and deploy/test/kafka-acl-probes.mjs with a fake kafkajs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const here = import.meta.dirname;
const ENFORCING = "authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer\nallow.everyone.if.no.acl.found=false\nsuper.users=User:ANONYMOUS";
const MIGRATE = ENFORCING.replace("found=false", "found=true");
const NONE = "process.roles=broker,controller";

/** Runs kafka-acls.test.ts against a fake exec that reports `properties`; returns the probe runs it was asked for. */
function aclTest(properties: string) {
  const dir = mkdtempSync(join(tmpdir(), "lontra-acl-guard-"));
  const exec = join(dir, "exec.sh");
  writeFileSync(exec, `#!/usr/bin/env bash
service=$1; shift
case "$service $*" in
  "kafka cat /tmp/lontra-kafka.properties") printf '%s\\n' "$FAKE_PROPERTIES" ;;
  kafka\\ *) ;;
  *) printf '%s %s\\n' "$service" "$*" >> "$FAKE_LOG"; echo '{"probes":10,"failed":0}' ;;
esac
`, { mode: 0o755 });
  try {
    const result = spawnSync(process.execPath, ["--test", join(here, "kafka-acls.test.ts")], {
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, STACK_KAFKA_EXEC: exec, STACK_KAFKA_BENCHES: "", FAKE_PROPERTIES: properties, FAKE_LOG: join(dir, "probes.log") }
    });
    const log = join(dir, "probes.log");
    return { status: result.status, output: result.stdout, probes: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("kafka-acls.test.ts runs no probe unless the broker denies what no ACL allows", () => {
  for (const properties of [NONE, MIGRATE]) {
    const result = aclTest(properties);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.probes, [], properties);
    assert.match(result.output, /Not probing gateway: the broker does not deny what no ACL allows/);
  }
  // The fake does see probe runs: against an enforcing broker both principals are probed.
  const enforcing = aclTest(ENFORCING);
  assert.equal(enforcing.probes.length, 2, enforcing.output);
  assert.match(enforcing.probes[0]!, /^gateway env KAFKA_PROBE_BENCHES=1,2,3 node --input-type=module - gateway/);
});

/** Runs the probes as `role` with a fake kafkajs: "open" accepts everything, "enforcing" denies everything. */
function probes(role: string, broker: "open" | "enforcing") {
  const dir = mkdtempSync(join(tmpdir(), "lontra-acl-probes-"));
  mkdirSync(join(dir, "node_modules/kafkajs"), { recursive: true });
  writeFileSync(join(dir, "node_modules/kafkajs/index.js"), `
const { appendFileSync } = require('node:fs');
const record = line => appendFileSync(process.env.FAKE_LOG, line + '\\n');
const answer = async value => {
  if (process.env.FAKE_BROKER === 'open') return value;
  throw Object.assign(new Error('denied'), { type: 'TOPIC_AUTHORIZATION_FAILED' });
};
class Kafka {
  admin() {
    return {
      connect: async () => undefined, disconnect: async () => undefined,
      fetchTopicOffsets: topic => { record('describe ' + topic); return answer([]); },
      listTopics: async () => ['lab-1.quarantine', 'lab-1.field.gauges'],
      deleteGroups: groups => { record('delete group ' + groups[0]); return answer([{}]); },
      createTopics: ({ topics }) => { record('create ' + topics[0].topic); return answer(true); },
      deleteTopics: ({ topics }) => { record('delete topic ' + topics[0]); return answer(undefined); }
    };
  }
  producer() {
    return { connect: async () => undefined, disconnect: async () => undefined, send: ({ topic }) => { record('write ' + topic); return answer([]); } };
  }
  consumer() {
    return {
      events: { FETCH: 'fetch', CRASH: 'crash' }, on: () => undefined,
      connect: () => answer(undefined), disconnect: async () => undefined,
      subscribe: ({ topics }) => { record('read ' + topics[0]); return answer(undefined); }, run: async () => undefined
    };
  }
}
module.exports = { Kafka, logLevel: { DEBUG: 5 } };
`);
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-", role], {
      cwd: dir, encoding: "utf8", input: readFileSync(join(here, "kafka-acl-probes.mjs"), "utf8"), timeout: 30_000,
      env: {
        ...process.env, FAKE_BROKER: broker, FAKE_LOG: join(dir, "calls.log"), KAFKA_PROBE_CA_FILE: join(here, "kafka-acl-probes.mjs"), KAFKA_PROBE_BENCHES: "1,2,3",
        KAFKA_GATEWAY_USERNAME: "gateway", KAFKA_GATEWAY_PASSWORD: "x", KAFKA_FIELD_STATION_USERNAME: "field-station", KAFKA_FIELD_STATION_PASSWORD: "x",
        LAB_BENCH: "1", KAFKA_LAB_USERNAME: "lab-1", KAFKA_LAB_PASSWORD: "x"
      }
    });
    const calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
    return { status: result.status, stderr: result.stderr, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("kafka-acl-probes.mjs refuses to probe a broker that allows what no ACL allows", () => {
  for (const role of ["gateway", "field-station", "bench"]) {
    const open = probes(role, "open");
    assert.equal(open.status, 2, role);
    assert.match(open.stderr, /Refusing to probe: the broker did not deny describing a topic nobody is granted/);
    assert.equal(open.calls.length, 1, open.calls.join("\n"));
    assert.match(open.calls[0]!, /^describe acl-probe-guard-/);
    // Past the guard, the same fake records the probes' writes.
    const enforcing = probes(role, "enforcing");
    assert.ok(enforcing.calls.some(call => call.startsWith("write ")), `${role}: ${enforcing.calls.join("\n")}`);
  }
});
