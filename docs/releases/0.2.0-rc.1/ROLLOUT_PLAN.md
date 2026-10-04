# Rollout plan: StreamOtter 0.2.0-rc.1, Lontra Creek V1.1, streamotter.dev

Prepared 2026-10-04 for the devops team. Checked against `jfricano/StreamOtter` (#56 head `4e67ef8`) and `jfricano/lontra-creek` (#40 head `d5c1b7b`, plus draft #41). Nothing here has been run against production. The live hosts were not reachable from where this was written, so what is running today is not verified.

## What ships, and what is decoupled

| Component | Source | How it deploys | StreamOtter version it uses |
| --- | --- | --- | --- |
| npm packages (6) | StreamOtter #55 → #20 → #56 | Manual publish from jason's machine ([StreamOtter `docs/RELEASE_CHECKLIST.md`](https://github.com/jfricano/StreamOtter/blob/main/docs/RELEASE_CHECKLIST.md)) | is 0.2.0-rc.1 |
| Demo backend (Oracle host) | Lontra Creek `main` after #40 + #41 | `images.yml` builds `ghcr.io/jfricano/lontra-creek:<sha>` on push to main; `Deploy demo` (manual, one full SHA) | Pinned exactly in Lontra's lockfile: `0.1.0-rc.3` until the pin PR |
| streamotter.dev site | Lontra Creek `main` | `Deploy static site` (manual, preview or production) to Cloudflare Pages | Same pin, bundled into the site |

The key fact: Lontra Creek pins `streamotter` exactly (`apps/field-station` and `apps/site`, `0.1.0-rc.3`). Publishing 0.2.0-rc.1 changes nothing on the demo or site until a Lontra Creek PR moves that pin. So the three components can roll out one at a time, and each has its own rollback.

## Blocker found: the domain

The site is meant to be streamotter.dev, but Lontra Creek still names streamotter.app in the production gateway config (`apps/field-station/streamotter.production.json` `allowedOrigins`, baked into the image), the field station and Lab defaults, Caddy's Origin guards, `site.yml`'s `PUBLIC_FIELD_STATION_ORIGIN`, canonical URLs, robots.txt and the social card. A live view from streamotter.dev would be refused. Draft PR **lontra-creek #41** (stacked on #40) renames all of it. It must be in the image and the site build that go to production.

## Configure first (one time, before any deploy)

GitHub (jfricano/lontra-creek → Settings):

- Environments with required reviewer (jason) and `main`-only branch rules: `registry`, `production`, `preview`.
- Secrets: `DEPLOY_HOST`, `DEPLOY_KEY` (separate restricted key, never a login key), `DEPLOY_KNOWN_HOSTS` (full line from the server console, not `ssh-keyscan`), `CLOUDFLARE_API_TOKEN` (Pages deploy only).
- Variables: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`.
- Enable switches, last, after the above: `LONTRA_IMAGES_ENABLED=true`, `LONTRA_DEPLOY_ENABLED=true`, `LONTRA_SITE_ENABLED=true`. All three workflows silently skip without them.
- GHCR: set `ghcr.io/jfricano/lontra-creek` to public (the host pulls without credentials) and a retention rule that keeps at least the current and previous SHA tags.

Cloudflare:

- DNS: `demo.streamotter.dev` A record to the Oracle IP, proxied. Apex `streamotter.dev` on the Pages project as a custom domain.
- SSL/TLS: Full (strict). An Origin certificate for `streamotter.dev` and `*.streamotter.dev`.
- Pages: a Direct Upload project with `main` as its production branch (the workflow does not create it).
- If the old `.app` hosts are live, add a 301 redirect rule from `streamotter.app/*` and `demo.streamotter.app/*` to the `.dev` names once the `.dev` stack is verified.

Oracle host:

- Re-run `deploy/setup.sh` from an audited checkout that includes #41, with the new `.dev` origin certificate (setup checks the host name `demo.streamotter.dev`). It keeps the existing epoch, secrets and Kafka CA.
- In `/srv/lontra/stack.env`, any `SITE_ORIGIN`, `DEMO_HOST` or `GATEWAY_PUBLIC_ORIGIN` override must use the `.dev` names (or be removed so the new defaults apply).
- Leave `KAFKA_AUTHORIZATION` unset (`none`) for this rollout. Moving the hosted broker to ACLs is a separate, owner-approved maintenance window (`deploy/OPERATIONS.md`, Kafka authorization).
- Leave the Lab overlay off (no `lab.enabled` marker) unless jason approves public benches. If it is enabled, #40 adds `LAB_STATE_DIR` and three new `lab-N-state` volumes; nothing to create by hand.
- Confirm which topology the host runs. `lontra-deploy` uses `compose.yaml` (+ `compose.lab.yaml`). The shared-host overlay (`compose.shared.yaml`, `Caddyfile.shared`) is not applied by that script; if the host is the shared iYosi/Roost box, agree how its overlay is applied before the first deploy.

## Sequence

### Step 1. StreamOtter 0.2.0-rc.1 to npm (owner)

1. jason merges #55, then #20, then #56. CI on main: `Verify (Node 24)` and `Verify (Node 26)` green.
2. Run the `Extended checks` workflow by hand on main (Kafka, install, browser, deploy tiers); it otherwise runs only nightly.
3. Follow StreamOtter's [`docs/RELEASE_CHECKLIST.md`](https://github.com/jfricano/StreamOtter/blob/main/docs/RELEASE_CHECKLIST.md) steps 1 to 6: `node scripts/release/set-version.mjs 0.2.0-rc.1` (the manifests are still `0.1.0-rc.3`), date the CHANGELOG entry, full suite, dry run, tag `v0.2.0-rc.1`, publish all six with `--tag latest`.
   The step-by-step release handoff is [docs/releases/0.2.0-rc.1/RELEASE_HANDOFF.md](https://github.com/jfricano/StreamOtter/blob/feat/v1.2-quality-fixes/docs/releases/0.2.0-rc.1/RELEASE_HANDOFF.md).
4. Smoke: `npm dist-tag ls streamotter` shows `latest: 0.2.0-rc.1` for all six; `STREAMOTTER_INSTALL_FROM=registry pnpm test:install` passes.

Note: publishing with `--tag latest` (the checklist's rule until the first stable version) moves every unpinned `npm install streamotter` to 0.2.0-rc.1. Two changes can refuse a config or request that rc.3 accepted (the `maxControlFrameBytes` minimum, and production answers to invalid subscribe parameters; see the CHANGELOG).

Rollback: never unpublish. `npm dist-tag add <pkg>@0.1.0-rc.3 latest` for all six, then `npm deprecate <pkg>@0.2.0-rc.1 "<reason>; use 0.1.0-rc.3"`, and fix forward as 0.2.0-rc.2. The demo and site are unaffected (pinned).

### Step 2. Lontra Creek V1.1 backend (still on StreamOtter rc.3)

1. jason merges #40 and #41 (or #41 folded into #40). CI green on main.
2. `Images` builds and pushes `ghcr.io/jfricano/lontra-creek:<full main SHA>` for amd64 and arm64. Record the SHA and the arm64 digest.
3. Before deploying: take a world checkpoint and record the current SHA.
   ```sh
   sudo /usr/local/sbin/lontra-checkpoint backup
   sudo cat /srv/lontra/current.sha
   ```
4. Dispatch `Deploy demo` from main with that full SHA; approve the `production` environment. The host pulls the tag and waits up to 300 s for health; on failure it restores the previous release by itself and the job fails.
5. Smoke:
   - `sudo /usr/local/sbin/lontra-health` passes.
   - `curl -s https://demo.streamotter.dev/api/config -H 'Origin: https://streamotter.dev'` answers with `gatewayOrigin: https://demo.streamotter.dev` and `Access-Control-Allow-Origin: https://streamotter.dev`.
   - The same request with `Origin: https://streamotter.app` gets no CORS allow header.
   - `sudo grep -H "^KAFKA_AUTHORIZATION=" /srv/lontra/stack.env /srv/lontra/current.env` prints nothing or `none` (expected for now).

Rollback: dispatch `Deploy demo` with the previous SHA, or on the host `sudo /usr/local/sbin/lontra-deploy "$(sudo cat /srv/lontra/previous.sha)"`. This does not roll back Kafka data or study history; never use `down --volumes`.

### Step 3. streamotter.dev site (same day as step 2)

The new backend only accepts the `.dev` origin, so deploy the site right after step 2.

1. Dispatch `Deploy static site` with `preview`. Check pages, links and the social card on the `pages.dev` preview. The live walkthrough cannot work there (cross-site, `SameSite=Strict` cookie); that is expected, do not loosen CORS to make it work.
2. Dispatch again with `production`; approve.
3. Smoke on https://streamotter.dev:
   - Home live panel connects and revisions advance.
   - **"Drop my connection" really drops it**: revisions and the study clock freeze for at least 5 s while a second tab keeps updating, then "Restore" brings a fresh snapshot. This was the 2026-10-02 production-bundle bug; it is fixed on main by #23 and carried by #40, but it only ever failed in the production bundle, so check it on the real site.
   - `/workbench/` shows the sandbox as not enabled (expected; no sandbox service is deployed yet).
   - `view-source` canonical URL, `/robots.txt` and `/sitemap.xml` name streamotter.dev.
   - With the demo host stopped, pages still load and live panels show the unavailable state.

Rollback: Cloudflare Pages → Deployments → roll back to the previous production deployment (instant), or re-run the workflow from the previous main commit.

### Step 4. Lontra Creek on StreamOtter 0.2.0-rc.1 (after step 1 is on npm)

1. The Lontra Creek V1.1 thread opens a small PR pinning `streamotter@0.2.0-rc.1`, clearing the three tripwire tests and re-running the Lab security checks. jason merges.
2. Repeat step 2 (new image SHA, checkpoint, `Deploy demo`, smoke) and step 3 (site rebuild, same smoke).

Rollback: redeploy the step 2 SHA and roll Pages back to the step 3 deployment. Both still run rc.3.

## After the rollout

- Enable timers: `sudo systemctl enable --now lontra-checkpoint.timer lontra-health.timer`. They log only; route failures to a real notification channel, and apply the OCI alarm definitions (`deploy/operations/alarm-definitions.mjs`) so a dead host is noticed.
- Off-host encrypted backups are still an open owner decision; world checkpoints are not disaster recovery.
- A fresh full Lontra Creek review starts once 0.2.0-rc.1 is published.
- StreamOtter docs still say streamotter.app in 8 places (`docs/RELEASE_PLAN.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/WEBSITE_AND_DEMO_PLAN.md`, the workbench host contract docs, tests and examples). Not in any package README or manifest, so it does not affect npm; fold it into the release docs pass.
