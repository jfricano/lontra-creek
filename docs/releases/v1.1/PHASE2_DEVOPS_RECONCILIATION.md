# Phase 2 branch: answers for devops's review reconciliation

October 4, 2026 · Owner: Jason Fricano · For devops, before the rollout plan is called final

This answers the "Required review reconciliation" list in devops's review handoff, for the phase 2 pin PR ([#42](https://github.com/jfricano/lontra-creek/pull/42), branch `feat/v1.1-source-failure-exercises`, draft, stacked on #41). The [rollout plan](../0.2.0-rc.1/ROLLOUT_PLAN.md) already carries the sequencing, acceptance and rollback items below. Where this file and the plan differ, the plan wins.

Nothing here was merged, published or deployed. The hosted runtime is unchanged in both phases while the Lab and the sandbox stay off. An independent reviewer checked this against `compose.yaml`, `compose.shared*.yaml`, `Caddyfile.shared`, `deploy/shared-host/*` and `kafka/start.sh`'s `none` path.

## 1. Exact commits and files

The branch head is in #42; the PR will move as post-publish work lands. These are the commits devops will care about:

| Commit | What | Kept after publish |
| --- | --- | --- |
| `56e8d77` | `scripts/check-release-pins.mjs`, run first in `images.yml` and `site.yml` | Yes |
| `544075f` | TEMPORARY: `vendor/` tarballs, `file:` specs, root `overrides`, `COPY vendor vendor` in `deploy/Dockerfile`, lockfile | No: reverted in the pin commit |
| `7a32391` | `.github/workflows/release-pins.yml`: the same check on pull requests into `main`, using the base branch's copy of the script | Yes |

Deploy-relevant files changed against #41:

- `deploy/compose.sandbox.yaml` (new)
- `deploy/Caddyfile` and `deploy/Caddyfile.local-lab`
- `deploy/compose.lab.yaml` and `deploy/compose.local-lab.yaml`
- `deploy/kafka/start.sh`
- `deploy/make-secrets.sh`
- `deploy/Dockerfile` (vendor lines only)
- `deploy/OPERATIONS.md`
- `apps/site/public/_headers`
- `.github/workflows/{images,site,browser,release-pins}.yml`

None of these changed:

- `compose.yaml`
- `compose.shared.yaml` and `compose.shared.lab.yaml`
- `Caddyfile.shared` and `start-caddy-shared.sh`
- `deploy/shared-host/*`
- `deploy/operations/*`
- `setup.sh`

## 2. Sandbox: services, networks, resource limits, ingress

**Service.**
- One `sandbox` container, from the same image (`LONTRA_IMAGE`), running `node src/sandbox/sandbox-main.ts` as `node`.
- `init: true`, `restart: unless-stopped`, json-file logs 10m×3, `stop_grace_period: 15s`.
- Its environment is an allowlist: `SANDBOX_*`, `SITE_ORIGIN`, `NODE_ENV`, and a fixed set of runtime variables. The service refuses to start with anything else, such as the stack env file.
- `SITE_ORIGIN` must be one exact origin.
- The field station gets `SANDBOX_API_URL=http://sandbox:7620`, the same token, and `SANDBOX_SLOTS` (1 to 3).

**Health.** `GET /healthz` on `127.0.0.1:7620` answers 200 only while the workbench seam is available and at least one slot can serve. Otherwise it answers 503.

**Ports.**
- 7620 is the sandbox API.
- 7601 to 7603 are the slot development gateways.
- Each study's management handler is on 127.0.0.1 inside the container, with a per-study key.
- No port is published.

**Network.** The sandbox is on the default Compose network today. It holds no Kafka, field-station or Lab credentials, but it can reach those services. Only `caddy` (to 760N) and `field-station` (to 7620) need to reach it, so a dedicated network would shrink this.

