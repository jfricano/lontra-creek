# Rollout plan: StreamOtter 0.2.0-rc.1, Lontra Creek V1.1, streamotter.dev

Prepared 2026-10-04 for the devops team and reconciled the same day with devops's own rollout notes (`dev-ops/domain-rollout.md` and its review handoff, private). Devops's notes are the detailed operational procedure; this file is the shared upstream plan. Checked against `jfricano/StreamOtter` (#55, #20, #56 at `4e67ef8`, and #57) and `jfricano/lontra-creek` (#40 and #41). Nothing here has been run against production, and the live hosts were not reachable from where this was written.

What has actually been run since (sources, digests, run and deployment IDs, the phase-one activation incident) is recorded in the [rollout log](ROLLOUT_LOG.md).

## Ground rules

- **jason's preview hold.** Every merge, npm publication and deployment below waits for jason's explicit go. Nothing in this plan authorizes one.
- **Merges never publish or deploy.** StreamOtter CI only verifies. npm publication is a manual, owner-approved action. Lontra Creek's `images.yml` only builds an image (and only when `LONTRA_IMAGES_ENABLED=true`); activating it on the host is a separate devops step.
- **Shared host, not the standalone layout.** The demo runs on the shared ARM host beside iYosi and Roost, behind devops's shared TLS edge. Use devops's shared-host activation procedure. The standalone `/srv/lontra` scripts (`deploy/setup.sh`, `lontra-deploy`, `lontra-checkpoint`, `lontra-health`) and the `Deploy demo` workflow serve the standalone layout only: do not run them on the shared host, and leave `LONTRA_DEPLOY_ENABLED` unset.
- **Shared-host adapter status.** `deploy/compose.shared.yaml`, `Caddyfile.shared`, `start-caddy-shared.sh` and the backup hooks in `deploy/shared-host/` are tested locally and in disposable CI rehearsals, and devops's prepared shared-host adapter passes its isolated tests, but none of it is installed on the host. The live Docker activation rehearsal on the shared host is still pending and is the first gate of phase 1.
- **Transport.** Activation is operator-triggered over pinned SSH from the operator's address. GitHub-hosted runners cannot reach the host's SSH boundary, so no workflow deploys the backend.
- **Preserve on every step:** data volumes, the study epoch and generation, journals, strict TLS, resource and network boundaries, and the peer services on the host. A healthy container set does not accept a release; only the public acceptance checks below do. Backup and deploy are serialized, and an interrupted activation follows the adapter's recovery rules.

## What ships, and what is decoupled

| Component | Source | How it ships | StreamOtter version it uses |
| --- | --- | --- | --- |
| npm packages (6) | StreamOtter #55 → #20 → #56, publisher #57 | Manual, owner-approved publication (done October 5, 2026) | is 0.2.0-rc.1 |
| Demo backend (shared host) | Lontra Creek `main` | `images.yml` builds `ghcr.io/jfricano/lontra-creek:<sha>`; devops activate that release with the shared-host procedure | Pinned exactly in Lontra's lockfile |
| streamotter.dev site | Lontra Creek `main` | `Deploy static site` (manual, preview then production) to Cloudflare Pages | Same pin, bundled into the site |

Lontra Creek pins `streamotter` exactly (`apps/field-station` and `apps/site`, `0.1.0-rc.3`). Publishing 0.2.0-rc.1 changes nothing on the demo or site until a separate Lontra Creek pin PR moves that pin. So Lontra Creek rolls out in two phases: phase 1 on rc.3, then phase 2 on rc.1. In each phase the backend is activated and accepted before the website is deployed.

## The domain

The site is streamotter.dev. Lontra Creek used to name streamotter.app in the production gateway config (`apps/field-station/streamotter.production.json` `allowedOrigins`, baked into the image), the field station and Lab defaults, the routers' Origin guards, `site.yml`'s `PUBLIC_FIELD_STATION_ORIGIN`, canonical URLs, robots.txt and the social card. A live view from streamotter.dev would have been refused. Lontra Creek #41 (stacked on #40) moves all of it to streamotter.dev and demo.streamotter.dev, and must be in the image and the site build that go live.

## Configure first (one time, before phase 1)

GitHub (jfricano/lontra-creek → Settings):

- Environments with jason as required reviewer and `main`-only branch rules: `registry`, `preview`, `production`.
- Secrets: `CLOUDFLARE_API_TOKEN` (Pages deploy only). Variables: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`.
- Enable switches, last, after the above: `LONTRA_IMAGES_ENABLED=true` and `LONTRA_SITE_ENABLED=true`. Leave `LONTRA_DEPLOY_ENABLED` unset (standalone only).
- GHCR: decide visibility for `ghcr.io/jfricano/lontra-creek` (the host must be able to pull it) and a retention rule that keeps at least the current and previous release images.

Cloudflare:

- DNS: `demo.streamotter.dev` to the shared edge, proxied. Apex `streamotter.dev` as the Pages project's custom domain.
- SSL/TLS: Full (strict). TLS for `demo.streamotter.dev` is terminated by the shared edge, which owns its certificate; Lontra's router mounts none.
- Pages: a Direct Upload project with `main` as its production branch (the workflow does not create it).
- If old `.app` hosts are live anywhere, add 301 redirects to the `.dev` names once the `.dev` stack is accepted.

Shared host (devops, with their procedure):

- The pre-existing `edge-lontra` network, with the shared edge at the agreed peer address (`LONTRA_TRUSTED_EDGE_IP`, default `10.203.43.2`), and Compose 2.24.4 or later.
- `/etc/apps/lontra/lontra.env` (root, 0600): `DEMO_HOST=demo.streamotter.dev`, `SITE_ORIGIN=https://streamotter.dev`, `GATEWAY_PUBLIC_ORIGIN=https://demo.streamotter.dev`, the production secrets, and `LONTRA_SECRETS`, `FIELD_EPOCH` and the other names listed in `docs/SHARED_HOST_READINESS.md` (Ports and environment names). Leave `KAFKA_AUTHORIZATION` unset (`none`); moving the hosted broker to ACLs is a separate, owner-approved maintenance window.
- No `lab.enabled` marker. The Lab benches and the workbench sandbox (W9) stay off in both phases unless jason approves them separately.
- The release layout under `/srv/apps/lontra` (root, 0700): one `releases/<sha>/` directory per release holding `compose.yaml`, `compose.shared.yaml`, `Caddyfile.shared`, `start-caddy-shared.sh` and `kafka/start.sh` from that commit, and `current.env` naming `LONTRA_CONFIG_DIR` and `LONTRA_IMAGE`. Compose files apply as base, then shared (the Lab overlays only with `lab.enabled`). Activation takes `/srv/apps/lontra/deploy.lock`. See `deploy/shared-host/BACKUP.md` for the contract.
- The backup hooks (`deploy/shared-host/`) are installed and accepted by the shared infrastructure owner, per `BACKUP.md`. Until then there is no verified backup of the world checkpoint.

## Sequence

### Step 1. StreamOtter 0.2.0-rc.1 on npm (owner)

Done October 5, 2026: all six packages are on npm at 0.2.0-rc.1 with provenance, on the `latest` tag. The steps below are kept as the record of how it ran.

1. On jason's go, merge #55, then #20, then #56, retargeting each stacked branch to `main` before its merge and refreshing its checks. CI on main: `Verify (Node 24)` and `Verify (Node 26)` green. Run `Extended checks` by hand on main (Kafka, install, browser and deploy tiers, plus the replicated Kafka tier); it otherwise runs only nightly.
2. Reconcile publisher #57 (owner-approved npm trusted publishing, green and unmerged at `b89feb8`) with the merged main, especially its overlapping CI and its release checklist, which replaces the manual one. Merge it only on jason's go.
3. Prepare the release commit: `node scripts/release/set-version.mjs 0.2.0-rc.1` (the manifests are still `0.1.0-rc.3`), date the CHANGELOG entry, full suite. The step-by-step handoff is [docs/releases/0.2.0-rc.1/RELEASE_HANDOFF.md](https://github.com/jfricano/StreamOtter/blob/feat/v1.2-quality-fixes/docs/releases/0.2.0-rc.1/RELEASE_HANDOFF.md).
4. On jason's go, tag `v0.2.0-rc.1` on main and publish all six packages: dispatch `publish.yml` (from #57) on main with the release tag and the distribution tag, then jason approves the `npm-release` environment. Nothing publishes on a push, tag or release event. Direct publishing from jason's machine with StreamOtter's [release checklist](https://github.com/jfricano/StreamOtter/blob/main/docs/RELEASE_CHECKLIST.md) stays allowed. The distribution tag is jason's final choice; `latest` is recommended, and any `next` promotion is a separate step.
5. Verify: all six packages are on npm with provenance and the chosen tag (`npm dist-tag ls`), and a clean registry install passes (`STREAMOTTER_INSTALL_FROM=registry pnpm test:install`). Saved npm trust settings are setup evidence, not proof of publication.

Publishing with `--tag latest` (the rule until the first stable version) moved every unpinned `npm install streamotter` to 0.2.0-rc.1. Two changes can refuse a config or request that rc.3 accepted (the `maxControlFrameBytes` minimum, and production answers to invalid subscribe parameters; see the CHANGELOG).

Rollback: never unpublish. `npm dist-tag add <pkg>@0.1.0-rc.3 latest` for all six, `npm deprecate <pkg>@0.2.0-rc.1 "<reason>; use 0.1.0-rc.3"`, and fix forward as 0.2.0-rc.2. Lontra Creek is unaffected (pinned).

Step 1 can run before, during or after phase 1; phase 2 waits for it.

### Phase 1. Lontra Creek V1.1 on StreamOtter rc.3

**1a. Backend.**

1. Gate: the live Docker rehearsal of the shared-host adapter passes on the shared host (devops's procedure; the CI recipe is in `docs/SHARED_HOST_READINESS.md`, One shared edge).
2. On jason's go, merge #40 and #41 (or #41 folded into #40). CI green on main. `images.yml` builds `ghcr.io/jfricano/lontra-creek:<full main SHA>` for amd64 and arm64; record the SHA and the arm64 digest.
3. Before activating: record the current release (`/srv/apps/lontra/current.env`) and, if the backup hooks are accepted, take a snapshot through them.
4. Activate the new release with devops's shared-host procedure: install `/srv/apps/lontra/releases/<sha>/` from that commit, point `current.env` at it and the new image, and bring the `lontra-creek` project up with base then shared Compose files.
5. Acceptance:
   - Every service in the `lontra-creek` project is healthy, and none publishes a host port.
   - `curl -s https://demo.streamotter.dev/api/config -H 'Origin: https://streamotter.dev'` answers `gatewayOrigin: https://demo.streamotter.dev` with `Access-Control-Allow-Origin: https://streamotter.dev`. The same request with `Origin: https://streamotter.app` gets no allow header.
   - `/lab/1/socket.io/` and any unrouted path on the demo host answer 404 (Lab off).
   - `KAFKA_AUTHORIZATION` is unset or `none` in `lontra.env`.

Rollback: re-point `/srv/apps/lontra/current.env` at the previous retained release and image, and bring the project up again, with devops's procedure. This does not roll back Kafka data or study history. Never use `down --volumes` on the shared host. The production gateway runs without `failureHandling` in both phases, so it keeps no source-failure journal that a downgrade could strand; the Lab benches' study volumes only exist with the Lab on.

**1b. Website (after 1a is accepted).**

1. On jason's go, dispatch `Deploy static site` with `preview`. Check pages, links and the social card on the `pages.dev` preview. The live walkthrough cannot work there (cross-site, `SameSite=Strict` cookie); that is expected, so don't loosen CORS.
2. On jason's go, dispatch with `production` and approve.
3. Acceptance on https://streamotter.dev:
   - The home live panel connects and revisions advance.
   - **"Drop my connection" really drops it.** Revisions and the study clock freeze for at least 5 s while a second tab keeps updating, then "Restore" brings a fresh snapshot. This was the 2026-10-02 production-bundle bug, fixed on main by #23 and carried by #40. It only ever failed in the production bundle, so check it on the real site.
   - The Lab and the workbench sandbox read as unavailable, not as running or broken: `/lab/` says "The Lab is unavailable." with Borrow a bench disabled, and `/workbench/` says the sandbox is not enabled on this deployment. Every source-failure exercise except Fouled sensor stays listed as waiting for a StreamOtter release.
   - The page source's canonical URL, `/robots.txt` and `/sitemap.xml` name streamotter.dev.
   - With the backend stopped, pages still load and live panels show the unavailable state.

Rollback: Cloudflare Pages → Deployments → roll back to the previous production deployment, or re-run the workflow from the previous main commit. Roll the site back only to a build that works with the backend that is running: never to a pre-#41 build, which points at `demo.streamotter.app`.

### Phase 2. Lontra Creek on StreamOtter 0.2.0-rc.1 (after step 1 is verified on npm)

1. The pin PR is [#42](https://github.com/jfricano/lontra-creek/pull/42) (draft, `feat/v1.1-source-failure-exercises`, targeting `main`). Its scope, which needs its own review and devops reconciliation before merge:
   - `streamotter@0.2.0-rc.1` in both apps and the lockfile, the three tripwire tests, capability labels, and the WHC-1 version and integrity facts.
   - `@streamotter/workbench` mounted on `/workbench/`, with a Pages `_headers` policy for it (`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`).
   - A workbench sandbox Compose overlay (`deploy/compose.sandbox.yaml`) with a new `SANDBOX_SERVICE_TOKEN`, routed in the standalone `Caddyfile` and the local Lab's `Caddyfile.local-lab`. `Caddyfile.shared` does not route it, and it has no shared-host overlay or adapter tests yet.
   - A release-pin guard (`scripts/check-release-pins.mjs`) that `images.yml` and `site.yml` run first: it refuses to build while StreamOtter comes from anywhere but the npm registry. The branch's temporary pre-publish tarballs (`vendor/`) were removed on October 5, when the pin commit moved both apps to the registry release.
   Before it merges, after step 1 is verified on npm:
   - Re-run the real-Kafka exercise suite and the sandbox suites against the registry install, and re-record their evidence. A test keyed to the published package integrity enforces this.
   - Recapture the recordings, and re-check the `v0.2.0-rc.1` tag anchors the site links to.
   - Re-run the Lab security checks.
   - Every PR workflow is green on the pin commit itself, on both architectures. #40's and #41's green runs don't carry over, and no CI has run on that branch yet.
   jason merges on his go.
2. Repeat 1a (new image, record the current release, activate, acceptance), then 1b (preview, production, acceptance) with one change to 1b's Lab check: on 0.2.0-rc.1 with the Lab off, every source-failure exercise reads as unavailable on this backend ("This backend has no Lab benches.", or not yet verified against 0.2.0-rc.1), none has a working Start button, and `/releases/` reports 0 of 8 exercises verified. The rc.3 wording ("waiting for a StreamOtter release") no longer applies. On both the preview and production Pages deployments, also check:
   - `curl -sI https://streamotter.dev/workbench/` returns `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff` (on the preview, the same path on its `pages.dev` host).
   - The page's meta Content-Security-Policy `connect-src` names `https://demo.streamotter.dev` and `wss://demo.streamotter.dev`.
   - `/workbench/assets/0.2.0-rc.1/app.js` answers 200 as JavaScript.
   - `/workbench/` says the sandbox is not enabled on this deployment.
3. The pin PR alone does not turn on the Lab benches or the sandbox. The phase 2 release layout carries neither the Lab nor the sandbox overlay, and no `SANDBOX_SERVICE_TOKEN` is created on the host. They stay unavailable on the hosted demo, with accurate labels, until jason approves enabling them: a `lab.enabled` release, and a shared-host sandbox overlay with adapter tests, each with its own acceptance. Any Kafka permission change stays behind the separate, owner-approved authorization migration and never weakens existing authorization.

Rollback, in reverse of the deploy order: roll Pages back to the phase 1 deployment first, then re-activate the phase 1 backend release, so the rc.1 site never talks to an rc.3 backend. Both phase 1 pieces run rc.3.

Before enabling either feature on the hosted demo later (not part of either phase):

- **Workbench sandbox.** The overlay has no CPU, memory or PID limits and shares the default Compose network. It has no shared-host routes. Its config routes need a 72 KB body limit, against the shared `/api/*` limit of 8 KB. There is no rotation procedure for `SANDBOX_SERVICE_TOKEN`. Measured locally: about 53–69 MiB, under 0.2% CPU idle and up to 3% live, 12–18 PIDs.
- **Lab (`lab.enabled`).** The field station and the benches must share one `LAB_FAILURE_HANDLING` (the Compose default is `retry`). The first such deploy resets every bench study and creates per-study SQLite journals, which are unmeasured under the shared bench limits (0.06 CPU, 256 MiB). Recreating bench containers ends running leases: the journal lock names the old host, and a reset recovers in about a minute. On a broker with ACLs on, the six new grants stay after a rollback until removed by hand, and until then the previous release's exact-listing check fails.

## After the rollout

- Route health and backup failures to a real notification channel, through the shared host's monitoring.
- Off-host encrypted backups are owned by the shared infrastructure owner and still need a destination and key-recovery decision. World checkpoints are not disaster recovery.
- A fresh full Lontra Creek review starts now that 0.2.0-rc.1 is published.
- StreamOtter docs still say streamotter.app in a few places (`docs/RELEASE_PLAN.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/WEBSITE_AND_DEMO_PLAN.md`, the workbench host contract docs, tests and examples). None is in a package README or manifest, so npm is unaffected; fold it into the release docs pass.
