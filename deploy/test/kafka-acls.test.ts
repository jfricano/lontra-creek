/**
 * Kafka authorization in a running stack (LC11-ADR-03, LC11-A29; the table is in
 * docs/contracts/lab-api.md 10.9). CI runs it against a stack whose broker has
 * KAFKA_AUTHORIZATION=acl (.github/workflows/stack.yml and lab-spike.yml):
 *
 *   STACK_KAFKA_EXEC="docker compose … exec -T" STACK_KAFKA_BENCHES="1 2 3" \
 *     node --test deploy/test/kafka-acls.test.ts
 *
 * STACK_KAFKA_EXEC is a shell command prefix that runs a command in a Compose
 * service (the service name and command are appended); without it every test
 * skips. STACK_KAFKA_BENCHES lists the stack's benches (none by default). The
 * broker's ACLs must match the contract's table exactly, nothing more, and each
 * principal's probes (deploy/test/kafka-acl-probes.mjs) run in its own container
 * with its own credentials.
 */
import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

const EXEC = process.env["STACK_KAFKA_EXEC"];
const BENCHES = (process.env["STACK_KAFKA_BENCHES"] ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
const PROBES = join(import.meta.dirname, "kafka-acl-probes.mjs");
const run = promisify(exec);

/** "<type>:<name>;<pattern>;<principal>;<operation>", as deploy/kafka/start.sh grants them. */
function expectedAcls(benches: readonly number[]): string[] {
  const acls: string[] = [];
  const grant = (principal: string, pattern: string, operations: string[], resources: string[]) => {
    for (const resource of resources) for (const operation of operations) acls.push(`${resource};${pattern};User:${principal};${operation}`);
  };
  grant("gateway", "prefixed", ["read", "describe"], ["topic:field.", "topic:creek.", "group:streamotter-lontra-creek-"]);
  grant("field-station", "prefixed", ["create", "write", "describe"], ["topic:field.", "topic:creek.", ...benches.flatMap(n => [`topic:lab-${n}.field.`, `topic:lab-${n}.creek.`])]);
  grant("field-station", "literal", ["read"], ["topic:field.notebooks"]);
  grant("field-station", "prefixed", ["read", "delete"], ["group:lontra-field-station-read-"]);
  for (const n of benches) {
    grant(`lab-${n}`, "prefixed", ["read", "describe"], [`topic:lab-${n}.`]);
    grant(`lab-${n}`, "literal", ["write"], [`topic:lab-${n}.quarantine`]);
    grant(`lab-${n}`, "prefixed", ["read", "delete"], [`group:streamotter-lab-${n}-`]);
  }
  return acls.sort();
}

function parseAcls(listing: string): string[] {
  const acls: string[] = [];
  let resource = "";
  for (const line of listing.split("\n")) {
    const header = /resourceType=([A-Z_]+), name=([^,]+), patternType=([A-Z]+)/.exec(line);
    if (header) { resource = `${header[1]!.toLowerCase()}:${header[2]};${header[3]!.toLowerCase()}`; continue; }
    const entry = /principal=([^,]+), host=([^,]+), operation=([A-Z_]+), permissionType=([A-Z]+)/.exec(line);
    if (entry) acls.push(`${resource};${entry[1]};${entry[3]!.toLowerCase()}${entry[2] === "*" && entry[4] === "ALLOW" ? "" : ` (host ${entry[2]}, ${entry[4]})`}`);
  }
  return acls.sort();
}

describe("Kafka authorization", { skip: EXEC === undefined && "STACK_KAFKA_EXEC is not set" }, () => {
  test("the broker denies what no ACL allows, and its ACLs are exactly the contract's", async () => {
    const { stdout: config } = await run(`${EXEC} kafka cat /tmp/lontra-kafka.properties`);
    assert.match(config, /^authorizer\.class\.name=org\.apache\.kafka\.metadata\.authorizer\.StandardAuthorizer$/m);
    assert.match(config, /^allow\.everyone\.if\.no\.acl\.found=false$/m);
    assert.match(config, /^super\.users=User:ANONYMOUS$/m);
    const { stdout: listing } = await run(`${EXEC} kafka env KAFKA_HEAP_OPTS=-Xmx256m /opt/kafka/bin/kafka-acls.sh --bootstrap-server 127.0.0.1:9092 --list`, { timeout: 60_000 });
    assert.deepEqual(parseAcls(listing), expectedAcls(BENCHES));
    if (BENCHES.length === 0) return;
    const { stdout: topics } = await run(`${EXEC} kafka env KAFKA_HEAP_OPTS=-Xmx256m /opt/kafka/bin/kafka-topics.sh --bootstrap-server 127.0.0.1:9092 --describe --exclude-internal`, { timeout: 60_000 });
    for (const n of BENCHES) assert.match(topics, new RegExp(`Topic: lab-${n}\\.quarantine\\s.*PartitionCount: 1\\s.*retention\\.ms=3600000`));
  });

  const services: [string, string][] = [["gateway", "gateway"], ["field-station", "field-station"], ...BENCHES.map((n): [string, string] => [`lab-${n}`, "bench"])];
  for (const [service, role] of services) {
    test(`${service} can do only what its ACLs allow`, async () => {
      const command = `${EXEC} ${service} env KAFKA_PROBE_BENCHES=${BENCHES.length > 0 ? BENCHES.join(",") : "1,2,3"} node --input-type=module - ${role} < '${PROBES}'`;
      const result = await run(command, { timeout: 300_000 }).catch((error: { stdout?: string; stderr?: string; message: string }) => {
        assert.fail(`${service}'s probes failed:\n${error.stdout ?? ""}${error.stderr ?? ""}${error.stdout ? "" : error.message}`);
      });
      const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { probes: number; failed: number };
      assert.equal(summary.failed, 0, result.stdout);
      assert.ok(summary.probes >= 10, result.stdout);
      console.log(result.stdout.trim());
    });
  }
});
