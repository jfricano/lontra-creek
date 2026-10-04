/** scripts/dev-lab.mjs: argument parsing, prerequisite checks, and the discard guard, with no Docker. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  DEFAULT_DIR, DEFAULT_PROJECT, ROOT, UsageError,
  checkOwnDirectory, checkPrerequisites, compareVersions, confirmDiscard, extraCaDockerfile, localDirectory, parseArgs, readEnv, urls, waitForReadyBench
} from "../dev-lab.mjs";

describe("parseArgs", () => {
  test("defaults to up in .local/lab with a rebuild", () => {
    assert.deepEqual(parseArgs([]), { command: "up", dir: DEFAULT_DIR, project: undefined, build: true, extraCa: undefined, follow: false, yes: false, services: [] });
  });

  test("reads each command and its own options", () => {
    assert.equal(parseArgs(["up", "--no-build"]).build, false);
    assert.equal(parseArgs(["up", "--extra-ca", "/tmp/ca.pem"]).extraCa, "/tmp/ca.pem");
    assert.equal(parseArgs(["stop"]).command, "stop");
    assert.equal(parseArgs(["status", "--dir", ".local/lab-2", "--project", "lab-2"]).project, "lab-2");
    assert.deepEqual(parseArgs(["logs", "-f", "caddy", "lab-1"]).services, ["caddy", "lab-1"]);
    assert.equal(parseArgs(["logs", "--follow"]).follow, true);
    assert.equal(parseArgs(["discard", "-y"]).yes, true);
    assert.equal(parseArgs(["--help"]).command, "help");
    assert.equal(parseArgs(["stop", "-h"]).command, "help");
  });

  test("stop never implies discard, and discard is never confirmed by default", () => {
    assert.equal(parseArgs(["stop"]).yes, false);
    assert.equal(parseArgs(["discard"]).yes, false);
  });

  test("rejects unknown commands, options, stray arguments, and options for other commands", () => {
    for (const argv of [
      ["deploy"], ["down"], ["up", "--volumes"], ["stop", "--yes"], ["up", "--yes"], ["stop", "now"], ["status", "--follow"],
      ["discard", "--no-build"], ["logs", "--extra-ca", "x"], ["logs", "Caddy;rm"], ["--project", "Bad Name"], ["--dir", ""], ["--extra-ca"]
    ]) {
      assert.throws(() => parseArgs(argv), UsageError, argv.join(" "));
    }
  });
});

describe("compareVersions", () => {
  test("compares numerically and ignores prefixes and suffixes", () => {
    assert.ok(compareVersions("2.24.4", "2.24.4") === 0);
    assert.ok(compareVersions("2.24.3", "2.24.4") < 0);
    assert.ok(compareVersions("2.100.0", "2.24.4") > 0);
    assert.ok(compareVersions("v5.3.1\n", "2.24.4") > 0);
    assert.ok(compareVersions("2.29.1-desktop.1", "2.24.4") > 0);
    assert.ok(compareVersions("22.11.0", "24.0.0") < 0);
  });
});

describe("checkPrerequisites", () => {
  /** A fake command runner: `responses` maps "command arg..." to a result; anything else is missing (status null). */
  function runner(responses) {
    const calls = [];
    const run = (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      return responses[key] ?? { status: null, stdout: "", stderr: "" };
    };
    return { run, calls };
  }
  const ok = stdout => ({ status: 0, stdout, stderr: "" });
  const healthy = {
    "docker --version": ok("Docker version 28.0.0"),
    "docker info --format {{.ServerVersion}}": ok("28.0.0\n"),
    "docker compose version --short": ok("2.29.1\n"),
    "openssl version": ok("OpenSSL 3.0.13")
  };
  const free = async () => true;

  test("passes on a ready machine", async () => {
    const { run } = runner(healthy);
    assert.deepEqual(await checkPrerequisites({ run, portFree: free, nodeVersion: "24.21.0" }), []);
  });

  test("names an old Node", async () => {
    const { run } = runner(healthy);
    const problems = await checkPrerequisites({ run, portFree: free, nodeVersion: "22.12.0" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Node 24 or later.*22\.12\.0/);
  });

  test("reports missing Docker without probing its daemon or Compose", async () => {
    const { run, calls } = runner({ "openssl version": ok("OpenSSL 3") });
    const problems = await checkPrerequisites({ run, portFree: free, nodeVersion: "24.0.0" });
    assert.deepEqual(problems.map(p => /Docker is not installed/.test(p)), [true]);
    assert.ok(!calls.some(call => call.startsWith("docker info") || call.startsWith("docker compose")));
  });

  test("reports a stopped daemon, a missing or old Compose, and missing OpenSSL", async () => {
    const stopped = runner({ ...healthy, "docker info --format {{.ServerVersion}}": { status: 1, stdout: "", stderr: "Cannot connect" } });
    assert.match((await checkPrerequisites({ run: stopped.run, portFree: free, nodeVersion: "24.0.0" })).join(), /daemon is not reachable/);

    const noCompose = runner({ ...healthy, "docker compose version --short": { status: 1, stdout: "", stderr: "unknown command" } });
    assert.match((await checkPrerequisites({ run: noCompose.run, portFree: free, nodeVersion: "24.0.0" })).join(), /`docker compose` plugin/);

    const oldCompose = runner({ ...healthy, "docker compose version --short": ok("2.20.2\n") });
    assert.match((await checkPrerequisites({ run: oldCompose.run, portFree: free, nodeVersion: "24.0.0" })).join(), /2\.24\.4 or later.*found 2\.20\.2/);

    const noOpenssl = runner({ ...healthy, "openssl version": { status: null, stdout: "", stderr: "" } });
    assert.match((await checkPrerequisites({ run: noOpenssl.run, portFree: free, nodeVersion: "24.0.0" })).join(), /OpenSSL is required/);
  });

  test("reports a busy port 8443 unless the check is skipped for an already running stack", async () => {
    const { run } = runner(healthy);
    const ports = [];
    const busy = async port => { ports.push(port); return false; };
    assert.match((await checkPrerequisites({ run, portFree: busy, nodeVersion: "24.0.0" })).join(), /Port 8443 on 127\.0\.0\.1 is in use/);
    assert.deepEqual(ports, [8443]);
    assert.deepEqual(await checkPrerequisites({ run, portFree: busy, nodeVersion: "24.0.0", checkPort: false }), []);
  });

  test("reports a missing --extra-ca file", async () => {
    const { run } = runner(healthy);
    assert.match((await checkPrerequisites({ run, portFree: free, nodeVersion: "24.0.0", extraCa: "/nonexistent/ca.pem" })).join(), /--extra-ca file not found/);
  });
});

