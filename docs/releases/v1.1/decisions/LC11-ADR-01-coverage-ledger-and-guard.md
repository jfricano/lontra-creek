# LC11-ADR-01 — Application coverage ledger and recovery guard

Status: **Accepted for implementation** (October 3, 2026) · Slice: W5 (app side), W9b (native binding) · Companion plan §8 · Native: StreamOtter V1.1 §7, ADR-15B

## Context

StreamOtter V1.1's `quarantine-resync` policy lets a source continue past a quarantined record only when an application-owned **recovery guard** attests that the authoritative snapshot system can supersede the excluded input for every potentially affected current or future channel instance. The gateway persists a cumulative **recovery boundary**; every later snapshot for that source must explicitly acknowledge it before a view can be `live` (native spec §7.2). The application, not StreamOtter, is responsible for the truth of that attestation.

In Lontra Creek, the field station is the only application writer and already serves each bench's snapshots from a restricted, per-bench endpoint (`/lab-internal/N/views/…`, Lab contract §8). The simulation updates authoritative state before publishing, with monotonically advancing revisions. That is a foundation, not an implementation of the barrier: today nothing records which mutation a bad record carried, and snapshots never see a boundary.

## Decision

1. **The field station keeps an application scenario ledger per bench study**, separate from any library journal. It is persisted under the field station's state directory, keyed by study ID (LC11-ADR-02), and holds for each scenario run:
   - the scenario ID and run ID,
   - the predetermined domain mutation the scenario publishes (for example an LC-03 reading at a stated simulation tick),
   - the set of **potentially affected channel instances**, derived by the simulation's own view derivation from that mutation (station `LC-03`, its reach, `creekOverview`), never from the record bytes,
   - the authoritative **watermark** (simulation tick and per-instance revision) at which the mutation is reflected in snapshot state,
   - the publication coordinates once known (topic, partition, offset),
   - a coverage status: `withheld`, `pending`, or `established`.
2. **The guard is answered by the ledger.** The bench's `sourceRecovery` handler forwards the incident context to a private field station endpoint (`POST /lab-internal/N/recovery/assess`, bench N's own service token). The answer is `hold` unless the ledger shows coverage `established` for every affected instance at a watermark at or past the mutation. A recoverable answer returns an opaque, bounded barrier that is the **cumulative** maximum of every unresolved obligation in the study, so a second incident never drops the first one's requirement, and an evidence reference naming the ledger entries.
3. **Snapshots acknowledge only what they satisfy.** The bench's snapshot handler passes the required boundary context to the field station. The snapshot endpoint acknowledges the boundary only when the state it is serving is at or past the barrier's watermark for that study. A lagging or deliberately withheld snapshot returns state without the acknowledgment, so the native barrier keeps the view out of `live`.
4. **Withheld coverage is a labeled teaching state.** For S03 the scenario starts with coverage `withheld`, shown as **Snapshot coverage not ready**. The `scenario.prepare-coverage` intent releases the predetermined authoritative update and marks coverage `established`. This is a bench-only negative condition. It does not fake a Kafka outage, edit browser state, or change the normal write-before-publish rule for the shared creek.
5. **Unrelated publication stays deterministic and bounded** during a study, so a background tick cannot erase the teaching moment before the visitor observes it.
6. **The app-side code is written against an internal interface** (`CoverageLedger`, `RecoveryAssessor`, `SnapshotAcknowledger`). Binding to the native guard and acknowledgment types is a thin adapter added only when a published release exports them (W9b). No intent or field name here is assumed to be a native API name.

## Tests

- Unit: guard returns `hold` while coverage is `withheld` or `pending`; `established` yields a barrier covering every affected instance; a second incident keeps the first obligation; a snapshot behind the barrier, with a missing acknowledgment, or with a wrong one never acknowledges.
- An **independent expected-state ledger** in the tests computes what each view should show, so assertions do not reuse the implementation's own derivation.
- Native integration (W9b): LC11-A09, A10, A12, A13 against a real Kafka bench.

## Consequences

- The field station's internal API grows a small, bench-scoped recovery surface, authenticated with each bench's own token. It never serves notebooks or holts, matching M11.
- The ledger outlives a gateway restart and a bench container restart within a study, and is discarded with the study (LC11-ADR-02).
- The reference page must say plainly that an integrator's guard is only as true as their own ledger.

## Alternatives considered

- **Derive affected instances from the quarantined record.** Rejected: the native spec forbids trusting bytes that may conceal the entity.
- **Guard always recoverable for LC-03 only.** Rejected: assumes impact instead of establishing it, and teaches the wrong pattern.
- **Keep the ledger in the bench.** Rejected: the field station owns authoritative state and publication; a bench-side ledger would duplicate it and could disagree.
