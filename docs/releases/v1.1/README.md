# Lontra Creek V1.1 site and demo plan

**Owner amendment:** October 1, 2026; reconciled with main October 2. V1.1 replaces the former V1.5 milestone label. **State, October 5:** the sandbox and the new failure scenarios are built on the phase 2 branch, which pins StreamOtter 0.2.0-rc.1 from npm (published October 5), and run under `npm run dev:lab`; nothing is deployed. See the [release notes](#release-notes) and [STATUS.md](STATUS.md).

Keep the eight existing routes and six-chapter walkthrough. Add Source failures inside `/lab/`. Replace the existing `/workbench/` screenshot/recorded tour with the actual published workbench UI in an isolated synthetic visitor sandbox. Do not add a page or navigation item. Preserve `/playground/` as the quick configuration validator.

Visitors explicitly allocate a bounded session, then Connect, Define, validate, Preview, Inspect, and Export supported synthetic material. Lontra Creek owns restricted candidate edits, synthetic bindings, visitor isolation, leases/reset/expiry cleanup, capacity limits, hosting, and site acceptance. Production management, native credentials, arbitrary code/broker/offset/file operations, and protected evidence remain private. Recordings are an honest unavailable fallback.

Start with the creek's `station` channel alongside the pinned `streamotter init` example's `jobProgress`, a synthetic Kafka record beside the state it becomes, and an **In your app** explanation of the transferable pattern.

## Release notes

V1.1 reaches the site in two phases ([rollout plan](../0.2.0-rc.1/ROLLOUT_PLAN.md)). Each is activated on the shared host and accepted before the website is deployed, and every merge, publication and deployment waits for Jason's go.

**Phase 1: #40 and #41, on `streamotter@0.1.0-rc.3`.**

- The Failure Lab's Source failures track, with the scenario catalog, deep links, the capability summary, and an incident panel bound to typed projections. On rc.3 every new story is listed with the reason it can't run; Fouled sensor runs as before.
- Persistent Lab studies with a coverage ledger, restart versus reset (LC11-ADR-01, ADR-02), and the October 2 review's Lab fixes.
- The `/workbench/` page shell with honest unavailable states and labeled screenshots; the sandbox session service, not yet connected to a runtime.
- `/when-it-breaks/`, `/releases/` and the home page separate the site's release, the library package, what the demo runs, and the verified boundary.
- `npm run dev:lab` runs the real three-bench Lab locally; least-privilege Kafka ACLs locally and in CI (LC11-ADR-03).
- The domain is streamotter.dev, with the demo backend at demo.streamotter.dev (#41).

**Phase 2: the pin PR ([#42](https://github.com/jfricano/lontra-creek/pull/42), draft), on `streamotter@0.2.0-rc.1`.** Built from `feat/v1.1-source-failure-exercises`, which pins 0.2.0-rc.1 from npm:

- The pages describe 0.2.0-rc.1, including its opt-in source-failure policies, and the playground gains failure-policy presets checked by the installed validator (LC11-A34).
- `/workbench/` mounts the published `@streamotter/workbench` through WHC-1, served from the site's own origin with SRI, under the workbench's content security policy and a Pages `_headers` policy that forbids framing. A `sandbox` service (`deploy/compose.sandbox.yaml`, `SANDBOX_SERVICE_TOKEN`) gives each visitor an isolated synthetic slot ([sandbox contract](../../contracts/sandbox-api.md), LC11-ADR-04).
- The source-failure exercises S01–S09 on `/lab/`: intents, operations and the incident projection (Lab contract §12). See [SOURCE_FAILURE_EXERCISES.md](SOURCE_FAILURE_EXERCISES.md).
- A release-pin guard (`scripts/check-release-pins.mjs`) keeps the image and site workflows from building StreamOtter from anywhere but the npm registry.

**Published October 5, 2026:** 0.2.0-rc.1 is on npm, so `npm install streamotter@0.2.0-rc.1` works, and the GitHub tag `v0.2.0-rc.1` and the npm pages the site links to exist. The pin PR now builds from the registry, and its real-Kafka evidence and recordings were retaken from the registry install the same day.

**Only after deployment:** anything on https://streamotter.dev or demo.streamotter.dev. **Not in either hosted phase:** the Lab benches and the workbench sandbox. Both stay off and read as unavailable until Jason approves enabling them, each with its own acceptance; the hosted broker keeps `KAFKA_AUTHORIZATION` at `none` until the separate, owner-approved authorization migration.

## Read in order

1. [Companion plan](LONTRA_CREEK_V1_1_COMPANION_PLAN.md), revision 0.4.
2. [Acceptance plan](LONTRA_CREEK_V1_1_ACCEPTANCE_PLAN.md): LC11-A01–A46, including six sandbox families.
3. [Implementation handoff](LONTRA_CREEK_V1_1_HANDOFF.md).

## Implementation records

- [Implementation plan and work breakdown](IMPLEMENTATION_PLAN.md): the pull-request sequence, branching, team, and gates.
- [Status](STATUS.md): the live tracker of slices, gates, and acceptance evidence.
- [Slice A baseline](BASELINE.md): compatibility and exposure review of the current `main`.
- Decisions: [LC11-ADR-01 coverage ledger and guard](decisions/LC11-ADR-01-coverage-ledger-and-guard.md), [LC11-ADR-02 restart and reset](decisions/LC11-ADR-02-study-restart-and-reset.md), [LC11-ADR-03 private operations and Kafka authority](decisions/LC11-ADR-03-private-operations-and-kafka-authority.md), [LC11-ADR-04 workbench sandbox](decisions/LC11-ADR-04-workbench-sandbox-architecture.md).
- [Independent review of the combined slices](REVIEW_FINDINGS.md): findings and fixes, October 4, 2026.
- [Release handoff](RELEASE_HANDOFF.md): StreamOtter version consumed, unfinished integrations, server changes, acceptance checks and rollback.
- [Rollout plan](../0.2.0-rc.1/ROLLOUT_PLAN.md): the two phases on the shared host, acceptance and rollback. It wins where other documents disagree.
- [Source failure exercises](SOURCE_FAILURE_EXERCISES.md): what they are, how to run them locally, the hosted profile, the evidence, and the switch from the pre-publish packages to npm.
- [Requirements on published StreamOtter packages](UPSTREAM_REQUIREMENTS.md).
- [Workbench sandbox API contract](../../contracts/sandbox-api.md) (draft 0.3).

## Separate ownership and release gates

[StreamOtter](https://github.com/jfricano/StreamOtter/tree/3c0443efcab3053111e997e4aeb7c12ede02edaf/docs/releases/v1.1) owns native failure handling, F01–F48, the approved specification/ADRs, and the published workbench frontend/integration contract. Lontra Creek consumes an exact published npm release; missing support remains an upstream dependency, not permission to link sibling runtime source or emulate native success.

Native links pin the reviewed planning revision rather than an unmerged `main` path, so either documentation PR can merge first. [StreamOtter PR #9](https://github.com/jfricano/StreamOtter/pull/9) tracks that plan; its canonical folder is `docs/releases/v1.1/`.

Library publication and site deployment have independent acceptance and release decisions. [Site plan](../../PLAN.md), [Lab contract](../../contracts/lab-api.md), and the deployment records retain their authority. Historical reviews and unchanged shipped routes are baselines, not new implementation claims.

Matching V1.1 labels do not require matching versions or dates. The actual sandbox depends on a published frontend/integration seam; the source-failure exercises depend on their published native APIs. A compatible earlier library release satisfies the applicable capability gate. Copy, generalization examples, layout, and session/adapter design can proceed independently, but an unavailable sandbox is not completed sandbox acceptance. The library validates its seam with native fixtures and a clean package install; it does not wait for LC11 hosted checks. See the [capability prerequisites](LONTRA_CREEK_V1_1_COMPANION_PLAN.md#independent-milestones-specific-capability-prerequisites).

### Native decisions retained from main

The [approved native specification](https://github.com/jfricano/StreamOtter/tree/3c0443efcab3053111e997e4aeb7c12ede02edaf/docs/releases/v1.1) and ADR-15A/B/C remain authoritative. The October 2 reconciliation preserves main's later decisions instead of reverting to the original September 28 draft. ADR IDs retain their names; historical LC15-A01–A40 families map one-to-one to LC11-A01–A40, with sandbox families A41–A46 added.

- Stored redrive re-evaluates the original and admits it at a record boundary through the normal revision filter. It does not force all live views to resynchronize (ADR-15C §5); guarded continuation still obeys recovery barriers.
- Recovery boundaries retire per source by `generation` (default), `application`, or `operator` (ADR-15B §4). The Lab coverage ledger maps to `application`; the demo cannot silently retire a boundary or expose an unsafe override.
- Health, state-directory, and operator-socket settings are gateway/start options, not editable project configuration (ADR-15C §2). The public editor cannot change private deployment settings.
- Preserve the approved journal engine decision: usable Node 24 `node:sqlite`, otherwise `better-sqlite3` (ADR-15A §2). Native quarantine identity, byte format, durable handoff, and offset advancement remain library responsibilities.
