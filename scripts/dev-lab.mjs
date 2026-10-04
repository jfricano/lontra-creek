/**
 * The real-Kafka Failure Lab on this machine, built from source: the
 * docs/LOCAL_LAB.md recipe as one command. Three benches, Kafka over TLS, the
 * field station, the gateway, and Caddy, served at https://localhost:8443 only.
 *
 *   npm run dev:lab                         # same as `up`
 *   npm run dev:lab -- up [--no-build] [--extra-ca <file>]
 *   npm run dev:lab -- status
 *   npm run dev:lab -- logs [--follow] [service...]
 *   npm run dev:lab -- stop                 # keeps volumes and the current study
 *   npm run dev:lab -- discard [--yes]      # deletes this local study, after confirmation
 *
 * Every command takes --dir <path> (default .local/lab; it must be a git-ignored
 * directory under this repository's .local/, not dev:kafka's) and --project <name>
 * (the Compose project, default lontra-local-lab, fixed when the directory is
 * first prepared).
 *
 * This launcher never deploys anything, publishes no image, changes no system or
 * browser trust store, and deletes volumes only through `discard` after an
 * explicit confirmation. It has no dependencies beyond Node, Docker, Compose,
 * OpenSSL, and the repository's own scripts. See docs/LOCAL_LAB.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, copyFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:https";
import { createInterface } from "node:readline/promises";
import { join, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";

export const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DEFAULT_DIR = ".local/lab";
export const DEFAULT_PROJECT = "lontra-local-lab";
/** scripts/dev-kafka.mjs keeps its broker here unless LONTRA_KAFKA_DATA_DIR says otherwise. */
export const KAFKA_DEV_DIR = ".local/kafka-dev";
/** Fixed by deploy/compose.local-lab.yaml and deploy/Caddyfile.local-lab. */
export const PORT = 8443;
export const ORIGIN = `https://localhost:${PORT}`;
export const MIN_NODE = "24.0.0";
/** `!override` in deploy/compose.local-lab.yaml needs Compose 2.24.4. */
export const MIN_COMPOSE = "2.24.4";
const COMPOSE_FILES = ["deploy/compose.yaml", "deploy/compose.lab.yaml", "deploy/compose.local-lab.yaml"];
const STATE_FILE = "dev-lab.json";
const COMMANDS = ["up", "stop", "status", "logs", "discard"];

export class UsageError extends Error {}

export const USAGE = `Usage: npm run dev:lab -- [command] [options]

Runs the real-Kafka Failure Lab locally from source at ${ORIGIN}/lab/.
Not the same as \`npm run dev\` (fixture walkthrough, no Kafka) or
\`npm run dev:kafka\` (native Kafka walkthrough, no Lab benches).

Commands:
  up        Check prerequisites, prepare the local directory, build, and start (default)
  status    Show containers and probe the site, health, and Lab status URLs
  logs      Show recent container logs; --follow to stream; optional service names
  stop      Stop and remove the containers; keeps volumes and the current study
  discard   Delete this local study: the project's volumes and the local directory.
            Asks for confirmation; --yes confirms non-interactively

Options:
  --dir <path>        Local directory under .local/, git-ignored (default ${DEFAULT_DIR})
  --project <name>    Compose project name (default ${DEFAULT_PROJECT}); fixed at first \`up\`
  --no-build          up: reuse the existing site build and image instead of rebuilding
  --extra-ca <file>   up: trust this extra CA bundle for npm inside the image build only
                      (for networks behind a TLS-intercepting proxy); needs BuildKit
  --follow, -f        logs: keep streaming
  --yes, -y           discard: confirm without a prompt
  --help, -h          Show this help`;