**Ingress.** Standalone `Caddyfile` and `Caddyfile.local-lab` only:
- `/sandbox/{1,2,3}/socket.io/*` for the exact site Origin; anything else gets 403, and the rest of `/sandbox/` gets 404.
- A 72 KB body limit on `/api/sandbox/wb/v1/config/*`. The rest of `/api/*` stays at 8 KB.
- `X-Client-IP` must be the real visitor address, because places and budgets key on it:
  - 2 places per address, across the Lab and the sandbox;
  - 20 burst and 3/s per address;
  - per session, a burst of 8 operations, then 2/s.
- `Caddyfile.shared` has none of these routes.

**Resource limits.** None are set, and `compose.shared*.yaml` has no sandbox entry. Measured on the local stack (`docker stats`):

| | Memory | CPU | PIDs |
| --- | --- | --- | --- |
| Sandbox | 53 to 69 MiB | under 0.2% idle, up to 3.3% in a live session | 12 to 18 |
| Field station, for comparison | 60 to 72 MiB | 4 to 5% (its own simulation) | |

At peak there are 3 slot gateways during resets.

**Timeouts, ordered.**
- 3 s: the field station's status poll and lifecycle calls.
- 10 s: the service's slot call (a timeout is a retryable 504 and keeps the lease).
- 15 s: the field station's ops and repro calls.
- The pool never holds a lock across a service call, so a hung service doesn't stall other visitors. The real stack proved this with a paused-service test.

**Gaps before any hosted sandbox** (all in the rollout plan):
- a shared-host overlay with cgroup parent, cpus, `mem_limit` and `pids_limit`;
- a dedicated network;
- shared Caddy routes, with the 72 KB config limit;
- adapter tests;
- a capacity decision (ADR-04 defaults: 3 slots, 600 s leases, a 30-place queue).

## 3. `SANDBOX_SERVICE_TOKEN`: creation, storage, rotation

- **Creation:**
  - `deploy/make-secrets.sh` writes `openssl rand -hex 32` into new env files only.
  - `npm run dev:lab` appends it once to an older local env file.
  - `OPERATIONS.md` shows the manual append, for the standalone layout and local stacks only.
  - Under the rollout plan, no token is created on the shared host in either phase.
- **Storage:** the env file (umask 077), then the container environment. Anyone with Docker access can read it (`docker inspect`). It travels in cleartext on the Compose bridge. The service and the field station refuse a token under 32 characters.
- **Rotation:** there is no overlap between two tokens. Replace the value and recreate `field-station` and `sandbox` together. Every sandbox session ends: the field station returns all slots on start, and a new service boot ends leases as `sandbox-restarted`. Schedule it as a short sandbox outage.

## 4. Kafka permissions: least-privilege additions and migration

Each bench gets two additions, all ALLOW, host `*`, principal `User:lab-N` (`deploy/kafka/start.sh:231-232`):

| Resource | Pattern | Operations | Why |
| --- | --- | --- | --- |
| topic `lab-N.quarantine` | literal | DescribeConfigs | The quarantine writer checks the topic's `max.message.bytes` at gateway start; without it the bench's gateway refuses to start |
| group `streamotter-lontra-creek-lab-N-quarantine-read-` | prefixed | Read, Delete | Evaluation and redrive read evidence back through a throwaway group, which is deleted after use and swept on reset |

These were the only two authorizer denials on the real stack. `maxSourceRecordBytes` is 262144, which fits the broker default, so no topic setting changes.

**Migration behavior.**
- The bootstrap only adds grants, and it is idempotent: it lists the existing grants, then adds what is missing.
- An ACL broker picks the grants up on its next `kafka/start.sh` start. The `migrate` check in OPERATIONS.md now expects 19 grants with three benches.
- The grants are added whatever the profile; under `retry` and `off` they go unused.
- A broker at `none` (the hosted broker in both phases) is untouched.
- Nothing weakens existing authorization.

**Notes.**
- The production gateway's existing group prefix `streamotter-lontra-creek-` also covers the new read-group names. That is harmless, because the gateway can't read `lab-N` topics; it is documented in Lab contract §10.9.
- On rollback of an ACL broker, the six grants stay until someone removes them by hand (`kafka-acls.sh --remove`). The previous release's exact-listing check fails until then.

## 5. Upgrade and downgrade: journal and data compatibility

