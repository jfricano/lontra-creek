# Lontra Creek V1.5 — Acceptance plan

**Date:** September 28, 2026 · **Revision:** 0.1 · **Status:** proposed scenario families, not executed tests.  
**Companion:** `LONTRA_CREEK_V1_5_COMPANION_PLAN.md`.  
**Site baseline:** `2397e2cbdfa3a32dda69920583ed9d18881ab863`.  
**Native authority:** supplied StreamOtter V1.5 specification revision 0.1 and F01–F48 acceptance plan.

## 1. Method and evidence levels

Keep static/UI tests, fixture tests, Kafka integration tests, process/volume tests, and hosted checks separate. Fixtures or recorded responses may test rendering but cannot establish that quarantine, source advancement, persistence, or guard enforcement works. Every executed case records its package/build, backend mode, inputs, independent expected result, observed state, and limits.

Reuse `npm test`, `npm run typecheck`, `npm run test:browser`, `npm run check:site`, the existing deploy Lab tests, and the amd64/arm64 stack workflows where appropriate. New command names below are implementation deliverables, not existing scripts. The reference configuration must install an exact published native package; a sibling checkout is not an integration substitute.

Maintain an independent test ledger of synthetic domain mutations, intended public views, source coordinates, quarantine incidents, and required recovery boundaries. Do not calculate expectations with the production mapper or guard being tested. Assert sequence and intermediate states, not just final convergence. Polling snapshots alone can miss a transient false `live`; collect SDK state events and relevant backend observations.

## 2. Required scenario families

The IDs identify **40 test families**, not the number of tests already written or run. Each may need several assertions or environments. F references below refer to the native package's acceptance plan; a demo check is not a replacement for a native-library test.