/** Parses the command line (without node and the script path). Throws UsageError. */
export function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: "string" },
        project: { type: "string" },
        "no-build": { type: "boolean" },
        "extra-ca": { type: "string" },
        follow: { type: "boolean", short: "f" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" }
      }
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: "help" };
  const [command = "up", ...rest] = positionals;
  if (!COMMANDS.includes(command)) throw new UsageError(`Unknown command "${command}". Expected one of: ${COMMANDS.join(", ")}.`);
  if (rest.length > 0 && command !== "logs") throw new UsageError(`"${command}" takes no arguments; got: ${rest.join(" ")}.`);
  const only = (option, allowed) => {
    if (values[option] !== undefined && command !== allowed) throw new UsageError(`--${option} applies only to "${allowed}".`);
  };
  only("no-build", "up");
  only("extra-ca", "up");
  only("follow", "logs");
  only("yes", "discard");
  for (const service of rest) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(service)) throw new UsageError(`Not a service name: ${service}`);
  }
  if (values.project !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(values.project)) {
    throw new UsageError("--project must be lowercase letters, digits, '-' or '_', starting with a letter or digit.");
  }
  if (values.dir === "") throw new UsageError("--dir needs a path.");
  if (values["extra-ca"] === "") throw new UsageError("--extra-ca needs a file.");
  return {
    command,
    dir: values.dir ?? DEFAULT_DIR,
    project: values.project,
    build: !values["no-build"],
    extraCa: values["extra-ca"],
    follow: values.follow === true,
    yes: values.yes === true,
    services: rest
  };
}

/** Compares dotted versions numerically: negative, zero, or positive. Ignores a leading "v" and any suffix. */
export function compareVersions(a, b) {
  const parts = value => String(value).trim().replace(/^v/, "").split(/[^0-9.]/)[0].split(".").map(n => Number(n) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Runs a command to completion and captures its output. */
export function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

/** True when nothing on this machine holds the loopback port. */
export function isPortFree(port, host = "127.0.0.1") {
  return new Promise(done => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)));
  });
}

/**
 * Checks what `up` needs. `run(command, args)` returns { status, stdout, stderr }
 * (status null when the command is missing); `portFree(port)` resolves to a boolean.
 * Returns the problems found, each a sentence with what to do; empty means ready.
 */
export async function checkPrerequisites({ run = capture, portFree = isPortFree, nodeVersion = process.versions.node, checkPort = true, extraCa } = {}) {
  const problems = [];
  if (compareVersions(nodeVersion, MIN_NODE) < 0) problems.push(`Node ${MIN_NODE.split(".")[0]} or later is required; this is Node ${nodeVersion}.`);
  const docker = await run("docker", ["--version"]);
  if (docker.status !== 0) {
    problems.push("Docker is not installed or not on PATH. Install Docker Engine or Docker Desktop.");
  } else {
    const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    if (info.status !== 0) problems.push("The Docker daemon is not reachable. Start Docker (Docker Desktop, or the docker service) and try again.");
    const compose = await run("docker", ["compose", "version", "--short"]);
    if (compose.status !== 0) problems.push(`Docker Compose v2 (the \`docker compose\` plugin), ${MIN_COMPOSE} or later, is required.`);
    else if (compareVersions(compose.stdout, MIN_COMPOSE) < 0) problems.push(`Docker Compose ${MIN_COMPOSE} or later is required (for !override); found ${compose.stdout.trim()}.`);
  }
  const openssl = await run("openssl", ["version"]);
  if (openssl.status !== 0) problems.push("OpenSSL is required to make the local test certificates and secrets.");
  if (extraCa !== undefined && !existsSync(extraCa)) problems.push(`--extra-ca file not found: ${extraCa}`);
  if (!existsSync(join(ROOT, "node_modules"))) problems.push("Dependencies are not installed. Run `npm ci` first.");
  if (checkPort && !(await portFree(PORT))) problems.push(`Port ${PORT} on 127.0.0.1 is in use. Stop whatever holds it (another local Lab: \`npm run dev:lab -- stop\`) and try again.`);
  return problems;
}

/**
 * The local directory, absolute, after checking it is under the repository's
 * .local/ and git-ignored, so secrets and study data never become tracked files,
 * land where something serves them (apps/site/dist), or share dev:kafka's data,
 * which `discard` would delete. Without git (a source archive), .local/ is enough.
 */
