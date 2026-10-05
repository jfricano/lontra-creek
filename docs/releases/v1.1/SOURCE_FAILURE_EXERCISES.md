# Lontra Creek V1.1 — Source failure exercises

October 4, 2026 · Owner: Jason Fricano · Slice W9b · Built on the phase 2 branch `feat/v1.1-source-failure-exercises` against StreamOtter 0.2.0-rc.1 from npm (a pre-publish pack until October 5)

The Failure Lab's **Source failures** track: nine stories (LC11-S01–S09) in which a bad record reaches a leased bench and the visitor watches what StreamOtter 0.2.0-rc.1's opt-in failure handling does with it: hold it, save it as evidence, refuse to continue until the view can be trusted, evaluate it again, and reprocess it on approval. This page says what the exercises are, how to run them locally, why the hosted demo differs, what has been proven at which level, and how the temporary pre-publish packages gave way to the registry release.

The interfaces are fixed elsewhere and not repeated here: the [Lab contract §12](../../contracts/lab-api.md#12-the-source-failures-track-v11) (routes, intents, projection, page), its private bench surface in §8b, the [companion plan](LONTRA_CREEK_V1_1_COMPANION_PLAN.md#4-scenario-catalog-and-release-coverage) (stories and labels), and the decisions listed at the end. [STATUS.md](STATUS.md) is the live tracker. Where this page and the [rollout plan](../0.2.0-rc.1/ROLLOUT_PLAN.md) differ about hosting, the rollout plan wins.

## What the exercises are

| Story | `?scenario=` | What it shows | Where it can run |
| --- | --- | --- | --- |
| LC11-S01 Fouled sensor: fix and retry | `fouled-sensor` | The default pause: restore calibration, retry the exact held record, nothing skipped | Every Lab, as before; also as an intent with any profile but `off` |
| LC11-S02 Garbled reading: preserve and hold | `garbled-reading` | Invalid JSON is saved as evidence and the source stays held; saved bytes are not repairable | Public track, profile `quarantine` |
| LC11-S03 Bad projection: recover from authoritative state | `bad-projection` | The headline path: quarantine, the recovery guard refusing to continue, then continuing once snapshot coverage is established | Public track, profile `quarantine` |
| LC11-S04 Inspect the old reading: evaluate, then reprocess | `inspect-old-reading` | A dry-run evaluation with no delivery effect, one reviewed approval, and a newer snapshot superseding the old state | Public track, profile `quarantine` |
| LC11-S05 Conflicting readings: stopping is correct | `conflicting-readings` | Two different readings at one revision stay held; there is no force-skip | Public track, profile `quarantine` |
| LC11-S06 Calibration lookup blip | `calibration-blip` | Bounded retry of a transient mapper error: a clean retry, then retries that run out | Public track, profile `retry` or `quarantine` |
| LC11-S07 Too many bad readings | `too-many-bad-readings` | The automatic-continuation limit: the sixth incident holds | Local and CI only |
| LC11-S08 Recovery across restart and a new subscription | `restart-recovery` | The durable failure journal keeps a cumulative recovery barrier across a gateway restart | Local and CI only |
| LC11-S09 Unavailable evidence | `unavailable-evidence` | A deleted quarantine copy refuses stored reprocessing | Local and CI only |

A visitor borrows a bench, opens the Source failures track, and presses **Start this scenario**. The field station publishes the scenario's synthetic LC-03 (and, for S08, LC-01) records to that bench's own topics, recording each in the coverage ledger first. The incident panel then shows the application's view, the record's disposition, and the observed steps, and offers one **Next supported action** at a time (retry, reassess, prepare coverage, evaluate, or a reviewed approval to reprocess). Every incident fact comes from the installed library's published operator API (`streamotter/gateway/operator`); nothing is simulated. Returning the bench discards its study; it never fixes a held incident.

A scenario is offered only when the capability summary (`GET /api/lab/capabilities`, contract §12.3) lists it as available. That needs all of:

1. Recorded real-Kafka evidence matches what is running (`VERIFIED_WITH` in `apps/field-station/src/lab/capabilities.ts`, contract §12.3): the installed StreamOtter release, the exact packages it was proven against (the six `streamotter` and `@streamotter/*` lockfile `integrity` values), and, for that scenario, the failure-handling profile this deployment runs. A scenario is recorded only after its real-Kafka test passes on `npm run dev:lab` under that profile. Another build of the same version (as when the registry release replaced the pre-publish pack) matches nothing until the suite is run on it again.
2. The deployment has Lab benches.
3. The deployment's failure-handling profile (`LAB_FAILURE_HANDLING`: `off`, `retry`, or `quarantine`, set alike on the field station and every bench) provides what the scenario needs, and, for S07–S09, `LAB_LOCAL_EXERCISES=1` is set.

Otherwise the page lists the scenario with the summary's reason and its Start button stays inert. An older backend without the route answers 404, and the page says it does not support the scenario.

## Run them locally

The exercises need real Kafka, so they run only under `npm run dev:lab` ([LOCAL_LAB.md](../../LOCAL_LAB.md)); `npm run dev` and `npm run dev:kafka` have no Lab benches.

Requirements: Node 24.15 or later (the failure journal's floor: earlier Node 24 releases warn that `node:sqlite` is experimental, and the gateway refuses to open the journal on them; the image runs 24.21.0), Docker with Compose 2.24.4 or later, and OpenSSL.

```sh
npm ci
npm run dev:lab
```

Then, in a test browser profile (see LOCAL_LAB.md for the throwaway certificate):

1. Open `https://localhost:8443/lab/#source-failures` and choose **Borrow a bench**.
2. Pick a scenario that the page lists as available and choose **Start this scenario**.
3. Follow the incident panel's **Next supported action**. For reprocessing, the review dialog shows exactly what you approve.

To see what this backend offers, without a browser:

```sh
curl --cacert .local/lab/secrets/origin/ca.pem https://localhost:8443/api/lab/capabilities
```

The contract's local profile is `quarantine` with `LAB_LOCAL_EXERCISES=1` (§12.2), with the local stack's least-privilege Kafka ACLs (`KAFKA_AUTHORIZATION=acl`, LC11-ADR-03), which include the grants for each bench's quarantine topics. Whatever the page shows, the capability summary above is the backend's answer.

On 0.2.0-rc.1 the local stack offers all eight new stories: `npm run dev:lab` runs the benches and the field station with `LAB_FAILURE_HANDLING=quarantine` and `LAB_LOCAL_EXERCISES=1` (`deploy/compose.local-lab.yaml`), with Kafka ACLs on. The real-Kafka suite and how to run it are in [LOCAL_LAB.md](../../LOCAL_LAB.md#source-failure-exercises).

The unit, library and fixture suites below run with `npm test` on Node 24. Under Node 22, eight tests in `lab-coverage.test.ts` are cancelled by the test runner, which is not a product failure.

## The hosted demo

**In both hosted phases the Lab benches and the workbench sandbox are off**, and the pages read them as unavailable rather than broken: `/lab/` says "The Lab is unavailable." with **Borrow a bench** disabled, and each source-failure story is listed with the reason the capability summary gives. Phase 1 (#40 and #41) runs StreamOtter 0.1.0-rc.3, which lacks the failure APIs, so every new story waits for a StreamOtter release. Phase 2 (the pin PR) runs 0.2.0-rc.1 with no benches, so the stories read as not verified or as having no Lab benches. The [rollout plan](../0.2.0-rc.1/ROLLOUT_PLAN.md) has the sequence and the acceptance checks.

Turning the hosted Lab on is not part of either phase. It needs Jason's separate approval and its own acceptance: a `lab.enabled` release on the shared host, with devops's shared-host procedure.

Even then the hosted exercises would differ from local ones, because the hosted broker runs `KAFKA_AUTHORIZATION=none`: every SCRAM user can read and write every topic (the Lab threat model's residual risk R2). A bench that writes quarantine evidence makes that a release risk, so:

- Hosted benches would run profile `retry`, which offers only S06 (`calibration-blip`) among the new stories, beside S01.
- S02–S05 need profile `quarantine`, which waits for the owner-approved Kafka authorization migration (LC11-ADR-03; `deploy/OPERATIONS.md`, Kafka authorization). The pin PR's quarantine-topic grants take effect only once the broker enforces ACLs, and that migration never weakens existing authorization.
- S07–S09 stay local and CI exercises (companion plan §4): they need the CI harness or a restart a visitor can't make on the hosted Lab. S09, for example, needs a harness that deletes the scenario's quarantine copy.

## What is proven where

| Level | What it shows | Where |
| --- | --- | --- |
| Rendering fixtures | The page's catalog, deep links, availability reasons, intent bodies, operation lookups, the review dialog, labels, focus, and axe, against scripted answers. Not evidence that any backend produces them | `apps/site/test/lab-catalog.test.ts`, `lab-incident.test.ts`, `lab-operation.test.ts`, `lab-approval.test.ts`; `e2e/lab-source-failures.spec.ts` |
| Application, scripted bench | Intent validation and idempotency, preconditions and stale revisions, lease cancellation, the projection's composition, and each scenario's records against a hand-written expected ledger | `apps/field-station/test/lab-intents.test.ts`, `lab-capabilities.test.ts` |
| Operator adapter, typed fake | The bench's bookkeeping: profiles, handler variants, the guard, plan tokens, closed studies | `apps/field-station/test/lab-bench-failures.test.ts` |
| Installed library, fixture source | StreamOtter 0.2.0-rc.1's own behavior through its published exports: the journal, S02 quarantine and hold, S03 guard hold and reassess, S04 evaluation and single-use approval, S05 integrity hold, S06 and S01 under `retry`, S07 circuit, restart and reset. The quarantine topic, the committed offset, and Kafka coordinates are left to real Kafka | `apps/field-station/test/lab-failures.test.ts` |
| Real Kafka, local stack | Each scenario end to end on `npm run dev:lab`; a scenario is offered only after this passes (contract §12.3) | See below |
| Hosted | Nothing: no bench runs on the hosted demo in either phase | — |

Results at the real-Kafka level are recorded here and in STATUS.md. A scenario not listed is not verified on real Kafka, whatever the lower levels show.

Real Kafka, `npm run dev:lab` built from the registry lockfile, October 5, 2026: StreamOtter 0.2.0-rc.1 from npm (the six lockfile integrity values `VERIFIED_WITH` records), profile `quarantine`, `KAFKA_AUTHORIZATION=acl`, `deploy/test/lab-source-failures.test.ts` 11 of 11 in two runs, with no authorizer denials (`kafka-authorizer.log`) in the second. On the same stack, `deploy/test/sandbox.test.ts` passed 7 of 7 (with the hung-service test), `deploy/test/kafka-acls.test.ts` 6 of 6, and `deploy/test/lab.test.ts` 7 of 7 (the lease-expiry test skipped). Every new story is recorded in `VERIFIED_WITH` for 0.2.0-rc.1 under `quarantine`. The October 4 runs below used the pre-publish pack.

| Scenario | What the real run checked |
| --- | --- |
| Routes | The intent and incident routes are served exactly while a scenario is offered |
| S01 | A `pause` incident with no evidence; restore calibration, retry, processed |
| S02 | The quarantine copy's bytes and envelope match the source record; the source holds with its committed offset at or before the record; reassess is refused; evaluate reports still-fails; the evidence read group is gone afterwards |
| S03 | Hold, prepare coverage, reassess: advanced, committed past the record, resynchronized |
| S04 | Evaluate passes; approval comes back superseded; the spent plan token is refused |
| S05 | Integrity hold; reassess refused |
| S06 | A blip is absorbed; a sustained one runs out of retries, and the record is processed after restore |
| S07 | Five records advance; the sixth opens the circuit and holds; retry is refused as `circuit-open` |
| S08 | The study survives a gateway restart and a container restart (same study, one more process restart) |
| S09 | The quarantine copy is deleted; evaluation reports the evidence unavailable |
| A32 | Nothing is left behind after resets; the journal directory is owner-only |

The hosted default was rechecked on the same stack with `LAB_FAILURE_HANDLING=retry`, `LAB_LOCAL_EXERCISES=0` and `KAFKA_AUTHORIZATION=none` (October 4 on the pack, and again October 5 on the registry install): only S06 is offered, the other seven report `deployment-restricted`, and S01, S06 and A32 pass. S06 is therefore also recorded under `retry`; no other story is, so under `retry` nothing else would be offered even if the profile could run it. That recheck ran on a developer machine, not under the shared host's container limits.

After the phase 2 review's fixes (one intent at a time, ordered projection reads, plan tokens bound to the incident revision, no study ID in the projection, and a suite that fails on any refusal it doesn't expect, asserts S04's `superseded`, and resets every bench twice in A32), both runs were repeated on October 4 with the same packages: `quarantine` with ACLs 11 of 11 with no authorizer denials, and `retry` with `KAFKA_AUTHORIZATION=none` S01, S06 and A32 passing with the other seven skipped as not offered.

One limit found on the real stack: a bench container that is recreated (a new hostname) while its gateway still holds the journal lock, for example after a kill, comes back `failed`, because StreamOtter can't check a lock that names another host. The field station's reset then discards that study and the bench is ready with a new one in about a minute. A graceful stop releases the lock, and a restart in place (same hostname) resumes the same study.

## Pre-publish packages, and their removal

Until StreamOtter 0.2.0-rc.1 was on npm, this branch built and tested the exercises against six locally packed tarballs in `vendor/`: `jfricano/StreamOtter@4e67ef8` (the head of its #56), with every package version set to 0.2.0-rc.1. They arrived in one commit marked temporary (`chore(vendor): TEMPORARY pre-publish StreamOtter 0.2.0-rc.1 tarballs`). While they were here, `scripts/check-release-pins.mjs` kept the Images (`images.yml`) and Deploy static site (`site.yml`) workflows from building the branch, and the Release pins workflow (`release-pins.yml`) kept it out of `main`.

The switch, October 5, 2026:

- 0.2.0-rc.1 was published to npm at 03:27 UTC, with provenance, on the `latest` dist-tag, for all six packages: `streamotter`, `@streamotter/cli`, `@streamotter/client`, `@streamotter/contracts`, `@streamotter/gateway` and `@streamotter/workbench`. The GitHub tag `v0.2.0-rc.1` and the npm pages now exist.
- This branch removed `vendor/`, the `file:` specs, the root `overrides` and the Dockerfile's `COPY vendor vendor` lines, pinned `streamotter@0.2.0-rc.1` exactly in both apps, and regenerated `package-lock.json` from the registry. `scripts/check-release-pins.mjs` now passes.
- The published packages differ from the pack in one runtime file, `@streamotter/gateway`'s operator IPC (`dist/operator/ipc.js`): an answer to an oversized or overloaded request now lingers briefly so the caller reads it, and an over-long socket path is refused up front. The other differences are README text and dependency order.
- Every lockfile integrity value changed, so the real-Kafka evidence (`VERIFIED_WITH`) and the site's recordings, both taken from the pack, were retaken on the registry install the same day (steps 4 and 5 below; results above). The workbench seam's version and integrity were unchanged in the published `workbench-host.json`.

After 0.2.0-rc.1 is published and verified on npm (rollout plan, step 1), one commit does all of the following, and passes the checks below before it is pushed:

1. Removes `vendor/`, the `file:` specs in `apps/field-station/package.json` and `apps/site/package.json`, the root `overrides`, and the two `COPY vendor vendor` lines in `deploy/Dockerfile` (with their comment).
2. Pins `streamotter` to `0.2.0-rc.1` exactly in both apps and regenerates `package-lock.json` from the registry. `node scripts/check-release-pins.mjs` then passes.
3. Re-pins `PUBLISHED_SEAM` in `apps/site/src/scripts/workbench-seam.ts` (version and the sha384 integrity of `app.js` and `workbench-host.css`) from the **published** tarball's `workbench-host.json`, and drops that file's pre-publish comment. `apps/site/test/workbench-seam.test.ts` and the site build fail until it matches the installed files.
4. Re-records the real-Kafka evidence for the registry install: `deploy/test/lab-source-failures.test.ts` and `deploy/test/sandbox.test.ts` run again on `npm run dev:lab` built from the new lockfile (under `quarantine` with ACLs, and S06 again under `retry` with `KAFKA_AUTHORIZATION=none`), and `VERIFIED_WITH` gets the registry packages' six integrity values and only the scenarios and profiles that passed (contract §12.3). `apps/field-station/test/lab-capabilities.test.ts` fails until it does, so the commit can't pass `npm test` on the old evidence. The run's date and results replace the October 4 ones here, in STATUS.md, in LOCAL_LAB.md's status, and in the Lab contract (§10.9's evidence, §11, §12.3).
5. Recaptures both recordings from the registry install ([content verification](../../research/content-verification.md)): `node scripts/capture-demo.ts` (`apps/site/public/recordings/creek.json`) and `node scripts/capture-workbench.mjs` (`apps/site/public/recordings/workbench/`). Their labels then say npm; `scripts/test/capture-provenance.test.mjs` fails until both are retaken. Update the October 4 capture note in `docs/research/content-verification.md`.
6. Rewrites what describes the pre-publish pack as current, so no link points at the removed `vendor/` and no page says the release isn't on npm:
   - `README.md`: the "This branch builds against an unpublished release" banner and the `vendor` row of the layout table.
   - `docs/LOCAL_LAB.md`: the requirements' sentence about `npm ci` installing from `vendor/`, with its link.
   - This page: the "Pre-publish packages, and their removal" section (its `vendor/README.md` links and the list above become a short record of the switch), the opening line's "against a pre-publish pack", and the evidence paragraphs' "pre-publish pack" wording.
   - `docs/DEPLOYMENT_PLAN.md`: the npm-only rule's parenthesis about the phase 2 branch and `vendor/`.
   - `docs/releases/v1.1/STATUS.md`: the phase 2 bullet ("built and tested against a pre-publish pack … in `vendor/`") and the gates that say "not on npm yet" or "uses the pre-publish pack".
   - `docs/releases/v1.1/IMPLEMENTATION_PLAN.md`: the October 4 update's "not on npm yet … pre-publish pack of it in `vendor/`".
   - `docs/releases/v1.1/UPSTREAM_REQUIREMENTS.md`: the October 4 update paragraph and the "not on npm yet" states of R7–R12.
   - `docs/releases/v1.1/README.md`: the state line, the phase 2 heading's "against a pre-publish pack", and the "Only after npm publication" paragraph.
   - `docs/releases/v1.1/RELEASE_HANDOFF.md` and `docs/releases/0.2.0-rc.1/ROLLOUT_PLAN.md` (step 1's "the branch's temporary pre-publish tarballs (`vendor/`) must be removed"): with their owners, since those plans are kept by the rollout thread.
   - `docs/PLAN.md` ("not on npm yet") and `docs/research/release-facts.md` ("vendored pre-publish tarballs").
   - Comments that name the pack: `apps/site/test/site-content.test.ts` and `apps/field-station/src/lab/capabilities.ts` (`VERIFIED_WITH`).

   `grep -rn "pre-publish\|vendor/\|not on npm" --include=*.md --include=*.ts --include=*.mjs .` (outside `node_modules`) then finds only history: dated notes that say what was true on October 4.

Then the usual checks run on Node 24: `npm run typecheck`, `npm test`, the site build, `npm run check:site`, and `npm run test:browser`. The pin PR also re-runs the Lab threat model's §10.2 and checks S1–S6 against the published package (Lab contract R4), and needs its own review and devops reconciliation before Jason merges it.

## Decisions and contracts

- [Lab contract §12](../../contracts/lab-api.md#12-the-source-failures-track-v11) (the track) and §8b (the private intent surface); §10.9 for the local Kafka ACLs.
- [LC11-ADR-01](decisions/LC11-ADR-01-coverage-ledger-and-guard.md): the application coverage ledger and the recovery guard, with its W9b binding notes.
- [LC11-ADR-02](decisions/LC11-ADR-02-study-restart-and-reset.md): restart keeps a study; reset discards it.
- [LC11-ADR-03](decisions/LC11-ADR-03-private-operations-and-kafka-authority.md): operator operations stay inside the bench; least-privilege Kafka authorization, hosted only after approval.
- [Companion plan](LONTRA_CREEK_V1_1_COMPANION_PLAN.md) §§4–11 and the [acceptance plan](LONTRA_CREEK_V1_1_ACCEPTANCE_PLAN.md) (LC11-A05–A24, A28, A31, A32).
- [Release handoff](RELEASE_HANDOFF.md) and the [rollout plan](../0.2.0-rc.1/ROLLOUT_PLAN.md).
