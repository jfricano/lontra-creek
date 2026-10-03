# LC11-ADR-04 — Workbench sandbox architecture

Status: **Accepted for implementation of the session layer** (October 3, 2026). The runtime binding is finalized against the published seam. · Slices: W2, W3, W9a · Companion plan §3 "Workbench sandbox on the existing route" · Acceptance: LC11-A41–A46

## Context

`/workbench/` must serve the actual published StreamOtter workbench UI to anonymous visitors, each on an isolated synthetic runtime, with Connect, Define, validate, Preview, Inspect, and Export (and the Failures view once a release supports it). The rc.3 workbench can only be served by the native management server on loopback with a pasted per-run token (BASELINE.md §3). StreamOtter owns the integration seam; Lontra Creek owns visitor sessions, synthetic bindings, isolation, limits, hosting, and cleanup.

## Decision

### Components

```
browser, https://streamotter.app/workbench/
  ├─ published workbench UI, mounted by the page through the seam's embed API
  │    └─ host adapter (site code) ──fetch, credentials──▶ /api/sandbox/*       Caddy ─▶ field-station:7402   sessions, queue, op allowlist
  └─ preview SDK WebSocket ─────────────────────────────▶ /sandbox/N/socket.io/ Caddy (Origin check) ─▶ sandbox:76N0

field-station ──service token──▶ sandbox:7620   sandbox API, Compose network only

sandbox (one container, K slots, default K = 3)
  slot N gateway        :76N0          createGateway({ mode: "development" }) on synthetic fixture sources
  slot N management     in-process     the seam's management service; never listened on, never routed
  sandbox API           :7620          slot lease, credential minting, operation execution, reset
```

1. **A separate `sandbox` service**, not the Lab benches. Benches are Kafka-only and must register no development principals (Lab contract M1); the sandbox needs fixture sources and a preview principal. Keeping them apart keeps both threat models simple.
2. **One lifecycle and capacity owner.** The field station's lease coordinator owns both pools (Lab benches and sandbox slots): separate queues and capacities, one session model, and one per-client-address cap across both (2 places in total). No other component grants or ends a sandbox lease.
3. **Explicit allocation.** A slot is allocated only by `POST /api/sandbox/session`. Opening, reloading, or restoring the page from the back-forward cache never allocates, and revalidates before showing an active session.
4. **Server-owned bindings.** Each slot runs a fixed project: the creek's `station` channel and the pinned `streamotter init` example's `jobProgress`, on synthetic fixture sources, with server-chosen IDs, handlers, and development principal. The visitor cannot name or replace a source, topic, handler, connection, credential, gateway setting, or file path.
5. **Restricted candidate editor.** The visitor edits a candidate configuration. The server applies only allowlisted fields (sandbox contract §5) onto the server-owned base, enforces size limits, and validates with the published validator in the sandbox service. Candidates never change the running gateway. A later, supported preset lifecycle (stop, reconfigure, start) is the only way configuration changes take effect, and only for presets the server defines.
6. **Closed operation allowlist.** The host adapter can call only the operations in the sandbox contract §6, each mapped to the slot's private management service. There is no generic proxy, no pass-through of paths or bodies, and the native management token never leaves the sandbox process.
7. **Preview credentials.** The sandbox API mints a development preview token for the slot's own principal only, for the current session, expiring at the earlier of the native preview lifetime and the session's end. Caddy routes `/sandbox/N/socket.io/*` only with the site's exact Origin. Revocation on return, reset, or expiry closes the slot's connections.
8. **Bounded downloads.** Export returns canonical configuration built from the validated candidate, and a reproduction bundle of this session's metadata, both size-capped and generated per request. No host paths, tokens, cookies, or other sessions' data.
9. **Honest modes.** The page labels the mode **synthetic fixture** and the exact package version from the running service. Fixture mode never claims Kafka durability or quarantine. A real-Kafka sandbox mode is out of scope until the Failures view needs it (open question 1).
10. **Unavailable is a first-class state.** With no published seam, a full pool, or the service down, the page says so and offers the recorded tour, labeled with its own capture provenance. A recording never stands in for sandbox acceptance.

### Defaults (configuration, not measured capacity)

| Setting | Default |
| --- | --- |
| Slots | 3 |
| Session lease | 600 s, never past the visitor's session |
| Claim window | 30 s |
| Idle limit | 60 s without a heartbeat |
| Queue | 30 places |
| Operations | 2 a second per session; fixture advance at most 10 records per call |
| Candidate body | 64 KB |
| Download | 256 KB |
| Slot gateway limits | `maxConnections` 4, `maxSubscriptionsPerConnection` 8 |

Real values are measured locally and on the host before a hosted proposal (Jason decides host capacity).

## Open questions

1. **Failures view in the sandbox.** Native quarantine needs Kafka. When a release supplies the Failures view, decide between a real-Kafka sandbox slot type and leaving Failures to the Lab, based on what the release supports in fixture mode.
2. **Seam shape.** This ADR assumes an embed API with a host-supplied transport and an in-process management service ([UPSTREAM_REQUIREMENTS.md](../UPSTREAM_REQUIREMENTS.md) R1–R6). If the published seam differs, W9a adapts the adapter and amends this ADR; the session layer (W2) does not change.

## Alternatives considered

- **Serve the rc.3 assets and imitate `/management/v1/*`.** Rejected as a product path: undocumented route shapes, a developer token gate, and no supported embed contract. Allowed only as a local, time-boxed feasibility spike.
- **Proxy the native management server.** Rejected: a generic proxy and the native token in reach of visitors.
- **Rebuild a lookalike UI.** Rejected by the companion plan.
- **Reuse Lab benches.** Rejected: conflicts with M1 (no development principals), the five-minute scenario lease, and Kafka-only benches.
