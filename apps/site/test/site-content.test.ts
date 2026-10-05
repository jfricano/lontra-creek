import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import installedPackage from "streamotter/package.json" with { type: "json" };
import fieldStationPackage from "../../field-station/package.json" with { type: "json" };
import { labCapabilities } from "../../field-station/src/lab/capabilities.ts";
import lockfile from "../../../package-lock.json" with { type: "json" };
import capture from "../public/recordings/workbench/capture.json" with { type: "json" };
import sitePackage from "../package.json" with { type: "json" };
import { RECORDING, SITE_RELEASE, SURFACES, WAITING_EXERCISES } from "../src/demo-availability.ts";
import { TRACKS } from "../src/lab-catalog.ts";
import {
  CIRCUIT, DISPOSITION_LIFECYCLE, INSTALLED_VALIDATOR_ON_FAILURE_HANDLING, NOT_OFFERED, OPERATOR_ACTIONS, POLICIES, POLICY_MATRIX,
  REDRIVE_OUTCOMES, V11_SOURCES, V11_SPEC_COMMIT
} from "../src/planned-failure-handling.ts";
import { RELEASE_VERSION } from "../src/release-facts.ts";
import { serviceLines } from "../src/scripts/release-service.ts";
import { INSTALL_COMMAND, PAGES, RELEASE, SITE } from "../src/site.ts";

const SRC = new URL("../src/", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(astro|ts)$/.test(entry.name) ? [join(dir, entry.name)] : []);
}

