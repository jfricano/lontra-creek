#!/usr/bin/env node
/**
 * Refuses a release build that doesn't install StreamOtter from the npm registry.
 *
 * A branch may carry locally packed StreamOtter tarballs (vendor/, `file:` specs,
 * root overrides) to test an unpublished release. The image and site deploy
 * workflows run this first, so such a branch can be tested but never built for
 * deployment. Usage: node scripts/check-release-pins.mjs [root]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFESTS = ["package.json", "apps/field-station/package.json", "apps/site/package.json"];
const REGISTRY = "https://registry.npmjs.org/";
const isStreamOtter = name => name === "streamotter" || name.startsWith("@streamotter/");

/** Every reason this checkout isn't installing StreamOtter from the registry; empty when it is. */
export function releasePinProblems(root) {
  const problems = [];
  if (existsSync(join(root, "vendor"))) problems.push("vendor/ holds locally packed packages");
  for (const path of MANIFESTS) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    for (const field of ["dependencies", "devDependencies", "overrides"]) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (isStreamOtter(name)) {
          if (field === "overrides") problems.push(`${path} overrides ${name}`);
          else if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(spec))) problems.push(`${path} ${field}.${name} is "${spec}", not an exact version`);
        }
      }
    }
  }
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (path.includes("node_modules/") && isStreamOtter(name) && !String(entry.resolved ?? "").startsWith(REGISTRY)) {
      problems.push(`package-lock.json resolves ${name} from ${entry.resolved ?? "nowhere"}`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const problems = releasePinProblems(root);
  if (problems.length) {
    console.error("Not a release build: StreamOtter must come from the npm registry at an exact version.");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("StreamOtter is pinned to registry releases.");
}