| ID | Case | Required result | Related native cases |
| --- | --- | --- | --- |
| LC15-A01 | Eight-route navigation and source-failure deep link | Existing routes remain reachable. Deep link selects explanatory content only; no lease, injection, or approval on page load. | — |
| LC15-A02 | Existing six-chapter walkthrough and live hero | Existing behavior remains accurate; no new poison effects reach the shared world. Optional Lab link works. | F01, F42 |
| LC15-A03 | Existing four Lab scenarios | Fouled sensor, relay outage, slow client, and ordinary restart retain their actual semantics; source outage is not a DLQ incident. | F01, F03, F09 |
| LC15-A04 | New static site with rc.3 or missing backend capability | New actions unavailable with an accurate reason. No calls to invented APIs and no simulated live success. | F02 |
| LC15-A05 | Main headline scenario classification | Source JSON, tenant, parameters, and revision are valid; downstream public payload validation fails in the intended native stage. | F04–F06 |
| LC15-A06 | Real malformed JSON quarantine-and-hold | Original complete bytes saved when acknowledged; exact original position remains held; affected source views stale. | F03, F10, F19 |
| LC15-A07 | Stored evaluation of malformed original | Decoding still fails. No hidden editing, replacement bytes, source advancement, or fabricated recovery. | F31, F36 |
| LC15-A08 | Quarantine acknowledgment visibility | Pending/unknown is not “saved.” Positive acknowledgment shown independently of source progress and browser recovery. | F12–F17 |
| LC15-A09 | Initial recovery refusal | Missing/lagging authoritative coverage keeps incident held after evidence capture; no override by an operator-looking demo button. | F20–F22 |
| LC15-A10 | Coverage prepared by application; reassessment | App's ledger substantiates coverage; native barrier is persisted before exact advancement; only matching snapshots can reach live. | F21–F22 |
| LC15-A11 | Same-source impact and independent workloads | All affected source views invalidated, not just LC-03. Shared creek and other benches remain isolated under the declared workload. | F05, F42 |
| LC15-A12 | New subscription after prior guarded exclusion | Required persistent boundary reaches newly created views and cannot be bypassed by reconnect/rejoin. | F23 |
| LC15-A13 | Two excluded changes | Second guard decision retains first obligation; different potentially affected entities are covered without guessed impact. | F24 |
| LC15-A14 | Same-study gateway restart | Same group/generation/journal/application ledger; hold/barrier survives. Connected control API can explain a held source. | F16–F18, F23 |
| LC15-A15 | Bench process/container restart with volume intact | Persisted state, rather than surviving JavaScript objects, supports recovery. Unknown outcomes remain unknown until reconciled. | F15–F18, F29 |
| LC15-A16 | Corrected mapper and dry-run | Original immutable evidence used; no delivery, topic write, offset seek/commit, or business effect. Effective provenance captured. | F31 |
| LC15-A17 | Exact-plan approval and superseded state | Normal native reprocessing path; original Kafka topic untouched and group position unchanged by redrive. Old state never regresses current view. | F33–F34 |
| LC15-A18 | Stale/expired plan or changed mapping/evidence | Plan refused; re-evaluate and approve again. No accidental API fallback or force path. | F32, F36 |
| LC15-A19 | Lost response and repeated click | Stable request/operation ID; result lookup precedes any retry. Completed result reused; uncertain operation is not silently replayed. | F35 |
| LC15-A20 | Equal-revision conflict and other integrity failure | Source remains held. Quarantine configuration cannot permit force-skip; public exercise explains repair/reset distinction. | F06 |
| LC15-A21 | Explicit transient mapper retry | Installed trusted error class used; finite attempts and heartbeat behavior; success and exhausted-hold observed separately. | F07–F08 |
| LC15-A22 | Circuit breaker and duplicate envelopes | Distinct-incident threshold uses declared configuration; next incident holds. Duplicate writes do not count as distinct faults. | F26 |
| LC15-A23 | Quarantine or journal unavailable | No unsafe original-position advancement; control/read status remains useful; bounded attempts and explicit failure. | F12–F18 |
| LC15-A24 | Evidence expired/unavailable | Evaluation and later advancement do not use a made-up record or outdated saved flag. Availability labeled correctly. | F27–F28 |
| LC15-A25 | Scenario reset versus restart | Reset clearly discards synthetic study with new identity and quiesced old work; restart preserves existing obligations. Neither silently clears a live incident. | F29–F30, F48 |
| LC15-A26 | Lease expiry/return during write, guard, evaluation, or redrive | Immediate authority invalidation; late results confined to old run; no action or data enters next lease. Recorded completed writes remain honest. | F18, F25, F35 |
| LC15-A27 | Long operation with other visitors waiting | Heartbeats, status, queue fairness, and return/reset remain responsive; no shared coordinator lock held across slow I/O. | F06, F41–F42 |
| LC15-A28 | Cross-lease IDs, cursors, plans, tokens, and injected bodies | No protected access or side effect. Server selects bench/source/incident; arbitrary topics, offsets, code, files, or raw payload edits refused. | F36–F38 |
| LC15-A29 | Private surfaces and new Kafka write permissions | Management/operator/journal not public. A bench cannot read/write another bench, shared creek, holts, or notebooks; hosted gate has real ACL/containment evidence. | F37–F39 |
| LC15-A30 | Trace gap and incident-summary recovery | Gap is visible; bounded summary states what is known now without reconstructing missing steps. Mapper-returned annotation not treated as commit proof. | F44 |
| LC15-A31 | Synthetic record view and reproduction download | Only current-run synthetic fixture/metadata; text-safe rendering; no credential, host-path, protected payload, or other-lease exposure. | F39–F40 |
| LC15-A32 | Journal/topic/pool capacity and repeated resets | Bounded total resources, confirmed cleanup, no unlimited group/topic growth. Failed cleanup keeps bench unavailable. | F11, F41 |
| LC15-A33 | Process health, source readiness, and pool eligibility | Deliberate hold does not kill control liveness or trigger a restart loop. Clean-new-lease eligibility remains separate. Port configuration does not collide. | F43 |
| LC15-A34 | Playground presets and negative cases | Published validator used; unknown/missing/forbidden settings rejected as supported. No network/handler execution, live edits, or copied validator semantics. | F02, F46 |
| LC15-A35 | Workbench captures, transcripts, and CLI samples | Actual release and mode recorded per asset. Old footage not relabeled with new global version; samples tested against installed package. | F44, F46 |
| LC15-A36 | Keyboard, screen reader, themes, narrow screens | Focus stable through polling/approval; state conveyed beyond color; controlled announcements; all supported browser-engine checks recorded. | F45 |
| LC15-A37 | Unavailable Lab, queue full, idle, bfcache, and session expiry | Accurate notices and revalidation; no auto-approval/hidden lease extension; fallback labeled as recorded or static. | F25, F44 |
| LC15-A38 | Local launcher and clean published-package install | Documented fixture/Kafka/Lab distinctions hold; launcher is local, persistent on stop, non-destructive by default, and never imports sibling source. | F46 |
| LC15-A39 | Same-origin/private-host deployment and rollback | Actual ingress/private service boundaries, persistent volumes, TLS, lease cleanup, and compatible rollback verified before hosted release. | F38, F46, F48 |
| LC15-A40 | Claim-to-evidence and release crosswalk | Site/library versions, scenario availability, local/hosted status, exclusions, known limits, and remaining unverified cases agree across all pages. | F43–F48 |

