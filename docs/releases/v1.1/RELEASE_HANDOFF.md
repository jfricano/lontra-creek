# Lontra Creek V1.1 — Release handoff

October 4, 2026 · Owner: Jason Fricano · For the coordinated StreamOtter 0.2.0-rc.1 / Lontra Creek V1.1 deployment checklist

This is a summary for whoever builds the deployment checklist. The step-by-step rollout (GitHub environments, Cloudflare, the shared host, the two Lontra Creek phases, acceptance and rollback) is in the [rollout plan](https://github.com/jfricano/lontra-creek/blob/fix/streamotter-dev-domain/docs/releases/0.2.0-rc.1/ROLLOUT_PLAN.md) (on #41's branch; it moves to `docs/releases/0.2.0-rc.1/ROLLOUT_PLAN.md` on main when #41 merges) and is not repeated here. That plan is reconciled with devops's own rollout notes; where this file and the plan differ, the plan wins. No credentials are named or needed here.

Nothing here merges, publishes or deploys anything: every one of those steps waits for Jason's go. Activation is operator-triggered over pinned SSH; no workflow deploys the backend, and a healthy set of containers does not accept a release, only the public acceptance checks do.

## What ships

| PR | What | Merge |
| --- | --- | --- |
| [#40](https://github.com/jfricano/lontra-creek/pull/40) | All V1.1 slices that could be built without new StreamOtter APIs, independently reviewed ([REVIEW_FINDINGS.md](REVIEW_FINDINGS.md)) | After StreamOtter (#55, #20, #56), by Jason |
| [#41](https://github.com/jfricano/lontra-creek/pull/41) | Renames `streamotter.app` to `streamotter.dev` (production gateway `allowedOrigins`, Caddy guards, site build origin, canonical URLs, social card) | With #40 or right after it, before the backend image is built. Without it, the production gateway refuses live views from streamotter.dev |
| Phase 2 PR (not opened yet) | Moves both apps to `streamotter@0.2.0-rc.1`. It is built from the draft branch `feat/v1.1-source-failure-exercises` (stacked on #41), which also carries the workbench mount and its Pages `_headers` policy, the sandbox Compose overlay, the source-failure exercises and a release-pin guard, all against a pre-publish pack of 0.2.0-rc.1. Its scope needs its own review and devops reconciliation before merge | Only after 0.2.0-rc.1 is verified on npm; the branch's temporary pre-publish packages are replaced by the registry pin first |

## StreamOtter version consumed

- **#40 and #41: `streamotter@0.1.0-rc.3`**, pinned exactly in `apps/field-station`, `apps/site` and `package-lock.json`. Publishing 0.2.0-rc.1 changes nothing in Lontra Creek until the pin PR merges.
- **Phase 2 PR: `streamotter@0.2.0-rc.1`**, exact. The draft branch already builds against a pre-publish pack of StreamOtter `4e67ef8` (the #56 head) and handles the three unit tests that guard the bump:
  1. The one-version check (LC11-A40) accepts the temporary pack now and an exact registry version after publish.
  2. The site describes V1.1 failure policies (`failureHandling`) as shipped instead of planned.
  3. `apps/site/src/scripts/workbench-seam.ts` carries the WHC-1 host manifest's version and integrity hashes, taken from the pack.

  What remains after publish: the exact registry pin, a lockfile regenerated from the registry, and re-pinning the workbench integrity hashes from the **published** tarball.
  The phase 2 PR also re-runs the Lab threat model's §10.2 and checks S1–S6 against the new package (Lab contract R4).

## Unfinished integrations (none ship in this release)

| Item | State | Unblocked by |
| --- | --- | --- |
| W9a: real workbench sandbox (embedded UI, a sandbox service in Compose, preview sockets through Caddy) | Built on the phase 2 branch and running under `npm run dev:lab`; in #40/#41 `/workbench/` shows "not enabled" with the screenshot fallback | Phase 2 PR, then Jason's separate approval to run the sandbox service on the hosted demo, with a capacity decision |
| W9b: source-failure exercises (quarantine, recovery, operator actions) | Being built on the phase 2 branch; in #40/#41 the exercises show as unavailable | Phase 2 PR, then Jason's separate approval of public Lab benches and of Kafka ACLs on the hosted broker |

[STATUS.md](STATUS.md) is the live tracker. On the hosted demo the Lab and the sandbox stay off in both phases unless Jason approves them separately; the phase 1 acceptance checks that they read as unavailable, not broken.

## Server changes

- **Kafka permissions:** none for either phase. Leave `KAFKA_AUTHORIZATION` unset (`none`) in the shared host's `lontra.env`. ACLs are built and tested locally and in CI (W7); turning them on is a separate, owner-approved maintenance window. The phase 2 branch adds grants for the exercises' quarantine topics; they apply only once the broker enforces ACLs, through that separate migration, which never weakens existing authorization.
- **Persistent storage:**
  - The base stack keeps its existing volumes: `kafka-data`, `field-data` and `caddy-data`.
  - Only with a `lab.enabled` release, #40 adds `lab-1-state`, `lab-2-state` and `lab-3-state` (`LAB_STATE_DIR=/var/lib/lontra`). Compose creates them, and they hold study ledgers and summaries. No `lab.enabled` marker is set in either phase.
  - Release files live in the shared host's layout under `/srv/apps/lontra`, per [`deploy/shared-host/BACKUP.md`](../../../deploy/shared-host/BACKUP.md).
  - Never run `down --volumes` on the shared host.
- **Sandbox capacity:** nothing to provision in either phase, because no sandbox service runs on the hosted demo and no `SANDBOX_SERVICE_TOKEN` is created on the host. The sandbox overlay has no shared-host overlay or adapter tests yet.
  - For W9a, the configured defaults are 3 slots, 600 s leases, a 30-place queue, and 2 places per visitor address shared with the Lab ([LC11-ADR-04](decisions/LC11-ADR-04-workbench-sandbox-architecture.md#defaults-configuration-not-measured-capacity)).
  - Real capacity gets measured locally and on the host first, and Jason decides it.
- **Domain:** #41 plus the Cloudflare and shared-host steps in the [rollout plan](https://github.com/jfricano/lontra-creek/blob/fix/streamotter-dev-domain/docs/releases/0.2.0-rc.1/ROLLOUT_PLAN.md) (`DEMO_HOST`, `SITE_ORIGIN` and `GATEWAY_PUBLIC_ORIGIN` in `/etc/apps/lontra/lontra.env`; TLS at the shared edge).

## Acceptance checks

- **CI on the merge commit:**
  - `ci.yml`: typecheck, 294 unit tests, site build and link check.
  - Browser workflow: Chromium, Firefox and WebKit.
  - `site.yml` (site build).
  - Stack and Lab spike on amd64 and arm64.
  - Shared host.
  - Setup rehearsal.
  
  All of these are green on #40 at `d5c1b7b`.
- **Locally:** run `npm run typecheck`, `npm test`, `npm run check:site` and `npm run test:browser`. They need **Node 24** (24.15 or later on the phase 2 branch, whose failure journal needs it): under Node 22, eight tests in `lab-coverage.test.ts` are cancelled by the test runner, and that is not a product failure.
- **After activation:** the acceptance in the [rollout plan](https://github.com/jfricano/lontra-creek/blob/fix/streamotter-dev-domain/docs/releases/0.2.0-rc.1/ROLLOUT_PLAN.md): the backend (1a) before the website (1b) in each phase, especially checking on the real site that "Drop my connection" actually drops it, and that the Lab and the sandbox read as unavailable.

## Rollback

- **Backend:** with devops's shared-host procedure, re-point `/srv/apps/lontra/current.env` at the previous retained release and image and bring the project up again. Record the current release, and take a snapshot through the backup hooks once they are accepted, before each activation. Kafka data and study history are not rolled back. The standalone scripts (`lontra-deploy`, `lontra-checkpoint`, the `Deploy demo` workflow) are for the standalone layout only; don't run them on the shared host.
- **Site:** roll back to the previous production deployment in Cloudflare Pages, but only to a build that works with the running backend: never to a pre-#41 build, which points at `demo.streamotter.app`.
- **Phase 2:** re-activate the phase 1 release and roll Pages back to the phase 1 deployment. Both keep working, because each pins its own version.

The shared-host contract is in [`docs/SHARED_HOST_READINESS.md`](../../SHARED_HOST_READINESS.md) and [`deploy/shared-host/BACKUP.md`](../../../deploy/shared-host/BACKUP.md).
