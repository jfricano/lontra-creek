import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { validateWorkbenchHostConfig, type WorkbenchDiscovery, type WorkbenchHostManifest } from "streamotter/contracts";
import type { SandboxConnection, SandboxEndReason, SandboxLease, SandboxRuntime, SandboxStatus } from "../../field-station/src/sandbox/contract.ts";
import { API_BASE, availabilityView, connectAllows, cspConnectSources, endedText, formatRemaining, mountDecision, problemText, refusal, runtimeLabels, sessionView, websocketOrigin, workbenchCsp, type MountInput, type SessionInput } from "../src/scripts/workbench-model.ts";
import type { PublishedSeam } from "../src/scripts/workbench-seam.ts";

// Every value below is a test fixture, not something a running sandbox said.
const NOW = "2026-10-03T12:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
const runtime: SandboxRuntime = { packages: { streamotter: "9.9.9-fixture", workbench: "9.9.9-fixture" }, mode: "synthetic-fixture", contractVersion: "1" };
const status = (over: Partial<SandboxStatus> = {}): SandboxStatus => ({ now: NOW, availability: "available", runtime, slots: [{ slot: 1, state: "ready" }, { slot: 2, state: "leased" }, { slot: 3, state: "ready" }], queueLength: 0, nextFreeAt: null, ...over });
const unavailable = (reason: NonNullable<SandboxStatus["reason"]>): SandboxStatus => ({ now: NOW, availability: "unavailable", reason, runtime: null, slots: [], queueLength: 0, nextFreeAt: null });
const held = (state: "ready" | "active" | "resetting", over: Partial<Extract<SandboxLease, { leaseId: string }>> = {}): SandboxLease =>
  ({ status: state, now: NOW, leaseId: "lease-fixture", studyId: "study-fixture", slot: 2, grantedAt: NOW, expiresAt: at(600), claimBy: state === "ready" ? at(30) : null, runtime, ...over });
const input = (over: Partial<SessionInput> = {}): SessionInput => ({ status: status(), statusProblem: null, lease: null, checking: false, busy: false, now: Date.parse(NOW), connectedStudy: null, ...over });

describe("problems", () => {
  test("refusal keeps only known codes and a usable Retry-After", () => {
    assert.deepEqual(refusal(429, { error: "Too many requests.", code: "too-many-places" }, "2"), { kind: "refused", status: 429, code: "too-many-places", message: "Too many requests.", retryAfter: 2 });
    assert.deepEqual(refusal(502, "<html>bad gateway</html>", "soon"), { kind: "refused", status: 502, code: null, message: "", retryAfter: null });
    const unknown = refusal(400, { error: "x", code: "made-up" }, null);
    assert.ok(unknown.kind === "refused" && unknown.code === null);
  });
  test("each refusal reads as plain words, never a raw code", () => {
    assert.match(problemText(refusal(429, { code: "too-many-places" }, null)), /already holds two places across the Failure Lab and the workbench sandbox/);
    assert.match(problemText(refusal(503, { code: "queue-full" }, null)), /line .* is full/);
    assert.match(problemText(refusal(503, { code: "sandbox-unavailable" }, null)), /no session was started/);
    assert.match(problemText(refusal(429, { code: "too-many-requests" }, "4")), /in 4 s/);
    assert.match(problemText({ kind: "network", message: "no answer within 8 s" }), /did not answer \(no answer within 8 s\)/);
    assert.equal(problemText(refusal(502, null, null)), "The field station answered 502.");
  });
});

describe("availability", () => {
  test("every unavailable reason the service can give has its own explanation", () => {
    const reasons = ["disabled", "seam-unavailable", "service-unavailable", "all-slots-unavailable"] as const;
    const headlines = new Set(reasons.map(reason => { const view = availabilityView(unavailable(reason), null); assert.equal(view.available, false); assert.equal(view.reason, reason); return view.headline; }));
    assert.equal(headlines.size, reasons.length);
    assert.match(availabilityView(unavailable("seam-unavailable"), null).detail, /The StreamOtter the sandbox service runs does not.*Nothing on this page simulates one/);
  });
  test("an unanswered status is unknown, not available", () => {
    const view = availabilityView(null, { kind: "network", message: "the request failed" });
    assert.equal(view.available, false); assert.equal(view.reason, "unreachable"); assert.match(view.detail, /did not answer/);
  });
  test("a field station without the sandbox routes is not enabled, not unknown", () => {
    const view = availabilityView(null, refusal(404, { error: "Not found." }, null));
    assert.equal(view.reason, "disabled"); assert.match(view.detail, /does not serve the sandbox API/);
  });
  test("a full pool says that starting queues, with the service's own upper bound", () => {
    const view = availabilityView(status({ slots: [{ slot: 1, state: "leased" }, { slot: 2, state: "leased" }, { slot: 3, state: "resetting" }], queueLength: 2, nextFreeAt: at(400) }), null);
    assert.equal(view.available, true);
    assert.equal(view.pool, "All 3 sandbox slots are in use. Starting a session puts you in line. 2 visitors are waiting in line. One frees within 7 min at the latest.");
    assert.equal(availabilityView(status(), null).pool, "2 of 3 sandbox slots are free.");
  });
});

