# Lontra Creek V1.1 — Slice A baseline, compatibility, and exposure review

October 3, 2026 · Reviewed: `jfricano/lontra-creek@aa9c236` with `streamotter@0.1.0-rc.3` installed from npm · Companion plan baseline: `2397e2c`

This is the slice A deliverable the companion plan's §14 asks for: the current branch, native API availability, a route and contract inventory, the sandbox integration boundary, and the exposure delta. It records what was checked and how; it makes no claim about behavior that was not run.

## 1. How this was checked

- Fresh clone of `main` at `aa9c236`. Node 24.21.0, `npm ci`, `npm run typecheck`, `npm test` (119 passed, 0 failed), `npm run build -w @lontra-creek/site` (9 pages), `npm run check:site` (311 local links and assets). All passed.
- Source reading of `apps/field-station/src/lab/*`, `apps/site/src/pages/{lab,workbench,playground}.astro`, `apps/site/src/site.ts`, `docs/contracts/lab-api.md`, `deploy/kafka/start.sh`, and the installed `node_modules/@streamotter/*` packages, plus the StreamOtter repository at `b0109ba` for planned behavior.
- Not run for this review: the Docker/Kafka stack, the browser suite, or any hosted environment. The [October 2 site evaluation](../../reviews/2026-10-02-site-evaluation.md) ran the full local production stack and remains the latest end-to-end evidence.

## 2. What changed since the companion plan's baseline

28 commits between `2397e2c` and `aa9c236`. Relevant to V1.1:

