# Lontra Creek V1.5
## See the failure. Preserve the evidence. Verify the recovery.

**Companion product, demo, and delivery plan**  
Prepared for Jason Fricano / Orca Solutions · September 28, 2026  
Revision 0.1 · Proposed plan; not implemented, tested, or approved for public deployment

**Site baseline:** `jfricano/lontra-creek@2397e2cbdfa3a32dda69920583ed9d18881ab863`.  
**Library installed by that site:** `streamotter@0.1.0-rc.3`.  
**Target behavior:** the supplied *StreamOtter V1.5 — Contain, explain, recover*, specification revision 0.1. The V1.5 milestone is not an assertion that an npm package named `1.5.0` exists. [LC12, SO15]

> Keep the existing site and its eight principal routes. Make source-failure handling a first-class, linkable track inside the Failure Lab. Update the surrounding explanations, configuration examples, and recorded workbench tour. Do not create a second live demo application or a public production-remediation console.

## 1. Decision and product boundary

**A new top-level page is not needed for V1.5.** The existing `/lab/` already answers “What happens when it breaks?”, allocates isolated benches, and demonstrates a mapper failure at LC-03. That is the correct starting point. Add a prominent **Source failures** track at `/lab/#source-failures`, with an optional scenario query parameter for direct links. Preserve `/lab/` and the existing navigation. [LC02–LC04]

The extension should teach five distinctions: a processing defect versus a transport failure; preserving evidence versus advancing a source; advancing a source versus recovering a view; evaluating a record versus reprocessing it; and retrying an old state versus creating a new business event. These are the substance of the new library specification. [SO15 §§3–8]

Selecting a pause, hold, or guarded-recovery exercise chooses a server-owned policy preset at study initialization. A policy change that requires new configuration uses the documented stop/reconfigure/start lifecycle, not an invented hot-edit API. The playground cannot change that policy.

The visitor outcome is: **“I saw why the stream stopped, what was saved, why continuation was allowed or refused, and what the browser actually received.”** Developers should leave with a reproducible integration pattern, not merely a successful animation.

Use **Source failure handling**, **Quarantine**, and **Controlled reprocessing** in the interface. Kafka-Penguin can be acknowledged as inspiration in an engineering note, but the site must not imply that it is installed, endorsed, or providing StreamOtter's implementation. [SO15 §18]

### Proposed scope

| Area | V1.5 decision |
| --- | --- |
| Main live creek and six-chapter walkthrough | Preserve; add an optional next-step link to the new Lab track. Do not introduce destructive failures into the shared creek. |
| Failure Lab | Add a guided source-failure track, an incident detail panel, and bounded advanced exercises. Preserve the four existing scenarios. |
| Workbench tour | Add real, version-labeled captures of the new Failures view and recorded operator workflow. |
| Failure reference | Explain the new policy and incident lifecycle separately from existing browser subscription states. |
| Playground | Add release-validated policy presets; configuration editing still does not operate the hosted demo. |
| Home, docs, releases | Add focused discovery links and accurate capability/operating-boundary information. |
| Local development | Make fixture, real-Kafka walkthrough, and real-Kafka Lab modes unmistakable; add a convenience launcher around the existing Lab recipe. |
| Hosting | Preserve the bounded bench pool. Add protected journal storage, scoped quarantine resources, and verification of the new write authority. |

### Out of scope

No new top-level “Kafka-Penguin” product page; no arbitrary record editor, topic selector, uploaded handler, or broker connection form; no browser access to the real workbench or operator socket; no bulk/scheduled redrive; no V2 browser replay/checkpoints or multi-gateway product demo; no V3 business commands, shared administration, or new transport demonstration. Do not change the approved visual direction or expand the simulation into a new game.

## 2. What was actually reviewed

This plan is based on the checked-in page implementations, current Lab API contract, bench runtime and handlers, local-run instructions, site metadata, project plan, and implementation record at the commit above. The supplied library V1.5 specification, acceptance plan, and handoff were read in full. Source references appear in §15.

**Review limits:** The owner's Mac and its running dev server were not accessed. A container checkout attempt failed because GitHub DNS was unavailable in the execution environment; the GitHub connector supplied the source review instead. No site build, browser session, Kafka stack, or new acceptance test was executed for this plan. Unpushed local changes are not covered. Repository-reported verification remains reported evidence, not independently reproduced results.

### Existing behavior relevant to this release