export function localDirectory(dir, { root = ROOT, run = capture, kafkaDataDir = process.env.LONTRA_KAFKA_DATA_DIR } = {}) {
  const path = resolve(root, dir);
  const inside = relative(root, path);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new UsageError(`--dir must be a directory inside the repository (${root}); got ${path}.`);
  // .local/ also holds dev:kafka's data; the Lab gets a directory of its own beneath it.
  if (inside === ".local") throw new UsageError("--dir must be a directory of its own, such as .local/lab, not .local itself.");
  if (inside.split(sep)[0] !== ".local") throw new UsageError(`--dir must be under .local/ (the default is ${DEFAULT_DIR}); got ${inside}.`);
  for (const kafka of [resolve(root, KAFKA_DEV_DIR), ...(kafkaDataDir ? [resolve(root, kafkaDataDir)] : [])]) {
    if (path === kafka || path.startsWith(kafka + sep) || kafka.startsWith(path + sep)) {
      throw new UsageError(`--dir ${inside} overlaps dev:kafka's data directory (${relative(root, kafka) || kafka}); use another directory under .local/.`);
    }
  }
  const ignored = run("git", ["check-ignore", "-q", "--no-index", inside.split(sep).join("/") + "/"], { cwd: root });
  if (ignored.status === 1) throw new UsageError(`${inside} is not git-ignored. Use a directory under .local/ (the default is ${DEFAULT_DIR}).`);
  return path;
}

/**
 * Refuses an existing directory that has contents but no dev-lab.json: `up` would
 * write secrets among another tool's files and mark them as the launcher's, which
 * `discard` then deletes.
 */
export function checkOwnDirectory(path) {
  if (!existsSync(path)) return;
  if (!statSync(path).isDirectory()) throw new UsageError(`${path} is not a directory.`);
  if (readdirSync(path).length > 0 && !readState(path)) {
    throw new UsageError(`${path} already has files and was not made by this launcher (no ${STATE_FILE}). Use a new or empty directory under .local/.`);
  }
}

/**
 * Asks before discarding. Confirms with --yes, or when an interactive person types
 * the project name; refuses otherwise, including in a non-interactive shell.
 */
export async function confirmDiscard({ project, yes, interactive, ask, describe = [] }) {
  if (yes) return true;
  if (!interactive) return false;
  const answer = await ask([
    "This deletes the local study permanently:",
    ...describe.map(line => `  ${line}`),
    `Type the project name (${project}) to confirm, or anything else to cancel: `
  ].join("\n"));
  return answer.trim() === project;
}

/** deploy/Dockerfile with each `RUN npm ci` trusting an extra CA, mounted as a build secret. */
export function extraCaDockerfile(text) {
  let count = 0;
  const result = text.replace(/^RUN npm ci /gm, () => {
    count++;
    return "RUN --mount=type=secret,id=ca,target=/tmp/extra-ca.pem NODE_EXTRA_CA_CERTS=/tmp/extra-ca.pem npm ci ";
  });
  if (count === 0) throw new Error("deploy/Dockerfile has no `RUN npm ci` line to adapt for --extra-ca.");
  return result;
}

