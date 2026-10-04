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
  // Whether an exercise runs is the backend's answer, read at runtime; no summary decides it.
  assert.match(lab.summary, /whether this demo's backend can run each one/);
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