The checked-in site is Astro and installs the library at an exact npm version. `/lab/` currently contains an LC-03 view, a four-scenario control panel, and a redacted trace feed. The bench contract provides three leased benches, one visitor per bench, a five-minute lease, private service credentials, and a loopback-only management interface. Holts and notebooks are excluded from the Lab. [LC01, LC03–LC06, LC12]

The four existing stories are **Fouled sensor**, **Flash flood takes the relay**, **Laptop on a satellite link**, and **Relay restart**. Fouled sensor is already a useful demonstration of pause-and-retry, but it is an arbitrary mapper exception—not proof of a malformed-record quarantine capability. [LC03–LC06]

| Existing run path | What the source says it runs | Consequence for this plan |
| --- | --- | --- |
| `npm run dev` | Fixture-driven field station and Astro site; no Kafka Lab benches. | Useful for layout, copy, reference pages, and clearly labeled fixture behavior. It cannot demonstrate durable Kafka quarantine. |
| `npm run dev:kafka` | Local Kafka walkthrough with persistent notebooks; no Failure Lab. | Keep its current purpose; do not describe it as the new Lab launcher. |
| `docs/LOCAL_LAB.md` recipe | Source-built, three-bench Kafka/Compose stack behind local HTTPS. | Extend this as the real local V1.5 demonstration path. |

The records say hosting is pending and identify unresolved public-exposure conditions. Some historical checkpoints refer to earlier commits or pending PRs. Reconcile them at implementation; do not overwrite their evidence or treat their old status prose as the current branch state. [LC01, LC07, LC08]

## 3. Information architecture and page-by-page changes

### Failure Lab: one page, two tracks

Keep `/lab/` as the entry point. Above the bench controls, introduce a compact chooser:

- **Connections and clients:** the existing relay cut, slow client, and restart exercises.
- **Source failures:** pause/retry, quarantine, guarded continuation, evaluation/reprocessing, and cases where the safe answer remains “hold.”

Retain Fouled sensor as the bridge between the old and new material. It can appear in both track indexes while remaining one scenario implementation. Do not duplicate the scenario or create competing controls.

Only one scenario is active on a bench at a time. A scenario link selects explanatory content; it must not borrow a bench, inject a record, or approve an operation automatically. A visitor explicitly chooses **Borrow a bench** and **Start this scenario**. On an existing lease, changing to an incompatible scenario requires a visible reset of the disposable study and invalidates old plans.

The main guided path should fit comfortably into one existing five-minute lease. Target approximately two to three minutes for the ordinary path, then measure it. Each advanced exercise is separately runnable; completing the whole catalog in one lease is not a requirement. Do not silently extend leases or increase the pool to accommodate a longer script.

### Change matrix

| Route | Required change | Keep unchanged |
| --- | --- | --- |
| `/` | Add one V1.5 feature panel and **Try source failures** link. Explain preservation, controlled continuation, and visible outcomes. | Shared live hero, installation flow, tagline/design decisions, and recorded/unavailable labeling. |
| `/field-station/` | Add an optional “Next: handle a bad reading” link after the walkthrough; show the installed demo version where appropriate. | Six chapters, researcher/volunteer boundary, notebook behavior, and shared world. No forced seventh chapter or poison injection. |
| `/lab/` | New track, scenario guidance, incident panel, guarded actions, and evidence summary. | Queue/lease fairness, direct SDK subscriptions, source-scoped failures, and other visitors' isolation. |
| `/when-it-breaks/` | Add a failure-policy matrix and record-disposition lifecycle; update state/error examples against the installed release. | Existing SDK state explanation; detailed internal causes are not invented browser states. |
| `/workbench/` | Add Failures captures, evaluation/approval sequence, metadata export, and a private CLI explanation. | Recorded tour rather than a remotely exposed workbench. |
| `/playground/` | Add legacy-pause, quarantine-hold, guarded-resync, and bounded-retry examples using the published validator. | Browser-local validation; no secrets, handler execution, Kafka connections, or live configuration changes. |
| `/docs/` | Link to exact-release source-failure guide, recovery-guard recipe, local Lab instructions, and operational runbook when those exist. | Documentation map rather than duplicated mutable library manuals. |
| `/releases/` | Separate site release, actual library package, demo availability, and verified operating boundary. | Accurate limitations, changelog links, and explicitly unverified combinations. |

Also update the page summaries in `apps/site/src/site.ts`, the homepage's scenario/feature copy, and tests that assert “four controlled failures.” The route count need not change. [LC03, LC09–LC12]

## 4. Scenario catalog and release coverage

