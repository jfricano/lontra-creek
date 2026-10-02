# Lontra Creek V1.1 — Acceptance plan

**Owner amendment - October 1, 2026:** The next planned milestone is V1.1. Lontra Creek will replace the existing `/workbench/` page with an interactive workbench sandbox, without adding a page or navigation item. This planning amendment does not change the installed npm version or establish implementation, test, or deployment completion.

**Date:** September 28, 2026 · **Revision:** 0.4 · **Status:** proposed scenario families, not executed tests.\
**Companion:** `LONTRA_CREEK_V1_1_COMPANION_PLAN.md`.\
**Site baseline:** `2397e2cbdfa3a32dda69920583ed9d18881ab863`.\
**Native authority:** supplied StreamOtter V1.1 approved specification revision 1.0 plus ADR-15A/B/C and the owner amendment and F01–F48 acceptance plan.

**Native decision alignment:** Read the [retained ADR decisions](README.md#native-decisions-retained-from-main) before implementing or testing. They govern over the original supplied draft. Historical LC15-A01–A40 families map one-to-one to LC11-A01–A40; A41–A46 add sandbox coverage.

## 1. Method and evidence levels

Keep static/UI tests, fixture tests, Kafka integration tests, process/volume tests, and hosted checks separate. Fixtures or recorded responses may test rendering but cannot establish that quarantine, source advancement, persistence, or guard enforcement works. Every executed case records its package/build, backend mode, inputs, independent expected result, observed state, and limits.

Reuse `npm test`, `npm run typecheck`, `npm run test:browser`, `npm run check:site`, the existing deploy Lab tests, and the amd64/arm64 stack workflows where appropriate. New command names below are implementation deliverables, not existing scripts. The reference configuration must install an exact published native package; a sibling checkout is not an integration substitute.

Maintain an independent test ledger of synthetic domain mutations, intended public views, source coordinates, quarantine incidents, and required recovery boundaries. Do not calculate expectations with the production mapper or guard being tested. Assert sequence and intermediate states, not just final convergence. Polling snapshots alone can miss a transient false `live`; collect SDK state events and relevant backend observations.

## 2. Required scenario families

The IDs identify **46 test families**, not the number of tests already written or run. Each may need several assertions or environments. F references below refer to the native package's acceptance plan; a demo check is not a replacement for a native-library test.

| ID | Case | Required result | Related native cases |
| --- | --- | --- | --- |
| LC11-A01 | Eight-route navigation and source-failure deep link | Existing routes remain reachable. Deep link selects explanatory content only; no lease, injection, or approval on page load. | — |
| LC11-A02 | Existing six-chapter walkthrough and live hero | Existing behavior remains accurate; no new poison effects reach the shared world. Optional Lab link works. | F01, F42 |
| LC11-A03 | Existing four Lab scenarios | Fouled sensor, relay outage, slow client, and ordinary restart retain their actual semantics; source outage is not a DLQ incident. | F01, F03, F09 |
| LC11-A04 | New static site with rc.3 or missing backend capability | New actions unavailable with an accurate reason. No calls to invented APIs and no simulated live success. | F02 |
| LC11-A05 | Main headline scenario classification | Source JSON, tenant, parameters, and revision are valid; downstream public payload validation fails in the intended native stage. | F04–F06 |
| LC11-A06 | Real malformed JSON quarantine-and-hold | Original complete bytes saved when acknowledged; exact original position remains held; affected source views stale. | F03, F10, F19 |
| LC11-A07 | Stored evaluation of malformed original | Decoding still fails. No hidden editing, replacement bytes, source advancement, or fabricated recovery. | F31, F36 |
| LC11-A08 | Quarantine acknowledgment visibility | Pending/unknown is not “saved.” Positive acknowledgment shown independently of source progress and browser recovery. | F12–F17 |
| LC11-A09 | Initial recovery refusal | Missing/lagging authoritative coverage keeps incident held after evidence capture; no override by an operator-looking demo button. | F20–F22 |
| LC11-A10 | Coverage prepared by application; reassessment | App's ledger substantiates coverage; native barrier is persisted before exact advancement; only matching snapshots can reach live. | F21–F22 |
| LC11-A11 | Same-source impact and independent workloads | All affected source views invalidated, not just LC-03. Shared creek and other benches remain isolated under the declared workload. | F05, F42 |
| LC11-A12 | New subscription after prior guarded exclusion | Required persistent boundary reaches newly created views and cannot be bypassed by reconnect/rejoin. | F23 |
| LC11-A13 | Two excluded changes | Second guard decision retains first obligation; different potentially affected entities are covered without guessed impact. | F24 |
| LC11-A14 | Same-study gateway restart | Same group/generation/journal/application ledger; hold/barrier survives. Connected control API can explain a held source. | F16–F18, F23 |
| LC11-A15 | Bench process/container restart with volume intact | Persisted state, rather than surviving JavaScript objects, supports recovery. Unknown outcomes remain unknown until reconciled. | F15–F18, F29 |
| LC11-A16 | Corrected mapper and dry-run | Original immutable evidence used; no delivery, topic write, offset seek/commit, or business effect. Effective provenance captured. | F31 |
| LC11-A17 | Exact-plan approval and superseded state | Native re-evaluation/admission at a record boundary through the normal revision filter (ADR-15C §5); no forced resynchronization solely for stored redrive. Original Kafka topic/group position unchanged. Old state never regresses current view. | F33–F34 |
| LC11-A18 | Stale/expired plan or changed mapping/evidence | Plan refused; re-evaluate and approve again. No accidental API fallback or force path. | F32, F36 |
| LC11-A19 | Lost response and repeated click | Stable request/operation ID; result lookup precedes any retry. Completed result reused; uncertain operation is not silently replayed. | F35 |
| LC11-A20 | Equal-revision conflict and other integrity failure | Source remains held. Quarantine configuration cannot permit force-skip; public exercise explains repair/reset distinction. | F06 |
| LC11-A21 | Explicit transient mapper retry | Installed trusted error class used; finite attempts and heartbeat behavior; success and exhausted-hold observed separately. | F07–F08 |
| LC11-A22 | Circuit breaker and duplicate envelopes | Distinct-incident threshold uses declared configuration; next incident holds. Duplicate writes do not count as distinct faults. | F26 |
| LC11-A23 | Quarantine or journal unavailable | No unsafe original-position advancement; control/read status remains useful; bounded attempts and explicit failure. | F12–F18 |
| LC11-A24 | Evidence expired/unavailable | Evaluation and later advancement do not use a made-up record or outdated saved flag. Availability labeled correctly. | F27–F28 |
| LC11-A25 | Scenario reset versus restart | Reset clearly discards synthetic study with new identity and quiesced old work; restart preserves existing obligations. Neither silently clears a live incident. | F29–F30, F48 |
| LC11-A26 | Lease expiry/return during write, guard, evaluation, or redrive | Immediate authority invalidation; late results confined to old run; no action or data enters next lease. Recorded completed writes remain honest. | F18, F25, F35 |
| LC11-A27 | Long operation with other visitors waiting | Heartbeats, status, queue fairness, and return/reset remain responsive; no shared coordinator lock held across slow I/O. | F06, F41–F42 |
| LC11-A28 | Cross-lease IDs, cursors, plans, tokens, and injected bodies | No protected access or side effect. Server selects bench/source/incident; arbitrary topics, offsets, code, files, or raw payload edits refused. | F36–F38 |
| LC11-A29 | Private surfaces and new Kafka write permissions | Management/operator/journal not public. A bench cannot read/write another bench, shared creek, holts, or notebooks; hosted gate has real ACL/containment evidence. | F37–F39 |
| LC11-A30 | Trace gap and incident-summary recovery | Gap is visible; bounded summary states what is known now without reconstructing missing steps. Mapper-returned annotation not treated as commit proof. | F44 |
| LC11-A31 | Synthetic record view and reproduction download | Only current-run synthetic fixture/metadata; text-safe rendering; no credential, host-path, protected payload, or other-lease exposure. | F39–F40 |
| LC11-A32 | Journal/topic/pool capacity and repeated resets | Bounded total resources, confirmed cleanup, no unlimited group/topic growth. Failed cleanup keeps bench unavailable. | F11, F41 |
| LC11-A33 | Process health, source readiness, and pool eligibility | Deliberate hold does not kill control liveness or trigger a restart loop. Clean-new-lease eligibility remains separate. Port configuration does not collide. | F43 |
| LC11-A34 | Playground presets and negative cases | Published validator used; unknown/missing/forbidden settings rejected as supported. No network/handler execution, live edits, or copied validator semantics. | F02, F46 |
| LC11-A35 | Workbench workflow, fallback captures, transcripts, and CLI samples | Actual published UI is the primary experience; supported Failures flow is exercised on the isolated synthetic runtime. Fallback assets retain individual release/mode provenance; samples tested against installed package. | F44, F46 |
| LC11-A36 | Keyboard, screen reader, themes, narrow screens | Focus stable through polling/approval; state conveyed beyond color; controlled announcements; all supported browser-engine checks recorded. | F45 |
| LC11-A37 | Unavailable Lab, queue full, idle, bfcache, and session expiry | Accurate notices and revalidation; no auto-approval/hidden lease extension; fallback labeled as recorded or static. | F25, F44 |
| LC11-A38 | Local launcher and clean published-package install | Documented fixture/Kafka/Lab distinctions hold; launcher is local, persistent on stop, non-destructive by default, and never imports sibling source. | F46 |
| LC11-A39 | Same-origin/private-host deployment and rollback | Actual ingress/private service boundaries, persistent volumes, TLS, lease cleanup, and compatible rollback verified before hosted release. | F38, F46, F48 |
| LC11-A40 | Claim-to-evidence and release crosswalk | Site/library versions, capability prerequisites, scenario availability, local/hosted status, exclusions, known limits, and unverified cases agree across pages. Independent milestones and release decisions are recorded; matching V1.1 labels are not a dependency. An unavailable mandatory feature does not count as completed site V1.1. | F43–F48 |
| LC11-A41 | Actual sandbox UI, transferable examples, unchanged route | `/workbench/` serves the actual frontend from a pinned published package with the supported integration seam; no new page/navigation item. Connect, Define, validate, Preview, Inspect, and Export run in the visitor's synthetic session. Open with `station` alongside the pinned `init` example's `jobProgress`, a synthetic Kafka record beside its actual mapped state, and an In your app note. No lookalike or recorded primary experience. | F44, F46 |
| LC11-A42 | Visitor isolation and stale session references | Two concurrent visitors cannot read or change each other's candidates, runtime state, traces, incidents, plans, or exports. Expired/reset/run-mismatched requests and late callbacks have no authority over a new study. | F36–F40 |
| LC11-A43 | Restricted editor and private management boundary | Allowlisted candidate settings validate with the real published validator. Server-owned source/topic/handler/credential bindings cannot be overridden; no uploaded code, arbitrary Kafka/offset/file operations, production connections, native operator credentials, or generic management proxy. | F37–F39, F46 |
| LC11-A44 | Sandbox lifetime, cleanup, queue, and cohost budget | Explicit allocation, reset, return, timeout, expiry, and reuse are tested. Bounded resources and fair admission protect other sessions, Lab benches, and the shared creek. Failed cleanup prevents reuse; same-study restart preserves obligations. | F25, F29–F30, F41–F43 |
| LC11-A45 | Safe downloads and mode/version truth | Only current-session sanitized candidate/configuration, trace, or reproduction material is downloadable. Secrets, host paths, other sessions, and production payloads are absent; fixture versus real-Kafka claims and fallback provenance are accurate. | F39–F40, F44, F46 |
| LC11-A46 | Sandbox deployed-origin behavior and unavailable states | Actual UI/session adapter works through the intended HTTPS origin in Chromium, Firefox, and WebKit, with keyboard/screen-reader access. Pool full, service unavailable, navigation/reload, bfcache, and expiry stay honest without auto-allocation or approval. Native production transport remains private. | F38, F44–F46 |

## 3. Test environments and claims

**Fixture/UI environment:** Can exercise disabled/unavailable states, scenario selection, trace layouts, approval dialogs with explicit fixtures, and reference material. It cannot substantiate native source disposition or durable recovery.

**Real-Kafka local/container environment:** Required for new source-failure paths. Verify quarantine topic contents and original group progress with an independent observer where permitted. Test journal persistence with a genuine process/container restart and unchanged volume. A single broker does not establish tolerance of broker loss.

**Workbench sandbox integration:** In addition to fixture-rendering checks, install the exact published frontend/runtime and exercise real validation, preview, inspection, and export on isolated synthetic sessions. Record UI/runtime package identity and adapter contract. Run LC11-A41–A46 locally and on hosted staging; fixture-backed behavior cannot establish Kafka durability.

**Hosted staging:** Required before public launch. Exercise all three benches concurrently, another ordinary visitor on the shared creek, resource ceilings, wrong-lease requests, newly granted leases after fault/reset, and actual reverse-proxy restrictions. Verify the expanded Kafka permissions. Do not transfer local timing claims to the host.

**Native-library evidence:** Retain references to the library's replicated-broker/durability results where applicable. Do not recreate the full native F01–F48 suite in the marketing site or imply that a public demonstration is a security audit.

## 4. Measurements

Record time to get a bench, complete the main journey, correctly identify a failure, obtain acknowledged evidence, complete guarded continuation, and observe synchronization. Distinguish action request/acceptance time, server event time, and browser observation time. Record failures, timeouts, trace gaps, duplicated evidence, background-tab behavior, cleanup time, journal/topic growth, and impact on unaffected workloads.

Suggested user-experience target: complete the ordinary S03 path within a five-minute lease, preferably two to three minutes after allocation. Treat this as a design target until timed. Define resource and latency thresholds before test runs; do not choose them afterward from a favorable result.

## 5. Evidence manifest

```yaml
companion_milestone: Lontra Creek V1.1
status: proposed
plan_revision: '0.4'
site_commit: null
native_package_versions: {}
required_native_capabilities_and_available_versions: {}
site_and_library_release_dispositions: {}
native_spec_revision: '1.0'
owner_amendment: '2026-10-01; reconciled 2026-10-02'
mode: null # fixture-ui | real-kafka-local | container-ci | hosted-staging
host_node_browser_architecture: {}
config_and_handler_fingerprints: {}
topic_acl_retention_settings: {}
journal_and_application_ledger_settings: {}
lease_and_pool_limits: {}
workbench_ui_package_and_adapter: {}
sandbox_session_configuration_and_limits: {}
sandbox_isolation_cleanup_and_exports: {}
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
