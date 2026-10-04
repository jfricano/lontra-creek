import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { WorkbenchHostManifest } from "streamotter/contracts";
import { PUBLISHED_SEAM } from "../src/scripts/workbench-seam.ts";

// The workbench the installed streamotter brings with it, resolved the way npm laid it out.
const require = createRequire(createRequire(import.meta.url).resolve("streamotter/package.json"));
const workbench = dirname(require.resolve("@streamotter/workbench/package.json"));
const manifestPath = join(workbench, "dist", "workbench-host.json");
const sha384 = (file: string): string => `sha384-${createHash("sha384").update(readFileSync(join(workbench, "dist", file))).digest("base64")}`;

test("the page mounts a published workbench only when the installed one publishes the WHC-1 manifest", () => {
  const installed = JSON.parse(readFileSync(join(workbench, "package.json"), "utf8")) as { version: string };
  if (!existsSync(manifestPath)) {
    // rc.3 and earlier: no seam, so the mount path stays inert.
    assert.equal(PUBLISHED_SEAM, null, `@streamotter/workbench@${installed.version} publishes no workbench-host.json`);
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WorkbenchHostManifest;
  assert.ok(PUBLISHED_SEAM, `@streamotter/workbench@${installed.version} publishes WHC-1; pin it in workbench-seam.ts (W9a)`);
  assert.equal(PUBLISHED_SEAM.package, manifest.package);
  assert.equal(PUBLISHED_SEAM.hostContract, manifest.hostContract);
  assert.equal(PUBLISHED_SEAM.version, manifest.version);
  assert.equal(PUBLISHED_SEAM.version, installed.version);
  // The host links the scoped stylesheet, never the native one that styles the whole page (R12).
  assert.equal(PUBLISHED_SEAM.integrity.script, manifest.integrity[manifest.entry.script]);
  assert.equal(PUBLISHED_SEAM.integrity.hostStyle, manifest.integrity[manifest.entry.hostStyle]);
  // The installed bytes carry the pinned hashes, not only the manifest.
  assert.equal(sha384(manifest.entry.script), PUBLISHED_SEAM.integrity.script);
  assert.equal(sha384(manifest.entry.hostStyle), PUBLISHED_SEAM.integrity.hostStyle);
  // Served under the pinned version, so a re-pin never meets a stale cached file.
  assert.ok(PUBLISHED_SEAM.script.endsWith(`/${manifest.version}/${manifest.entry.script}`), PUBLISHED_SEAM.script);
  assert.ok(PUBLISHED_SEAM.hostStyle.endsWith(`/${manifest.version}/${manifest.entry.hostStyle}`), PUBLISHED_SEAM.hostStyle);
  assert.ok(PUBLISHED_SEAM.licenses.endsWith(`/${manifest.version}/THIRD_PARTY_LICENSES.txt`), PUBLISHED_SEAM.licenses);
  assert.ok(existsSync(join(workbench, "dist", "THIRD_PARTY_LICENSES.txt")), "app.js ships with its license file");
});