**Required** means implemented and verified for this companion release. “Local/CI” is an intentional demonstration boundary, not a substitute for required public-track behavior. The public site is still a deployment candidate until its own launch gates pass.

| ID | Story | Delivery | What it establishes |
| --- | --- | --- | --- |
| LC15-S01 | **Fouled sensor: fix and retry** | Existing public scenario, updated | Default pause remains available; restore calibration, retry the exact held position, then observe fresh synchronization. |
| LC15-S02 | **Garbled reading: preserve and hold** | New public exercise | Real invalid JSON is captured in quarantine; source does not advance; malformed bytes do not become repairable merely because they were saved. |
| LC15-S03 | **Bad projection: recover from authoritative state** | New public headline path | Valid source JSON produces an invalid public payload; quarantine succeeds, a guard initially refuses continuation, and verified snapshot coverage later permits it. |
| LC15-S04 | **Inspect the old reading: evaluate, then reprocess** | New public continuation/standalone exercise | Dry-run has no delivery effect; exact approval permits gateway-local reprocessing; a newer snapshot can correctly supersede the old state. |
| LC15-S05 | **Conflicting readings: stopping is correct** | New public advanced exercise | Equal revision with conflicting state remains held. There is no force-skip path. |
| LC15-S06 | **Calibration lookup blip** | New public advanced exercise | Only a trusted, explicitly transient mapper error gets bounded retry. Success and exhausted retry are different outcomes. |
| LC15-S07 | **Too many bad readings** | Local/CI plus concise reference explanation | Five distinct permitted automatic continuations in the configured window; the next incident holds. Duplicate evidence does not count as extra incidents. |
| LC15-S08 | **Recovery across restart and a new subscription** | Extend Relay restart; local/CI assertions | Same journal/group/generation preserve recovery obligations; a new view cannot evade the barrier. |
| LC15-S09 | **Unavailable evidence or quarantine** | Local/CI plus recorded example when captured | No advancement on an unacknowledged write; missing/expired evidence refuses stored reprocessing. |

Existing relay cut, slow-client, and ordinary restart remain required regressions. Source outage, access denial, and browser overload are not relabeled as quarantine-eligible data failures. [SO15 §4; LC04]

The native library's complete F01–F48 acceptance plan remains authoritative for its own guarantees. Lontra Creek demonstrates a selected workflow and verifies its application integration; it does not replace that fault suite or claim to prove universal durability.

## 5. Headline visitor journey

### 5.1 Use a synthetic LC-03 projection failure for the complete story

Use **LC-03 Slate Canyon**, already the Lab's failing sensor, rather than adding a new instrument. The scenario publisher produces one predetermined, valid JSON record whose routing identity and domain revision are valid, but whose selected mapper returns a public field with the wrong schema type. For example, a numeric gauge value can be emitted as a string by a deliberately broken projection. The precise field comes from the actual checked-in schema; do not change the public schema to make the test pass.

This must fail the library's **invalid public payload** stage. Invalid tenant/parameters/revision or a thrown arbitrary exception would be a different class and must not be used to demonstrate automatic continuation. Stage and failure class are observed from the real library, not inferred from the button the visitor clicked. [SO15 §4]

### 5.2 Sequence

**Start healthy.** Show a real LC-03 SDK subscription, connection state, subscription state, and revision. Explain that the bench is a private copy of the fictional creek. Do not apply failures to the shared field-station source.

**Inject the preset failure.** The trusted application publisher writes the predetermined record to this bench's configured source topic. The public request names a scenario, never the record bytes, a topic, a partition, or a Kafka credential. Stop additional scenario injections until the incident is classified. The source goes held and its views become stale; the socket may remain connected.

**Preserve evidence.** Show the incident's library-reported classification and separate journal/evidence outcomes. Only a positively acknowledged Kafka quarantine write earns **Evidence saved**. Do not show a green “recovered” state at this point.

**Explain the held decision.** Initially, the demo's authoritative snapshot service has not established coverage of the excluded update. The configured guard returns hold. Show **Saved, but not safe to continue** and explain that skipping a record could hide a real state change.

**Make the application's source of truth ready.** A separate, explicitly labeled demo action releases a predetermined authoritative-state update and its coverage evidence. This is a Lontra Creek application action, not something StreamOtter invents or repairs. The guard can now prove its declared relationship to that input and produce cumulative context.

**Reassess and recover.** A fixed scenario action invokes the installed library's supported reassessment. Show guard decision, durable boundary, source-position result, snapshot acknowledgment, and finally the browser's observed synchronization. If any step fails or is unknown, retain that state. No timer or click sets `live`.

