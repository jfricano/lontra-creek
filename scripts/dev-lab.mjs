/**
 * The real-Kafka Failure Lab on this machine, built from source: the
 * docs/LOCAL_LAB.md recipe as one command. Three benches, Kafka over TLS, the
 * field station, the gateway, the workbench sandbox, and Caddy, served at
 * https://localhost:8443 only.
 *
 *   npm run dev:lab                         # same as `up`
 *   npm run dev:lab -- up [--no-build] [--extra-ca <file> | --no-extra-ca]
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
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
/** The root package.json's engines floor: earlier Node 24 releases treat `node:sqlite` as experimental, and the failure journal refuses to open on them. */
export const MIN_NODE = "24.15.0";
/** `!override` in deploy/compose.local-lab.yaml needs Compose 2.24.4. */
export const MIN_COMPOSE = "2.24.4";
/** In order: the local overlay comes last so its overrides win. */
export const COMPOSE_FILES = ["deploy/compose.yaml", "deploy/compose.lab.yaml", "deploy/compose.sandbox.yaml", "deploy/compose.local-lab.yaml"];
const STATE_FILE = "dev-lab.json";
const COMMANDS = ["up", "stop", "status", "logs", "discard"];

export class UsageError extends Error {}

export const USAGE = `Usage: npm run dev:lab -- [command] [options]

Runs the real-Kafka Failure Lab locally from source at ${ORIGIN}/lab/,
with the workbench sandbox at ${ORIGIN}/workbench/.
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
                      (for networks behind a TLS-intercepting proxy); needs BuildKit.
                      Remembered in the local directory: later builds use it too
  --no-extra-ca       up: forget a remembered --extra-ca and build without one
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
        "no-extra-ca": { type: "boolean" },
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
  only("no-extra-ca", "up");
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
  if (values["extra-ca"] !== undefined && values["no-extra-ca"]) throw new UsageError("--extra-ca and --no-extra-ca contradict each other; pass one.");
  return {
    command,
    dir: values.dir ?? DEFAULT_DIR,
    project: values.project,
    build: !values["no-build"],
    extraCa: values["extra-ca"],
    forgetExtraCa: values["no-extra-ca"] === true,
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
export async function checkPrerequisites({ run = capture, portFree = isPortFree, nodeVersion = process.versions.node, checkPort = true, extraCa, extraCaRemembered = false } = {}) {
  const problems = [];
  if (compareVersions(nodeVersion, MIN_NODE) < 0) problems.push(`Node ${MIN_NODE} or later is required; this is Node ${nodeVersion}.`);
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
  if (extraCa !== undefined && !existsSync(extraCa)) {
    problems.push(extraCaRemembered
      ? `The extra CA bundle remembered from an earlier \`up --extra-ca\` is gone: ${extraCa}. Pass \`--extra-ca <file>\` again, or \`--no-extra-ca\` to build without one.`
      : `--extra-ca file not found: ${extraCa}`);
  }
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

/**
 * The extra CA bundle an image build trusts, and the launcher state to keep. A bundle given
 * with --extra-ca is remembered (as an absolute path) in the local directory's dev-lab.json, so
 * a later plain `up`, such as the one `stop` suggests, rebuilds through the same proxy;
 * --no-extra-ca forgets it. `source` says which: "given", "remembered", "forgotten", or "none".
 */
export function chooseExtraCa(state = {}, { given, forget = false, cwd = process.cwd() } = {}) {
  const { extraCa: remembered, ...rest } = state;
  if (given !== undefined) {
    const extraCa = resolve(cwd, given);
    return { extraCa, source: "given", state: { ...rest, extraCa } };
  }
  if (forget) return { extraCa: undefined, source: remembered === undefined ? "none" : "forgotten", state: rest };
  return { extraCa: remembered, source: remembered === undefined ? "none" : "remembered", state };
}

/** How npm and OpenSSL report a certificate chain they can't verify, as behind a TLS-intercepting proxy. */
const CERT_ERROR = /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_UNTRUSTED|self[- ]signed certificate in certificate chain|unable to get local issuer certificate/i;
/** Docker Hub's answer when anonymous pulls are over its rate limit. */
const PULL_LIMIT = /429 Too Many Requests|toomanyrequests/i;

