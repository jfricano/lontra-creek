# Lontra Creek V1.5 — Implementation handoff

**Date:** September 28, 2026 · **Revision:** 0.1 · Proposed implementation brief  
**Read with:** `LONTRA_CREEK_V1_5_COMPANION_PLAN.md` and `LONTRA_CREEK_V1_5_ACCEPTANCE_PLAN.md`.

## Product decisions to preserve

Keep the current eight-route site. Put Source failures inside `/lab/`, linkable without creating a new top-level page. Keep the six-chapter walkthrough and shared live creek intact. Use native StreamOtter failure handling, not Kafka-Penguin or a demo implementation of the proposed library APIs. This package supplements the native V1.5 package and final Future Strategy package; neither is superseded.

The site's review baseline is `2397e2cbdfa3a32dda69920583ed9d18881ab863`. The observed native dependency is `0.1.0-rc.3`, which must not be advertised as implementing the proposed V1.5 additions. Reconcile unpushed/local work and new commits before modifying anything. The owner's local approved design review is not included in the research baseline; preserve it.

## Copy-ready lead instruction

> Act as Lontra Creek's delivery lead for the V1.5 companion experience. Read the current site plan, deployment and working records, Lab contract, page implementations, and the supplied native StreamOtter V1.5 specification. Compare the current branch to the inspected baseline and reconcile later decisions rather than overwriting them.
>
> Implement a first-class Source failures track inside the existing Failure Lab. Keep queue/lease fairness, synthetic data, same-session bench selection, private management, holt/notebook exclusion, and the main creek's isolation. Preserve the existing four scenarios and upgrade Fouled sensor to use guarded incident-aware retry where applicable. Build the valid-JSON projection failure as the main quarantine/guard/recovery story; keep malformed JSON as a separate preserve-and-hold exercise.
>
> First establish three focused decisions: the application coverage ledger/guard; same-study restart versus disposable-study reset; and private operations plus Kafka topic/group permissions. Integrate one working quarantine-hold path before widening the scenario catalog. Use bounded parallel work after shared contracts are established, with one owner of bench lifecycle and incident state.
>
> Consume only an exact published StreamOtter release. Before it exists, build labeled static/UI fixtures and unavailable states, not simulated live successes. Map the final exported APIs; do not assume this plan's intent names are native function names. Do not import library internals, link a sibling checkout, or patch the runtime locally to manufacture demonstration results.
>
> Keep native classification, quarantine, offset progression, recovery barriers, and redrive authoritative. The demo may inject only predetermined synthetic records through its own constrained publisher, supply its application-owned guard, and project supported observations. It must not set a browser to live, infer successful commits from a mapper annotation, automatically replay uncertain operations, or publish stored originals back to business topics.
>
> Separate restart from reset. Same-study restart preserves journal, source generation, group, application coverage facts, and unresolved outcomes. Reset deliberately discards a synthetic study after quiescing old work; it creates a new identity and is never represented as incident repair. Prevent stale leases, tokens, plans, and callbacks from affecting a subsequent visitor. Keep control/read endpoints and lease heartbeats responsive during long operations.
>
> Complete LC15-A01–A40 with the required evidence levels. Extend the existing tests instead of replacing their results with new unexecuted counts. Verify real quarantine and source-progress facts against Kafka, and use an independent expected-state ledger. Public hosted actions require the new write-authority exposure review and real topic/group confinement evidence; separate SCRAM users alone are not enough.
>
> Update the failure reference, playground, real workbench captures, release metadata, docs links, and home/field-station cross-links. Preserve the visual design. Label asset versions/modes individually. A fixture recording cannot become a real-Kafka V1.5 recording just because the page's RELEASE constant changed.
>
> Deliver an integrated candidate, baseline-to-candidate change summary, completed decision records, evidence matrix, limits, local-run instructions, and a separate hosted-readiness disposition. Do not publish packages, push changes, deploy, change cloud accounts, or incur costs unless the implementation session separately authorizes those actions.

## Change map

Paths below were inspected unless described as proposed or a target to locate. Verify exact filenames and exports in the current checkout before editing.