**Investigate after recovery.** The view can be live while its incident remains preserved. The visitor can follow the S04 extension or reset the study. This reinforces that recovery of the current view and investigation of a defective record are separate jobs.

### 5.3 Why the raw-JSON example is separate

S02 really contains undecodable bytes. It demonstrates quarantine-and-hold. Its stored evaluation must still fail decoding; there is no “fix these bytes” editor. A button that makes malformed bytes evaluate successfully would contradict V1.5's immutable-original rule. The main redrive lesson therefore uses S03's valid source JSON and repairable mapping behavior instead. [SO15 §§8.1–8.3]

### 5.4 Evaluate and approve one old state

The controller selects a prepackaged corrected mapper variant and records its effective build/configuration identity. It does not accept uploaded code or rewrite a file from browser input. New evaluation uses the original retained evidence and the now-current mapper, producing an expiring library plan.

The review card states: **This evaluation changed no source offset, sent no state, and published no business event.** Show the intended gateway-local action and the possibility that the original state is now obsolete. Approval is bound to the exact plan, incident revision, evidence hash, source generation, and effective handler/configuration identity.

Re-evaluate on execution as required by the library. If the result or fingerprints change, refuse and require another review. A legitimate **Superseded by a newer snapshot** result is presented as a successful safety outcome, not an error to work around. Never manufacture a higher revision to make redrive look productive. A lost action response prompts result lookup, not an automatic second redrive. [SO15 §8]

## 6. Incident interface and evidence language

### Three visible areas

Retain the creek reading and existing trace feed. Add a focused incident panel beside/below them:

| Area | Required display |
| --- | --- |
| **Application view** | Actual SDK connection and subscription states; last observed revision/value; stale data retained and clearly marked. |
| **Record disposition** | Failure stage/class, policy, evidence saved/unknown/unavailable, source held/advanced/uncertain, active recovery requirement, and supported next action. |
| **Observed steps** | Chronological, bounded trace with origin labels: application action, library observation, or browser observation. Gaps remain visible. |

Use progressive disclosure for source coordinates and fingerprints. The main story should be understandable without studying a hash. Display an opaque incident label and a human-readable reason first. Detailed internal state belongs to the server; the browser receives a purpose-built, lease-scoped projection.

Do not derive the incident's current state solely from the rolling trace buffer. The existing feed can drop old items; expose a bounded current-incident summary separately. A trace gap means some steps are missing, not that the system can reconstruct them or that delivery history exists. [LC04; SO15 §10]

### Precise labels

| Say | Do not imply |
| --- | --- |
| Evidence saved | Record repaired or view recovered. |
| Source advanced past quarantined record | Browser received the excluded record. |
| Snapshot coverage established | StreamOtter independently proved arbitrary business data correct. |
| View resynchronized | Every intervening event replayed. |
| Evaluation passed | Reprocessing happened. |
| Reprocessed / superseded / failed / unknown | Business action completed or every browser rendered the result. |
| Study discarded and reset | The held incident was fixed. |

The current bench handler emits its own `processed` record annotation before downstream library validation and commit complete. V1.5 must not treat that annotation as proof of acceptance, quarantine disposition, or offset advancement. Preserve its historical meaning with a clearer label such as **mapper returned**, and derive stronger observations from supported library/operator results. [LC06]

### Accessibility and visual continuity

Preserve the site's Figtree/monospace design, themes, components, and named maintainer/footer choices. The private design-review file referenced in the working record was not available for this review; do not reinterpret or replace it. [LC08, LC12]

All actions must work by keyboard. Announce meaningful state changes politely, without reading every trace entry aloud. Distinguish outcomes in text and icons, not color alone. Keep focus on a stable control after polling; move it deliberately into an opened approval dialog and back afterward. On small screens, show reading, incident, then steps. No automatic feed scrolling that overrides the user's reading position. Preserve reduced-motion behavior and a static text explanation when JavaScript is unavailable.

## 7. Integration architecture: reuse the bench, do not clone the library

The demo remains an ordinary consumer of the exact published StreamOtter package. No monorepo links, imports from unexported internals, reimplemented quarantine engine, or monkey-patched synchronization to make a scenario pass. When the package lacks a needed observation, file a narrow upstream issue; use a published fix or accurately limit the demonstration. [LC01–LC02; SO15 §15]

### Existing ownership, extended

