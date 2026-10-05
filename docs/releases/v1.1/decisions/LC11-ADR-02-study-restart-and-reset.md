# LC11-ADR-02 — Same-study restart versus disposable-study reset

Status: **Accepted for implementation** (October 3, 2026) · Slice: W5 · Companion plan §10 · Native: ADR-15A, ADR-15B §4

## Context

A bench's reset today stops the gateway, starts a new one with a fresh consumer group and `startFrom: "latest"`, deletes the old group, and clears the feed (Lab contract §8). The source generation is fixed at `lab-N-field-1`. That disposes of a V1 exercise correctly, but under V1.1 it would silently erase recovery obligations if used for a restart, and it reuses one generation across unrelated studies. Startup also treats a non-healthy source as failure, so a correctly restored hold would look like a broken bench.

## Decision

### Study identity

Every lease starts a **study**: `studyId` (random, URL-safe), source generation `lab-N-<studyId>`, consumer group `streamotter-lab-N-<studyId>`, a journal directory `…/lab-N/studies/<studyId>/` on the bench's volume, and the field station's ledger entries (LC11-ADR-01). The bench persists the current study descriptor (`study.json`) on its volume.

### Restart keeps the study

`gateway.restart`, a bench process restart, and a bench container restart with its volume intact all resume the **same** study: same group, generation, journal, and ledger. Unresolved holds and barriers survive. The page labels which kind of restart was actually run; a gateway restart in the same process is not evidence of process crash durability (LC11-A14 versus A15).

### Three readiness facts, not one

| Fact | Meaning | Used for |
| --- | --- | --- |
| **Control available** | Bench API and the private operator service answer | Explaining state to the leaseholder; Compose health |
| **Source ready** | The bench's source is consuming | The Lab's data-readiness display |
| **Clean-lease eligible** | No study is open and the last cleanup succeeded | Granting the next lease |

A restored, explainable hold is control-available and not source-ready. It does not fail startup, trigger a restart loop, or end the lease (LC11-A33).

### Reset discards the study

Reset, on return, expiry, idle, or an incompatible scenario change, runs in order:

1. Invalidate the lease, its tokens, and any plan or operation tokens immediately.
2. Revoke the lease's subject on the gateway.
3. Gate the publisher: the field station refuses scenario publication for the old `studyId` before reset continues.
4. Quiesce pending work with a bounded wait. Late callbacks check `studyId` and are confined to the old study's record.
5. Finalize a bounded metadata summary of the old study (no payloads).
6. Stop the gateway; delete the old consumer group; remove the old journal directory and ledger entries after the summary.
7. Provision a new study identity, generation, group, and journal, and start the gateway.

Completed writes from the old study are recorded honestly in its summary, never described as not having happened. The page calls this **Study discarded**, never repair.

### Cleanup failure keeps the bench out of service

If any step fails, the bench reports `failed` and is not clean-lease eligible. The field station retries the reset on its existing 30-second schedule. A partially cleaned bench is never handed to a visitor.

### Topics

Bench source topics (`lab-N.*`) are copies the field station publishes. They are reused across studies because each new study has a new generation and group that starts after the publisher gate, so no old-study scenario record can enter the new study. Quarantine topics are per bench (`lab-N.quarantine`) with short retention, labeled as demo cleanup rather than the library's retention guarantee. Topic and group creation stay server-side and bounded (LC11-ADR-03).

## Consequences

- A lease may now end while its source is held; the next visitor still gets a clean study because reset rotates identity.
- The field station restart behavior is unchanged: leases live in memory, so on startup it resets every bench, which discards every open study (`lab-restarted`).
- Lab contract §8's reset steps and `BenchStatus` change; W5 amends the contract and `contract.ts` together.

## Alternatives considered

- **Keep the fixed generation and rely on a fresh group.** Rejected: boundary retirement in `generation` mode (ADR-15B §4) needs the generation to change; a fixed one would carry old obligations into a new visitor's study.
- **Rotate topics per study.** Rejected for now: unbounded topic churn on the broker, and unnecessary given the publisher gate and new group.
