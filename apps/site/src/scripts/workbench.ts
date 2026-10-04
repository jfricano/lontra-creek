/**
 * The /workbench/ sandbox panel (sandbox contract §4, LC11-ADR-04). Allocation is
 * explicit: only the Start button sends POST /api/sandbox/session. Opening, reloading,
 * or restoring the page from the back-forward cache only asks for the status and this
 * browser's session, and shows nothing active until the field station has answered.
 * The published workbench is mounted only when workbench-model.ts's mountDecision
 * says so, and at most once per document: WHC-1 has no teardown (G1), so a second
 * mount reloads the page and reopens the same lease without allocating.
 */
import { WORKBENCH_REQUEST_HEADER, type WorkbenchDiscovery } from "streamotter/contracts";
import type { SandboxConnection, SandboxLease, SandboxReproDownload, SandboxStatus } from "../../../field-station/src/sandbox/contract.ts";
import { API_BASE, availabilityView, BOOT_ELEMENT_ID, cspConnectSources, MOUNT_ELEMENT_ID, mountDecision, NO_DISCOVERY, problemText, refusal, runtimeLabels, sessionView, type Problem } from "./workbench-model.ts";
import { PUBLISHED_SEAM } from "./workbench-seam.ts";

const origin = (import.meta.env?.PUBLIC_FIELD_STATION_ORIGIN ?? "").replace(/\/+$/, "");
/** The lease a reload was for (see mountWorkbench); per tab, and cleared once read. */
const REOPEN_KEY = "lontra.workbench.reopen";

function reopenMarker(): string | null {
  try { const lease = sessionStorage.getItem(REOPEN_KEY); sessionStorage.removeItem(REOPEN_KEY); return lease; } catch { return null; }
}

const root = document.querySelector<HTMLElement>("[data-sandbox]");
if (root) mount(root);

type Answer<T> = { ok: true; data: T } | { ok: false; problem: Problem };
const HEARTBEAT_MS = 5_000;
const STATUS_MS = 15_000;