**Field station application:** Owns sessions, lease coordination, synthetic state, the allowed scenario publisher, and the authoritative coverage evidence. It is still the only application writer. Add a bounded, authenticated scenario method rather than a public producer endpoint.

**Bench runtime:** Owns its gateway, local incident access, scenario state, allowed operation mapping, and redaction. It calls the installed public in-process/operator service privately. It does not expose that service as a generic HTTP proxy.

**Library:** Owns classification, quarantine persistence, source progress, cumulative barriers, plan validation, redrive, and synchronization.

**Site:** Selects a scenario, submits a bounded intent, displays server observations, and observes its own SDK. It does not decide eligibility or generate a successful result.

**Hosting layer:** Confines resources, credentials, topics, journals, and private listeners; preserves state for restart; cleans up disposable studies under a separate lifecycle.

### Capability and package boundary

Before enabling the track, pin the actual published V1.5-capable package in both application and site, including the lockfile. Map the final library APIs to the demo contract only after their types exist. This plan uses operation names from the proposal; it is not a claim those functions can be called in `0.1.0-rc.3`.

Add a safe app-owned capability summary to the existing Lab status or a small separate status route. It reports the observed demo/library build, available scenario IDs, backend mode, and availability reason. Avoid exposing service URLs, secrets, local socket paths, or arbitrary operator capabilities. A newer static site against an older backend must show **This backend does not support this scenario**; no mock success fallback.

## 8. The application recovery contract in the demo

The existing simulation updates authoritative state before publishing and uses monotonically advancing revisions. That is a useful foundation, but it does not automatically implement V1.5's cumulative recovery barrier. Add and test that contract explicitly. [LC02; SO15 §7]

For each disposable study, keep a small persistent **application scenario ledger**, distinct from the library incident journal. Record the scenario run/generation, predetermined domain mutation, authoritative snapshot version or watermark, original publication coordinates once known, and intended audience coverage. The ledger establishes the relationship the malformed or misprojected payload cannot be trusted to assert.

The guard's answer comes from that ledger and the actual snapshot service. It must cover every potentially affected current or future instance of the source, including absence/deletion where relevant; it must retain earlier obligations when another incident occurs. For scenarios whose effect is limited to a known LC-03 mutation, the app's ledger must still establish that other instances are unaffected, not assume that from invalid bytes.

A snapshot receives the required boundary/context and acknowledges only what its backing state actually satisfies. An old or intentionally lagged snapshot must not echo a new boundary unconditionally. Include a negative test using missing/wrong acknowledgment, and an independent expected-state ledger for assertions. Explain in the reference page that arbitrary integrators remain responsible for the truth of their own guard.

The scenario may temporarily withhold its own application checkpoint advancement to make refusal visible. Label this as **snapshot coverage not ready**. The withheld coverage is a deliberate bench-only negative condition, not a replacement for the normal write-before-publish rule. It is not a fake Kafka outage or a direct edit of the browser's state. Keep unrelated publication deterministic and bounded so a background tick cannot accidentally erase the teaching moment before it is observed.

## 9. API, lease, and operation changes

Amend `docs/contracts/lab-api.md` and the matching TypeScript module together. Preserve session-derived bench selection, exact-origin checks, small request bodies, rate limits, and current lease timing. Add a closed set of scenario intents, not arbitrary runtime operation names. [LC04]

Suggested app-level intents include `scenario.start`, `scenario.restore-calibration`, `scenario.prepare-coverage`, `incident.retry-current`, `incident.reassess`, `incident.evaluate`, and `incident.approve-reprocess`. These are **proposed demo intents**, not new public StreamOtter API names. Each resolves to a fixed server-selected incident and action for the current run. Existing relay/satellite/restart actions remain available only in compatible states.

For consequential requests, bind an idempotency/request ID, expected scenario revision, and an opaque approval-plan token where needed. Client-supplied bench IDs, source names, incident storage IDs, arbitrary offsets, topics, file paths, raw data, handler code, and policy objects are rejected. Public opaque references are looked up under the active session/lease/run; they are not trusted as authority.

Long operations return an accepted operation identifier and observed status promptly. This acknowledges **the demo request**, not quarantine success or business completion. Poll the bounded result resource until the real outcome is known. Keep lease heartbeats, return/reset, and read-only status responsive while a quarantine write or gateway restart is waiting. Do not hold the shared FIFO coordinator lock through those waits.

Check lease expiry, scenario generation, incident revision, and cancellation before committing an action and after awaited boundaries. A late callback from an ended study cannot update a new visitor's panel or execute its plan. A write already completed before cancellation is recorded honestly in the old study; cleanup must not describe it as never having occurred.