/** What to do about a failed image build, from the tail of its output; null when the cause isn't recognised. */
export function buildFailureHint(output, { extraCa } = {}) {
  if (CERT_ERROR.test(output)) {
    return extraCa === undefined
      ? "The image build failed on a certificate error: this network seems to re-sign HTTPS traffic (a TLS-intercepting proxy).\n" +
        "Pass its CA bundle for the build only:\n  npm run dev:lab -- up --extra-ca <bundle.pem>\n" +
        "See \"Behind a TLS-intercepting proxy\" and Troubleshooting in docs/LOCAL_LAB.md."
      : `The image build failed on a certificate error even with the extra CA ${extraCa}.\n` +
        "Check that it is the PEM bundle your proxy signs with. See \"Behind a TLS-intercepting proxy\" in docs/LOCAL_LAB.md.";
  }
  if (PULL_LIMIT.test(output)) {
    return "Docker Hub refused a base image pull (429 Too Many Requests: its limit for anonymous pulls).\n" +
      "Wait a few minutes and run the same command again, or sign in with `docker login` first. See Requirements in docs/LOCAL_LAB.md.";
  }
  return null;
}

/** How to start the stack again after `stop`, or when `status` finds it stopped, for the local directory given as `dir`. */
export function startAgain(state = {}, { dir = DEFAULT_DIR } = {}) {
  const flags = dir === DEFAULT_DIR ? "" : ` --dir ${dir}`;
  const plain = flags === "" ? "npm run dev:lab" : `npm run dev:lab -- up${flags}`;
  const ca = state.extraCa === undefined ? "" : ` Rebuilds use the extra CA remembered from \`--extra-ca\` (${state.extraCa}); \`up --no-extra-ca\` forgets it.`;
  return `Start again with \`${plain}\` (rebuilds the site and image), or \`npm run dev:lab -- up --no-build${flags}\` to reuse the last build; the same study resumes.${ca}`;
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
    labStatus: `${ORIGIN}/api/lab/status`,
    workbench: `${ORIGIN}/workbench/`,
    sandboxStatus: `${ORIGIN}/api/sandbox/status`
  };
}

/**
 * The env-file lines that give the workbench sandbox its service token, or "" when
 * the file has one. deploy/make-secrets.sh writes it into new files; an env file
 * made before the sandbox existed gets one here, once.
 */
export function sandboxSecret(env, token = () => randomBytes(32).toString("hex")) {
  if (env.SANDBOX_SERVICE_TOKEN !== undefined) return "";
  return `\n# Workbench sandbox service token, added by scripts/dev-lab.mjs.\nSANDBOX_SERVICE_TOKEN=${token()}\n`;
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

function writeState(path, state) {
  writeFileSync(join(path, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

/**
 * Records a given --extra-ca in the local directory's dev-lab.json, or forgets the remembered
 * one for --no-extra-ca, keeping everything else there. Returns chooseExtraCa's answer.
 */
export function rememberExtraCa(path, { given, forget = false, cwd = process.cwd() } = {}) {
  const choice = chooseExtraCa(readState(path) ?? {}, { given, forget, cwd });
  if (choice.source === "given" || choice.source === "forgotten") writeState(path, choice.state);
  return choice;
}

/** How much of a build's output (in characters) to keep for buildFailureHint: the error is at the end. */
const TAIL_CHARS = 256 * 1024;

/** Runs a command with its output shown as it comes, keeping the tail of its stderr; resolves to { status, signal, tail }, or { status: null, error, tail }. */
function runShowingOutput(command, args, options = {}) {
  return new Promise(done => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["inherit", "inherit", "pipe"], ...options });
    let tail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { process.stderr.write(chunk); tail = (tail + chunk).slice(-TAIL_CHARS); });
    child.on("error", error => done({ status: null, tail, error }));
    child.on("close", (status, signal) => done({ status, signal, tail }));
  });
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
  const sandbox = sandboxSecret(env);
  if (sandbox !== "") appendFileSync(envFile, sandbox);
  return { ...wanted, ...env };
}

