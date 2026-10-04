/**
 * What /workbench/ shows for the sandbox, from the field station's answers alone
 * (sandbox contract §§3–4, LC11-ADR-04). No DOM here: workbench.ts renders it, and
 * test/workbench-model.test.ts covers it. Nothing in this module invents a session,
 * a runtime, or a version: when the service has not said, the page says so.
 */
import { isWorkbenchApiOrigin, validateWorkbenchHostConfig, WORKBENCH_BOOT_ELEMENT_ID, WORKBENCH_MOUNT_ELEMENT_ID, type WorkbenchDiscovery, type WorkbenchHostConfig } from "streamotter/contracts";
import type { SandboxConnection, SandboxEndReason, SandboxErrorCode, SandboxLease, SandboxRuntime, SandboxStatus } from "../../../field-station/src/sandbox/contract.ts";
import type { PublishedSeam } from "./workbench-seam.ts";

/** WHC-1 `apiBase`: the sandbox's host API on the field station (sandbox contract §6). */
export const API_BASE = "/api/sandbox/wb/v1";
/** WHC-1 §2's `bootElementId` and `mountElementId`, from the published contract. */
export const BOOT_ELEMENT_ID = WORKBENCH_BOOT_ELEMENT_ID;
export const MOUNT_ELEMENT_ID = WORKBENCH_MOUNT_ELEMENT_ID;
/** WHC-1 §4: without all of these the workbench shows only "Not available in this environment". */
export const SHELL_OPERATIONS = ["config", "health", "channels", "sources"] as const;

/** A request that did not succeed: no answer at all, or the field station's refusal. */
export type Problem =
  | { kind: "network"; message: string }
  | { kind: "refused"; status: number; code: SandboxErrorCode | null; message: string; retryAfter: number | null };

const ERROR_CODES: ReadonlySet<string> = new Set<SandboxErrorCode>(["invalid-request", "field-not-editable", "candidate-too-large", "no-session", "origin-not-allowed",
  "operation-not-allowed", "no-lease", "stale-study", "too-many-requests", "too-many-places", "queue-full", "sandbox-unavailable", "slot-unavailable"]);

/** Reads a non-2xx answer. The body may be anything, or nothing a proxy did not mangle. */
export function refusal(status: number, body: unknown, retryAfter: string | null): Problem {
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const code = typeof record["code"] === "string" && ERROR_CODES.has(record["code"]) ? record["code"] as SandboxErrorCode : null;
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  return { kind: "refused", status, code, message: typeof record["error"] === "string" ? record["error"].slice(0, 200) : "", retryAfter: Number.isFinite(seconds) && seconds >= 0 ? seconds : null };
}

/** Plain words for a problem, from its code; the server's own message only when there is no code. */
export function problemText(problem: Problem): string {
  if (problem.kind === "network") return `The field station did not answer (${problem.message}). Check your connection, then try again.`;
  switch (problem.code) {
    case "too-many-places": return "This network address already holds two places across the Failure Lab and the workbench sandbox. Return one of them, then try again.";
    case "queue-full": return "The line for a sandbox slot is full. Try again in a few minutes.";
    case "sandbox-unavailable": return "The field station says the sandbox is unavailable, so no session was started.";
    case "slot-unavailable": return "Your sandbox slot failed, so the field station took it out of service and ended your session.";
    case "too-many-requests": return `Too many requests from this address. Try again in ${problem.retryAfter ?? 1} s.`;
    case "no-lease": return "This browser holds no sandbox slot right now.";
    case "no-session": return "This browser has no sandbox session.";
    case "stale-study": return "That answer belonged to a study that has since been reset or ended, so it was ignored.";
    case "origin-not-allowed": return "The field station refused requests from this page's origin.";
    default: return problem.message ? `The field station refused the request (${problem.status}): ${problem.message}` : `The field station answered ${problem.status}.`;
  }
}

export type UnavailableReason = NonNullable<SandboxStatus["reason"]> | "unreachable";