A plan's effective approval lifetime is no longer than the library plan lifetime, the remaining lease, and the current scenario. Navigation/back-forward cache restoration must revalidate the lease and plan, not silently approve. Repeated clicks reuse the same operation and show its result; uncertain operations are not automatically repeated.

## 10. Restart, scenario reset, and bench reuse

This is a required architecture change, not cosmetic polish. The present reset creates a fresh consumer group with `startFrom: latest`; the bench's source generation is otherwise fixed. That deliberately disposes of a V1 exercise, but it must not be presented as recovery of a V1.5 quarantine incident. [LC04–LC06]

### A. Restart within the same study

Preserve the consumer group, source generation, journal volume, application scenario ledger, and unresolved barriers. Restore safety state before useful delivery resumes. A held source can remain held while the bench control API is healthy enough to explain it.

The current gateway-start helper requires the source to become healthy before reporting success. Revise that assumption for a legitimate restored hold: distinguish **operator/control service available**, **source ready for data**, and **clean bench eligible for a new lease**. Do not mark an explainable held incident as a vanished Lab or erase it to pass startup checks. [LC05]

A normal gateway restart in the existing process demonstrates restart behavior, not necessarily process/OS crash durability. Add a separate process/container restart test with the volume intact before making that stronger claim. The public explanation must identify which test was actually run.

### B. Reset between scenarios or leases

Reset is explicit disposal of a synthetic study. Immediately invalidate old lease/run tokens and plans; revoke connections; stop scenario work and gate the publisher; quiesce the old gateway and pending operations. Finalize a bounded metadata summary, then provision a fresh study identity, source generation, application state, and journal using the approved initialization path.

Reuse or rotate physical bench resources only through a bounded reset protocol. Do not simply attach an empty journal to an old advanced source identity. A shared physical topic can be reused only when the new generation, starting boundary, and publisher handoff exclude the old study correctly; otherwise rotate an allowlisted topic generation and delete it through private lifecycle administration. Topic and group creation remain server/operator controlled and bounded.

Describe cleanup as **Study discarded**. It is not a recipe for clearing real production failures. Old operations/evidence must never become visible to the next lease, even if retained internally until the configured cleanup time. Cleanup failure keeps the bench unavailable; it does not produce a deceptively clean lease.

## 11. Quarantine, storage, and exposure controls

### Resources and scope

Allocate a protected quarantine destination and local journal per bench, with explicit study identity within them. Preserve journal state across same-study restarts. Keep the application scenario ledger separate from the library journal and retain its coverage facts for as long as that study can resume.

Quarantine topics must not match any source subscription. Bound retained bytes, pending operations, incident reads, and cleanup retries. Compute the entire host's disk/memory allowance across three benches rather than blindly multiplying the library's example defaults. Measure before approving host capacity; do not promise that the larger stack remains free or fits the previously discussed VM.

The short-lived demo may discard synthetic studies earlier than the library's default evidence retention, but that must be explicitly labeled as demo cleanup, never advertised as the library's retention guarantee. Missing evidence produces **Unavailable/expired**, not an empty success or reprocessing from an invented copy.

### Kafka authorization is a specific release risk

The existing Lab contract records **R2: separate SCRAM identities without broker topic ACLs**. The working record leaves public exposure subject to its disposition. V1.5 adds quarantine write authority, so it cannot inherit a claim that separate users alone isolate topics. [LC04, LC08]

**Proposed hosted-V1.5 gate:** enable and verify least-privilege topic/group access for each bench and the scenario publisher, or keep the new quarantine actions local/private until an explicitly reviewed equivalent containment design is approved. A bench needs only its own source reads, quarantine reads/writes, and scoped group operations. It must not write the shared creek, another bench, holts, or notebooks. Any required broker change is an explicit deployment-plan amendment, not a silent library change.

The browser never receives management/operator credentials or a raw-topic read capability. The existing private management arrangement may continue only after review against the new installed release; the old rc.3 development-mode analysis is not automatically valid for V1.5. Use supported private in-process operations when available; no import from library internals. [LC04; SO15 §12]

### Synthetic evidence and exports

Default public incident summaries contain metadata only. An optional **Show synthetic record** control displays only the exact, server-owned fixture belonging to this run, rendered as text, and clearly labeled synthetic. It is not a generic quarantine browser, a raw-download API, or access to protected source payloads.

