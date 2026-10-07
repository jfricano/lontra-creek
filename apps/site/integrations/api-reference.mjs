/**
 * Builds the site's API reference (/docs/api/) from the installed `streamotter` package: the
 * release the site pins, so the reference can't describe any other version. TypeDoc reads the
 * package's published type declarations, comments included, once per dev server or build, and
 * src/api-reference/build.ts turns its model into the pages' data. The pages import it from
 * `virtual:lontra/api-reference`. A declaration TypeDoc can't read fails the build.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { Application, LogLevel } from "typedoc";
import { buildApiReference } from "../src/api-reference/build.ts";
import { API_MODULES } from "../src/api-reference/modules.ts";

const VIRTUAL = "virtual:lontra/api-reference";
const REPOSITORY = "https://github.com/jfricano/StreamOtter";

/** The installed streamotter package's directory and version. */
export function installedStreamotter() {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("streamotter/package.json");
  return { dir: dirname(manifest), version: require(manifest).version, require: createRequire(manifest) };
}

/**
 * A declaration's file on GitHub at the release's tag. TypeDoc names files from the installed
 * packages (`@streamotter/contracts/dist/types.d.ts`); each is emitted from the same path under
 * the repository's `packages/<name>/src/`, so the link opens the source, not the declaration.
 */
export function sourceUrlFor(version) {
  return fileName => {
    const match = /(?:^|\/)@streamotter\/([\w-]+)\/dist\/(.+)\.d\.ts$/.exec(fileName.split(sep).join("/"));
    return match ? `${REPOSITORY}/blob/v${version}/packages/${match[1]}/src/${match[2]}.ts` : null;
  };
}

/** Runs TypeDoc over the installed release's entry points and returns its JSON model. */
export async function readStreamotterModel(installed = installedStreamotter()) {
  // Contracts first: a symbol several entry points export is documented where it is declared.
  const order = ["contracts", ...API_MODULES.map(module => module.entry).filter(entry => entry !== "contracts")];
  const entryPoints = order.map(entry => join(installed.dir, "dist", `${entry}.d.ts`));
  const typesNode = dirname(installed.require.resolve("@types/node/package.json"));
  const work = mkdtempSync(join(tmpdir(), "lontra-api-reference-"));
  try {
    const tsconfig = join(work, "tsconfig.json");
    writeFileSync(tsconfig, JSON.stringify({
      compilerOptions: {
        module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023", lib: ["ES2023", "DOM"], strict: true, noEmit: true,
        types: ["node"], typeRoots: [dirname(typesNode)]
      },
      files: entryPoints
    }));
    const problems = [];
    const app = await Application.bootstrap({
      entryPoints, tsconfig, logLevel: LogLevel.Warn, excludeInternal: true, excludePrivate: true, excludeProtected: true,
      // The package was type-checked when it was released; its declarations are read as published.
      skipErrorChecking: true, readme: "none", plugin: [], sort: ["source-order"]
    });
    const log = app.logger.log.bind(app.logger);
    app.logger.log = (message, level) => {
      if (level >= LogLevel.Error) problems.push(String(message));
      log(message, level);
    };
    const project = await app.convert();
    if (project === undefined || problems.length > 0) throw new Error(`API reference: TypeDoc could not read streamotter@${installed.version}.\n${problems.join("\n")}`);
    return app.serializer.projectToObject(project, installed.dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The reference's data for the installed release. */
export async function loadApiReference(installed = installedStreamotter()) {
  const model = await readStreamotterModel(installed);
  return buildApiReference(model, { release: installed.version, sourceUrl: sourceUrlFor(installed.version) });
}

/** The Astro integration: builds the reference once and serves it as a virtual module. */
export default function apiReference() {
  let reference = null;
  return {
    name: "lontra-api-reference",
    hooks: {
      "astro:config:setup": async ({ updateConfig }) => {
        reference = await loadApiReference();
        updateConfig({ vite: { plugins: [{
          name: "lontra-api-reference",
          resolveId: id => id === VIRTUAL ? `\0${VIRTUAL}` : undefined,
          load: id => id === `\0${VIRTUAL}` ? `export default ${JSON.stringify(reference)};` : undefined
        }] } });
      }
    }
  };
}
