# Lontra Creek V1.1 — Requirements on published StreamOtter packages

October 3, 2026 · Owner: Jason Fricano · Counterpart: the StreamOtter V1.1 implementation (`jfricano/StreamOtter`, `docs/releases/v1.1/`)

Lontra Creek consumes exact published npm releases. It never links a sibling checkout, imports unexported internals, or patches the installed package (companion plan §7). This file lists the capabilities the site needs, why, and their state. StreamOtter decides the shape; Lontra Creek adapts to what is published. Any compatible release satisfies a requirement; none needs a version named `1.1.0`.

Requirements R1–R6 were sent to the StreamOtter V1.1 implementation on October 3, 2026. The same day StreamOtter answered with the **workbench host contract, WHC-1** (revision 0.1, defined but not implemented), in [StreamOtter PR #12](https://github.com/jfricano/StreamOtter/pull/12) at `docs/releases/v1.1/WORKBENCH_HOST_CONTRACT.md`. It ships in an early StreamOtter PR that can be published before the rest of native V1.1. Lontra Creek builds its sandbox adapter against WHC-1; R11 and R12 were sent back as gaps; StreamOtter accepted both for WHC-1 revision 0.3 on PR #14.

**Update, October 4, 2026.** Every requirement below ships in StreamOtter 0.2.0-rc.1 (#55, #20 and #56 at `4e67ef8`), which is not on npm yet. Lontra Creek's phase 2 branch builds against a pre-publish pack of it ([SOURCE_FAILURE_EXERCISES.md](SOURCE_FAILURE_EXERCISES.md#pre-publish-packages-and-their-removal)); the states below say what the package exports, not that it is published.

## Workbench integration seam (StreamOtter spec §10, F44/F46)

| ID | Requirement | Why the site needs it | State |
| --- | --- | --- | --- |
| R1 | **Embeddable UI.** A published ESM entry (for example `@streamotter/workbench/embed`) with a mount function that takes a root element, a host-supplied transport implementing the management operations, the preview gateway origin and path, and an optional mode/version label; returns an unmount handle. No token gate when a host transport is supplied. CSS scoped to the root; no inline scripts or styles; assets importable or relative. | Serve the real UI on `/workbench/` at the site origin, under the site's CSP, without the loopback server or a pasted token | Covered by WHC-1 §§2–3: relative assets, an asset manifest with integrity and CSP, a JSON boot block with `auth.mode: "session"` (no token gate) |
| R2 | **Typed wire contract.** Exported request and result types for every management operation, a contract version constant, and a versioned specification document. | The sandbox contract §6 maps to these types; version checks prevent a mismatched UI and adapter | Covered by WHC-1 §5 and §7 (`ManagementOperations`, `hostContract: 1`) |
| R3 | **Capability-driven UI.** The UI reads a host-supplied capability set and shows unsupported operations disabled with a reason. | The sandbox may disallow some operations; the UI must not fail or pretend | Covered by WHC-1 §4 (`GET {apiBase}/workbench` discovery) |
| R4 | **In-process management service.** A function exposing the same operations for a development-mode gateway without its own listener or token (or a request handler with a host `authorize` hook). The native loopback server and its restrictions stay as they are; production mode still refuses. | The sandbox mounts operations behind its own session auth and allowlist; the native token never reaches a visitor | Covered by WHC-1 §6 (`createManagementHandler` with an operation allowlist and host `authorize`) |
| R5 | **Preview through a reverse proxy.** A supported way to set allowed browser origins and the advertised gateway origin and path for development preview sessions. | Preview sockets at `/sandbox/N/socket.io/` on the site's HTTPS origin | Partly covered: the boot block names the preview gateway; allowed-origin configuration for the slot gateway is the host's `allowedOrigins` |
| R6 | **Pure validation and export.** Validate and export return content and never write files. | The host provides bounded downloads | True in rc.3 and kept by WHC-1 |
| R11 | **Same-site API base.** Allow an absolute https `apiBase` in `session` mode, called with `credentials: "include"` and the `X-StreamOtter-Workbench` header, for an explicitly declared API origin. | The site is static on Cloudflare Pages (`streamotter.dev`); every API, and the `lc_session` cookie, is on `demo.streamotter.dev`. WHC-1 rev 0.1 refuses cross-origin API bases, which would force new proxy infrastructure | Accepted October 3 for WHC-1 rev 0.3 (StreamOtter PR #14): an optional `apiOrigin` boot field (exact https origin, session mode only); requests go to `apiOrigin + apiBase` with `mode: "cors"`, `credentials: "include"`, `redirect: "error"` and `X-StreamOtter-Workbench: 1`, so the host answers the preflight for exactly the page origin, with credentials. Published in 0.2.0-rc.1 (not on npm yet); used by the phase 2 branch's pre-publish pack |
| R12 | **Scoped styles in host mode.** Scope the workbench's CSS rules and custom properties under its mount element. | `/workbench/` keeps the site's layout around the workbench; the global `:root`, `html, body`, and heading rules in `dist/styles.css` would restyle the site | Accepted October 3 for WHC-1 rev 0.3: with a boot block the mount carries `data-streamotter-workbench`, and a separate `dist/workbench-host.css` (named in the manifest) scopes every rule and custom property under it; native mode keeps `styles.css`. Published in 0.2.0-rc.1 (not on npm yet); used by the phase 2 branch |

Evidence the site expects from StreamOtter: a native synthetic-fixture test mounting the embed against the in-process service, and a packed-install check (F44, F46).

## Native failure handling (StreamOtter spec §§4–9)

| ID | Requirement | Why | State |
| --- | --- | --- | --- |
| R7 | Published `failureHandling` configuration and validator support, including `quarantine-hold`, `quarantine-resync` with `sourceRecoveryRef`, transient retries, and the automatic-advance limit | Lab exercises S02–S07 and playground presets | Published in 0.2.0-rc.1 (not on npm yet): `failureHandling` in the validator, CLI and gateway |
| R8 | An in-process operator API (list/show incidents, retry-current, reassess, evaluate, redrive, reopen-circuit, export) with structured result codes | The bench's private operation adapter (LC11-ADR-03) | Published in 0.2.0-rc.1 (not on npm yet) as `streamotter/gateway/operator` |
| R9 | Recovery guard and snapshot acknowledgment types | LC11-ADR-01's binding | Published in 0.2.0-rc.1 (not on npm yet) |
| R10 | Failures operations through the R1/R4 seam, gated by capability | Workbench Failures view in the sandbox | In StreamOtter draft PR #17 (October 3): the tab appears when discovery lists `failures.list`; `failures.list`, `failures.show` and `operator.status` show it, action operations are optional, and the routes exist only when the gateway has `failureHandling`. Published in 0.2.0-rc.1's workbench (not on npm yet); the sandbox doesn't offer Failures operations (LC11-ADR-04, open question 1) |

## How a release is adopted

1. Pin the exact version in both apps and the lockfile.
2. Review the changed public surfaces and the seam contract; regenerate types and examples.
3. Re-verify the Lab threat model's §10.2 against the new published source and rerun S1–S6 (Lab contract R4).
4. Enable only the features whose capability gates pass, and record the package identity in STATUS.md and on `/releases/`.
