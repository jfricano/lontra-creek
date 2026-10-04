/**
 * Serves the pinned published workbench from the site's own origin (sandbox contract §4,
 * LC11-ADR-04). Exactly three files of the installed `@streamotter/workbench` are served,
 * at `/workbench/assets/<version>/`: the manifest's `entry.script` and `entry.hostStyle`,
 * and THIRD_PARTY_LICENSES.txt, which ships with app.js. The source map is not shipped.
 * Each hashed file must match both the installed manifest and `PUBLISHED_SEAM`, or the
 * dev server and the build fail. In development the files come from a dev-server
 * middleware, so the stubbed browser specs run the real app.js; a build copies them
 * into `dist/`. The page reads the manifest's `csp` from `virtual:lontra/workbench-host`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHED_SEAM } from "../src/scripts/workbench-seam.ts";

export const LICENSES = "THIRD_PARTY_LICENSES.txt";
const VIRTUAL = "virtual:lontra/workbench-host";

/** The installed @streamotter/workbench, resolved through streamotter the way npm laid it out. */
export function installedWorkbench() {
  const require = createRequire(createRequire(import.meta.url).resolve("streamotter/package.json"));
  return dirname(require.resolve("@streamotter/workbench/package.json"));
}

const sha384 = bytes => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/**
 * The manifest and the allowlisted files, read and checked. Null when the site pins no
 * seam. Throws when the installed release is not the pinned one, a pinned path is not
 * the versioned path of an allowlisted file, or any hash differs.
 */
export function loadWorkbenchAssets(seam = PUBLISHED_SEAM, packageDir = installedWorkbench()) {
  if (seam === null) return null;
  const dist = join(packageDir, "dist");
  const manifest = JSON.parse(readFileSync(join(dist, "workbench-host.json"), "utf8"));
  const fail = message => { throw new Error(`Workbench assets: ${message} Re-pin apps/site/src/scripts/workbench-seam.ts from the installed manifest.`); };
  if (manifest.package !== seam.package || manifest.hostContract !== seam.hostContract || manifest.version !== seam.version) {
    fail(`the installed ${manifest.package}@${manifest.version} (host contract ${manifest.hostContract}) is not the pinned ${seam.package}@${seam.version} (host contract ${seam.hostContract}).`);
  }
  const base = `/workbench/assets/${manifest.version}/`;
  const allowed = [
    { name: manifest.entry.script, url: seam.script, integrity: seam.integrity.script, type: "text/javascript; charset=utf-8" },
    { name: manifest.entry.hostStyle, url: seam.hostStyle, integrity: seam.integrity.hostStyle, type: "text/css; charset=utf-8" },
    { name: LICENSES, url: seam.licenses, integrity: null, type: "text/plain; charset=utf-8" }
  ];
  const files = allowed.map(({ name, url, integrity, type }) => {
    if (typeof name !== "string" || !/^[\w.-]+$/.test(name) || url !== base + name) fail(`${url} is not where ${name} is served (${base}${name}).`);
    const bytes = readFileSync(join(dist, name));
    if (integrity !== null) {
      const actual = sha384(bytes);
      if (manifest.integrity[name] !== integrity) fail(`the manifest's integrity for ${name} is ${manifest.integrity[name]}, but the pin says ${integrity}.`);
      if (actual !== integrity) fail(`the installed ${name} hashes to ${actual}, not the pinned ${integrity}.`);
    }
    return { name, url, type, bytes };
  });
  return { manifest, files };
}

/** The Astro integration: the dev-server middleware, the build copy, and the virtual manifest module. */
export default function workbenchAssets() {
  let assets = null;
  return {
    name: "lontra-workbench-assets",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        assets = loadWorkbenchAssets();
        const manifest = assets?.manifest ?? null;
        updateConfig({ vite: { plugins: [{
          name: "lontra-workbench-host",
          resolveId: id => id === VIRTUAL ? `\0${VIRTUAL}` : undefined,
          load: id => id === `\0${VIRTUAL}` ? `export default ${JSON.stringify(manifest)};` : undefined
        }] } });
      },
      "astro:server:setup": ({ server }) => {
        const byUrl = new Map((assets?.files ?? []).map(file => [file.url, file]));
        server.middlewares.use((request, response, next) => {
          const file = byUrl.get(new URL(request.url ?? "/", "http://localhost").pathname);
          if (!file || (request.method !== "GET" && request.method !== "HEAD")) return next();
          response.writeHead(200, { "content-type": file.type, "content-length": file.bytes.length, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
          response.end(request.method === "HEAD" ? undefined : file.bytes);
        });
      },
      "astro:build:done": ({ dir }) => {
        const out = fileURLToPath(dir);
        for (const file of assets?.files ?? []) {
          const target = join(out, ...file.url.split("/").filter(Boolean));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, file.bytes);
        }
      }
    }
  };
}
