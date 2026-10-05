# Lontra Creek full review, October 5, 2026

**Reviewed:**
- `main` at `d6e426a` (phase one: StreamOtter 0.1.0-rc.3, Lab and sandbox off, `KAFKA_AUTHORIZATION=none`);
- PR #42 at `61184c1` (phase two: `streamotter@0.2.0-rc.1` from npm, source-failure exercises, workbench mount, release-pin guard).

**Result:** no blockers. 7 major and 24 minor findings, of which 2 majors and 5 minors were found twice by different reviewers, which leaves 5 distinct majors and 19 distinct minors.
- Every finding on `main` is fixed on `review/full-2026-10-05` (this branch).
- Every #42-only finding is fixed on the proposal branch `review/full-2026-10-05-pr42` (#42 plus these fixes); #42's own branch is untouched.
- Each code fix has a regression test that fails without it.
- Nothing here merges before phase-one acceptance; `main` stays at `d6e426a` until production Pages is live.

Six reviewers who did not write the code each took one area. Each reported findings with a concrete failure scenario and a repro, plus what they checked and found correct. Their full reports are in [2026-10-05/](2026-10-05/). The repro scripts named there were scratch files and are not committed; the regression tests are.

| Area | Report | Major | Minor |
| --- | --- | --- | --- |
| Field station core and simulator | [CORE.md](2026-10-05/CORE.md) | 3 | 2 |
| Lab backend | [LAB.md](2026-10-05/LAB.md) | 0 | 5 |
| Workbench sandbox and mount | [SBX.md](2026-10-05/SBX.md) | 0 | 2 |
| Site and browser code | [SITE.md](2026-10-05/SITE.md) | 1 | 4 |
| Deploy, CI and tooling | [OPS.md](2026-10-05/OPS.md) | 1 | 7 |
| Security (attacker's view, all areas) | [SEC.md](2026-10-05/SEC.md) | 2 | 4 |

## What matters for the rollout

- **Phase one is clear.** On main's production build, every phase-one acceptance check in the rollout plan passes:
  - the live panel, and Drop and Restore;
  - the Lab and the workbench reading as unavailable;
  - canonical URLs, `robots.txt` and `sitemap.xml`;
  - the backend-down state.

  The image labels, published ports, Caddy guards, env names and approval gates are all correct (OPS, "Checked and found correct").
- **Don't run `deploy/test/shared-host/rehearse.sh` on the shared host (OPS-1).** It uses the production project and network names. On that host its network create always fails, and its exit trap then runs `down --volumes` on `lontra-creek`. It is safe only on a disposable CI runner. The fix (`245e77f`) makes it refuse any host with a Lontra install.
- **The site's install command is unpinned on main (SITE-1).** `npm install streamotter` now installs 0.2.0-rc.1, because `latest` moved on October 5, while the same pages describe 0.1.0-rc.3. #42 already pins it, so phase two corrects it. `4572a33` is the main-side fix, if Jason wants it before phase two.
- **One badge, or one IPv6 /64, can lock other visitors out (CORE-1, CORE-2).** One badge could hold all 300 gateway connections, and one IPv6 /64 could fill all 5,000 notebook places. Both are fixed in code here (`55d729c`, `bf2b07b`).

  A per-address limit on WebSocket upgrades still belongs at the edge: a Cloudflare rate-limiting rule on `/streamotter/socket.io`. That is a hosting setting, not a code change.
- **The shared overlay's health checks don't fit its CPU caps (OPS-2, OPS-3).** Kafka's check uses most of its 0.35 CPU. The field station's health window is too short for a catch-up of more than about two weeks at 0.18 CPU.

  Both are tuned here (`ba93a8f`). Devops's own adapter should get the same change.

## Major findings

| ID | What was wrong | Fix (`main` branch / #42 proposal) |
| --- | --- | --- |
| CORE-1 = SEC-1 | One badge could open all 300 gateway connections, refusing every other visitor with `OVERLOADED`. | `55d729c` / `4f48753`: a badge opens at most two connections. The edge rate limit is still to set. |
| CORE-2 = SEC-2 | One host with an IPv6 /64 filled the 5,000 open-notebook cap in about 7 s, so every sighting got 503 (2026-10-02 F2). | `bf2b07b` / `77a9319`: IPv6 is counted by /64, with at most 20 open notebooks per client address. |
| CORE-3 | A failing hourly checkpoint stopped every creek publish while `/healthz` stayed green (2026-10-02 F1). | `47a69fd` / `ab14c10`: flush in a `finally`. |
| SITE-1 | Main's pages say `npm install streamotter`, which now installs 0.2.0-rc.1, beside rc.3 labels and "V1.1 not released" copy. | `4572a33` (main only; #42 already pins it). |
| OPS-1 | `rehearse.sh` on the shared host deletes the production `lontra-creek` volumes. | `245e77f` / `b9f77cb`: refuses a host with a Lontra install, and sets its trap only after creating its network. |

## Minor findings

| ID | Finding | Fix (`main` branch / #42 proposal) |
| --- | --- | --- |
| CORE-4 = OPS-3 | At 0.18 CPU, a catch-up of more than about two weeks outlasted the field station's health window, so `up --wait` failed. | `ba93a8f` / `6a74245` (`start_period: 900s` on the shared overlay) |
| CORE-5 = SEC-6 | Session subjects had 32 random bits, so sessions could collide and share a notebook. | `b542635` / `acd53d6` |
| OPS-2 | Kafka's JVM health check every 10 s used most of a 0.35 CPU cap. | `ba93a8f` / `6a74245` (every 60 s on the shared overlay) |
| OPS-4 = SEC-5 | `site.yml` exposed the Cloudflare token to install scripts, tests and the build. | `81c6842` / `381f9fc` |
| OPS-6 | The backup hooks refuse a 0644 `deploy.lock`, and no doc said which mode it needs. | `16b0fba` / `3043f22` (docs) |
| OPS-7 | The shared-host docs got secrets permissions and `KAFKA_HEAP_OPTS` wrong; the acceptance `curl -s` shows no headers. | `16b0fba` / `3043f22`. The rollout plan lines are for the rollout thread. |
| OPS-8 | Stale relay-token recovery steps (2026-10-02 L11). | `16b0fba` / `3043f22` |
| SITE-2 | The home panel never retried `/api/config` after a failure, while saying it was still trying. | `a4d3500` / `d52fed7` |
| SITE-3 | `/lab/` rewrote its polite status region every 10 s with the same text. | `edbcb80` / `ac1e268` |
| SITE-4 = SEC-3 | No framing protection or `nosniff` outside #42's `/workbench/` (2026-10-02 L9). | #42 only, `ce77e40`: one `/*` rule in `_headers`, checked by `check:site`. Main has no `_headers`, and adding one there would conflict with #42's. |
| SITE-5 | Static copy said the Lab "Runs" on a deployment where it is off. | `97ada18` / `70ec73f` |
| LAB-1 | After a gateway restart, the bench still offered an approval token for a plan the library had lost. | #42 only, `d571887` |
| LAB-2 | The recovery guard could ask about a record before its coordinates were recorded, so recovery was held as `unknown-record`. | #42 only, `54d96bc`: waits up to 3 s for in-flight publications. |
| LAB-3 | `deployment-restricted` blamed Kafka authorization, which the field station never reads. | #42 only, `797d021`: names the profile, and documents that `quarantine` needs `acl`. |
| LAB-4 | A bench with another failure-handling profile was reset every 30 s forever, with no log line. | #42 only, `b52c00e` |
| LAB-5 | `lab-api.md` still described the pre-publish `vendor/` pack. | #42 only, `844516b` (docs) |
| SBX-1 | A role switch orphaned the browser's sandbox or Lab place until its idle limit. | #42 only, `4a99d12`: the old place ends as `session-ended`. |
| SBX-2 | A grant to an expired session took a clean slot out of service for 30 s. | #42 only, `2de06f6` |
| SEC-4 + OPS-5 | The release-pin guard missed npm aliases, nested overrides, a shrinkwrap, off-release tarballs and non-registry `resolved` values. Its comment overstated what it protects. | #42 only, `4e89228`, `f9c6a61` |

## Verification

- **This branch:**
  - `npm test` passes 303/303 and `npm run typecheck` passes.
  - The site builds and `check:site` passes.
  - Playwright passes 97/97 in production mode.
- **#42 proposal:**
  - `npm test` passes 457/457 and `npm run typecheck` passes.
  - The release-pin guard and `check:site` pass.
  - On a fresh `npm run dev:lab` stack (quarantine, ACLs on), the real-Kafka suites pass:
    - source failures 11/11, run twice, with 0 authorizer denials;
    - sandbox 7/7;
    - Kafka ACLs 6/6;
    - Lab 7 of 8 passed, none failed.

## Left open (not code)

- An edge rate-limiting rule on `/streamotter/socket.io` per client address. This is a Cloudflare or shared-edge setting.
- Make "Release pins" a required check, and protect `.github/workflows/` and `scripts/check-release-pins.mjs` with code-owner review. These are repository settings.
- Rollout plan lines owned by the rollout thread:
  - acceptance `curl -s` should be `curl -si`;
  - state `deploy.lock` as root:root 0600.
- The exact phase-one Compose combination (base plus shared, `KAFKA_AUTHORIZATION=none`) has never been started in CI. The live rehearsal should use exactly that.
- `images.yml` builds arm64 under QEMU while every test runs natively on arm64. This is not known to differ, but nothing exercises that build path.
- Stale copy that needs a decision:
  - the og:image alt text and the social card still show the unpinned command;
  - "The API may change before 0.1.0";
  - the When-it-breaks "Planned" section.
- After SBX-1, the workbench says "Your browser session expired." after a role switch, which is slightly off.