| Change | Commits | Effect on this plan |
| --- | --- | --- |
| Production connection-drop fix and production-bundle browser checks | `1380697` (PR #23) | The `Browser` workflow now also runs the home and walkthrough specs against production bundles. W10 extends that to the Lab and Workbench. |
| Shared-host adapter, isolated router, checkpoint backups | `e669e22`…`4caadff` (PR #21) | Hosting now has a shared-host path with bounded resources. Sandbox capacity must be budgeted against it (ADR-04). |
| V1.1 plan and sandbox seed examples | `36edccf`, `a60980e` (PR #26) | The plan this document implements. |
| Code review and site evaluation | `edb69e3`, `b680bb5` (PRs #24, #25) | Lab reliability findings feed W1. |
| Kafka data-flow documentation | `bb9ed6a`, `924ca3d` (PR #28) | Background only. |

No commit after `2397e2c` changes the Lab contract, the bench runtime, or the installed package version.

## 3. Native capability availability

`streamotter@0.1.0-rc.3` ships `@streamotter/{cli,client,contracts,gateway,workbench}`. Against the V1.1 needs:

| Need | In rc.3? | Notes |
| --- | --- | --- |
| `failureHandling` configuration, quarantine policies, recovery guard (`sourceRecoveryRef`), cumulative barrier, snapshot acknowledgment | No | Planned in StreamOtter V1.1 §§4–9. |
| Local operator service (list/show/export incidents, retry-current, reassess, evaluate, redrive, reopen-circuit) | No | Planned in StreamOtter V1.1 §9, slice D. |
| Health probes as gateway/start options | No | Planned (ADR-15C §2). |
| `gateway.resumeSource()` | Yes | Used by the existing Fouled sensor scenario. |
| Development management API (`startManagementServer`) | Yes | Loopback by default, per-run bearer token, no CORS, exact-Origin checks, refuses production gateways. Routes listed in the [Lab contract §10.2 D4](../../contracts/lab-api.md#102-what-development-mode-changes). |
| Workbench static assets (`@streamotter/workbench/dist`) | Yes | Built to be served only by `startManagementServer`: it calls same-origin `/management/v1/*` with a pasted bearer token and reads the gateway origin from injected `<meta>` tags. No embed API, no host-supplied transport, no documented contract for another origin. |
| Published config validator in the browser | Yes | `/playground/` already imports it; it knows nothing of `failureHandling`. |

**Conclusion:** every new Lab exercise and the actual sandbox UI depend on unpublished StreamOtter work. Until a release supplies them, the site shows those features as unavailable with accurate reasons (LC11-A04). The requirements are filed with the StreamOtter V1.1 thread in [UPSTREAM_REQUIREMENTS.md](UPSTREAM_REQUIREMENTS.md).

### Why not serve the rc.3 workbench assets now

The published rc.3 assets could technically be served at the site origin with a Lontra-owned imitation of `/management/v1/*` behind a visitor-scoped "token". That depends on undocumented route shapes and a token-paste gate meant for a local developer, and the companion plan asks for "a supported way to serve the actual UI". It is rejected as the product path (ADR-04 §Alternatives). It may be used only as a time-boxed local feasibility spike, never deployed.

## 4. Handoff assumptions, re-verified

The handoff lists six baseline assumptions that need adaptation. Each still holds at `aa9c236`:

| Assumption | Verified at | Addressed by |
| --- | --- | --- |
| Reset rotates the consumer group and starts at `latest`, while the source generation is fixed (`lab-N-field-1`) | `lab/runtime.ts` `reset()`; `lab/bench.ts` `benchConfig()` | ADR-02, W5 |
| Gateway startup treats a non-healthy source as failure | `lab/runtime.ts` `#startGateway()` throws `Bench source did not become healthy.` | ADR-02, W5 |
| The mapper's `processed` annotation is emitted before downstream validation and commit | `lab/bench.ts` `map` calls `options.record(...)` before returning | W4 relabels it **mapper returned**; W9b derives stronger facts from native results |
| `npm run dev` and `dev:kafka` start no Lab benches | `scripts/dev-kafka.mjs` strips `LAB_BENCH*` from its environment; `dev` is fixture-only | W6 |
| Recorded workbench assets interpolate the global `RELEASE` | `pages/workbench.astro` notice and image `alt` use `RELEASE`; `capture.json` records `0.1.0-rc.3` | W3 binds provenance to `capture.json` |
| No broker topic ACLs (Lab contract R2) | `deploy/kafka/start.sh` configures no authorizer | ADR-03, W7 |

## 5. Route and contract inventory

| Route | Today | V1.1 change (owner slice) |
| --- | --- | --- |
| `/` | Live hero, install flow, scenario copy | V1.1 panel and **Try source failures** (W8) |
| `/field-station/` | Six-chapter walkthrough | Optional "Next: handle a bad reading" link (W8) |
| `/lab/` | LC-03 view, four scenarios, redacted feed | Track chooser, Source failures catalog and incident panel (W4), exercises (W9b) |
| `/when-it-breaks/` | SDK states and errors | Policy matrix and record-disposition lifecycle (W8) |
| `/workbench/` | Recorded tour and screenshots | Sandbox (W2, W3, W9a); recordings become labeled fallback |
| `/playground/` | Browser-local validator | Failure-policy presets once the validator supports them (gated) |
| `/docs/` | Documentation map | Links to exact-release guides when they exist (W8) |
| `/releases/` | Release facts | Separate site release, library package, demo availability, verified boundary (W8) |

Contracts: [`docs/contracts/lab-api.md`](../../contracts/lab-api.md) with `apps/field-station/src/lab/contract.ts` (Lab), the new [`docs/contracts/sandbox-api.md`](../../contracts/sandbox-api.md) (sandbox, draft), and [`docs/contracts/ui-components.md`](../../contracts/ui-components.md) (notices and shared components).

## 6. Exposure delta

What V1.1 adds to the public surface, and the decision or test that bounds it:

| New surface | Risk | Bound |
| --- | --- | --- |
| `/api/sandbox/*` on the field station | Cross-visitor access, resource exhaustion, a generic management proxy | Session-derived slot selection, closed operation allowlist, body and rate limits, one lifecycle owner (ADR-04, sandbox contract §6) |
| Sandbox gateway sockets at `/sandbox/N/socket.io/` | Development-mode D2/D3 paths (Lab contract §10.2) | One isolated synthetic gateway per slot, preview tokens minted only for the current session's slot, Caddy Origin rule, principal expiry equals session end (ADR-04) |
| Sandbox management service | Native management token or routes reaching a browser | Never routed; the adapter calls a private in-process or loopback service; the browser holds only its sandbox session credential (ADR-04) |
| Quarantine write authority on benches | A bench writing another bench's or production topics (R2) | Broker authorizer and per-bench ACLs; hosted exposure gated on real ACL evidence (ADR-03) |
| Failure journals and the application scenario ledger | Evidence leaking across leases; unbounded disk | Per-bench volumes with study identity; bounded retention labeled as demo cleanup (ADR-02, ADR-03) |
| New scenario intents on `/api/lab/actions` | Arbitrary offsets, topics, or payloads | Closed intent set, server-selected incident, idempotency and expected-revision binding (companion plan §9; W4 contract amendment) |

The Lab contract's §10.8 verdict was made against rc.3. Its R4 obligation applies: when the pinned release changes, redo §10.2 against the new published source and rerun S1–S6 before exposure.
