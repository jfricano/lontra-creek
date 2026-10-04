/** scripts/capture-provenance.mjs: capture labels come from the install, never from typed text. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { installSource, installedStreamotter, platformName } from "../capture-provenance.mjs";

const root = new URL("../../", import.meta.url);

test("only a registry tarball is labeled as published npm", () => {
  assert.equal(installSource("https://registry.npmjs.org/streamotter/-/streamotter-0.2.0-rc.1.tgz"), "published npm");
  assert.equal(installSource("file:vendor/streamotter-0.2.0-rc.1/streamotter-0.2.0-rc.1.tgz"), "pre-publish tarball");
  assert.throws(() => installSource("git+https://github.com/jfricano/StreamOtter.git"), /Unrecognized install source/);
  assert.throws(() => installSource(undefined), /Unrecognized install source/);
});

test("platforms are named for readers", () => {
  assert.equal(platformName("darwin"), "macOS");
  assert.equal(platformName("linux"), "Linux");
  assert.equal(platformName("freebsd"), "freebsd");
});

test("the installed streamotter is described by its own version and lockfile entry", () => {
  const described = installedStreamotter(root);
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const installed = JSON.parse(readFileSync(new URL("node_modules/streamotter/package.json", root), "utf8"));
  assert.equal(described.version, installed.version);
  assert.equal(described.install, installSource(lock.packages["node_modules/streamotter"].resolved));
  assert.equal(described.platform, platformName());
});

test("the committed recordings' labels match the install the lockfile describes", () => {
  // When the lockfile moves to the registry release, this fails until both captures are taken
  // again from that install (SOURCE_FAILURE_EXERCISES.md, the post-publish commit's recapture step).
  const described = installedStreamotter(root);
  const workbench = JSON.parse(readFileSync(new URL("apps/site/public/recordings/workbench/capture.json", root), "utf8"));
  assert.deepEqual([workbench.version, workbench.install], [described.version, described.install], "recordings/workbench/capture.json: rerun scripts/capture-workbench.mjs");
  const creek = JSON.parse(readFileSync(new URL("apps/site/public/recordings/creek.json", root), "utf8"));
  const from = described.install === "published npm" ? "npm" : "a pre-publish tarball";
  assert.ok(creek.where.includes(`streamotter@${described.version} from ${from},`), `recordings/creek.json says "${creek.where}": rerun scripts/capture-demo.ts`);
});
