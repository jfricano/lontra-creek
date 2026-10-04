import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PUBLISHED_SEAM } from "../src/scripts/workbench-seam.ts";

// The workbench the installed streamotter brings with it, resolved the way npm laid it out.
const require = createRequire(createRequire(import.meta.url).resolve("streamotter/package.json"));
const workbench = dirname(require.resolve("@streamotter/workbench/package.json"));
const manifestPath = join(workbench, "dist", "workbench-host.json");

test("the page mounts a published workbench only when the installed one publishes the WHC-1 manifest", () => {
  const installed = JSON.parse(readFileSync(join(workbench, "package.json"), "utf8")) as { version: string };
  if (!existsSync(manifestPath)) {
    // rc.3 and earlier: no seam, so the mount path stays inert.
    assert.equal(PUBLISHED_SEAM, null, `@streamotter/workbench@${installed.version} publishes no workbench-host.json`);
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { hostContract: number; version: string; integrity: Record<string, string> };
  assert.ok(PUBLISHED_SEAM, `@streamotter/workbench@${installed.version} publishes WHC-1; pin it in workbench-seam.ts (W9a)`);
  assert.equal(PUBLISHED_SEAM.hostContract, manifest.hostContract);
  assert.equal(PUBLISHED_SEAM.version, manifest.version);
  assert.equal(PUBLISHED_SEAM.integrity.script, manifest.integrity["app.js"]);
  assert.equal(PUBLISHED_SEAM.integrity.style, manifest.integrity["styles.css"]);
});
