# V1.5 companion: Source failures in the Failure Lab (proposal)

**Status:** proposed, revision 0.1 (September 28, 2026). Not scheduled. It starts after the site launches and after StreamOtter publishes a release that implements V1.5.

This proposal adds a "Source failures" track inside the existing Failure Lab. The track demonstrates StreamOtter V1.5's quarantine, guarded recovery and single-record redrive. It adds no new top-level page.

| Document | What it is |
| --- | --- |
| [LONTRA_CREEK_V1_5_COMPANION_PLAN.md](./LONTRA_CREEK_V1_5_COMPANION_PLAN.md) | Product decisions, page changes, scenarios, architecture, safety and release plan |
| [LONTRA_CREEK_V1_5_ACCEPTANCE_PLAN.md](./LONTRA_CREEK_V1_5_ACCEPTANCE_PLAN.md) | Scenario families LC15-A01 to A40 and the evidence manifest |
| [LONTRA_CREEK_V1_5_HANDOFF.md](./LONTRA_CREEK_V1_5_HANDOFF.md) | Implementation instructions, file map and sequencing |

The native behavior is governed by StreamOtter's approved [V1.5 specification](https://github.com/jfricano/StreamOtter/tree/main/docs/releases/v1.5). Its ADRs made decisions after this companion was written, and they win where the two differ. In particular:

- Redrive re-evaluates the stored record and admits it through the normal revision filter. It doesn't force every subscriber to resynchronize (ADR-15C §5). Scenarios that expect a resynchronization flicker on redrive need adjusting.
- Recovery boundaries retire per source: by generation change (the default), by an application `retire()` handler, or by an operator command (ADR-15B §4). The Lab's coverage-ledger guard maps naturally to `application` mode.
- Health probes, the operator socket and the state directory are `streamotter start` options, not project configuration (ADR-15C §2).

This site keeps consuming only published `streamotter` versions. Nothing here is built against unreleased library code.