A downloadable reproduction bundle contains the scenario ID/seed, package/build identity, sanitized incident summary, observed steps, trace-gap flags, expected behavior, and local replay instructions. Include synthetic bytes only when deliberately selected and supported; exclude all cookies, tokens, host paths, private topic credentials, raw production material, and other leases. Bound bundle size and allow export without making a new incident state look resolved.

## 12. Health, records, and surrounding content

### Health is a supporting lesson, not another dashboard

Show a small **Process / Source / View** explanation in the Lab's under-the-hood area. A deliberate source hold should leave the control plane available while data readiness is false. A retained historical incident should not keep readiness false after safe recovery. [SO15 §11]

Use library health probes privately and expose only a safe demo summary. Do not route them publicly to obtain observability. Keep bench-pool readiness and data readiness separate so intentional scenario failures do not trigger a restart loop or prematurely recycle a leased bench. The specification's example health port is not a mandated port; avoid colliding with Lontra Creek's existing `7402` API in local setups. [LC01]

### Workbench and recordings

Recapture Connect/Inspect where their content changed, and add a Failures sequence: hold, saved evidence, guarded recovery, evaluate, approve, superseded result, and redacted export. Record CLI-only production operations separately from the development UI. Do not claim the local production operator service is available to a browser visitor.

Store package version, fixture/Kafka mode, date, capture script, environment, and transcript per asset. The current tour interpolates the page's global `RELEASE` into older recording descriptions; updating the package must not relabel an rc.3 capture as a V1.5 capture. Either regenerate it or retain its original explicit version. The same rule applies to hardcoded CLI transcripts and fingerprints in the playground. [LC10–LC12]

### Configuration and claim checks

The browser playground imports the real published validator. Provide presets and negative examples: missing guard, forbidden ignore/force-skip, quarantine/source topic overlap, and omitted failure handling preserving legacy behavior. Clearly distinguish schema/configuration validation from validating a guard's truth, write permissions, journal durability, or Kafka reachability.

Keep type generation unavailable in the browser until a published release actually supplies the needed generation interface. The existing generator/file-I/O separation request is not an excuse to reimplement the generator in Lontra Creek.

Update `/when-it-breaks/` from exact-release facts: public SDK states, operator causes, retry eligibility, and record disposition. `captured`, `quarantined`, or `advance-confirmed` are not invented subscription states. Retain the explanation of state listeners versus error listeners. [LC09, SO15 §§7,11]

## 13. Local development and dependency sequencing

1. **Before the native package exists:** Build static explanations and layout with explicitly labeled design fixtures. Keep interactive V1.5 actions unavailable. Do not import the sibling library checkout or emulate success as a live demo.
2. **After a suitable published candidate exists:** Pin that exact package, review changed public surfaces, regenerate types/examples, and enable real-Kafka local integration.
3. **After local/container verification:** Complete recordings and release facts. Keep public deployment gated separately.

Add a proposed `npm run dev:lab` convenience script wrapping the existing `docs/LOCAL_LAB.md` source-build recipe. It checks prerequisites, creates only an explicit git-ignored local project, uses loopback HTTPS and documented test-certificate handling, and prints site/health/status URLs. It must not deploy cloud resources, grant system trust silently, or delete volumes as its default stop behavior.

Normal stop preserves current-study state. A separately confirmed **discard local studies** command performs cleanup. Document the difference. Docker/Kafka dependencies remain visible; this plan does not promise that the ordinary fixture command can demonstrate broker durability without them. A native no-Docker launcher is optional follow-up work, not a prerequisite added to this release.

## 14. Delivery plan and release gates

| Slice | Deliverable | Exit condition |
| --- | --- | --- |
| A — Baseline and boundary | Confirm current branch, native API availability, route/contract inventory, and three bounded design decisions below. | Written compatibility and exposure delta; no fabricated live behavior. |
| B — First vertical slice | Real Kafka S02 quarantine-and-hold, private library operations, incident projection, and one upgraded bench. | Correct observed evidence/hold state; old Lab scenarios still work. |
| C — Honest continuation | Persistent application coverage ledger, S03 guard/refusal/recovery, restart separation, and current/future-view tests. | No false live state under the declared app contract. |
| D — Operator story | S04 evaluation/approval/superseded; S05 integrity hold; S06 retry; bounded trace/export and lease-safe actions. | Verified outcomes, cancellation, cross-lease isolation, and resource bounds. |
| E — Whole site and release | Page updates, real captures, presets, local launcher, three-engine UI checks, scoped Kafka authorization, deployment evidence. | Companion acceptance matrix and owner release review. |