async function report(ca) {
  const u = urls();
  for (const [label, url] of [["Site", u.site], ["Lab page", u.lab], ["Health (field station)", u.health], ["Lab status", u.labStatus], ["Workbench page", u.workbench], ["Sandbox status", u.sandboxStatus]]) {
    const result = await probe(url, ca);
    let detail = result.status === null ? `unreachable (${result.error})` : `HTTP ${result.status}`;
    if (result.status === 200 && url === u.labStatus) {
      try {
        const status = JSON.parse(result.body);
        detail += status.enabled === false ? ", Lab disabled" : `, benches: ${status.benches.map(b => `${b.bench}=${b.state}`).join(" ") || "none"}`;
      } catch { /* the HTTP status is enough */ }
    }
    if (result.status === 200 && url === u.sandboxStatus) {
      try {
        const status = JSON.parse(result.body);
        detail += `, ${status.availability}${status.reason ? ` (${status.reason})` : ""}, slots: ${status.slots.map(s => `${s.slot}=${s.state}`).join(" ") || "none"}`;
      } catch { /* the HTTP status is enough */ }
    }
    if (result.status === 200 && url === u.health) {
      try {
        const status = JSON.parse(result.body);
        if (status.kafka !== undefined) detail += `, kafka ${status.kafka}`;
      } catch { /* the HTTP status is enough */ }
    }
    console.log(`  ${label.padEnd(24)} ${url.padEnd(42)} ${detail}`);
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
  // A remembered --extra-ca matters only to a build; one given now is checked either way.
  const extra = chooseExtraCa(readState(path) ?? {}, { given: options.extraCa, forget: options.forgetExtraCa });
  const checkCa = extra.source === "given" || (options.build && extra.source === "remembered");
  const problems = await checkPrerequisites({ checkPort: !alreadyServing, extraCa: checkCa ? extra.extraCa : undefined, extraCaRemembered: extra.source === "remembered" });
  if (problems.length > 0) throw new Error(`Not ready to start the local Lab:\n${problems.map(p => `  - ${p}`).join("\n")}`);
  console.log(`Ready. Local directory: ${relative(ROOT, path)}; Compose project: ${project}.`);

  step("Preparing local secrets, test certificates, and settings (kept across runs)");
  const env = prepare(path, project);
  // Recorded only now that prepare() has made (or kept) the launcher's own state file.
  rememberExtraCa(path, { given: options.extraCa, forget: options.forgetExtraCa });
  if (extra.source === "forgotten") console.log("Forgot the extra CA bundle remembered from an earlier `up --extra-ca`.");

  if (options.build) {
    step("Building the site for the local origin");
    must("npm", ["run", "build", "-w", "@lontra-creek/site"], { env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", PUBLIC_FIELD_STATION_ORIGIN: ORIGIN } });
    step(`Building the image ${env.LONTRA_IMAGE} (local only; never pushed)`);
    let dockerfile = "deploy/Dockerfile";
    const secret = [];
    if (extra.extraCa !== undefined) {
      const build = join(path, "build");
      mkdirSync(build, { recursive: true });
      dockerfile = join(build, "Dockerfile");
      writeFileSync(dockerfile, extraCaDockerfile(readFileSync(join(ROOT, "deploy/Dockerfile"), "utf8")));
      copyFileSync(join(ROOT, "deploy/Dockerfile.dockerignore"), `${dockerfile}.dockerignore`);
      secret.push("--secret", `id=ca,src=${extra.extraCa}`);
      console.log(extra.source === "given"
        ? `Using an extra CA for npm inside the build only: ${extra.extraCa}\nIt is remembered in ${relative(ROOT, join(path, STATE_FILE))} for later builds; \`up --no-extra-ca\` forgets it.`
        : `Using the extra CA remembered from an earlier \`up --extra-ca\`, for npm inside the build only: ${extra.extraCa}\n\`up --no-extra-ca\` forgets it.`);
    }
    const built = await runShowingOutput("docker", ["build", "-f", dockerfile, ...secret, "-t", env.LONTRA_IMAGE, "."], { env: { ...process.env, DOCKER_BUILDKIT: "1" } });
    if (built.error) throw new Error(`docker could not run: ${built.error.message}`);
    if (built.status !== 0) {
      const hint = buildFailureHint(built.tail, { extraCa: extra.extraCa });
      throw new Error(`docker build -f ${relative(ROOT, resolve(ROOT, dockerfile))} failed (${built.status === null ? built.signal : `exit ${built.status}`}).${hint ? `\n\n${hint}` : ""}`);
    }
  } else {
    if (!existsSync(join(ROOT, "apps/site/dist/lab/index.html"))) throw new Error("--no-build: apps/site/dist has no built Lab page. Run without --no-build.");
    if (capture("docker", ["image", "inspect", env.LONTRA_IMAGE]).status !== 0) throw new Error(`--no-build: image ${env.LONTRA_IMAGE} does not exist. Run without --no-build.`);
  }

  step("Starting the stack (Kafka, field station, gateway, three benches, the workbench sandbox, Caddy); this can take a few minutes");
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
Open ${urls().lab} or ${urls().workbench} . Only 127.0.0.1:${PORT} is published;
Kafka, bench and sandbox APIs, relay controls and management listeners are private
to the Compose network.

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
  console.log(`Stopped. ${startAgain(readState(path), { dir: options.dir })} To delete it instead: \`npm run dev:lab -- discard${options.dir === DEFAULT_DIR ? "" : ` --dir ${options.dir}`}\`.`);
}

async function status(options) {
  const { path, project, prepared } = existing(options);
  if (!prepared) {
    console.log(`No local Lab is prepared in ${relative(ROOT, path)}. Start one with \`npm run dev:lab\`.`);
    return;
  }
  step(`Containers (${project})`);
  must("docker", compose(project, path, ["ps", "--all"]));
  const running = capture("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`]);
  if (running.status === 0 && running.stdout.trim() === "") {
    console.log(`\nThe local Lab (Compose project ${project}) is not running. ${startAgain(readState(path), { dir: options.dir })}`);
    return;
  }
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
