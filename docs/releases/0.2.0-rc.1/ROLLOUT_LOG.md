# Rollout log: phase one (Lontra Creek V1.1 on StreamOtter 0.1.0-rc.3)

This log records what has actually happened in phase one of the [rollout plan](ROLLOUT_PLAN.md): sources, digests, manifest hashes, run and deployment IDs, the activation incident, and every re-verification, with the time it was made. The plan says what should happen; this file says what did. Phase two (#42, StreamOtter 0.2.0-rc.1) gets its own section once phase one is accepted.

Execution moved from devops (Codex) to Claude on 2026-10-05 at jason's request, following the devops handoff of 2026-10-04 (Pacific). Times are UTC unless marked.

## Where phase one stands

| Piece | State | Recorded |
| --- | --- | --- |
| StreamOtter 0.2.0-rc.1 on npm | Published on `latest`, all six packages, with provenance. Not used by phase one. | 2026-10-05 03:23 |
| Lontra main | `d6e426a122b81cc3fc576b28bb98f79add45a3de` (#40 with #41) | merged 03:32 |
| Backend image | Published and verified | 03:45 |
| Backend activation | Candidate running and healthy; first attempt failed and was recovered (see Incident) | 05:13 |
| Adapter journal | `awaiting-public-acceptance`; accepted pointer is still the previous release | 05:13 |
| Pages (streamotter.dev) | **Not deployed in this phase.** `site.yml` has never run; production is still the 2026-10-02 build | 05:25 |
| Browser proof on streamotter.dev | **Outstanding** | |
| Adapter `accept` | **Not run.** Phase one is not accepted. | |
| #42 (phase two) | Draft, unmerged, all 12 checks green on `61184c1` | 04:31 |

## Source records

These come from the devops handoff and the devops receipts in `Orca-Solutions/dev-ops` (private). Items marked *re-verified* were checked again from the public GitHub API or registries on 2026-10-05 (see the next section).

**StreamOtter 0.2.0-rc.1**

- Source `fc7f47c7cd642164302f5076581ac02a84325fde`; annotated tag `v0.2.0-rc.1` points to it; [GitHub prerelease](https://github.com/jfricano/StreamOtter/releases/tag/v0.2.0-rc.1) published 2026-10-05 03:28:44. *Re-verified.*
- Publish run [`37253704865`](https://github.com/jfricano/StreamOtter/actions/runs/37253704865), "Approve v0.2.0-rc.1 to npm latest", `workflow_dispatch` on main, successful on attempt 3. *Re-verified.*
- npm: all six packages at `latest` = `0.2.0-rc.1` with a provenance attestation. *Re-verified.* The handoff also records a clean TLS-Kafka registry install test (22 passed). No republish is needed. Publication docs were reconciled in StreamOtter #62 (merged), which superseded #61 (closed, branch kept).

| Package | Integrity of 0.2.0-rc.1 |
| --- | --- |
| `streamotter` | `sha512-Xw9sObzC1vmptYpEDDBOOeaQAkJxbV3oCh8FGpF5/UEGlmSuMbyC7IUSdgpcjTY8AQldhsL5Xe1u916G6K2xNA==` |
| `@streamotter/cli` | `sha512-y8It80MUcxh8d7XtnJdeO5Rpswy1AQ/wE8jvFO92mZPAeKV+CzNnab/TiaknIVssXAA12X4B7s5E3qiZo9ovQQ==` |
| `@streamotter/client` | `sha512-SnsFBGSEKgOPEZOxgpD/viUw5BXwZLtEOYWj4R19RZxgQyXCTpPt/HAsbsPr7YgHKCBB+BMivSiq+N0fw5ECyw==` |
| `@streamotter/contracts` | `sha512-7aCW7zBOenyS0b8j5Jjrr0tk5NW6XjBjtcjdRC1qyYtOka60Wt/5DlVYjVHSO0+sTE4BYKAp9KbdmTBQb9LRTQ==` |
| `@streamotter/gateway` | `sha512-ep6W92ZYpsdH5eommxIv5vQaKyCujyO6vy1/MDbqUJ2n/EZipceGpZ1vEUectNRQcS9o0hdtHmICf5doJv4tFQ==` |
| `@streamotter/workbench` | `sha512-Yn8gCDuho4JAayHVDzekx9DubhPAnn1PlrQ4rmTcEE0ljpIfz2X00A492Y+wCv2zs+l5Sj/17lidxJBjaTao9A==` |

The five `@streamotter/*` packages still carry `next` = `0.1.0-rc.1`; moving it is an owner action and not part of this rollout.

**Phase-one candidate (backend)**

- Source: Lontra main `d6e426a122b81cc3fc576b28bb98f79add45a3de`, intentionally on all six `0.1.0-rc.3` packages (exact pins in `apps/field-station` and `apps/site`, registry lockfile). *Re-verified.*
- Image `ghcr.io/jfricano/lontra-creek:d6e426a122b81cc3fc576b28bb98f79add45a3de`, built by Images run [`37259874010`](https://github.com/jfricano/lontra-creek/actions/runs/37259874010) (push to main, `registry` environment, success). *Re-verified.*
  - Index `sha256:a88855305be507cf8f8d93e40ff117de730a8be41d495d77e418a0e26a4c541a`. *Re-verified.*
  - ARM64 manifest `sha256:16bb87b0fa4e5aa1e96cd129c537445554f0890036023503fddd34b2f39292df`. *Re-verified* (listed in the index, and the manifest bytes hash to it).
  - AMD64 manifest `sha256:8613db0d3cc015dff5c4598669c9c53fb8793357e9de36e0f730838d4c2b6a7a` (from the index; not used on the ARM host).
  - OCI `revision`/`source` labels and the installed rc.3 packages were verified by devops on the host. Not re-read here (see below).
- Candidate manifest `/srv/apps/lontra/manifests/phase1-d6e426a.json`, canonical SHA256 `a19d62b9a5ef45808808fdf60713cee76c9a9cfce8923ed7a4692208855572ca`.
- Previous accepted release: source `4caadffb2a15684d95cf6c95e4f474709acb4ada`, canonical manifest SHA256 `a78d73c24caef73957cd8e831f6a24e7b6936f5e5714678c37917b2dcb7b7228`, pointer SHA256 `560f2526c86783f8a06def47d369ceda2296a05636773b896610be09f2ecf106`.
- Study identity unchanged: `FIELD_EPOCH=2026-10-01T20:24:28Z`, `FIELD_GENERATION=1`, `FIELD_TICK_MS=2000`. Named volumes retained: `lontra-creek_field-data`, `lontra-creek_kafka-data` and two anonymous Kafka volumes. All five peer containers unchanged.
- Installed adapter `/usr/local/sbin/lontra-activate` (root, 0700), SHA256 `a76f02da52a0d0ef3bcc611d48b605dcb4e4c0146becabf64c44656e924d7580`, unchanged by the incident.

**Candidate public checks (devops, 2026-10-05 05:13:49, running candidate `d6e426a`)**

`api_config`, `credentialed_session`, `origin_denial`, `live_websocket_revisions`, `privacy_isolation`, `unauthenticated_notebook_write_denied` and `lab_sandbox_off` all passed, over 4 WebSocket frames. `/lab/socket.io/?EIO=4&transport=polling`, `/api/sandbox` and `/api/lab` answered 404. These are backend checks only; they are not the browser proof the adapter's acceptance needs.

**GitHub settings (devops readback, 2026-10-05 00:58)**

- Environments `registry`, `preview`, `production`: required reviewer `jfricano`, self-review allowed (jason can dispatch and approve his own run), administrator bypass off, deployment branch `main` only, no tags.
- `CLOUDFLARE_API_TOKEN` secret present in `preview` (updated 00:10:31) and `production` (00:09:52). Values never read. Token scope and expiry were not independently read back; the first approved site run is the functional test.
- Variables: `CLOUDFLARE_ACCOUNT_ID` (the existing StreamOtter account), `CLOUDFLARE_PAGES_PROJECT=streamotter-site`, `LONTRA_IMAGES_ENABLED=true`, `LONTRA_SITE_ENABLED` unset, `LONTRA_DEPLOY_ENABLED` unset.

**Cloudflare Pages (devops dashboard readback, 2026-10-04 ~18:02 Pacific)**

- The existing StreamOtter account, Direct Upload project `streamotter-site` (no Git connection), production branch `main`, custom domains `streamotter.dev` and `www.streamotter.dev` Active with SSL.
- Redirect rule "StreamOtter www to apex": 301 to `https://streamotter.dev` + path; a public read at 2026-10-05 01:02 confirmed the query string is kept.
- Current production deployment `01aa1aed-5697-430c-b1d6-95c6f395d477` (`https://01aa1aed.streamotter-site.pages.dev`), deployed 2026-10-02. It is a hand-built upload of Lontra main `a09501c` (#23, the "Drop my connection" fix) with a `.app` → `.dev` source overlay and `PUBLIC_FIELD_STATION_ORIGIN=https://demo.streamotter.dev` (devops record `deployments/streamotter-main-a09501c/manifest.json`, archive SHA256 `f832dace193c56225bd0ee6689781d12c265ca8e92814d34ec44969e9370f6a0`). It is the V1.0 site, so it is the phase-one Pages rollback candidate, but its compatibility with the `d6e426a` backend still has to be confirmed before the upload (see step 2 below). Never roll back to a plain pre-#41 build: `a09501c`'s own `site.yml` names `demo.streamotter.app`.

## Re-verification, 2026-10-05

Done read-only from a Claude cloud session between 05:22 and 05:30. Nothing was dispatched, approved, changed or uploaded.

| Check | Expected | Observed | Result |
| --- | --- | --- | --- |
| Lontra `main` head | `d6e426a…` | `d6e426a122b81cc3fc576b28bb98f79add45a3de` | Match |
| Checks on `d6e426a` | green | 7 of 7 success, including Images `publish` (03:45:01) | Match |
| Runs on `d6e426a` | | Stack `37259873966`, CI `37259874019`, Browser `37259873948`, Images `37259874010`, all success, attempt 1 | Recorded |
| `site.yml` runs | none in this phase | 0 runs ever | Match: no Pages upload has happened |
| `site.yml` on main | dispatch-only, main-only, gated | `workflow_dispatch` with `destination` = `preview`/`production`; job runs only if `github.ref == refs/heads/main` and `vars.LONTRA_SITE_ENABLED == 'true'`; environment `preview` or `production`; Pages branch `staging` or `main`; `PUBLIC_FIELD_STATION_ORIGIN=https://demo.streamotter.dev`; no source-SHA input | Match |
| Site build config on main | `.dev` everywhere | `astro.config.mjs` `site: https://streamotter.dev`; `robots.txt` names `https://streamotter.dev/sitemap.xml`; gateway `allowedOrigins` is only `https://streamotter.dev`; no `streamotter.app` in the site or field-station sources | Match |
| #42 | draft, unmerged, head `61184c1…`, 12 green | draft, open, base `main`, head `61184c1318132273da2540c093bff20a0860c51d`, mergeable `clean`, 12 of 12 success (last 04:31:02) | Match |
| GHCR index and ARM64 digests | as recorded | as recorded (anonymous registry read) | Match |
| npm `latest` and provenance | rc.1 on all six | rc.1 on all six, provenance present | Match |
| StreamOtter release and publish run | `fc7f47c`, run `37253704865` attempt 3 | as recorded | Match |
| devops records | | dev-ops #6 (incident docs, head `5815718`) was merged by jason at 05:22:32 as `b15355e`; the handoff called it a draft | Updated |
| Other open Lontra PRs | | #43 (Claude web-read settings) is open and ready to merge | See the main-branch warning below |

### Not checked tonight, and why

- **Repository variables and environment metadata**, including the current value of `LONTRA_SITE_ENABLED`: the session's GitHub proxy refuses the Actions variables and environments endpoints (HTTP 403). Indirect evidence: Images `publish` ran on `d6e426a` instead of being skipped, so `LONTRA_IMAGES_ENABLED` was `true` at 03:32, and `site.yml` has no runs. The last direct readback (00:58) had `LONTRA_SITE_ENABLED` unset. jason re-reads it in Settings → Secrets and variables → Actions before step 1 below.
- **demo.streamotter.dev and streamotter.dev**: this session's network policy denies both hosts, so no public request was made. The devops candidate checks at 05:13 are the latest public evidence.
- **OCI labels**: GHCR serves image config blobs from a host this session cannot reach. devops verified the labels on the host.
- **Adapter status on the host**: it needs jason's Mac and the pinned SSH config. No Remote Control session for his dev-ops workspace is available.

## Incident: the first phase-one activation failed (recovered)

- **Cause.** Staging ran under umask 077, so the candidate's non-secret directories and public startup files were created 0700/0600. The unprivileged Kafka container could not read its bind-mounted startup script. The byte-hash preflight did not check readability.
- **Automatic rollback did not complete.** It needed `docker exec` into the restarting Kafka container to inspect the broker mode, so it stopped before applying the predecessor and kept the journal as recovery-required.
- **Recovery.** The installed `recover` action restored the accepted `4caadff` release with exit code 0 and no data restore. Four services, five peers, protected hashes, study identity and volumes were verified unchanged, and the restored baseline passed the public checks (05:08:22).
- **Correction and retry.** Candidate non-secret directories were set to 0755 and public files to 0644; `images.env` stays 0600. File bytes and credentials were unchanged. A new read-only staging guard plus isolated unprivileged, network-disabled mount-read checks for Kafka and Caddy passed, and a regression test (`test_lontra_staging_permissions`) rejects 0700 directories, 0600 startup files and a 0644 `images.env`. One corrected retry was cleared; it completed at 05:13 and passed the public checks above. No further retry is authorized by that receipt.
- **Open item.** The supplementary mode gate is not installed into the activation adapter itself.
- **Records.** devops receipt `deployments/lontra-phase1-activation-recovery-20261005.json` and dev-ops #6 (merged). Raw session evidence stays on jason's machine, outside Git.

## Remaining phase-one steps

Every step below waits for jason. Steps 1 to 5 need his go and his GitHub environment approvals; step 6 needs his Mac. Fill in the evidence table as each step completes.

> **Never run `deploy/test/shared-host/rehearse.sh` on the shared host**, even though the plan's phase-one gate 1a.1 points at its CI recipe. Its only guard is `CI=true`. On the host, `docker network create edge-lontra` (line 35) fails because the network already exists, and the cleanup trap set on line 31 then runs `docker compose -p lontra-creek … down --volumes` under the production project name: that deletes the live Kafka and field-data volumes. Line 77 would also overwrite `/etc/apps/lontra/lontra.env`. Every host step below uses only the installed adapter through `lontra_operator.py`. (Found in review of `d6e426a` on 2026-10-05; a guard is being added on a separate branch.)

> **Keep `main` at `d6e426a` until production Pages is deployed.** `site.yml` builds whatever `main` is when it is dispatched, and the candidate manifest is bound to `d6e426a`. Do not merge #43, #45 (the 2026-10-05 review fixes), #42 or this log's PR before step 3 is done. A merge to `main` also starts an Images build that asks for `registry` approval; decline it.

**1. Before the preview (jason, about 5 minutes)**

- [ ] Settings → Secrets and variables → Actions: confirm `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PAGES_PROJECT` as above, `LONTRA_IMAGES_ENABLED=true`, `LONTRA_DEPLOY_ENABLED` absent, and note `LONTRA_SITE_ENABLED`'s current value.
- [ ] Settings → Environments: `preview` and `production` still require `jfricano`, `main` only, and hold a `CLOUDFLARE_API_TOKEN` secret (names only).
- [ ] Lontra `main` is still `d6e426a` (`git ls-remote https://github.com/jfricano/lontra-creek refs/heads/main`).
- [ ] From the dev-ops workspace: `python3 oracle/operations/lontra_operator.py status` still shows the candidate running, healthy, and the journal at `awaiting-public-acceptance` for manifest `a19d62b9…`.
- [ ] Cloudflare → Workers & Pages → `streamotter-site` → Deployments: production is still `01aa1aed…`. Record its ID as the rollback target.
- [ ] Open https://streamotter.dev (today's `01aa1aed` build, talking to the `d6e426a` backend): the home live panel connects and revisions advance. If it does, `01aa1aed` is a compatible phase-one rollback; if it does not, stop and record why before uploading anything.

**2. Pages preview (jason's go, then his `preview` approval)**

- [ ] Set the repository variable `LONTRA_SITE_ENABLED=true`. Leave `LONTRA_DEPLOY_ENABLED` unset.
- [ ] Actions → Deploy static site → Run workflow → branch `main`, destination `preview`.
- [ ] Before approving: the run page shows commit `d6e426a`. If it shows anything else, cancel the run.
- [ ] Approve the `preview` environment. The job runs `npm ci`, typecheck, tests and the site build, then `wrangler pages deploy … --branch=staging`. A failure at the wrangler step most likely means the token's scope; it is fixed in Cloudflare, never by changing the workflow.
- [ ] From the wrangler step's log, record the deployment URL (`https://<id>.streamotter-site.pages.dev`) and the branch alias (`https://staging.streamotter-site.pages.dev`).
- [ ] Check the preview (Claude can do this if the session's network policy allows `*.pages.dev`):
  - `/`, `/field-station/`, `/lab/`, `/playground/`, `/workbench/`, `/when-it-breaks/`, `/releases/`, `/docs/` and a missing path (the 404 page) all load, and in-page links resolve.
  - Page source: `<link rel="canonical">` and `og:url` are on `https://streamotter.dev/…`; the social card image is on `streamotter.dev`; `/robots.txt` names `https://streamotter.dev/sitemap.xml`; `/sitemap.xml` lists only `streamotter.dev` URLs.
  - No page or script names `streamotter.app`.
  - `/lab/` reads "The Lab is unavailable." with Borrow a bench disabled; `/workbench/` says the sandbox is not enabled on this deployment; every source-failure exercise except Fouled sensor reads as waiting for a StreamOtter release.
  - The live panels do not connect on `pages.dev`. That is expected (the session cookie is `SameSite=Strict` and the preview is cross-site). Record it; never loosen cookies or CORS.

**3. Pages production (jason's separate go, then his `production` approval)**

- [ ] Actions → Deploy static site → Run workflow → branch `main`, destination `production`.
- [ ] Before approving: the run shows commit `d6e426a`.
- [ ] Approve `production`. Record the run ID and the new production deployment ID from the wrangler log and the Cloudflare dashboard.

**4. Browser proof on https://streamotter.dev (jason, in his browser)**

Capture each item as a screenshot or recording with a visible timestamp, and keep the files together; their hash becomes `evidence_sha256` in step 6.

- [ ] *credentialed_session*: the home live panel connects (the session cookie is set on `demo.streamotter.dev`), and revisions advance.
- [ ] *live_websocket_revisions*: revisions keep advancing for at least 30 s over a WebSocket (DevTools → Network → WS shows frames).
- [ ] *disconnect_freeze_recovery*: open a second tab on the same page. In the first, click **Drop my connection**: its revisions and study clock stay frozen for at least 5 s while the second tab keeps advancing. Click **Restore**: the first tab shows a fresh snapshot and advances again.
- [ ] *privacy_isolation*: the den location stays withheld (the researcher-only notice shows, as in the 2026-10-02 browser acceptance), and no other visitor's session data is visible. devops's scripted check of the same name passed on the backend at 05:13; repeat it with the browser proof.
- [ ] *origin_denial*, from a terminal:

  ```sh
  curl -si https://demo.streamotter.dev/api/config -H 'Origin: https://streamotter.dev' | grep -i '^access-control-allow-origin'   # https://streamotter.dev
  curl -si https://demo.streamotter.dev/api/config -H 'Origin: https://streamotter.app' | grep -ci '^access-control-allow-origin'  # 0
  curl -si https://demo.streamotter.dev/api/config -H 'Origin: https://example.com'     | grep -ci '^access-control-allow-origin'  # 0
  ```

- [ ] *lab_sandbox_off*: the `/lab/` and `/workbench/` wording from step 2, and `curl -s -o /dev/null -w '%{http_code}\n' 'https://demo.streamotter.dev/lab/socket.io/?EIO=4&transport=polling'` answers 404 (also `/api/sandbox` and `/api/lab`).
- [ ] Redirects: `curl -sI 'https://www.streamotter.dev/releases/?check=1'` answers 301 to `https://streamotter.dev/releases/?check=1`.
- [ ] Canonical, `/robots.txt` and `/sitemap.xml` on the live site name `streamotter.dev`.
- [ ] Backend-unavailable UI: in DevTools → Network request blocking, block `demo.streamotter.dev` and reload. Pages still load and the live panels show the unavailable state. Never stop the shared backend for this.

**5. If anything fails**

Roll Pages back first: Cloudflare → `streamotter-site` → Deployments → `01aa1aed…` → Rollback (only if step 1 showed it works with the running backend). The backend stays on the candidate with its journal pending; inspect it with `status` and follow the installed `recover` path only on devops's procedure. No new activation, backup or phase-two work while the journal is pending.

**6. Adapter acceptance (jason's Mac, pinned SSH)**

From jason's dev-ops workspace, over the pinned SSH config and host alias named in the devops handoff. Read `oracle/operations/README.md` and the installed adapter contract first.

- [ ] Write the evidence record as root, mode 0600, at `/srv/apps/lontra/manifests/phase1-public-acceptance.json`, in the shape of `oracle/operations/templates/public-acceptance.json`: exactly `schema` (1), `manifest_sha256` (`a19d62b9a5ef45808808fdf60713cee76c9a9cfce8923ed7a4692208855572ca`), `operator_verified`, `checks` and `evidence_sha256` (SHA256 of the retained step-4 evidence). `checks` has exactly the six keys from step 4. Every value is `true` only if it was actually observed; nothing is filled in ahead of the proof.
- [ ] `python3 oracle/operations/lontra_operator.py status`
- [ ] `python3 oracle/operations/lontra_operator.py accept --evidence /srv/apps/lontra/manifests/phase1-public-acceptance.json`
- [ ] `status` again: no journal, accepted source `d6e426a`, previous `4caadff`.

**Open decisions from the 2026-10-05 Lontra review (jason; none blocks phase one)**

- [ ] #45 (draft) holds the review's fixes for `main`, including a guard in `rehearse.sh`. Merge it only after step 3, like #43 and this PR.
- [ ] Fixes for #42 are proposed on branch `review/full-2026-10-05-pr42` (#42 plus fixes). Decide whether #42 takes them before merging #42.
- [ ] Cloudflare: add a rate-limiting rule for `/streamotter/socket.io` on `demo.streamotter.dev`.
- [ ] GitHub branch protection on `main`: make the "Release pins" check required.

**After acceptance**

- Refresh and verify recovery bound to the new accepted manifest before any phase-two step (devops's backup workflow, including the disposable restore check).
- Then phase two: re-check #42's head and CI, jason marks it ready and regular-merges (no squash), and the same backend → preview → production → proof → accept sequence runs for the rc.1 candidate.
- Merge this log's PR only after step 3 (main must not move earlier), with the results filled in.

### Evidence

| Step | Item | Value | When | By |
| --- | --- | --- | --- | --- |
| 1 | `LONTRA_SITE_ENABLED` before | | | |
| 1 | Pages rollback target | `01aa1aed-5697-430c-b1d6-95c6f395d477` (to confirm) | | |
| 1 | Today's site works with `d6e426a` backend | | | |
| 2 | Preview run ID / run SHA | | | |
| 2 | Preview deployment ID / URL | | | |
| 2 | Preview static checks | | | |
| 3 | Production run ID / run SHA | | | |
| 3 | Production deployment ID | | | |
| 4 | Six acceptance checks | | | |
| 4 | Redirects, canonical, robots, sitemap | | | |
| 4 | Evidence bundle SHA256 | | | |
| 6 | `accept` result; accepted source after | | | |

## Ground rules for this phase

- jason gives each go: the site switch, the preview, and production separately. GitHub required reviewers, branch rules and the administrator-bypass setting are never bypassed or changed to move faster.
- No backups, new activations or phase-two deployment while the phase-one journal is pending.
- #42 stays a draft and unmerged until phase one is accepted. The Lab and the workbench sandbox stay off; no sandbox token, no Kafka ACL change.
- No 1.0.0 version bump and no npm republish during this rollout.
- Secret values are never read, pasted or logged; only names and timestamps.
- On the host, use only the installed adapter through `lontra_operator.py`. Never run `deploy/test/shared-host/rehearse.sh` there (see the warning above).
- Never stop or restart the shared backend as a test, never `down --volumes`, never use the standalone `/srv/lontra` scripts or the `Deploy demo` workflow, and never loosen cookies or CORS.
