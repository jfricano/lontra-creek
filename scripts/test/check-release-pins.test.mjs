/** scripts/check-release-pins.mjs: a release build must install StreamOtter from the registry. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releasePinProblems } from "../check-release-pins.mjs";

const REGISTRY_LOCK = { packages: { "node_modules/streamotter": { version: "0.2.0-rc.1", resolved: "https://registry.npmjs.org/streamotter/-/streamotter-0.2.0-rc.1.tgz" } } };

function checkout(t, { root = {}, app = "0.2.0-rc.1", lock = REGISTRY_LOCK, vendor = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ["apps/field-station", "apps/site"]) {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, "package.json"), JSON.stringify({ dependencies: { streamotter: app } }));
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(root));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
  if (vendor) mkdirSync(join(dir, "vendor"));
  return dir;
}

test("an exact registry pin passes", t => {
  assert.deepEqual(releasePinProblems(checkout(t)), []);
});

test("vendored tarballs, file: specs, overrides and a non-registry lockfile are each refused", t => {
  const problems = releasePinProblems(checkout(t, {
    vendor: true,
    app: "file:../../vendor/streamotter-0.2.0-rc.1/streamotter-0.2.0-rc.1.tgz",
    root: { overrides: { "@streamotter/gateway": "file:vendor/streamotter-0.2.0-rc.1/streamotter-gateway-0.2.0-rc.1.tgz" } },
    lock: { packages: { "node_modules/@streamotter/gateway": { version: "0.2.0-rc.1", resolved: "file:vendor/streamotter-0.2.0-rc.1/streamotter-gateway-0.2.0-rc.1.tgz" } } }
  }));
  assert.equal(problems.length, 5, problems.join("\n"));
  assert.match(problems.join("\n"), /vendor\//);
  assert.match(problems.join("\n"), /overrides @streamotter\/gateway/);
  assert.match(problems.join("\n"), /package-lock\.json resolves @streamotter\/gateway/);
});

test("a range is not an exact pin", t => {
  assert.match(releasePinProblems(checkout(t, { app: "^0.2.0-rc.1" })).join(""), /not an exact version/);
});

test("this repository's own manifests are checked without throwing", () => {
  assert.ok(Array.isArray(releasePinProblems(new URL("../..", import.meta.url).pathname)));
});