describe("localDirectory", () => {
  const git = status => () => ({ status, stdout: "", stderr: "" });

  test("accepts a git-ignored directory inside the repository", () => {
    assert.equal(localDirectory(".local/lab", { run: git(0) }), `${ROOT}/.local/lab`);
  });

  test("refuses tracked, outside, top-level, and .local itself", () => {
    assert.throws(() => localDirectory(".local/lab", { run: git(1) }), /not git-ignored/);
    assert.throws(() => localDirectory("/tmp/lab", { run: git(0) }), /inside the repository/);
    assert.throws(() => localDirectory("..", { run: git(0) }), /inside the repository/);
    assert.throws(() => localDirectory(".", { run: git(0) }), /inside the repository/);
    assert.throws(() => localDirectory(".local", { run: git(0) }), /not \.local itself/);
  });

  test("without git, accepts only a directory under .local/", () => {
    assert.equal(localDirectory(".local/lab", { run: git(128) }), `${ROOT}/.local/lab`);
    assert.throws(() => localDirectory("build/lab", { run: git(128) }), /must be under \.local\//);
  });

  test("refuses git-ignored directories outside .local/ that something serves or another tool owns", () => {
    for (const dir of ["apps/site/dist/lab", "apps/site/dist", "node_modules", "dist", "apps/field-station/.data", "build/lab"]) {
      assert.throws(() => localDirectory(dir, { run: git(0) }), /must be under \.local\//, dir);
    }
  });

  test("refuses dev:kafka's data directory, inside it, or around it", () => {
    for (const dir of [".local/kafka-dev", ".local/kafka-dev/lab", "./.local/kafka-dev/"]) {
      assert.throws(() => localDirectory(dir, { run: git(0), kafkaDataDir: undefined }), /overlaps dev:kafka's data directory \(\.local\/kafka-dev\)/, dir);
    }
    assert.throws(() => localDirectory(".local/broker", { run: git(0), kafkaDataDir: ".local/broker" }), /overlaps/);
    assert.throws(() => localDirectory(".local/lab", { run: git(0), kafkaDataDir: `${ROOT}/.local/lab/kafka` }), /overlaps/);
    assert.equal(localDirectory(".local/lab", { run: git(0), kafkaDataDir: ".local/broker" }), `${ROOT}/.local/lab`);
    assert.equal(localDirectory(".local/kafka-dev-lab", { run: git(0), kafkaDataDir: undefined }), `${ROOT}/.local/kafka-dev-lab`);
  });

  test("the default directory is ignored by this repository's .gitignore", () => {
    assert.equal(localDirectory(DEFAULT_DIR), `${ROOT}/.local/lab`);
  });
});

describe("checkOwnDirectory", () => {
  test("accepts a new, empty, or launcher-made directory and refuses anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "lontra-dev-lab-"));
    try {
      checkOwnDirectory(join(dir, "new"));
      mkdirSync(join(dir, "empty"));
      checkOwnDirectory(join(dir, "empty"));
      mkdirSync(join(dir, "made"));
      writeFileSync(join(dir, "made/dev-lab.json"), JSON.stringify({ project: DEFAULT_PROJECT }));
      writeFileSync(join(dir, "made/.env"), "A=1\n");
      checkOwnDirectory(join(dir, "made"));
      mkdirSync(join(dir, "foreign"));
      writeFileSync(join(dir, "foreign/meta.properties"), "node.id=1\n");
      assert.throws(() => checkOwnDirectory(join(dir, "foreign")), /already has files and was not made by this launcher \(no dev-lab\.json\)/);
      writeFileSync(join(dir, "file"), "");
      assert.throws(() => checkOwnDirectory(join(dir, "file")), /is not a directory/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("confirmDiscard", () => {
  const never = async () => { throw new Error("must not prompt"); };

  test("--yes confirms without prompting", async () => {
    assert.equal(await confirmDiscard({ project: DEFAULT_PROJECT, yes: true, interactive: false, ask: never }), true);
  });

  test("a non-interactive shell without --yes refuses without prompting", async () => {
    assert.equal(await confirmDiscard({ project: DEFAULT_PROJECT, yes: false, interactive: false, ask: never }), false);
  });

  test("an interactive person must type the project name", async () => {
    const asked = [];
    const answer = text => async question => { asked.push(question); return text; };
    const describe = ["Compose project lontra-local-lab: volumes a, b"];
    assert.equal(await confirmDiscard({ project: DEFAULT_PROJECT, yes: false, interactive: true, ask: answer(`${DEFAULT_PROJECT}\n`), describe }), true);
    for (const text of ["", "y", "yes", "discard", "LONTRA-LOCAL-LAB", "lontra"]) {
      assert.equal(await confirmDiscard({ project: DEFAULT_PROJECT, yes: false, interactive: true, ask: answer(text), describe }), false, text);
    }
    assert.match(asked[0], /deletes the local study permanently/);
    assert.match(asked[0], /volumes a, b/);
    assert.match(asked[0], /Type the project name \(lontra-local-lab\)/);
  });
});

describe("extraCaDockerfile", () => {
  test("mounts the CA as a build secret for every npm ci, and nowhere else", () => {
    const original = readFileSync(new URL("../../deploy/Dockerfile", import.meta.url), "utf8");
    const adapted = extraCaDockerfile(original);
    const runs = original.match(/^RUN npm ci /gm) ?? [];
    assert.ok(runs.length >= 1);
    assert.equal((adapted.match(/^RUN --mount=type=secret,id=ca,target=\/tmp\/extra-ca\.pem NODE_EXTRA_CA_CERTS=\/tmp\/extra-ca\.pem npm ci /gm) ?? []).length, runs.length);
    assert.equal(adapted.replace(/--mount=type=secret,id=ca,target=\/tmp\/extra-ca\.pem NODE_EXTRA_CA_CERTS=\/tmp\/extra-ca\.pem /g, ""), original);
    assert.throws(() => extraCaDockerfile("FROM node\nRUN npm install\n"), /no `RUN npm ci`/);
  });
});

describe("readEnv and urls", () => {
  test("reads KEY=value lines, keeping spaces in values", () => {
    assert.deepEqual(readEnv("# comment\nA=1\nKAFKA_HEAP_OPTS=-Xms512m -Xmx512m\n\nnot a line\n"), { A: "1", KAFKA_HEAP_OPTS: "-Xms512m -Xmx512m" });
  });

  test("every printed URL is on the loopback HTTPS origin", () => {
    for (const url of Object.values(urls())) assert.match(url, /^https:\/\/localhost:8443\//);
  });
});

describe("waitForReadyBench", () => {
  const reply = body => ({ status: 200, body: JSON.stringify(body) });

  test("waits until a bench is ready, polling only the Lab status URL", async () => {
    const seen = [];
    const answers = [{ status: null, error: "ECONNREFUSED" }, { status: 502, body: "" }, reply({ benches: [{ bench: 1, state: "unavailable" }] }), reply({ benches: [{ bench: 1, state: "unavailable" }, { bench: 2, state: "ready" }] })];
    const check = async url => { seen.push(url); return answers.shift(); };
    assert.equal(await waitForReadyBench("ca", { check, intervalMs: 1, timeoutMs: 5000 }), true);
    assert.equal(seen.length, 4);
    assert.ok(seen.every(url => url === urls().labStatus));
  });

  test("gives up after the timeout", async () => {
    const check = async () => reply({ enabled: false, benches: [] });
    assert.equal(await waitForReadyBench("ca", { check, intervalMs: 1, timeoutMs: 20 }), false);
  });
});
