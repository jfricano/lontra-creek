/**
 * The playground's presets (LC11-A34), held to the installed validator and gateway. The page
 * shows only what the validator answers in the browser; this test pins the answer each
 * preset's note describes, so a release that changes it fails here instead of on the page.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGateway } from "streamotter/gateway";
import { validateProjectConfig } from "streamotter/contracts";
import base from "../src/data/playground-config.json" with { type: "json" };
import { PLAYGROUND_PRESETS, presetText, type PlaygroundPreset } from "../src/data/playground-presets.ts";

const preset = (id: string): PlaygroundPreset => {
  const found = PLAYGROUND_PRESETS.find(candidate => candidate.id === id);
  assert.ok(found, id);
  return found;
};
const issues = (config: unknown) => validateProjectConfig(config).issues.map(issue => [issue.path, issue.code]);

/** The refusals each refused preset demonstrates, as the installed validator reports them. */
const REFUSALS: Record<string, string[][]> = {
  "skip-policies": [["/failureHandling/sources/jobs/invalidJson", "INVALID_VALUE"], ["/failureHandling/sources/jobs/invalidPublicPayload", "INVALID_VALUE"]],
  "topic-overlap": [["/failureHandling/quarantine/topic", "INVALID_VALUE"]],
  "missing-quarantine": [["/failureHandling/quarantine", "REQUIRED"]],
  "retry-not-replay-safe": [["/failureHandling/sources/jobs/transientMapperRetries", "INVALID_VALUE"]]
};

test("presets have unique IDs and labels, and the first is the unchanged example", () => {
  assert.equal(new Set(PLAYGROUND_PRESETS.map(entry => entry.id)).size, PLAYGROUND_PRESETS.length);
  assert.equal(new Set(PLAYGROUND_PRESETS.map(entry => entry.label)).size, PLAYGROUND_PRESETS.length);
  assert.equal(PLAYGROUND_PRESETS[0]!.id, "init-example");
  assert.deepEqual(PLAYGROUND_PRESETS[0]!.config, base);
  assert.equal("failureHandling" in base, false);
  for (const entry of PLAYGROUND_PRESETS) assert.deepEqual(JSON.parse(presetText(entry)), entry.config, entry.id);
});

test("every accepted preset is valid under the installed validator", () => {
  const accepted = PLAYGROUND_PRESETS.filter(entry => entry.group === "accepted");
  assert.deepEqual(accepted.map(entry => entry.id), ["init-example", "quarantine-hold", "quarantine-resync", "bounded-retry"]);
  for (const entry of accepted) assert.deepEqual(validateProjectConfig(entry.config), { valid: true, issues: [] }, entry.id);
});

test("every refused preset is refused for the reason its note gives", () => {
  const refused = PLAYGROUND_PRESETS.filter(entry => entry.group === "refused");
  assert.deepEqual(refused.map(entry => entry.id), Object.keys(REFUSALS));
  for (const entry of refused) assert.deepEqual(issues(entry.config), REFUSALS[entry.id], entry.id);
  const skip = validateProjectConfig(preset("skip-policies").config).issues;
  for (const issue of skip) assert.match(issue.message, /never skips a record silently/);
});

test("the quarantine-resync preset passes validation but the gateway refuses it without a guard, as its note says", () => {
  const { config } = preset("quarantine-resync");
  const channels = { jobProgress: { authorize: () => true, snapshot: () => ({ revision: "1", data: { jobId: "job_1", state: "queued", percent: 0 } }), map: () => [] } };
  const build = (sources?: object) => createGateway({ config: config as never, handlers: { authenticate: () => null, channels, ...(sources ? { sources } : {}) } as never, mode: "development" });
  assert.throws(() => build(), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, "CONFIG_INVALID");
    assert.match(error.message ?? "", /requires a recovery guard at handlers\.sources\.jobs\.recover/);
    return true;
  });
  // With a guard, construction succeeds; nothing is started, so nothing connects.
  assert.doesNotThrow(() => build({ jobs: { recover: () => ({ decision: "hold", reason: "example" }) } }));
  assert.match(preset("quarantine-resync").note, /handlers\.sources\.jobs\.recover/);
});