| Area | Existing path / proposed artifact | Work |
| --- | --- | --- |
| Site authority | `docs/PLAN.md` | Add V1.5 companion link, route deltas, and explicit source-failure scope. Retain historical evidence. |
| API authority | `docs/contracts/lab-api.md` | Versioned additive demo intents, current-incident projection, operation status, capabilities, reset/restart and privacy rules. |
| Shared demo types | `apps/field-station/src/lab/contract.ts` | Align DTOs with contract; reject arbitrary operator arguments. |
| Bench configuration/handlers | `apps/field-station/src/lab/bench.ts` | Failure policies, private resources, pure mapping variants, coverage-aware snapshots, real native classification. |
| Bench lifecycle | `apps/field-station/src/lab/runtime.ts` | Private operator adapter, persistent study identity, asynchronous operations, replay-safe plans, startup-held handling, reset isolation. |
| Lease/feed integration | Existing `src/lab/leases.ts`, `feed.ts`, and server routing; inspect current implementations | Preserve FIFO/expiry; bounded incident projection and observations; no shared lock across slow I/O. |
| Application state/publication | Locate current field-station simulation publisher and bench snapshot handlers | Predetermined synthetic injections, durable coverage ledger, scoped private endpoint, independent test fixtures. |
| Lab UI | `apps/site/src/pages/lab.astro`, `apps/site/src/scripts/lab.ts` | Track/scenario selector, incident panel, approval/result workflow, deep-link behavior, accessible polling. |
| Failure reference | `apps/site/src/pages/when-it-breaks.astro`, `apps/site/src/release-facts.ts` | Record disposition versus SDK states; exact-release error facts and examples. |
| Product navigation | `apps/site/src/site.ts`, homepage and field-station page | Targeted links; update scenario counts; do not replace main narrative. |
| Workbench/Playground | Existing page files and their capture/snippet/data scripts; inspect before change | Real Failures recordings, versioned provenance, validator presets, checked CLI transcripts. |
| Local runner | `docs/LOCAL_LAB.md`; proposed `scripts/dev-lab.mjs` | Safe convenience wrapper; persist on stop; separate confirmed discard. |
| Deployment | Existing `deploy/compose.lab.yaml`, broker bootstrap, secrets, private ingress; inspect before change | Per-bench journals, quarantine ACLs, private operator exposure, safe health and cleanup. |
| Verification | Existing application, browser, `deploy/test/lab.test.ts`, and stack workflows | Add LC15 acceptance coverage with fixture/Kafka/host boundaries visible. |

## Five implementation slices

A. Baseline/capability/exposure review and shared contract. B. Quarantine-hold with real Kafka on one bench. C. Guard/barrier, honest continuation, and restart/reset. D. Evaluation/reprocessing, integrity/refusal, retry, and complete public source-failure track. E. Site-wide content/capture/preset updates, local launcher, concurrency/security/host evidence, and release review.

One maintainer may perform several roles. A separate verifier should challenge incident/source/view observations and expected-state logic. Escalate changed guarantees, public privileges, new services, operating costs, unplanned release dependencies, or a proposed reduction of required scope. Ordinary file organization and component refactoring are engineering decisions.

## Mandatory implementation cautions

The following are **observed baseline assumptions that need adaptation**, not claims of defects in the V1 product:

- Reset currently rotates the consumer group and starts at latest, while the source generation is fixed. This must not erase new persistent incident obligations during a same-study restart.
- Gateway startup currently treats a held source as a failure to become healthy. V1.5's control UI must be able to explain a correctly restored hold.
- Mapper `processed` annotations precede downstream acceptance/commit. They cannot supply the new disposition evidence.
- Default dev and dev:kafka do not start Lab benches. The source-build Compose recipe is the local real-Lab foundation.
- Old recorded assets interpolate a global package version. Reconcile capture provenance when upgrading.
- The current Lab threat model has an explicit topic-ACL risk. Adding quarantine writers requires a fresh, scoped permission review before hosted exposure.

## Suggested repository placement

```text
docs/releases/v1.5/
  LONTRA_CREEK_V1_5_COMPANION_PLAN.md
  LONTRA_CREEK_V1_5_ACCEPTANCE_PLAN.md
  LONTRA_CREEK_V1_5_HANDOFF.md
```

The PDF is a reading copy, not another mutable source of requirements. Keep links from the existing plan/contract and preserve native-library references rather than copying its specification into the site repository.