**Production gateway.** It runs without `failureHandling` in both phases, so it keeps no failure journal that a downgrade could strand. Field-data checkpoints and ledger formats are unchanged.

**Lab benches** (only with a `lab.enabled` release, which neither phase has):
- Each study gets a SQLite failure journal in its `lab-N-state` volume. The directory is 0700 and the files 0600.
- The first deploy with `retry` or `quarantine` discards each bench's persisted study and provisions a new one.
- A graceful stop releases the journal lock.
- A restart in place (same hostname) resumes the study.
- A container recreated after a kill gets a new hostname, so StreamOtter can't check the old lock and the bench comes back `failed`. The field station's reset then discards that study, and the bench is ready again in about a minute. Every recreate-style deploy ends running leases.
- On a downgrade to rc.3 with the Lab on, journal directories are left behind, and open studies resume without failure handling. The rc.3 study parser tolerates the new fields.
- The field station and the benches must share one `LAB_FAILURE_HANDLING`. The code defaults to `off` and `compose.lab.yaml` defaults to `retry`, so deploy them together.

## 6. The image-build guard and rc.3-first sequencing

- The guard exists only on the phase 2 branch and passes an rc.3 registry layout, so phase 1 (#40, #41) is unaffected.
- While `vendor/` is present:
  - `images.yml` and `site.yml` refuse to build;
  - `release-pins.yml` refuses a pull request into `main`, including one retargeted onto `main`;
  - so the vendored branch can be tested but not merged to `main`. That protects phase 1 rebuilds and the site's "re-run from the previous main commit" rollback.
- The guard checks the package source (exact version, registry lockfile, no `vendor/`, no `file:` specs or overrides). It doesn't check which version. Two other things stop early use of the published packages:
  - The capability summary offers a scenario only for the exact packages and profile its real-Kafka run proved. A unit test fails until the suite is re-run on the registry install and the evidence re-recorded.
  - A test ties the site recordings' install label to the lockfile.
- It enforces no rollout order: phase 1 acceptance before phase 2, and backend before site, stay operator holds in the plan.

## 7. Pages: headers and CSP acceptance

`apps/site/public/_headers` sends three headers on `/workbench/*`:
- `X-Frame-Options: DENY`
- `Content-Security-Policy: frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`

The page's meta CSP is built from `PUBLIC_FIELD_STATION_ORIGIN` at build time, which must equal the field station's `GATEWAY_PUBLIC_ORIGIN`. Otherwise the page refuses to mount and says why. The workbench assets are served at `/workbench/assets/0.2.0-rc.1/` with SRI from the installed manifest.

`npm run check:site` verifies the policy in every build, and CI now also runs the workbench browser specs against production bundles. The phase 2 acceptance on the preview and production deployments is in the rollout plan:
- the three headers;
- `connect-src` naming `https://demo.streamotter.dev` and `wss://demo.streamotter.dev`;
- `app.js` answering 200 as JavaScript;
- `/workbench/` reading "not enabled".

Not verified anywhere yet:
- `_headers` on Cloudflare Pages itself, and whether `/workbench/*` also matches `/workbench/`;
- the cross-origin `apiOrigin` path;
- the production Caddyfile's 72 KB limit end to end;
- Firefox and WebKit on the real stack.

## Changes to sequencing, prerequisites and rollback

The rollout plan records each of these.

**Sequencing:**
- Phase 2 rolls back Pages first, then the backend.

**Prerequisites:**
- The phase 2 pin PR now requires, after publish:
  - re-running the real-Kafka exercise suite and the sandbox suites on the registry install, and re-recording the evidence;
  - recapturing the recordings;
  - re-checking the tag anchors;
  - all PR workflows green on both architectures.
- The draft PR is the branch's first CI run.
- Any hosted sandbox needs the shared overlay, limits, routes, adapter tests and a capacity decision (section 2).
- Any hosted Lab needs a matching `LAB_FAILURE_HANDLING` on both sides and a measurement of the journals under shared bench limits (section 5).

**Rollback:**
- An ACL broker keeps the new grants after a rollback until they are removed by hand (section 4).
- Never roll the site back to a pre-#41 build.
