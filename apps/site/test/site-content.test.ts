import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import installedPackage from "streamotter/package.json" with { type: "json" };
import fieldStationPackage from "../../field-station/package.json" with { type: "json" };
import { labCapabilities, NEW_SCENARIOS } from "../../field-station/src/lab/capabilities.ts";
import lockfile from "../../../package-lock.json" with { type: "json" };
import capture from "../public/recordings/workbench/capture.json" with { type: "json" };
import sitePackage from "../package.json" with { type: "json" };
import { RECORDING, SITE_RELEASE, SURFACES } from "../src/demo-availability.ts";
import { NEW_SOURCE_EXERCISES, TRACKS } from "../src/lab-catalog.ts";
import { RELEASE_VERSION, UPCOMING_STABLE } from "../src/release-facts.ts";
import { serviceLines } from "../src/scripts/release-service.ts";
import { PAGES, RELEASE, SITE } from "../src/site.ts";

const SRC = new URL("../src/", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(astro|ts)$/.test(entry.name) ? [join(dir, entry.name)] : []);
}

test("one library version everywhere: the site pin, the field station pin, the lockfile, and the installed package (LC11-A40)", () => {
  const locked = (lockfile as { packages: Record<string, { version?: string }> }).packages["node_modules/streamotter"]?.version;
  // An exact pin, not a range; or, before a release is on npm, its locally packed tarball in
  // vendor/, which scripts/check-release-pins.mjs keeps out of every release build.
  const pinned = (spec: string): string | undefined => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec) ? spec : /^file:\.\.\/\.\.\/vendor\/streamotter-([\w.-]+)\/streamotter-\1\.tgz$/.exec(spec)?.[1];
  assert.equal(pinned(sitePackage.dependencies.streamotter), RELEASE);
  assert.equal(pinned(fieldStationPackage.dependencies.streamotter), RELEASE);
  assert.equal(locked, RELEASE);
  assert.equal(installedPackage.version, RELEASE);
  assert.equal(RELEASE_VERSION, RELEASE);
});

test("the release-candidate notice names the stable version this release leads to, never a hand-typed one", () => {
  assert.equal(UPCOMING_STABLE, RELEASE.includes("-") ? RELEASE.split("-")[0] : null);
  const typed = sources(SRC).filter(file => /may change before \d/.test(readFileSync(file, "utf8")));
  assert.deepEqual(typed, []);
});

test("demo availability reads its facts from their sources", () => {
  assert.deepEqual(RECORDING, { version: capture.version, install: capture.install, capturedOn: capture.capturedAt.slice(0, 10) });
  // The stories the page counts are the new scenarios the backend's capability summary reports on.
  assert.deepEqual([...NEW_SOURCE_EXERCISES].sort(), [...NEW_SCENARIOS].sort());
  assert.deepEqual(NEW_SOURCE_EXERCISES, TRACKS["source-failures"].slice(1));
  const row = SURFACES.find(surface => surface.href === "/lab/#source-failures")!;
  assert.match(row.runs, new RegExp(`^Fouled sensor, on the same benches, and ${NEW_SOURCE_EXERCISES.length} more stories, each only where this field station's backend reports it can run it\\.`));
  const routes = new Set(PAGES.map(page => page.href));
  for (const surface of SURFACES) assert.ok(routes.has(surface.href.replace(/#.*$/, "")), surface.href);
  assert.match(SITE_RELEASE.milestone, /^V1\.1, in development\.$/);
  assert.equal(SITE.launched, false);
  assert.match(SITE_RELEASE.launch, /^Pre-launch\./);
});

/** Evidence for every new scenario under both failure-handling profiles, for an injected install, so the counts below depend only on the deployment. */
const EVIDENCE_PACKAGES = { "node_modules/streamotter": "sha512-evidence" };
const EVERY_PROFILE = new Map([[RELEASE, { packages: EVIDENCE_PACKAGES, scenarios: Object.fromEntries(NEW_SCENARIOS.map(id => [id, ["quarantine", "retry"] as const])), evidence: "test" }]]);

test("the releases page states neither that the new source-failure stories run nor that they don't: the backend decides", () => {
  const row = SURFACES.find(surface => surface.href === "/lab/#source-failures")!;
  assert.doesNotMatch(`${row.runs} ${row.needs}`, /can't run\.|cannot run|are listed with the reason|waiting/i);
  // How many run depends on the deployment. A bench's verified set is injected so the counts don't depend on which releases are verified.
  const runnable = (options: Partial<Parameters<typeof labCapabilities>[0]>): number =>
    labCapabilities({ labEnabled: true, now: 0, version: RELEASE, verified: EVERY_PROFILE, integrity: EVIDENCE_PACKAGES, ...options }).scenarios.filter(scenario => NEW_SOURCE_EXERCISES.includes(scenario.id) && scenario.available).length;
  // The hosted demo has no Lab benches in either rollout phase: none runs there.
  assert.equal(runnable({ labEnabled: false, version: "0.1.0-rc.3" }), 0);
  assert.equal(runnable({ labEnabled: false }), 0);
  // A Lab deployment's profile decides the rest: none with failure handling off, Calibration lookup blip with retry, all with quarantine and the local exercises.
  assert.equal(runnable({ profile: "off" }), 0);
  assert.equal(runnable({ profile: "retry" }), 1);
  assert.equal(runnable({ profile: "quarantine", localExercises: true }), NEW_SOURCE_EXERCISES.length);
});

test("the route set is unchanged and no summary claims a fixed number of Lab failures", () => {
  assert.deepEqual(PAGES.map(page => page.href), ["/field-station/", "/lab/", "/playground/", "/workbench/", "/when-it-breaks/", "/docs/", "/releases/"]);
  const lab = PAGES.find(page => page.href === "/lab/")!;
  assert.match(lab.summary, /Source failures track/);
  // Whether an exercise runs is the backend's answer, read at runtime; no summary decides it.
  assert.match(lab.summary, /whether this demo's backend can run each one/);
  for (const page of PAGES) assert.doesNotMatch(page.summary, /\bfour\b/i, page.href);
});

test("no page or script still says \"four controlled failures\"", () => {
  for (const file of sources(SRC)) assert.doesNotMatch(readFileSync(file, "utf8"), /four controlled failures/i, file);
});

test("no page shows an unpinned install: npm's latest tag need not be the release the site describes", () => {
  for (const file of sources(join(SRC, "pages"))) assert.doesNotMatch(readFileSync(file, "utf8"), /npm (?:install|i) streamotter(?![@\w/-])/, file);
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
  const retry = { kind: "summary", summary: labCapabilities({ labEnabled: true, now: 0, version: RELEASE, profile: "retry", verified: EVERY_PROFILE, integrity: EVIDENCE_PACKAGES }) } as const;
  assert.equal(serviceLines({ config: null, capabilities: retry }, RELEASE)[3], `New source-failure exercises it can run: 1 of ${NEW_SOURCE_EXERCISES.length}.`);
  assert.deepEqual(serviceLines({ config: null, capabilities: { kind: "unreachable" } }, "0.1.0-rc.3"), ["The field station didn't answer, so this page can't say what the demo runs right now. The facts above still describe this build."]);
  assert.match(serviceLines({ config: { gatewayOrigin: "", gatewayPath: "/", mode: "kafka", tickMs: 2000 }, capabilities: { kind: "absent" } }, "0.1.0-rc.3")[1]!, /doesn't report Lab capabilities/);
});