function mount(root: HTMLElement): void {
  function el<T extends HTMLElement = HTMLElement>(selector: string): T { const element = root.querySelector<T>(selector); if (!element) throw new Error(`Missing ${selector}`); return element; }
  const buttons = {
    start: el<HTMLButtonElement>("[data-sandbox-start]"), claim: el<HTMLButtonElement>("[data-sandbox-claim]"), return: el<HTMLButtonElement>("[data-sandbox-return]"),
    reset: el<HTMLButtonElement>("[data-sandbox-reset]"), repro: el<HTMLButtonElement>("[data-sandbox-repro]")
  };
  const host = el("[data-sandbox-mount]");
  let status: SandboxStatus | null = null;
  let statusProblem: Problem | null = null;
  let lease: SandboxLease | null = null;
  let connection: SandboxConnection | null = null;
  let discovery: WorkbenchDiscovery | null = null;
  /** Why the last discovery request failed, shown with the mount note. */
  let discoveryProblem: Problem | null = null;
  let mountNote = "";
  let mountedStudy: string | null = null;
  /** Set once app.js has run in this document; it cannot be torn down or booted again (G1). */
  let mountedOnce = false;
  /** True while this page reloads to mount a new study: leaving keeps the lease. */
  let reloading = false;
  /** The lease a reload was for, until revalidation has seen it. */
  let reopen = reopenMarker();
  /** The last action's outcome, and the last failed check-in; shown together, cleared separately. */
  let note = "";
  let contact = "";
  let offset = 0;
  let checking = true;
  let busy = false;
  /** True while this page's Start request is in flight: the field station may already hold a place for it. */
  let starting = false;
  /** Claim without a second click: only right after this page's own Start or Reset. */
  let autoClaim = false;
  /** Bumped on pagehide and pageshow, so answers to requests from before are dropped. */
  let generation = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  let lastStatusAt = 0;
  /** True while a heartbeat is in flight, so a visibility change doesn't start a second one. */
  let ticking = false;

  async function call<T>(path: string, method: "GET" | "POST" = "GET"): Promise<Answer<T>> {
    let response: Response;
    try { response = await fetch(`${origin}/api/sandbox/${path}`, { method, credentials: "include", cache: "no-store", signal: AbortSignal.timeout(8_000) }); }
    catch (error) { return { ok: false, problem: { kind: "network", message: error instanceof Error && error.name === "TimeoutError" ? "no answer within 8 s" : "the request failed" } }; }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, problem: refusal(response.status, body, response.headers.get("retry-after")) };
    if (body === null) return { ok: false, problem: { kind: "network", message: "the answer was not JSON" } };
    return { ok: true, data: body as T };
  }
  const holding = (): boolean => lease !== null && (lease.status === "queued" || lease.status === "ready" || lease.status === "active" || lease.status === "resetting");
  const now = (): number => Date.now() + offset;

  function setLease(next: SandboxLease): void {
    lease = next; offset = Date.parse(next.now) - Date.now();
    if (next.status !== "active" && next.status !== "ready") connection = null;
    if (next.status !== "ready" && next.status !== "active" && next.status !== "resetting") autoClaim = false;
    if (next.status !== "active" || (mountedStudy !== null && mountedStudy !== next.studyId)) unmount();
  }

  function unmount(): void {
    if (mountedStudy === null && !host.childElementCount) return;
    mountedStudy = null; host.replaceChildren(); host.hidden = true;
    document.getElementById(BOOT_ELEMENT_ID)?.remove();
  }

  /** The connect-src this page's own policy enforces, so a gateway it could not reach is refused with a reason. */
  function connectSrc(): string[] | null {
    return cspConnectSources(document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? null);
  }

  /**
   * WHC-1 §3: the scoped host stylesheet, the boot block, the mount element, then app.js,
   * both files with their pinned integrity. app.js reads the boot block once and has no
   * teardown, so only the first mount in a document loads it; a later one (after a reset,
   * or a new session in this tab) reloads the page, which revalidates and reopens the lease.
   */
  function mountWorkbench(): void {
    const decision = mountDecision({ lease, connection, discovery, seam: PUBLISHED_SEAM, apiOrigin: origin, pageOrigin: location.origin, connectSrc: connectSrc() });
    if (!decision.mount) {
      const unanswered = decision.reason === NO_DISCOVERY ? discoveryProblem : null;
      mountNote = lease?.status === "active" ? (unanswered ? `${decision.reason} ${problemText(unanswered)}` : decision.reason) : "";
      // Only the discovery request kept it closed: leaving the slot unclaimed here offers Open the workbench, which asks again.
      if (unanswered) connection = null;
      return;
    }
    if (lease?.status !== "active" || mountedStudy === lease.studyId) return;
    if (mountedOnce) {
      // An old instance would keep polling, under the same cookie, against the new study (A42).
      try { sessionStorage.setItem(REOPEN_KEY, lease.leaseId); } catch { /* the reloaded page then waits for Open the workbench */ }
      reloading = true; mountNote = "Reloading the page to open the workbench on the new study…";
      location.reload(); return;
    }
    unmount(); mountNote = "";
    const style = document.createElement("link"); style.rel = "stylesheet"; style.href = decision.hostStyle; style.integrity = decision.integrity.hostStyle;
    const boot = document.createElement("script"); boot.type = "application/json"; boot.id = BOOT_ELEMENT_ID; boot.textContent = JSON.stringify(decision.boot);
    const app = document.createElement("div"); app.id = MOUNT_ELEMENT_ID;
    const script = document.createElement("script"); script.type = "module"; script.src = decision.script; script.integrity = decision.integrity.script;
    host.append(style, boot, app, script); host.hidden = false; mountedStudy = lease.studyId; mountedOnce = true;
  }

  /** Rendering runs every second; only a real change touches the DOM, so live regions announce changes only. */
  function text(element: HTMLElement, value: string): void { if (element.textContent !== value) element.textContent = value; }

  function render(): void {
    const view = sessionView({ status, statusProblem, lease, checking, busy, now: now(), connectedStudy: connection?.studyId ?? null });
    root.dataset["phase"] = view.phase;
    text(el("[data-sandbox-headline]"), view.headline);
    text(el("[data-sandbox-detail]"), view.detail);
    text(el("[data-sandbox-clock]"), view.clock);
    text(el("[data-sandbox-note]"), [note, contact].filter(Boolean).join(" "));
    text(el("[data-sandbox-pool]"), checking ? "" : availabilityView(status, statusProblem).pool);
    // Revalidating mid-action would drop the action's answer, such as the place a Start was given.
    el<HTMLButtonElement>("[data-sandbox-retry]").disabled = busy;
    const shown: Record<keyof typeof buttons, boolean> = {
      start: ["checking", "unavailable", "idle", "ended"].includes(view.phase), claim: view.phase === "ready" || (view.phase === "active" && view.enabled.claim),
      return: ["queued", "ready", "active", "resetting"].includes(view.phase), reset: view.phase === "active", repro: view.phase === "active"
    };
    for (const [name, button] of Object.entries(buttons) as [keyof typeof buttons, HTMLButtonElement][]) { button.hidden = !shown[name]; button.disabled = !view.enabled[name]; }
    text(buttons.return, view.returnLabel); text(buttons.claim, view.claimLabel);
    const labels = runtimeLabels(checking ? null : view.runtime);
    text(el("[data-sandbox-mode]"), labels?.mode ?? "Not reported");
    text(el("[data-sandbox-packages]"), labels?.packages ?? "Not reported");
    text(el("[data-sandbox-contract]"), labels?.contract ?? "Not reported");
    el("[data-sandbox-runtime-note]").hidden = labels !== null || checking;
    text(el("[data-sandbox-mount-note]"), view.phase === "active" ? mountNote : "");
  }

  async function refreshStatus(): Promise<void> {
    const g = generation; const answer = await call<SandboxStatus>("status"); if (g !== generation) return;
    lastStatusAt = Date.now();
    if (answer.ok) { status = answer.data; statusProblem = null; } else { status = null; statusProblem = answer.problem; }
  }
  async function refreshLease(): Promise<void> {
    const g = generation; const answer = await call<SandboxLease>("session"); if (g !== generation) return;
    if (answer.ok) { setLease(answer.data); contact = ""; return; }
    const problem = answer.problem;
    // No session cookie: nothing held. After holding a place, that means the browser session ended.
    if (problem.kind === "refused" && problem.code === "no-session") { contact = ""; setLease(holding() ? { status: "ended", now: new Date(now()).toISOString(), reason: "session-ended", endedAt: new Date(now()).toISOString() } : { status: "none", now: new Date(now()).toISOString() }); return; }
    if (problem.kind === "refused" && problem.code === "sandbox-unavailable" && !holding()) return;
    contact = holding() ? `Could not check in with the field station: ${problemText(problem)}` : problemText(problem);
  }

  async function claim(): Promise<void> {
    const g = generation; const answer = await call<SandboxConnection>("session/claim", "POST"); if (g !== generation) return;
    autoClaim = false;
    if (!answer.ok) { note = problemText(answer.problem); await refreshLease(); return; }
    connection = answer.data;
    await refreshLease(); if (g !== generation) return;
    discovery = null; discoveryProblem = null;
    // Discovery matters only when this site pins a release with the seam; until then nothing is asked.
    if (PUBLISHED_SEAM && lease?.status === "active") {
      try {
        const response = await fetch(`${origin}${API_BASE}/workbench`, { credentials: "include", cache: "no-store", headers: { [WORKBENCH_REQUEST_HEADER]: "1" }, signal: AbortSignal.timeout(8_000) });
        const body = await response.json().catch(() => null) as { ok?: boolean; data?: WorkbenchDiscovery; error?: { details?: unknown } } | null;
        if (response.ok && body?.ok === true && body.data) discovery = body.data;
        // A WHC-1 refusal carries the sandbox's own code in error.details (sandbox contract §6).
        else discoveryProblem = refusal(response.status, body?.error?.details ?? null, response.headers.get("retry-after"));
      } catch (error) { discoveryProblem = { kind: "network", message: error instanceof Error && error.name === "TimeoutError" ? "no answer within 8 s" : "the request failed" }; }
    }
    if (g === generation) mountWorkbench();
  }

  /** One lifecycle action from a button: disable the controls, send it, then show the field station's answer. */
  async function act(action: () => Promise<void>, from?: HTMLButtonElement): Promise<void> {
    if (busy) return;
    const focused = from !== undefined && document.activeElement === from;
    busy = true; note = ""; render();
    try { await action(); } finally { busy = false; render(); if (focused) refocus(from); }
  }
  /** The pressed button was disabled, and may now be hidden: give focus back to it, to the control that replaces it, or to the new state's headline. */
  function refocus(from: HTMLButtonElement): void {
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== from) return; // the visitor has moved on
    const usable = (button: HTMLButtonElement): boolean => !button.hidden && !button.disabled;
    ([from, buttons.claim, buttons.start].find(usable) ?? el("[data-sandbox-headline]")).focus();
  }
  buttons.start.addEventListener("click", () => { void act(async () => {
    const g = generation; starting = true;
    const answer = await call<SandboxLease>("session", "POST").finally(() => { starting = false; }); if (g !== generation) return;
    if (!answer.ok) { note = problemText(answer.problem); if (answer.problem.kind === "refused" && answer.problem.code === "sandbox-unavailable") await refreshStatus(); return; }
    autoClaim = true; setLease(answer.data);
    if (lease?.status === "ready") await claim();
  }, buttons.start); });
  buttons.claim.addEventListener("click", () => { void act(claim, buttons.claim); });
  buttons.return.addEventListener("click", () => { void act(async () => {
    const g = generation; const answer = await call<SandboxLease>("session/return", "POST"); if (g !== generation) return;
    if (answer.ok) setLease(answer.data); else note = problemText(answer.problem);
  }, buttons.return); });
  buttons.reset.addEventListener("click", () => { void act(async () => {
    const g = generation; const answer = await call<SandboxLease>("session/reset", "POST"); if (g !== generation) return;
    if (answer.ok) { autoClaim = true; setLease(answer.data); } else { note = problemText(answer.problem); await refreshLease(); }
  }, buttons.reset); });
  buttons.repro.addEventListener("click", () => { void act(async () => {
    const answer = await call<SandboxReproDownload>("session/repro", "POST");
    if (!answer.ok) { note = problemText(answer.problem); return; }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([answer.data.content], { type: "application/json" })); link.download = answer.data.filename;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0);
    note = `Saved ${answer.data.filename}: this study's synthetic scenario, packages, and traces only.`;
  }, buttons.repro); });
  el("[data-sandbox-retry]").addEventListener("click", () => { void revalidate(); });

  async function tick(): Promise<void> {
    const g = generation; ticking = true;
    try {
      const held = holding();
      if (held) {
        await refreshLease(); if (g !== generation) return;
        if (autoClaim && !busy && (lease?.status === "ready" || (lease?.status === "active" && connection?.studyId !== lease.studyId))) await act(claim);
      }
      // A session that just ended (a failed slot, an unreachable service) asks for the status at once, so Start is never offered on an old one.
      if (g === generation && (Date.now() - lastStatusAt >= STATUS_MS || (held && !holding()))) await refreshStatus();
      if (g !== generation) return;
      render(); poll = setTimeout(() => { void tick(); }, HEARTBEAT_MS);
    } finally { if (g === generation) ticking = false; }
  }
  // A browser can slow a background tab's timers to one wake-up a minute, as long as the idle limit,
  // so check in as soon as the page is visible again rather than at the next timer.
  document.addEventListener("visibilitychange", () => { if (document.hidden || checking || ticking || !holding()) return; clearTimeout(poll); void tick(); });

  /** Status, then this browser's session; nothing is shown as active until both have answered. */
  async function revalidate(): Promise<void> {
    const g = ++generation; clearTimeout(poll); ticking = false; // a heartbeat in flight is now stale
    const held = holding();
    checking = true; render();
    await refreshStatus(); if (g !== generation) return;
    if (held || status?.availability === "available") await refreshLease();
    if (g !== generation) return;
    checking = false; render();
    poll = setTimeout(() => { void tick(); }, HEARTBEAT_MS);
    // After a reload for a new study: claim again, which only returns the active lease's connection, and mount.
    const reopening = reopen; reopen = null;
    if (reopening !== null && lease?.status === "active" && lease.leaseId === reopening) await act(claim);
  }

  function start(): void { clock = setInterval(render, 1_000); void revalidate(); }
  function stop(): void { generation++; ticking = false; clearTimeout(poll); clearInterval(clock); }

  window.addEventListener("pagehide", () => {
    // A reload for a new study keeps the lease: the reloaded page reopens it.
    const held = !reloading && (holding() || starting);
    stop(); unmount(); connection = null; discovery = null; autoClaim = false; checking = true;
    // Leaving the page returns the slot or place, including one a Start still in flight may get; the empty body keeps keepalive preflight-free.
    if (held) void fetch(`${origin}/api/sandbox/session/return`, { method: "POST", credentials: "include", keepalive: true }).catch(() => undefined);
  });
  // A restore from the back-forward cache revalidates and never allocates.
  window.addEventListener("pageshow", event => { if (event.persisted) start(); });
  start();
}