describe("labels", () => {
  test("mode and versions come from the service's runtime, and are absent without one", () => {
    assert.equal(runtimeLabels(null), null);
    assert.deepEqual(runtimeLabels(runtime), { mode: "Synthetic fixture", packages: "streamotter@9.9.9-fixture · @streamotter/workbench@9.9.9-fixture", contract: "Host contract 1" });
    assert.equal(runtimeLabels({ ...runtime, contractVersion: null })?.contract, "No host contract reported");
  });
  test("every end reason has its own sentence", () => {
    const reasons: SandboxEndReason[] = ["left", "returned", "expired", "idle", "unclaimed", "session-ended", "slot-failed", "sandbox-restarted"];
    assert.equal(new Set(reasons.map(endedText)).size, reasons.length);
    assert.match(endedText("idle"), /stopped checking in, which can happen when a browser slows a tab left in the background\./);
  });
  test("formatRemaining never goes negative", () => {
    assert.equal(formatRemaining(61_001), "1:02"); assert.equal(formatRemaining(-5_000), "0:00");
  });
});

describe("sessionView", () => {
  test("while revalidating, nothing active is shown and no control works", () => {
    const view = sessionView(input({ checking: true, lease: held("active") }));
    assert.equal(view.phase, "checking");
    assert.deepEqual(Object.values(view.enabled), [false, false, false, false, false]);
  });
  test("an available pool offers Start and nothing else; busy disables it", () => {
    const view = sessionView(input());
    assert.equal(view.phase, "idle"); assert.deepEqual(view.enabled, { start: true, claim: false, return: false, reset: false, repro: false });
    assert.equal(sessionView(input({ busy: true })).enabled.start, false);
  });
  test("an unavailable sandbox cannot be started and says why", () => {
    for (const reason of ["disabled", "seam-unavailable", "service-unavailable", "all-slots-unavailable"] as const) {
      const view = sessionView(input({ status: unavailable(reason) }));
      assert.equal(view.phase, "unavailable"); assert.equal(view.enabled.start, false); assert.equal(view.runtime, null);
    }
    assert.equal(sessionView(input({ status: null, statusProblem: { kind: "network", message: "x" } })).phase, "unavailable");
  });
  test("a place in line shows its position and can be left", () => {
    const view = sessionView(input({ lease: { status: "queued", now: NOW, position: 2, queueLength: 3, joinedAt: NOW, nextFreeAt: at(90), sessionExpiresAt: at(3600) } }));
    assert.equal(view.phase, "queued"); assert.match(view.headline, /number 2 of 3/); assert.match(view.detail, /within 2 min/);
    // It checks in for the visitor, but a browser may slow a background tab: the copy doesn't promise more than a page can do.
    assert.match(view.detail, /A browser can slow a tab left in the background enough to miss check-ins\./);
    assert.equal(view.returnLabel, "Leave the line"); assert.deepEqual(view.enabled, { start: false, claim: false, return: true, reset: false, repro: false });
  });
  test("a ready slot shows its claim window and the lease's runtime", () => {
    const view = sessionView(input({ lease: held("ready"), now: Date.parse(NOW) + 5_000 }));
    assert.equal(view.phase, "ready"); assert.equal(view.clock, "0:25 left to claim it · 9:55 left in this session");
    assert.equal(view.runtime, runtime); assert.ok(view.enabled.claim && view.enabled.return && !view.enabled.start);
  });
  test("the claim countdown runs in the clock, so the status text holds still from second to second", () => {
    const first = sessionView(input({ lease: held("ready"), now: Date.parse(NOW) + 5_000 }));
    const next = sessionView(input({ lease: held("ready"), now: Date.parse(NOW) + 6_000 }));
    assert.equal(next.headline, first.headline); assert.equal(next.detail, first.detail);
    assert.equal(first.detail, "Claim it within the time shown below, or it goes to the next visitor.");
    assert.notEqual(next.clock, first.clock);
  });
  test("an active session can reset, download, and end; claim only until this page holds the study's connection", () => {
    const active = sessionView(input({ lease: held("active") }));
    assert.equal(active.phase, "active"); assert.deepEqual(active.enabled, { start: false, claim: true, return: true, reset: true, repro: true });
    assert.equal(sessionView(input({ lease: held("active"), connectedStudy: "study-fixture" })).enabled.claim, false);
    assert.equal(sessionView(input({ lease: held("active"), connectedStudy: "an-older-study" })).enabled.claim, true);
  });
  test("resetting allows only ending the session", () => {
    assert.deepEqual(sessionView(input({ lease: held("resetting") })).enabled, { start: false, claim: false, return: true, reset: false, repro: false });
  });
  test("an ended session explains itself and offers Start only when the sandbox is available", () => {
    const lease: SandboxLease = { status: "ended", now: NOW, reason: "expired", endedAt: NOW };
    const view = sessionView(input({ lease }));
    assert.equal(view.phase, "ended"); assert.match(view.headline, /time limit/); assert.equal(view.enabled.start, true);
    const down = sessionView(input({ lease: { ...lease, reason: "slot-failed" }, status: unavailable("service-unavailable") }));
    assert.equal(down.phase, "ended"); assert.equal(down.enabled.start, false); assert.match(down.detail, /not answering/);
  });
});