const UNAVAILABLE: Readonly<Record<NonNullable<SandboxStatus["reason"]>, { headline: string; detail: string }>> = {
  "disabled": { headline: "The workbench sandbox is not enabled on this deployment.", detail: "This field station runs no sandbox service, so no session can start here." },
  "seam-unavailable": {
    headline: "The workbench sandbox is not available yet.",
    detail: "A sandbox session runs the published StreamOtter workbench, which needs a release that publishes its host contract (WHC-1). The StreamOtter the sandbox service runs does not, so it has nothing to run and no session can start. Nothing on this page simulates one."
  },
  "service-unavailable": { headline: "The sandbox service is not answering.", detail: "The field station cannot reach it, so no session can start, and any open session has ended." },
  "all-slots-unavailable": { headline: "Every sandbox slot is out of service.", detail: "Each slot is being cleaned or failed its cleanup. None is handed out again until it is clean." }
};

export interface AvailabilityView {
  available: boolean;
  reason: UnavailableReason | null;
  headline: string;
  detail: string;
  /** The pool as the service reported it; empty when it reported nothing. */
  pool: string;
}

/** Minutes, rounded up, from the service's `now` to one of its times. */
function minutesUntil(at: string, now: string): number { return Math.max(1, Math.ceil((Date.parse(at) - Date.parse(now)) / 60_000)); }

export function availabilityView(status: SandboxStatus | null, problem: Problem | null): AvailabilityView {
  if (!status) {
    // A field station without the sandbox routes at all, such as `npm run dev`'s fixture API.
    if (problem?.kind === "refused" && problem.status === 404) return { available: false, reason: "disabled", headline: UNAVAILABLE.disabled.headline, detail: "This field station does not serve the sandbox API, so no session can start here.", pool: "" };
    const detail = problem ? problemText(problem) : "The field station did not answer.";
    return { available: false, reason: "unreachable", headline: "The sandbox's status is unknown.", detail, pool: "" };
  }
  if (status.availability !== "available") {
    const reason = status.reason ?? "service-unavailable";
    return { available: false, reason, ...UNAVAILABLE[reason], pool: "" };
  }
  const free = status.slots.filter(slot => slot.state === "ready").length;
  const waiting = status.queueLength === 0 ? "" : ` ${status.queueLength} ${status.queueLength === 1 ? "visitor is" : "visitors are"} waiting in line.`;
  const pool = free > 0
    ? `${free} of ${status.slots.length} sandbox ${status.slots.length === 1 ? "slot is" : "slots are"} free.${waiting}`
    : `All ${status.slots.length} sandbox ${status.slots.length === 1 ? "slot is" : "slots are"} in use. Starting a session puts you in line.${waiting}${status.nextFreeAt ? ` One frees within ${minutesUntil(status.nextFreeAt, status.now)} min at the latest.` : ""}`;
  return { available: true, reason: null, headline: "The workbench sandbox is available.", detail: "Start a session to borrow an isolated slot running synthetic fixture data. Nothing is allocated until you press Start.", pool };
}

const MODE_LABELS: Readonly<Record<SandboxRuntime["mode"], string>> = { "synthetic-fixture": "Synthetic fixture" };

export interface RuntimeLabels { mode: string; packages: string; contract: string }

/** The runtime identity the service reported, or null when it reported none. Never the site's own build. */
export function runtimeLabels(runtime: SandboxRuntime | null): RuntimeLabels | null {
  if (!runtime) return null;
  return {
    mode: MODE_LABELS[runtime.mode] ?? runtime.mode,
    packages: `streamotter@${runtime.packages.streamotter} · @streamotter/workbench@${runtime.packages.workbench}`,
    contract: runtime.contractVersion === null ? "No host contract reported" : `Host contract ${runtime.contractVersion}`
  };
}