Resolve three focused decisions at the beginning: **demo coverage ledger and guard**, **persistent study/restart versus disposable reset**, and **private operations plus scoped Kafka write authority**. These adapt Lontra Creek; they must not redefine the native library's safety contract.

The accompanying acceptance plan defines LC15-A01–A40. Reuse existing test infrastructure and add evidence, rather than replacing tests with new counts. A library capability being implemented or passing its own tests is not proof that this demo integrates it correctly.

**Local companion completion:** All required public-track scenarios work on a pinned real-Kafka local stack, and UI/reference/fixture modes are labeled correctly. **Hosted companion readiness:** additionally prove deployed ingress isolation, topic permissions, persistent volumes, quotas, lease cleanup, backup/disposal boundaries, rollback, and behavior on the actual host. **Public launch:** requires the existing site's launch approval plus the V1.5-specific gate; it is not implied by this document.

For rollback, preserve journals and barriers. Do not downgrade the core or delete a volume to make a failing demo green. The public story can be disabled while the compatible runtime is kept for reconciliation. Discarding a synthetic study is permitted only through its explicit lifecycle and must never be described as a production incident remedy.

## 15. Sources, traceability, and placement

**Authority:** Lontra Creek's `docs/PLAN.md` owns its experience and launch criteria. `docs/contracts/lab-api.md` owns existing demo interfaces. The supplied StreamOtter V1.5 specification owns the proposed native behavior. This companion is an additive proposal; exact library declarations supersede interface sketches. Preserve the founding direction, the final Future Strategy package, and the native V1.5 package.

All LC links below use the immutable inspected site commit. No external-market or cloud-price assumptions were revalidated for this plan.

- **LC01 — README and run modes:** [README.md](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/README.md).
- **LC02 — Experience, simulation, routes, and gates:** [docs/PLAN.md](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/docs/PLAN.md).
- **LC03 — Existing Lab page:** [apps/site/src/pages/lab.astro](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/apps/site/src/pages/lab.astro).
- **LC04 — Lab API, isolation, reset, and threat model:** [docs/contracts/lab-api.md](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/docs/contracts/lab-api.md).
- **LC05 — Bench lifecycle and actions:** [apps/field-station/src/lab/runtime.ts](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/apps/field-station/src/lab/runtime.ts), selectively inspected.
- **LC06 — Bench configuration and mapper:** [apps/field-station/src/lab/bench.ts](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/apps/field-station/src/lab/bench.ts).
- **LC07 — Real-Kafka local Lab recipe:** [docs/LOCAL_LAB.md](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/docs/LOCAL_LAB.md).
- **LC08 — Reported evidence and pending deployment conditions:** [docs/WORKING_RECORD.md](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/docs/WORKING_RECORD.md), [docs/LAB_CHECKPOINT.md](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/docs/LAB_CHECKPOINT.md). Historical checkpoints are not all current-head verification.
- **LC09 — Failure reference implementation:** [apps/site/src/pages/when-it-breaks.astro](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/apps/site/src/pages/when-it-breaks.astro).
- **LC10 — Recorded workbench tour:** [apps/site/src/pages/workbench.astro](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/apps/site/src/pages/workbench.astro).
- **LC11 — Playground implementation:** [apps/site/src/pages/playground.astro](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/apps/site/src/pages/playground.astro).
- **LC12 — Page registry, package provenance, and scripts:** [apps/site/src/site.ts](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/apps/site/src/site.ts), [apps/site/package.json](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/apps/site/package.json), [package.json](https://github.com/jfricano/lontra-creek/blob/2397e2cbdfa3a32dda69920583ed9d18881ab863/package.json).
- **SO15 — Native feature contract:** supplied `V1_5_SOURCE_FAILURE_SPEC.md`, revision 0.1, September 28, 2026; accompanying `V1_5_ACCEPTANCE_PLAN.md` and `V1_5_IMPLEMENTATION_HANDOFF.md`. These are proposed documents, not an installed release. Their SHA-256 fingerprints are recorded in this package's `PACKAGE_README.md`.

Suggested location: `docs/releases/v1.5/` in **Lontra Creek**, with a link from its plan and Lab contract. Do not overwrite the library's V1.5 documents. No GitHub or laptop-repository changes were made in preparing this package.

**Release identity:** the next Lontra Creek experience should make the native feature tangible without enlarging its claims: **a bad record has an observable fate, and a recovered view has evidence behind it.**