describe("mountDecision", () => {
  const seam: PublishedSeam = { package: "@streamotter/workbench", version: "9.9.9-fixture", hostContract: 1, script: "/workbench/assets/9.9.9-fixture/app.js", hostStyle: "/workbench/assets/9.9.9-fixture/workbench-host.css", licenses: "/workbench/assets/9.9.9-fixture/THIRD_PARTY_LICENSES.txt", integrity: { script: "sha384-a", hostStyle: "sha384-b" } };
  const discovery: WorkbenchDiscovery = { hostContract: 1, operations: ["workbench", "capabilities", "health", "sources", "channels", "config", "config.validate"], limits: { maxRequestBytes: 65_536 } };
  const connection: SandboxConnection = { leaseId: "lease-fixture", studyId: "study-fixture", expiresAt: at(600), gatewayOrigin: "https://demo.example", gatewayPath: "/sandbox/2/socket.io" };
  const ready: MountInput = { lease: held("active"), connection, discovery, seam, apiOrigin: "", pageOrigin: "https://site.example", connectSrc: null };
  const refused = (over: Partial<MountInput>): string => { const decision = mountDecision({ ...ready, ...over }); assert.equal(decision.mount, false); return decision.mount ? "" : decision.reason; };
  const mounted = (over: Partial<MountInput>) => { const decision = mountDecision({ ...ready, ...over }); assert.ok(decision.mount, decision.mount ? "" : decision.reason); return decision; };

  test("with no pinned release that publishes the seam, nothing mounts, whatever the service claims", () => {
    assert.match(refused({ seam: null }), /pins no StreamOtter release that publishes the embeddable workbench/);
  });
  test("each missing condition keeps the mount point inert, with its reason", () => {
    assert.match(refused({ lease: held("ready") }), /No sandbox session is active/);
    assert.match(refused({ lease: held("active", { runtime: { ...runtime, contractVersion: null } }) }), /reports no host contract/);
    assert.match(refused({ lease: held("active", { runtime: { ...runtime, contractVersion: "2" } }) }), /reports host contract 2; this page mounts host contract 1/);
    assert.match(refused({ lease: held("active", { runtime: { ...runtime, packages: { streamotter: "9.9.9-fixture", workbench: "0.1.0-rc.3" } } }) }), /runs @streamotter\/workbench@0\.1\.0-rc\.3; this page pins 9\.9\.9-fixture/);
    assert.match(refused({ discovery: null }), /did not describe its host API/);
    assert.match(refused({ discovery: { ...discovery, operations: ["workbench", "config", "health"] } }), /does not serve channels, sources/);
    assert.match(refused({ apiOrigin: "https://demo.example/" }), /not an exact https origin/);
    assert.match(refused({ apiOrigin: "http://demo.example" }), /not an exact https origin/);
    assert.match(refused({ connection: { ...connection, studyId: "an-older-study" } }), /not been claimed for the current study/);
  });
  test("a gateway the page's CSP does not allow is refused with a reason, instead of failing silently in the browser", () => {
    assert.match(refused({ connectSrc: ["'self'", "https://other.example", "wss://other.example"] }), /gateway, https:\/\/demo\.example, is not in this page's Content-Security-Policy/);
    // Both the https: origin (Socket.IO's handshake) and its wss: twin must be allowed.
    assert.match(refused({ connectSrc: ["'self'", "https://demo.example"] }), /Content-Security-Policy/);
    mounted({ connectSrc: ["'self'", "https://demo.example", "wss://demo.example"] });
    // On the page's own origin, 'self' covers both.
    mounted({ connectSrc: ["'self'"], connection: { ...connection, gatewayOrigin: "https://site.example" } });
  });
  test("on the page's own origin, the WHC-1 boot block is session mode at the sandbox's host API, labeled from the service, with no apiOrigin", () => {
    for (const apiOrigin of ["", "https://site.example"]) {
      const decision = mounted({ apiOrigin });
      assert.deepEqual(decision.boot, {
        hostContract: 1, apiBase: API_BASE, auth: { mode: "session" }, gateway: { origin: "https://demo.example", path: "/sandbox/2/socket.io" },
        environment: { kind: "sandbox", label: "Synthetic fixture", detail: decision.boot.environment.detail, packageVersion: "9.9.9-fixture" }
      });
      assert.equal(decision.script, seam.script); assert.equal(decision.hostStyle, seam.hostStyle); assert.deepEqual(decision.integrity, seam.integrity);
    }
  });
  test("with the field station on another origin, the boot block names it in apiOrigin (WHC-1 §3.4, R11)", () => {
    const decision = mounted({ apiOrigin: "https://demo.example" });
    assert.equal(decision.boot.apiOrigin, "https://demo.example");
    assert.equal(decision.boot.apiBase, API_BASE);
    assert.deepEqual(decision.boot.auth, { mode: "session" });
  });
  test("every boot block the page writes passes the published validator", () => {
    for (const over of [{}, { apiOrigin: "https://demo.example" }, { apiOrigin: "https://site.example" }, { connection: { ...connection, gatewayOrigin: "https://localhost:8443" } }] satisfies Partial<MountInput>[]) {
      const decision = mounted(over);
      const checked = validateWorkbenchHostConfig(JSON.parse(JSON.stringify(decision.boot)));
      assert.ok(checked.ok, checked.ok ? "" : JSON.stringify(checked.issues));
    }
    // WHC-1 §3.2 bounds the labels; a version the service reports outside them is refused, not written.
    const odd = "9.9.9 fixture";
    assert.match(refused({ lease: held("active", { runtime: { ...runtime, packages: { streamotter: odd, workbench: odd } } }), seam: { ...seam, version: odd } }), /would refuse this page's boot block \(\/environment\/packageVersion/);
  });
});

describe("Content-Security-Policy", () => {
  const require = createRequire(createRequire(import.meta.url).resolve("streamotter/package.json"));
  const manifest = JSON.parse(readFileSync(require.resolve("@streamotter/workbench/host"), "utf8")) as WorkbenchHostManifest;

  test("same origin: the placeholders drop to 'self', plus the gateway's wss: origin when it is known", () => {
    assert.equal(workbenchCsp(manifest.csp, { apiOrigin: null, gatewayOrigin: null }),
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    assert.equal(workbenchCsp(manifest.csp, { apiOrigin: "https://localhost:8443", gatewayOrigin: "https://localhost:8443" }),
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://localhost:8443 wss://localhost:8443; object-src 'none'; base-uri 'none'; form-action 'self'");
  });
  test("production: the field station's origin for requests, and its gateway over https: and wss:", () => {
    const policy = workbenchCsp(manifest.csp, { apiOrigin: "https://demo.streamotter.dev", gatewayOrigin: "https://demo.streamotter.dev" });
    assert.match(policy, /; connect-src 'self' https:\/\/demo\.streamotter\.dev wss:\/\/demo\.streamotter\.dev;/);
    // A meta policy cannot carry frame-ancestors; it is sent as a header.
    assert.doesNotMatch(policy, /frame-ancestors|</);
    assert.deepEqual(cspConnectSources(policy), ["'self'", "https://demo.streamotter.dev", "wss://demo.streamotter.dev"]);
  });
  test("an unknown placeholder fails the build instead of shipping a broken policy", () => {
    assert.throws(() => workbenchCsp({ "connect-src": ["'self'", "<telemetry origin>"] }, { apiOrigin: null, gatewayOrigin: null }), /Unknown placeholder <telemetry origin>/);
  });
  test("connect-src falls back to default-src, and no policy restricts nothing", () => {
    assert.equal(cspConnectSources(null), null);
    assert.deepEqual(cspConnectSources("default-src 'self'; img-src data:"), ["'self'"]);
    assert.equal(cspConnectSources("img-src 'self'"), null);
    assert.equal(websocketOrigin("http://127.0.0.1:7400"), "ws://127.0.0.1:7400");
    assert.equal(connectAllows(null, "https://anywhere.example", "https://site.example"), true);
    assert.equal(connectAllows(["'self'"], "wss://site.example", "https://site.example"), true);
    assert.equal(connectAllows(["'self'"], "wss://other.example", "https://site.example"), false);
  });
});
