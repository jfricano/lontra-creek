/**
 * Local development: the field station (gateway on the simulation replay, workbench,
 * site API) and the site, together. Ctrl+C stops both.
 *   npm run dev
 *
 * Environment (all optional; defaults match today's ports): LONTRA_SITE_PORT
 * (4321), LONTRA_GATEWAY_PORT (7400), LONTRA_WORKBENCH_PORT (7401), LONTRA_API_PORT
 * (7402). Both children below inherit them from this process's environment, so
 * setting them before `npm run dev` moves the whole stack to a different port
 * block and a second stack can run alongside this one (docs/TEAM_PLAN.md, F.1;
 * README.md, Develop).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const children = [];
let stopping = false;

function run(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" } });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", text => {
      process.stdout.write(text.split("\n").map(line => (line === "" ? line : `[${name}] ${line}`)).join("\n"));
    });
  }
  child.on("exit", code => {
    if (stopping) return;
    console.error(`[${name}] exited with ${code}; stopping.`);
    stop();
  });
}

function stop() {
  stopping = true;
  for (const child of children) child.kill("SIGINT");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

run("field", process.execPath, ["scripts/dev.ts"], new URL("../apps/field-station/", import.meta.url));
const astro = createRequire(new URL("../apps/site/package.json", import.meta.url)).resolve("astro/package.json").replace(/package\.json$/, "bin/astro.mjs");
// --ignore-lock keeps Astro in the foreground: Astro 7 detaches its dev server when it detects an AI agent.
run("site", process.execPath, [astro, "dev", "--ignore-lock"], new URL("../apps/site/", import.meta.url));
