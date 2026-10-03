# Lontra Creek V1.1 site and demo plan

**Owner amendment:** October 1, 2026; reconciled with main October 2. V1.1 replaces the former V1.5 milestone label. Planned scope; the sandbox and new failure scenarios are not implemented or deployed.

Keep the eight existing routes and six-chapter walkthrough. Add Source failures inside `/lab/`. Replace the existing `/workbench/` screenshot/recorded tour with the actual published workbench UI in an isolated synthetic visitor sandbox. Do not add a page or navigation item. Preserve `/playground/` as the quick configuration validator.

Visitors explicitly allocate a bounded session, then Connect, Define, validate, Preview, Inspect, and Export supported synthetic material. Lontra Creek owns restricted candidate edits, synthetic bindings, visitor isolation, leases/reset/expiry cleanup, capacity limits, hosting, and site acceptance. Production management, native credentials, arbitrary code/broker/offset/file operations, and protected evidence remain private. Recordings are an honest unavailable fallback.

Start with the creek's `station` channel alongside the pinned `streamotter init` example's `jobProgress`, a synthetic Kafka record beside the state it becomes, and an **In your app** explanation of the transferable pattern.

## Read in order

1. [Companion plan](LONTRA_CREEK_V1_1_COMPANION_PLAN.md), revision 0.4.
2. [Acceptance plan](LONTRA_CREEK_V1_1_ACCEPTANCE_PLAN.md): LC11-A01–A46, including six sandbox families.
3. [Implementation handoff](LONTRA_CREEK_V1_1_HANDOFF.md).

## Implementation records

- [Implementation plan and work breakdown](IMPLEMENTATION_PLAN.md): the pull-request sequence, branching, team, and gates.
- [Status](STATUS.md): the live tracker of slices, gates, and acceptance evidence.
- [Slice A baseline](BASELINE.md): compatibility and exposure review of the current `main`.
- Decisions: [LC11-ADR-01 coverage ledger and guard](decisions/LC11-ADR-01-coverage-ledger-and-guard.md), [LC11-ADR-02 restart and reset](decisions/LC11-ADR-02-study-restart-and-reset.md), [LC11-ADR-03 private operations and Kafka authority](decisions/LC11-ADR-03-private-operations-and-kafka-authority.md), [LC11-ADR-04 workbench sandbox](decisions/LC11-ADR-04-workbench-sandbox-architecture.md).
- [Requirements on published StreamOtter packages](UPSTREAM_REQUIREMENTS.md).
- [Workbench sandbox API contract](../../contracts/sandbox-api.md) (draft).

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
