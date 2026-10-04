/**
 * Where a capture's StreamOtter came from, for the labels the capture scripts write next to
 * their assets. Nothing here is hand-typed: the version is the installed package's own, the
 * install source is read from the lockfile entry npm installed it from, and the platform is
 * the one the script ran on. A label can therefore only say "published npm" once the lockfile
 * resolves the package from the registry.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const REGISTRY = "https://registry.npmjs.org/";

/** "published npm" for a registry tarball, "pre-publish tarball" for a local `file:` one; anything else is refused. */
export function installSource(resolved) {
  if (typeof resolved === "string" && resolved.startsWith(REGISTRY)) return "published npm";
  if (typeof resolved === "string" && resolved.startsWith("file:")) return "pre-publish tarball";
  throw new Error(`Unrecognized install source for streamotter: ${String(resolved)}`);
}

/** A reader's name for a `process.platform` value. */
export function platformName(platform = process.platform) {
  return { darwin: "macOS", linux: "Linux", win32: "Windows" }[platform] ?? platform;
}

/**
 * The installed streamotter, as a capture should describe it. `root` is the repository root
 * (where package-lock.json lives); the lockfile and the installed package must agree.
 */
export function installedStreamotter(root) {
  const require = createRequire(new URL("package.json", root));
  const { version } = require("streamotter/package.json");
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const entry = lock.packages?.["node_modules/streamotter"];
  if (entry?.version !== version) throw new Error(`package-lock.json locks streamotter@${entry?.version}, but ${version} is installed; run npm ci.`);
  return { version, install: installSource(entry.resolved), platform: platformName() };
}
