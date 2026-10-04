/**
 * The site describes source-failure handling as shipped in the installed release. Each claim
 * in src/failure-handling.ts is held here against the installed package: its validator, its
 * exported vocabulary, its CLI, and its gateway. Pinning a release without these features
 * fails these tests, so the "shipped" copy can't outlive the release that ships it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  FAILURE_CLASSES, OPERATOR_MUTATIONS, OPERATOR_OPERATIONS, QUARANTINE_ELIGIBLE_CLASSES, policyFor, resolveSourcePolicy, validateProjectConfig
} from "streamotter/contracts";
import fieldConfig from "../../field-station/streamotter.json" with { type: "json" };
import {
  AUTOMATIC_ADVANCE_LIMIT, DISPOSITION_LIFECYCLE, FAILURE_SOURCES, INSTALLED_VALIDATOR_ON_FAILURE_HANDLING, NOT_OFFERED, OPERATOR_TABLE, POLICIES,
  POLICY_MATRIX, REDRIVE_OUTCOMES
} from "../src/failure-handling.ts";
import { RELEASE_TAG } from "../src/release-facts.ts";

const FIELD_STATION = new URL("../../field-station/", import.meta.url);

/** This demo's configuration with a failureHandling section, as the installed validator sees it. */
function withPolicy(source: Record<string, unknown>): ReturnType<typeof validateProjectConfig> {
  return validateProjectConfig({ ...fieldConfig, failureHandling: { quarantine: { topic: "field.streamotter.quarantine", capture: "full-record" }, sources: { field: source } } });
}

test("the installed validator accepts a failureHandling section, so the site may call source-failure handling shipped", () => {
  assert.deepEqual(INSTALLED_VALIDATOR_ON_FAILURE_HANDLING, { valid: true, issues: [] });
  for (const policy of Object.keys(POLICIES)) assert.equal(withPolicy({ invalidJson: policy }).valid, true, policy);
});

test("every option the site says isn't offered is refused as a policy", () => {
  for (const value of NOT_OFFERED) {
    const result = withPolicy({ invalidJson: value });
    assert.deepEqual(result.issues.map(issue => [issue.path, issue.code]), [["/failureHandling/sources/field/invalidJson", "INVALID_VALUE"]], value);
    assert.match(result.issues[0]!.message, /never skips a record silently/, value);
  }
});

test("the policy matrix names every failure class once, and only the eligible ones may opt into quarantine", () => {
  const classes = POLICY_MATRIX.flatMap(row => row.classes);
  assert.deepEqual([...classes].sort(), [...FAILURE_CLASSES].sort());
  assert.equal(new Set(classes).size, classes.length);
  const quarantining = POLICY_MATRIX.filter(row => row.optIn.includes("quarantine-")).flatMap(row => row.classes);
  assert.deepEqual([...quarantining].sort(), [...QUARANTINE_ELIGIBLE_CLASSES].sort());
  // With no policy every class pauses; with the strongest policy only the eligible classes don't.
  const none = resolveSourcePolicy(undefined, "field");
  const strongest = resolveSourcePolicy({ sources: { field: { invalidJson: "quarantine-resync", invalidPublicPayload: "quarantine-resync" } } }, "field");
  for (const row of POLICY_MATRIX) {
    for (const failureClass of row.classes) {
      assert.equal(row.byDefault, "Pause", row.failure);
      assert.equal(policyFor(none, failureClass), "pause", failureClass);
      assert.equal(policyFor(strongest, failureClass) !== "pause", QUARANTINE_ELIGIBLE_CLASSES.includes(failureClass), failureClass);
    }
  }
});

test("the circuit breaker's default is the package's own", () => {
  assert.deepEqual(AUTOMATIC_ADVANCE_LIMIT, resolveSourcePolicy(undefined, "field").automaticAdvanceLimit);
});

test("the record-disposition lifecycle follows ADR-15A's order and says what each step doesn't prove", () => {
  assert.deepEqual(DISPOSITION_LIFECYCLE.map(stage => stage.name), ["Held", "Evidence saved", "Hold, or ask the recovery guard", "Source advanced", "Views resynchronized"]);
  const terms = DISPOSITION_LIFECYCLE.flatMap(stage => stage.terms);
  for (const term of ["held", "quarantine-unknown", "advance-pending", "advance-confirmed", "uncertain"] as const) assert.ok(terms.includes(term), term);
  assert.ok(terms.indexOf("held") < terms.indexOf("quarantine-unknown") && terms.indexOf("advance-pending") < terms.indexOf("advance-confirmed"));
  for (const stage of DISPOSITION_LIFECYCLE) assert.ok(stage.notProof.length > 10, stage.name);
  assert.deepEqual(Object.keys(REDRIVE_OUTCOMES), ["reprocessed", "superseded", "failed", "unknown"]);
});

test("the operator table lists the package's operations in its order, as the installed CLI spells them", () => {
  assert.deepEqual(OPERATOR_TABLE.map(action => action.operation), [...OPERATOR_OPERATIONS]);
  assert.deepEqual(OPERATOR_TABLE.filter(action => action.mutates).map(action => action.operation), [...OPERATOR_MUTATIONS]);
  const require = createRequire(import.meta.url);
  const bin = join(dirname(require.resolve("streamotter/package.json")), "bin/streamotter.js");
  const usage = execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  for (const action of OPERATOR_TABLE) assert.match(usage, new RegExp(`^\\s*streamotter ${action.command} `, "m"), action.command);
  for (const action of OPERATOR_TABLE) assert.doesNotMatch(action.command, /force|bulk|all/i);
});

test("a guarded-resync source without a guard passes the validator but not the installed gateway", async () => {
  // The validator is pure and can't see handlers; the page says the gateway refuses this at startup.
  const { createGateway } = await import("streamotter/gateway");
  const { handlers, development } = await import("../../field-station/src/fixture-handlers.ts");
  const fixture = JSON.parse(readFileSync(new URL("streamotter.fixture.json", FIELD_STATION), "utf8")) as Record<string, unknown>;
  const config = { ...fixture, failureHandling: { sources: { field: { invalidJson: "quarantine-resync" } } } };
  assert.deepEqual(validateProjectConfig(config), { valid: true, issues: [] });
  assert.throws(() => createGateway({ config: config as never, handlers, development, mode: "development" }), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, "CONFIG_INVALID");
    assert.match(error.message ?? "", /requires a recovery guard at handlers\.sources\.field\.recover/);
    return true;
  });
});

test("source-failure links point at the release tag, never a branch or a planning commit", () => {
  for (const url of Object.values(FAILURE_SOURCES)) {
    assert.ok(url.startsWith(`https://github.com/jfricano/StreamOtter/blob/${RELEASE_TAG}/`) || url.startsWith(`https://github.com/jfricano/StreamOtter/tree/${RELEASE_TAG}/`), url);
  }
  for (const stage of DISPOSITION_LIFECYCLE) assert.ok((Object.values(FAILURE_SOURCES) as string[]).includes(stage.source), stage.name);
});

test("the live creek configures no failure policies, as /when-it-breaks/ says", () => {
  for (const file of ["streamotter.json", "streamotter.fixture.json", "streamotter.production.json"]) {
    const config = JSON.parse(readFileSync(new URL(file, FIELD_STATION), "utf8")) as Record<string, unknown>;
    assert.equal(config["failureHandling"], undefined, `${file} now has failureHandling; update "What this demo runs" on /when-it-breaks/`);
  }
});
