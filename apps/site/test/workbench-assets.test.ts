import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import workbenchAssets, { installedWorkbench, LICENSES, loadWorkbenchAssets } from "../integrations/workbench-assets.mjs";
import { PUBLISHED_SEAM, type PublishedSeam } from "../src/scripts/workbench-seam.ts";

const seam = PUBLISHED_SEAM!;
const scratch = mkdtempSync(join(tmpdir(), "lontra-workbench-assets-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sha384 = (bytes: Buffer): string => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
/** A copy of the installed package, so a test can change one file. */
function copy(name: string): string { const dir = join(scratch, name); cpSync(installedWorkbench(), dir, { recursive: true }); return dir; }

describe("loadWorkbenchAssets", () => {
  test("serves exactly the script, the scoped host stylesheet and the license file, at the pinned versioned paths", () => {
    const assets = loadWorkbenchAssets();
    assert.ok(assets);
    assert.deepEqual(assets.files.map(file => file.url), [seam.script, seam.hostStyle, seam.licenses]);
    assert.deepEqual(assets.files.map(file => file.name), ["app.js", "workbench-host.css", LICENSES]);
    assert.equal(sha384(assets.files[0]!.bytes), seam.integrity.script);
    assert.equal(sha384(assets.files[1]!.bytes), seam.integrity.hostStyle);
    // Never the source map, the native stylesheet, or the standalone index.html.
    assert.ok(assets.files.every(file => !/\.map$|styles\.css$|index\.html$/.test(file.url)));
  });
  test("no pinned seam serves nothing", () => {
    assert.equal(loadWorkbenchAssets(null), null);
  });
  test("an installed file that no longer matches its pinned hash fails", () => {
    const dir = copy("tampered");
    writeFileSync(join(dir, "dist", "app.js"), readFileSync(join(dir, "dist", "app.js"), "utf8") + "\n// changed\n");
    assert.throws(() => loadWorkbenchAssets(seam, dir), /installed app\.js hashes to sha384-.*not the pinned/);
  });
  test("a pin that disagrees with the manifest fails, before anything is served", () => {
    assert.throws(() => loadWorkbenchAssets({ ...seam, integrity: { ...seam.integrity, hostStyle: "sha384-other" } }), /manifest's integrity for workbench-host\.css/);
    assert.throws(() => loadWorkbenchAssets({ ...seam, version: "0.2.0" }), /is not the pinned @streamotter\/workbench@0\.2\.0/);
    const upgraded = copy("upgraded");
    const manifestPath = join(upgraded, "dist", "workbench-host.json");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version: "0.2.0" }));
    assert.throws(() => loadWorkbenchAssets(seam, upgraded), /installed @streamotter\/workbench@0\.2\.0/);
  });
  test("a pinned path outside the allowlist's versioned paths fails", () => {
    const moved: PublishedSeam = { ...seam, script: "/workbench/assets/app.js" };
    assert.throws(() => loadWorkbenchAssets(moved), /\/workbench\/assets\/app\.js is not where app\.js is served/);
    assert.throws(() => loadWorkbenchAssets({ ...seam, licenses: `/workbench/assets/${seam.version}/app.js.map` }), /is not where THIRD_PARTY_LICENSES\.txt is served/);
  });
});

describe("the integration", () => {
  type Middleware = (request: { url?: string; method?: string }, response: { writeHead: (status: number, headers: Record<string, unknown>) => void; end: (body?: Buffer) => void }, next: () => void) => void;
  const integration = workbenchAssets();
  // The hooks take Astro's option objects; each test passes only the members its hook reads.
  const hooks = integration.hooks as unknown as Record<string, (options: any) => void>;
  let vite: { plugins: { resolveId: (id: string) => string | undefined; load: (id: string) => string | undefined }[] } | undefined;
  hooks["astro:config:setup"]!({ updateConfig: (config: { vite: typeof vite }) => { vite = config.vite; } });

  test("the page's virtual module is the installed manifest", () => {
    const plugin = vite!.plugins[0]!;
    const id = plugin.resolveId("virtual:lontra/workbench-host");
    assert.ok(id);
    assert.equal(plugin.resolveId("virtual:other"), undefined);
    const manifest = JSON.parse(plugin.load(id)!.replace(/^export default /, "").replace(/;$/, "")) as { version: string; csp: Record<string, string[]> };
    assert.equal(manifest.version, seam.version);
    assert.ok(manifest.csp["connect-src"]?.includes("<gateway websocket origin>"));
  });
  test("the dev server answers only the allowlisted paths, and passes everything else on", () => {
    let middleware: Middleware | undefined;
    hooks["astro:server:setup"]!({ server: { middlewares: { use: (handler: Middleware) => { middleware = handler; } } } });
    const ask = (url: string, method = "GET") => {
      let answered: { status: number; headers: Record<string, unknown>; body?: Buffer | undefined } | null = null; let passed = false;
      middleware!({ url, method }, { writeHead: (status, headers) => { answered = { status, headers }; }, end: body => { answered!.body = body; } }, () => { passed = true; });
      return { answered: answered as { status: number; headers: Record<string, unknown>; body?: Buffer | undefined } | null, passed };
    };
    const script = ask(`${seam.script}?v=1`);
    assert.equal(script.answered?.status, 200);
    assert.equal(script.answered?.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(sha384(script.answered!.body!), seam.integrity.script);
    assert.equal(ask(seam.hostStyle).answered?.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(ask(seam.licenses).answered?.headers["x-content-type-options"], "nosniff");
    for (const other of [`/workbench/assets/${seam.version}/app.js.map`, `/workbench/assets/${seam.version}/styles.css`, `/workbench/assets/${seam.version}/../../index.html`, "/workbench/"]) {
      assert.equal(ask(other).passed, true, other);
    }
    assert.equal(ask(seam.script, "POST").passed, true);
  });
  test("a build copies exactly the allowlisted files into dist/", () => {
    const dist = join(scratch, "dist");
    hooks["astro:build:done"]!({ dir: pathToFileURL(`${dist}/`) });
    const written = readdirSync(dist, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => `/${relative(dist, join(entry.parentPath, entry.name))}`).sort();
    assert.deepEqual(written, [seam.hostStyle, seam.licenses, seam.script].sort());
    assert.equal(sha384(readFileSync(join(dist, seam.script))), seam.integrity.script);
  });
});