test("one library version everywhere: the site pin, the field station pin, the lockfile, and the installed package (LC11-A40)", () => {
  const locked = (lockfile as { packages: Record<string, { version?: string }> }).packages["node_modules/streamotter"]?.version;
  assert.equal(RELEASE, sitePackage.dependencies.streamotter);
  assert.equal(fieldStationPackage.dependencies.streamotter, RELEASE);
  assert.equal(locked, RELEASE);
  assert.equal(installedPackage.version, RELEASE);
  assert.equal(RELEASE_VERSION, RELEASE);
  // An exact pin, not a range.
  assert.match(RELEASE, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
});

test("install commands name the pinned release, not npm's latest tag", () => {
  // npm's latest tag moved past this release; an unpinned command would install a newer one.
  assert.equal(INSTALL_COMMAND, `npm install streamotter@${RELEASE}`);
  for (const file of sources(join(SRC, "pages"))) assert.doesNotMatch(readFileSync(file, "utf8"), /npm install streamotter(?!@)/, file);
});

test("no page says StreamOtter V1.1 is unreleased: 0.2.0-rc.1 publishes it, though this site doesn't run it", () => {
  for (const file of sources(SRC)) assert.doesNotMatch(readFileSync(file, "utf8"), /specified, not released|planned, not installed|planned for StreamOtter V1\.1|When a StreamOtter release ships/i, file);
});

test("the installed validator rejects failureHandling, so V1.1 policies stay labeled as planned", () => {
  // The day a pinned release accepts the key, this fails and the planned copy must be revisited.
  assert.equal(INSTALLED_VALIDATOR_ON_FAILURE_HANDLING.valid, false);
  assert.deepEqual(INSTALLED_VALIDATOR_ON_FAILURE_HANDLING.issues.map(issue => [issue.path, issue.code]), [["/failureHandling", "UNKNOWN_KEY"]]);
});

test("planned V1.1 sources point at one pinned StreamOtter commit, never a branch or the release tag", () => {
  assert.match(V11_SPEC_COMMIT, /^[0-9a-f]{40}$/);
  for (const url of Object.values(V11_SOURCES)) {
    assert.ok(url.startsWith(`https://github.com/jfricano/StreamOtter/`), url);
    assert.ok(url.includes(`/${V11_SPEC_COMMIT}/docs/releases/v1.1`), url);
  }
  for (const stage of DISPOSITION_LIFECYCLE) assert.ok((Object.values(V11_SOURCES) as string[]).includes(stage.source), stage.name);
});

test("the policy matrix uses the specification's closed vocabulary and ADR-15B's classes once each", () => {
  assert.deepEqual(Object.keys(POLICIES), ["pause", "quarantine-hold", "quarantine-resync"]);
  for (const name of NOT_OFFERED) assert.ok(!(name in POLICIES), name);
  const classes = POLICY_MATRIX.flatMap(row => row.classes);
  assert.deepEqual([...classes].sort(), ["invalid-json", "mapper-error", "mapper-timeout", "mapper-transient", "oversize", "payload-schema", "revision-conflict", "routing-invalid", "tombstone"]);
  // Only the two eligible classes may opt into guarded continuation (ADR-15B section 1).
  const resync = POLICY_MATRIX.filter(row => row.optIn.includes("quarantine-resync")).flatMap(row => row.classes);
  assert.deepEqual(resync.sort(), ["invalid-json", "payload-schema"]);
  // Every record failure pauses by default, as the installed release does today.
  for (const row of POLICY_MATRIX.filter(row => row.classes.length > 0)) assert.equal(row.byDefault, "Pause", row.failure);
  assert.deepEqual(CIRCUIT, { incidents: 5, windowSeconds: 60 });
  assert.ok(OPERATOR_ACTIONS.every(action => !/force|skip all|bulk/i.test(action.command)));
});

test("the record-disposition lifecycle follows ADR-15A's order and says what each step doesn't prove", () => {
  assert.deepEqual(DISPOSITION_LIFECYCLE.map(stage => stage.name), ["Held", "Evidence saved", "Hold, or ask the recovery guard", "Source advanced", "Views resynchronized"]);
  const terms = DISPOSITION_LIFECYCLE.flatMap(stage => stage.terms);
  for (const term of ["held", "quarantine-unknown", "advance-pending", "advance-confirmed", "uncertain"]) assert.ok(terms.includes(term), term);
  assert.ok(terms.indexOf("held") < terms.indexOf("quarantine-unknown") && terms.indexOf("advance-pending") < terms.indexOf("advance-confirmed"));
  for (const stage of DISPOSITION_LIFECYCLE) assert.ok(stage.notProof.length > 10, stage.name);
  assert.deepEqual(Object.keys(REDRIVE_OUTCOMES), ["reprocessed", "superseded", "failed", "unknown"]);
});

test("demo availability reads its facts from their sources", () => {
  assert.deepEqual(RECORDING, { version: capture.version, capturedOn: capture.capturedAt.slice(0, 10) });
  // The count the page states matches what an rc.3 backend reports as unavailable.
  const unavailable = labCapabilities({ labEnabled: true, now: 0, version: RELEASE }).scenarios.filter(scenario => !scenario.available).map(scenario => scenario.id);
  assert.deepEqual([...WAITING_EXERCISES].sort(), [...unavailable].sort());
  assert.deepEqual(WAITING_EXERCISES, TRACKS["source-failures"].slice(1));
  const routes = new Set(PAGES.map(page => page.href));
  for (const surface of SURFACES) assert.ok(routes.has(surface.href.replace(/#.*$/, "")), surface.href);
  assert.match(SITE_RELEASE.milestone, /^V1\.1, in development\.$/);
  assert.equal(SITE.launched, false);
  assert.match(SITE_RELEASE.launch, /^Pre-launch\./);
});

test("the route set is unchanged and no summary claims a fixed number of Lab failures", () => {
  assert.deepEqual(PAGES.map(page => page.href), ["/field-station/", "/lab/", "/playground/", "/workbench/", "/when-it-breaks/", "/docs/", "/releases/"]);
  const lab = PAGES.find(page => page.href === "/lab/")!;
  assert.match(lab.summary, /Source failures track/);
  assert.match(lab.summary, /wait for StreamOtter V1\.1/);
  for (const page of PAGES) assert.doesNotMatch(page.summary, /\bfour\b/i, page.href);
});

test("no page or script still says \"four controlled failures\"", () => {
  for (const file of sources(SRC)) assert.doesNotMatch(readFileSync(file, "utf8"), /four controlled failures/i, file);
});

test("the releases page reports what the field station answers, and only that", () => {
  const rc3 = { kind: "summary", summary: labCapabilities({ labEnabled: false, now: 0, version: "0.1.0-rc.3" }) } as const;
  assert.deepEqual(serviceLines({ config: { gatewayOrigin: "", gatewayPath: "/socket.io/", mode: "fixture", tickMs: 2000 }, capabilities: rc3 }, "0.1.0-rc.3"), [
    "Field station: answering, replaying fixture data without Kafka.",
    "StreamOtter it runs: 0.1.0-rc.3.",
    "Lab benches: none on this backend.",
    "New source-failure exercises it can run: 0 of 8."
  ]);
  const newer = { kind: "summary", summary: labCapabilities({ labEnabled: true, now: 0, version: "0.2.0" }) } as const;
  const skew = serviceLines({ config: { gatewayOrigin: "", gatewayPath: "/socket.io/", mode: "kafka", tickMs: 2000 }, capabilities: newer }, "0.1.0-rc.3");
  assert.equal(skew[0], "Field station: answering, on real Kafka with synthetic data.");
  assert.match(skew[1]!, /^StreamOtter it runs: 0\.2\.0\. This page was built for 0\.1\.0-rc\.3/);
  assert.equal(skew[2], "Lab benches: enabled.");
  assert.deepEqual(serviceLines({ config: null, capabilities: { kind: "unreachable" } }, "0.1.0-rc.3"), ["The field station didn't answer, so this page can't say what the demo runs right now. The facts above still describe this build."]);
  assert.match(serviceLines({ config: { gatewayOrigin: "", gatewayPath: "/", mode: "kafka", tickMs: 2000 }, capabilities: { kind: "absent" } }, "0.1.0-rc.3")[1]!, /doesn't report Lab capabilities/);
});