## 3. Test environments and claims

**Fixture/UI environment:** Can exercise disabled/unavailable states, scenario selection, trace layouts, approval dialogs with explicit fixtures, and reference material. It cannot substantiate native source disposition or durable recovery.

**Real-Kafka local/container environment:** Required for new source-failure paths. Verify quarantine topic contents and original group progress with an independent observer where permitted. Test journal persistence with a genuine process/container restart and unchanged volume. A single broker does not establish tolerance of broker loss.

**Hosted staging:** Required before public launch. Exercise all three benches concurrently, another ordinary visitor on the shared creek, resource ceilings, wrong-lease requests, newly granted leases after fault/reset, and actual reverse-proxy restrictions. Verify the expanded Kafka permissions. Do not transfer local timing claims to the host.

**Native-library evidence:** Retain references to the library's replicated-broker/durability results where applicable. Do not recreate the full native F01–F48 suite in the marketing site or imply that a public demonstration is a security audit.

## 4. Measurements

Record time to get a bench, complete the main journey, correctly identify a failure, obtain acknowledged evidence, complete guarded continuation, and observe synchronization. Distinguish action request/acceptance time, server event time, and browser observation time. Record failures, timeouts, trace gaps, duplicated evidence, background-tab behavior, cleanup time, journal/topic growth, and impact on unaffected workloads.

Suggested user-experience target: complete the ordinary S03 path within a five-minute lease, preferably two to three minutes after allocation. Treat this as a design target until timed. Define resource and latency thresholds before test runs; do not choose them afterward from a favorable result.

## 5. Evidence manifest

```yaml
companion_milestone: Lontra Creek V1.5
status: proposed
plan_revision: '0.1'
site_commit: null
native_package_versions: {}
native_spec_revision: '0.1'
mode: null # fixture-ui | real-kafka-local | container-ci | hosted-staging
host_node_browser_architecture: {}
config_and_handler_fingerprints: {}
topic_acl_retention_settings: {}
journal_and_application_ledger_settings: {}
lease_and_pool_limits: {}
scenario_seed_and_generation: null
independent_expected_ledger: null
commands: []
scenario_results: []
raw_evidence_paths: []
recording_provenance: []
failed_runs: []
limits_and_unverified_conditions: []
independent_reviewer: null
owner_exceptions: []
```

No family is passed solely because its test file exists. Preserve failed runs, especially transient false-success or cross-lease exposure. A critical safety failure blocks the corresponding release even if the final screen converges correctly.
