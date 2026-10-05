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
/** The package an override key names, without its `@range`. */
const overridden = key => key.slice(0, key.indexOf("@", 1) === -1 ? key.length : key.indexOf("@", 1));
/** Every override key, at any depth, that names a StreamOtter package, as its path from the top. */
const streamOtterOverrides = (overrides, at = []) => Object.entries(overrides ?? {}).flatMap(([key, value]) => [
  ...isStreamOtter(overridden(key)) ? [[...at, key].join(" > ")] : [],
  ...value !== null && typeof value === "object" ? streamOtterOverrides(value, [...at, key]) : []
]);

/** Every reason this checkout isn't installing StreamOtter from the registry; empty when it is. */
export function releasePinProblems(root) {
  const problems = [];
  if (existsSync(join(root, "vendor"))) problems.push("vendor/ holds locally packed packages");
  for (const path of MANIFESTS) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    for (const field of ["dependencies", "devDependencies"]) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (isStreamOtter(name) && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(spec))) problems.push(`${path} ${field}.${name} is "${spec}", not an exact version`);
      }
    }
    for (const key of streamOtterOverrides(manifest.overrides)) problems.push(`${path} overrides ${key}`);
  }
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.includes("node_modules/")) continue;
    // npm writes `name` only for an alias: one package installed under another's name.
    const installed = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const name = entry.name ?? installed;
    if (!isStreamOtter(installed) && !isStreamOtter(name)) continue;
    if (name !== installed) problems.push(`package-lock.json installs ${name} as ${installed} (${path})`);
    else if (!String(entry.resolved ?? "").startsWith(REGISTRY)) problems.push(`package-lock.json resolves ${name} from ${entry.resolved ?? "nowhere"}`);
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