const ENDED: Readonly<Record<SandboxEndReason, string>> = {
  "left": "You left the line.",
  "returned": "You returned your slot. Its study was discarded.",
  "expired": "Your session reached its time limit. Its study was discarded.",
  "idle": "Your session ended because this page stopped checking in, which can happen when a browser slows a tab left in the background.",
  "unclaimed": "Your slot was offered but not claimed in time, so it went to the next visitor.",
  "session-ended": "Your browser session expired.",
  "slot-failed": "Your sandbox slot failed, so the field station ended the session and took the slot out of service.",
  "sandbox-restarted": "The sandbox service restarted, which ended every session on it."
};

export function endedText(reason: SandboxEndReason): string { return ENDED[reason] ?? `Your session ended (${reason}).`; }

/** m:ss, never negative. */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type Phase = "checking" | "unavailable" | "idle" | "queued" | "ready" | "active" | "resetting" | "ended";
export type Control = "start" | "claim" | "return" | "reset" | "repro";

export interface SessionInput {
  status: SandboxStatus | null;
  statusProblem: Problem | null;
  /** The last lease answer; null before the page has asked, or when it has no session. */
  lease: SandboxLease | null;
  /** True while the page revalidates (first load, a back-forward cache restore): nothing active is shown. */
  checking: boolean;
  /** True while a lifecycle request this page sent is in flight. */
  busy: boolean;
  /** The study this page holds a claimed connection for, if any. */
  connectedStudy: string | null;
  /** The service's clock, corrected for this browser's offset from it. */
  now: number;
}

export interface SessionView {
  phase: Phase;
  headline: string;
  detail: string;
  clock: string;
  enabled: Record<Control, boolean>;
  returnLabel: string;
  claimLabel: string;
  /** The runtime to label: the lease's while one is held, the pool's otherwise. */
  runtime: SandboxRuntime | null;
}

const NONE: Record<Control, boolean> = { start: false, claim: false, return: false, reset: false, repro: false };

export function sessionView(input: SessionInput): SessionView {
  const { status, lease, busy, now } = input;
  const availability = availabilityView(status, input.statusProblem);
  const base = { clock: "", enabled: { ...NONE }, returnLabel: "End session", claimLabel: "Open the workbench", runtime: status?.runtime ?? null };
  if (input.checking) return { ...base, phase: "checking", headline: "Checking the sandbox…", detail: "Asking the field station for the sandbox's status and this browser's session." };
  if (lease && lease.status === "queued") {
    return { ...base, phase: "queued", returnLabel: "Leave the line", enabled: { ...NONE, return: !busy },
      headline: `You are number ${lease.position} of ${lease.queueLength} in line for a sandbox slot.`,
      detail: `Keep this page open: it checks in for you, and the line forgets a place that stops checking in. A browser can slow a tab left in the background enough to miss check-ins.${lease.nextFreeAt ? ` A slot frees within ${minutesUntil(lease.nextFreeAt, lease.now)} min at the latest.` : ""}` };
  }
  if (lease && (lease.status === "ready" || lease.status === "active" || lease.status === "resetting")) {
    const held = { ...base, runtime: lease.runtime, clock: `${formatRemaining(Date.parse(lease.expiresAt) - now)} left in this session` };
    if (lease.status === "ready") {
      // The countdown goes in the clock, outside the polite status region, which would otherwise announce it every second.
      const claim = lease.claimBy ? formatRemaining(Date.parse(lease.claimBy) - now) : null;
      return { ...held, phase: "ready", claimLabel: "Claim your slot", enabled: { ...NONE, claim: !busy, return: !busy },
        clock: claim === null ? held.clock : `${claim} left to claim it · ${held.clock}`,
        headline: `Sandbox slot ${lease.slot} is yours to claim.`,
        detail: claim === null ? "Claim it to open the workbench." : "Claim it within the time shown below, or it goes to the next visitor." };
    }
    if (lease.status === "resetting") {
      return { ...held, phase: "resetting", enabled: { ...NONE, return: !busy }, headline: `Starting a fresh study on slot ${lease.slot}…`,
        detail: "The previous study's candidate, traces, and previews are being discarded. The workbench reopens when the slot is ready." };
    }
    return { ...held, phase: "active", enabled: { ...NONE, claim: !busy && input.connectedStudy !== lease.studyId, return: !busy, reset: !busy, repro: !busy },
      headline: `Your sandbox session is running on slot ${lease.slot}.`,
      detail: "An isolated synthetic study: nothing in it reaches the field station, its Kafka topics, or another visitor." };
  }
  const start = { ...NONE, start: availability.available && !busy };
  if (lease && lease.status === "ended") {
    return { ...base, phase: "ended", enabled: start, headline: endedText(lease.reason),
      detail: availability.available ? "Start a new session when you are ready. Nothing starts on its own." : `${availability.headline} ${availability.detail}` };
  }
  if (!availability.available) return { ...base, phase: "unavailable", headline: availability.headline, detail: availability.detail };
  return { ...base, phase: "idle", enabled: start, headline: availability.headline, detail: availability.detail };
}