/** Parses a Compose env file's KEY=value lines. */
export function readEnv(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

/** GETs a URL over HTTPS trusting only the given CA, for this request alone. */
export function probe(url, ca, timeoutMs = 5000) {
  return new Promise(done => {
    const req = request(url, { ca, timeout: timeoutMs }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { if (body.length < 2000) body += chunk; });
      response.on("end", () => done({ status: response.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", error => done({ status: null, error: error.message }));
    req.end();
  });
}

/** Polls Lab status until a bench is ready: benches start after Compose reports them healthy. */
export async function waitForReadyBench(ca, { timeoutMs = 120_000, intervalMs = 2000, check = probe } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check(urls().labStatus, ca);
    try {
      if (result.status === 200 && JSON.parse(result.body).benches?.some(bench => bench.state === "ready")) return true;
    } catch { /* not JSON yet */ }
    if (Date.now() >= deadline) return false;
    await new Promise(done => setTimeout(done, intervalMs));
  }
}

export function urls() {
  return {
    site: `${ORIGIN}/`,
    lab: `${ORIGIN}/lab/`,
    health: `${ORIGIN}/api/status`,
    labStatus: `${ORIGIN}/api/lab/status`
  };
}

// ---------------------------------------------------------------------------
// Commands

function step(message) {
  console.log(`\n==> ${message}`);
}

function must(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed (exit ${result.status}).`);
}

function readState(path) {
  try { return JSON.parse(readFileSync(join(path, STATE_FILE), "utf8")); } catch { return undefined; }
}

/** The local directory's recorded project, or an error when --project disagrees with it. */
function projectFor(path, requested) {
  const state = readState(path);
  if (state && requested !== undefined && requested !== state.project) {
    throw new UsageError(`${path} belongs to Compose project "${state.project}", not "${requested}". Use --project ${state.project}, or another --dir.`);
  }
  return state?.project ?? requested ?? DEFAULT_PROJECT;
}

function compose(project, path, args) {
  return ["compose", "-p", project, ...COMPOSE_FILES.flatMap(file => ["-f", file]), "--env-file", join(path, ".env"), ...args];
}

/** Writes the local settings once; later runs keep the epoch, secrets, and paths. */
function prepare(path, project) {
  mkdirSync(path, { recursive: true });
  if (!readState(path)) writeFileSync(join(path, STATE_FILE), JSON.stringify({ project, createdAt: new Date().toISOString(), note: "Made by scripts/dev-lab.mjs. `npm run dev:lab -- discard` deletes this directory." }, null, 2) + "\n");
  const envFile = join(path, ".env");
  must("bash", ["deploy/make-secrets.sh", envFile]);
  must("bash", ["deploy/make-certs.sh", "kafka", join(path, "secrets/kafka"), "lab-1-kafka", "lab-2-kafka", "lab-3-kafka"]);
  // make-certs.sh test-origin always makes a new CA; keep an existing one so a test browser profile's trust still applies.
  if (existsSync(join(path, "secrets/origin/cert.pem"))) console.log("Local origin test certificate already exists; keeping it.");
  else must("bash", ["deploy/make-certs.sh", "test-origin", join(path, "secrets/origin"), "localhost"]);

  const config = JSON.parse(readFileSync(join(ROOT, "apps/field-station/streamotter.production.json"), "utf8"));
  config.gateway.allowedOrigins = [ORIGIN];
  writeFileSync(join(path, "streamotter.production.json"), JSON.stringify(config, null, 2));

  const env = readEnv(readFileSync(envFile, "utf8"));
  const wanted = {
    LONTRA_IMAGE: project === DEFAULT_PROJECT ? "lontra-creek:local" : `lontra-creek:local-${project}`,
    LONTRA_SECRETS: join(path, "secrets"),
    LOCAL_LAB_DIR: path,
    FIELD_EPOCH: new Date().toISOString(),
    SITE_ORIGIN: ORIGIN,
    GATEWAY_PUBLIC_ORIGIN: ORIGIN,
    DEMO_HOST: "localhost",
    KAFKA_HEAP_OPTS: "-Xms512m -Xmx512m"
  };
  for (const key of ["LONTRA_SECRETS", "LOCAL_LAB_DIR"]) {
    if (env[key] !== undefined && env[key] !== wanted[key]) throw new Error(`${envFile} has ${key}=${env[key]}, but this directory is ${path}. Was it moved? Fix ${key} by hand, or discard it.`);
  }
  const missing = Object.keys(wanted).filter(key => env[key] === undefined);
  if (missing.length > 0) appendFileSync(envFile, `\n# Local Lab settings, added by scripts/dev-lab.mjs.\n${missing.map(key => `${key}=${wanted[key]}`).join("\n")}\n`);
  return { ...wanted, ...env };
}

async function report(ca) {
  const u = urls();
  for (const [label, url] of [["Site", u.site], ["Lab page", u.lab], ["Health (field station)", u.health], ["Lab status", u.labStatus]]) {
    const result = await probe(url, ca);
    let detail = result.status === null ? `unreachable (${result.error})` : `HTTP ${result.status}`;
    if (result.status === 200 && url === u.labStatus) {
      try {
        const status = JSON.parse(result.body);
        detail += status.enabled === false ? ", Lab disabled" : `, benches: ${status.benches.map(b => `${b.bench}=${b.state}`).join(" ") || "none"}`;
      } catch { /* the HTTP status is enough */ }
    }
    if (result.status === 200 && url === u.health) {
      try {
        const status = JSON.parse(result.body);
        if (status.kafka !== undefined) detail += `, kafka ${status.kafka}`;
      } catch { /* the HTTP status is enough */ }
    }
    console.log(`  ${label.padEnd(24)} ${url.padEnd(38)} ${detail}`);
  }
}

function trustAdvice(path) {
  const ca = join(path, "secrets/origin/ca.pem");
  console.log(`
The certificate for localhost is signed by a throwaway local test CA:
  ${ca}
Nothing was added to any system or browser trust store. To open the site in a
browser, either accept the warning for localhost in a dedicated test profile, or
trust that CA in a dedicated test browser profile only, and remove that trust
when you are done. Command-line checks can trust it for one process:
  curl --cacert ${ca} ${urls().labStatus}
  NODE_EXTRA_CA_CERTS=${ca} node ...`);
}

async function up(options) {
  const path = localDirectory(options.dir);
  checkOwnDirectory(path);
  const project = projectFor(path, options.project);
  step("Checking prerequisites");
  const running = capture("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.service=caddy"]);
  const alreadyServing = running.status === 0 && running.stdout.trim() !== "";
  const problems = await checkPrerequisites({ checkPort: !alreadyServing, extraCa: options.extraCa });
  if (problems.length > 0) throw new Error(`Not ready to start the local Lab:\n${problems.map(p => `  - ${p}`).join("\n")}`);
  console.log(`Ready. Local directory: ${relative(ROOT, path)}; Compose project: ${project}.`);

  step("Preparing local secrets, test certificates, and settings (kept across runs)");
  const env = prepare(path, project);

  if (options.build) {
    step("Building the site for the local origin");
    must("npm", ["run", "build", "-w", "@lontra-creek/site"], { env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", PUBLIC_FIELD_STATION_ORIGIN: ORIGIN } });
    step(`Building the image ${env.LONTRA_IMAGE} (local only; never pushed)`);
    let dockerfile = "deploy/Dockerfile";
    const secret = [];
    if (options.extraCa !== undefined) {
      const build = join(path, "build");
      mkdirSync(build, { recursive: true });
      dockerfile = join(build, "Dockerfile");
      writeFileSync(dockerfile, extraCaDockerfile(readFileSync(join(ROOT, "deploy/Dockerfile"), "utf8")));
      copyFileSync(join(ROOT, "deploy/Dockerfile.dockerignore"), `${dockerfile}.dockerignore`);
      secret.push("--secret", `id=ca,src=${resolve(options.extraCa)}`);
      console.log(`Using an extra CA for npm inside the build only: ${options.extraCa}`);
    }
    must("docker", ["build", "-f", dockerfile, ...secret, "-t", env.LONTRA_IMAGE, "."], { env: { ...process.env, DOCKER_BUILDKIT: "1" } });
  } else {
    if (!existsSync(join(ROOT, "apps/site/dist/lab/index.html"))) throw new Error("--no-build: apps/site/dist has no built Lab page. Run without --no-build.");
    if (capture("docker", ["image", "inspect", env.LONTRA_IMAGE]).status !== 0) throw new Error(`--no-build: image ${env.LONTRA_IMAGE} does not exist. Run without --no-build.`);
  }

  step("Starting the stack (Kafka, field station, gateway, three benches, Caddy); this can take a few minutes");
  const started = spawnSync("docker", compose(project, path, ["up", "-d", "--wait", "--wait-timeout", "300"]), { cwd: ROOT, stdio: "inherit" });
  if (started.status !== 0) {
    throw new Error(`The stack did not become healthy. It was left running for inspection:\n  npm run dev:lab -- status\n  npm run dev:lab -- logs\nStop it with \`npm run dev:lab -- stop\` (keeps data).`);
  }

  const ca = readFileSync(join(path, "secrets/origin/ca.pem"));
  step("Waiting for a Lab bench to report ready");
  const ready = await waitForReadyBench(ca);
  step(ready ? "Local Failure Lab is running" : "Local stack is running, but no Lab bench is ready yet");
  await report(ca);
  if (!ready) console.log("\nBenches can take longer on a slow machine. Check again with `npm run dev:lab -- status`, or read `npm run dev:lab -- logs lab-1`.");
  trustAdvice(path);
  console.log(`
Open ${urls().lab} . Only 127.0.0.1:${PORT} is published; Kafka, bench APIs, relay
controls and management listeners are private to the Compose network.

  npm run dev:lab -- status     # containers and URL checks
  npm run dev:lab -- logs -f    # stream logs
  npm run dev:lab -- stop       # stop; keeps Kafka data, checkpoints, bench studies, and the study epoch
  npm run dev:lab -- discard    # delete this local study (asks first)`);
}

function existing(options) {
  const path = localDirectory(options.dir);
  const project = projectFor(path, options.project);
  const prepared = existsSync(join(path, ".env"));
  return { path, project, prepared };
}

function stop(options) {
  const { path, project, prepared } = existing(options);
  if (!prepared) throw new Error(`No local Lab is prepared in ${relative(ROOT, path)}; nothing to stop.`);
  step(`Stopping ${project}; volumes and the local study are kept`);
  must("docker", compose(project, path, ["down"]));
  console.log(`Stopped. Start again with \`npm run dev:lab\`; the same study resumes. To delete it instead: \`npm run dev:lab -- discard\`.`);
}

async function status(options) {
  const { path, project, prepared } = existing(options);
  if (!prepared) {
    console.log(`No local Lab is prepared in ${relative(ROOT, path)}. Start one with \`npm run dev:lab\`.`);
    return;
  }
  step(`Containers (${project})`);
  must("docker", compose(project, path, ["ps", "--all"]));
  step("URLs");
  await report(readFileSync(join(path, "secrets/origin/ca.pem")));
}

function logs(options) {
  const { path, project, prepared } = existing(options);
  if (!prepared) throw new Error(`No local Lab is prepared in ${relative(ROOT, path)}.`);
  const result = spawnSync("docker", compose(project, path, ["logs", "--tail", "200", ...(options.follow ? ["--follow"] : []), ...options.services]), { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0 && result.signal === null) process.exitCode = result.status ?? 1;
}

async function discard(options) {
  const { path, project, prepared } = existing(options);
  if (!existsSync(path)) {
    console.log(`Nothing to discard: ${relative(ROOT, path)} does not exist.`);
    return;
  }
  if (!readState(path)) throw new Error(`${path} was not made by this launcher (no ${STATE_FILE}); refusing to delete it.`);
  const volumes = capture("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]);
  const names = volumes.status === 0 ? volumes.stdout.split("\n").filter(Boolean) : [];
  const describe = [
    `Compose project ${project}: its containers and ${names.length > 0 ? `volumes ${names.join(", ")}` : "volumes (none found)"}`,
    `Local directory ${relative(ROOT, path)}: secrets, test certificates, settings, and the study epoch`
  ];
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const ask = async question => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(question); } finally { rl.close(); }
  };
  if (!(await confirmDiscard({ project, yes: options.yes, interactive, ask, describe }))) {
    process.exitCode = 1;
    console.error(interactive ? "Not confirmed; nothing was deleted." : "Refusing to discard without confirmation in a non-interactive shell. Re-run with --yes to confirm. Nothing was deleted.");
    return;
  }
  if (prepared) {
    step(`Removing ${project}'s containers and volumes`);
    must("docker", compose(project, path, ["down", "--volumes", "--remove-orphans"]));
  }
  step(`Removing ${relative(ROOT, path)}`);
  rmSync(path, { recursive: true, force: true });
  console.log("Discarded. The next `npm run dev:lab` starts a new study with new secrets and a new test CA; remove the old CA from any test browser profile that trusted it. Images are kept.");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "help") return console.log(USAGE);
  if (options.command === "up") return up(options);
  if (options.command === "stop") return stop(options);
  if (options.command === "status") return status(options);
  if (options.command === "logs") return logs(options);
  return discard(options);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`\n${error.message}${error instanceof UsageError ? "\nSee `npm run dev:lab -- --help`." : ""}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
