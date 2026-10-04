# Lontra Creek V1.1 — Release handoff

October 4, 2026 · Owner: Jason Fricano · For the coordinated StreamOtter 0.2.0-rc.1 / Lontra Creek V1.1 deployment checklist

This is a summary for whoever builds the deployment checklist. The step-by-step rollout (GitHub environments, Cloudflare, the Oracle host, sequence, smoke tests) is in the shared rollout plan, `release-0.2.0-rc.1/ROLLOUT_PLAN.md` in the project files, and is not repeated here. No credentials are named or needed here.

## What ships

| PR | What | Merge |
| --- | --- | --- |
| [#40](https://github.com/jfricano/lontra-creek/pull/40) | All V1.1 slices that could be built without new StreamOtter APIs, independently reviewed ([REVIEW_FINDINGS.md](REVIEW_FINDINGS.md)) | After StreamOtter (#55, #20, #56), by Jason |
| [#41](https://github.com/jfricano/lontra-creek/pull/41) | Renames `streamotter.app` to `streamotter.dev` (production gateway `allowedOrigins`, Caddy guards, site build origin, canonical URLs, social card) | With #40 or right after it, before the backend image is built. Without it, the production gateway refuses live views from streamotter.dev |
| Pin PR (not opened yet) | Moves both apps to `streamotter@0.2.0-rc.1` | Only after 0.2.0-rc.1 is on npm |

## StreamOtter version consumed

- **#40 and #41: `streamotter@0.1.0-rc.3`**, pinned exactly in `apps/field-station`, `apps/site` and `package-lock.json`. Publishing 0.2.0-rc.1 changes nothing in Lontra Creek until the pin PR merges.
- **Pin PR: `streamotter@0.2.0-rc.1`**, exact. A trial against a local pack of StreamOtter `4e67ef8` (the #56 head) passed config validation, code generation (unchanged), typecheck, the site build and the link check. Three unit tests fail on purpose until the pin PR handles them:
  1. The one-version check (LC11-A40) passes once the pin is a registry version.
  2. The validator now accepts `failureHandling`, so the site stops labeling V1.1 failure policies as planned.
  3. The workbench publishes the WHC-1 host manifest, so `apps/site/src/scripts/workbench-seam.ts` gets its version and integrity hashes, taken from the **published** tarball.
  
  The pin PR also re-runs the Lab threat model's §10.2 and checks S1–S6 against the new package (Lab contract R4).

## Unfinished integrations (none ship in this release)

| Item | State | Unblocked by |
| --- | --- | --- |
| W9a: real workbench sandbox (embedded UI, a sandbox service in Compose, preview sockets through Caddy) | Session service and page shell are built; `/workbench/` shows "not enabled" with the screenshot fallback | 0.2.0-rc.1 on npm, then the pin PR, then W9a work and a capacity decision |
| W9b: source-failure exercises (quarantine, recovery, operator actions) | Track shell is built; exercises show as unavailable | 0.2.0-rc.1 on npm, then the pin PR, then W9b work |

[STATUS.md](STATUS.md) is the live tracker.

## Server changes

- **Kafka permissions:** none for this release. Leave `KAFKA_AUTHORIZATION` unset (`none`) on the host. ACLs are built and tested locally and in CI (W7). Turning them on is a separate maintenance window that needs Jason's approval, following [`deploy/OPERATIONS.md`](../../../deploy/OPERATIONS.md) (Kafka authorization). Set it in `stack.env`, never `current.env`. `deploy.sh` refuses to lower it again unless root sets `LONTRA_ALLOW_AUTHORIZATION_DOWNGRADE=1`.
- **Persistent storage:**
  - The base stack keeps its existing volumes: `kafka-data`, `field-data` and `caddy-data`.
  - When the Lab overlay is enabled, #40 adds `lab-1-state`, `lab-2-state` and `lab-3-state` (`LAB_STATE_DIR=/var/lib/lontra`). Compose creates them, and they hold study ledgers and summaries.
  - The Lab overlay stays off unless Jason approves public benches.
  - Never run `down --volumes`.
- **Sandbox capacity:** nothing to provision in this release, because no sandbox service is deployed.
  - For W9a, the configured defaults are 3 slots, 600 s leases, a 30-place queue, and 2 places per visitor address shared with the Lab ([LC11-ADR-04](decisions/LC11-ADR-04-workbench-sandbox-architecture.md#defaults-configuration-not-measured-capacity)).
  - Real capacity gets measured locally and on the host first, and Jason decides it.
- **Domain:** #41 plus the host and Cloudflare steps in the rollout plan (re-run `deploy/setup.sh` for `demo.streamotter.dev`, and `.dev` overrides in `stack.env`).

## Acceptance checks

- **CI on the merge commit:**
  - `ci.yml`: typecheck, 294 unit tests, site build and link check.
  - Browser workflow: Chromium, Firefox and WebKit.
  - `site.yml` (site build).
  - Stack and Lab spike on amd64 and arm64.
  - Shared host.
  - Setup rehearsal.
  
  All of these are green on #40 at `d5c1b7b`.
- **Locally:** run `npm run typecheck`, `npm test`, `npm run check:site` and `npm run test:browser`. They need **Node 24**: under Node 22, eight tests in `lab-coverage.test.ts` are cancelled by the test runner, and that is not a product failure.
- **After deploy:** the smoke steps in the rollout plan (steps 2 and 3), especially checking on the real site that "Drop my connection" actually drops it.

## Rollback

- **Backend:** take `lontra-checkpoint backup` before deploying. To roll back, dispatch `Deploy demo` with the previous SHA, or run `lontra-deploy "$(cat /srv/lontra/previous.sha)"` on the host. A failed health check restores the previous release automatically. Kafka data and study history are not rolled back.
- **Site:** roll back to the previous production deployment in Cloudflare Pages.
- **Pin PR:** redeploy the rc.3 backend SHA and the rc.3 site deployment. Both keep working, because each pins its own version.

Details are in [`deploy/OPERATIONS.md`](../../../deploy/OPERATIONS.md) and [`docs/DEPLOYMENT_PLAN.md`](../../DEPLOYMENT_PLAN.md).