/** The boot block this page writes: WHC-1's `WorkbenchHostConfig`, with every field the sandbox needs present. */
export type SandboxBoot = WorkbenchHostConfig & Required<Pick<WorkbenchHostConfig, "apiBase" | "auth" | "gateway">> & {
  environment: Required<NonNullable<WorkbenchHostConfig["environment"]>>;
};

export type MountDecision =
  | { mount: true; boot: SandboxBoot; script: string; hostStyle: string; integrity: PublishedSeam["integrity"] }
  | { mount: false; reason: string };

export interface MountInput {
  lease: SandboxLease | null;
  connection: SandboxConnection | null;
  discovery: WorkbenchDiscovery | null;
  seam: PublishedSeam | null;
  /** Where the page sends API requests ("" for its own origin), and the page's origin. */
  apiOrigin: string;
  pageOrigin: string;
  /** The page's enforced `connect-src` (see `cspConnectSources`), or null when it sets no policy, as in development. */
  connectSrc: readonly string[] | null;
}

/** The ws: or wss: origin a socket to an http: or https: origin uses. */
export function websocketOrigin(origin: string): string { return origin.replace(/^http(s?):/, "ws$1:"); }

/** Whether a `connect-src` source list lets the page reach an origin; `'self'` also covers the page's own host over ws: and wss: (CSP3). */
export function connectAllows(sources: readonly string[] | null, origin: string, pageOrigin: string): boolean {
  if (sources === null || sources.includes(origin)) return true;
  return sources.includes("'self'") && (origin === pageOrigin || origin === websocketOrigin(pageOrigin));
}

/**
 * Whether to mount the published workbench, and with what. Only an active lease, a
 * release this site pins with the seam, a service that runs exactly that release and
 * contract, discovery listing the shell operations, an API origin WHC-1 accepts (the
 * page's own, or an exact `apiOrigin`; R11), a gateway this page's CSP lets it reach,
 * and the claim's connection together say yes. The boot block is checked with the
 * published `validateWorkbenchHostConfig` before it is returned.
 */
export function mountDecision(input: MountInput): MountDecision {
  const { lease, connection, discovery, seam } = input;
  if (!lease || lease.status !== "active") return { mount: false, reason: "No sandbox session is active." };
  if (!seam) return { mount: false, reason: "This site pins no StreamOtter release that publishes the embeddable workbench (WHC-1), so there is nothing to mount." };
  const runtime = lease.runtime;
  if (runtime.contractVersion !== String(seam.hostContract)) return { mount: false, reason: `The sandbox service reports ${runtime.contractVersion === null ? "no host contract" : `host contract ${runtime.contractVersion}`}; this page mounts host contract ${seam.hostContract}.` };
  if (runtime.packages.workbench !== seam.version) return { mount: false, reason: `The sandbox runs @streamotter/workbench@${runtime.packages.workbench}; this page pins ${seam.version}.` };
  if (!discovery || discovery.hostContract !== seam.hostContract) return { mount: false, reason: "The sandbox did not describe its host API." };
  const missing = SHELL_OPERATIONS.filter(op => !discovery.operations.includes(op));
  if (missing.length) return { mount: false, reason: `The sandbox does not serve ${missing.join(", ")}, which the workbench needs to open.` };
  const apiOrigin = input.apiOrigin === "" || input.apiOrigin === input.pageOrigin ? null : input.apiOrigin;
  if (apiOrigin !== null && !isWorkbenchApiOrigin(apiOrigin)) return { mount: false, reason: `The sandbox's API origin, ${apiOrigin}, is not an exact https origin, so the workbench would refuse it.` };
  if (!connection || connection.leaseId !== lease.leaseId || connection.studyId !== lease.studyId) return { mount: false, reason: "The slot has not been claimed for the current study." };
  const gateway = connection.gatewayOrigin;
  if (!connectAllows(input.connectSrc, gateway, input.pageOrigin) || !connectAllows(input.connectSrc, websocketOrigin(gateway), input.pageOrigin)) {
    return { mount: false, reason: `The sandbox's gateway, ${gateway}, is not in this page's Content-Security-Policy, so the workbench could not reach it. This page was built for another gateway.` };
  }
  const boot: SandboxBoot = {
    hostContract: 1, apiBase: API_BASE, ...(apiOrigin === null ? {} : { apiOrigin }), auth: { mode: "session" },
    gateway: { origin: gateway, path: connection.gatewayPath },
    environment: { kind: "sandbox", label: MODE_LABELS[runtime.mode] ?? runtime.mode, detail: "An isolated demo session on synthetic data. Nothing here touches the field station, its Kafka topics, or another visitor.", packageVersion: runtime.packages.workbench }
  };
  const checked = validateWorkbenchHostConfig(boot);
  if (!checked.ok) return { mount: false, reason: `The workbench would refuse this page's boot block (${checked.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ").slice(0, 200)}).` };
  return { mount: true, script: seam.script, hostStyle: seam.hostStyle, integrity: seam.integrity, boot };
}

/** The manifest's placeholders (WHC-1 §2); any other `<…>` value fails the build. */
const CSP_PLACEHOLDERS = new Set(["<api origin>", "<gateway origin>", "<gateway websocket origin>"]);

/**
 * The /workbench/ page's Content-Security-Policy, from the manifest's `csp`, delivered in a
 * `<meta>` element: the placeholders are filled from `apiOrigin` and `gatewayOrigin`, or
 * dropped when null (the page's own origin, which `'self'` covers). `frame-ancestors` is
 * left out because a meta policy cannot carry it; Caddy and `public/_headers` send it as a
 * header. The page adds `default-src`, `object-src`, `base-uri` and `form-action`.
 */
export function workbenchCsp(csp: Readonly<Record<string, readonly string[]>>, origins: { apiOrigin: string | null; gatewayOrigin: string | null }): string {
  const fill = (source: string): string[] => {
    if (!source.startsWith("<")) return [source];
    if (!CSP_PLACEHOLDERS.has(source)) throw new Error(`Unknown placeholder ${source} in the workbench manifest's csp.`);
    if (source === "<api origin>") return origins.apiOrigin === null ? [] : [origins.apiOrigin];
    if (origins.gatewayOrigin === null) return [];
    return [source === "<gateway origin>" ? origins.gatewayOrigin : websocketOrigin(origins.gatewayOrigin)];
  };
  const directives: [string, string[]][] = [["default-src", ["'self'"]]];
  for (const [name, sources] of Object.entries(csp)) {
    if (name === "frame-ancestors" || name === "default-src") continue;
    directives.push([name, [...new Set(sources.flatMap(fill))]]);
  }
  directives.push(["object-src", ["'none'"]], ["base-uri", ["'none'"]], ["form-action", ["'self'"]]);
  return directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

/** The sources a policy applies to fetches and sockets: `connect-src`, else `default-src`, else null (unrestricted). */
export function cspConnectSources(policy: string | null): string[] | null {
  if (!policy) return null;
  const directives = new Map(policy.split(";").map(part => part.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...sources]) => [name!.toLowerCase(), sources]));
  return directives.get("connect-src") ?? directives.get("default-src") ?? null;
}
