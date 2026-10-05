# OPS review: deployment, CI and tooling

Reviewed main at `d6e426a` (`<main checkout>`, phase one) and PR #42 head `61184c1` (`<#42 checkout>`, phase two). Neither worktree was modified. Repros are in `<scratch>/work-ops/` (called `$W` below).

**Summary: 0 blockers, 1 major, 7 minor.**

I found nothing that stops the phase-one image build, the activation as configured (base plus shared Compose files, `KAFKA_AUTHORIZATION=none`, Lab and sandbox off) or the Pages deploy. The image labels, published ports, Caddy Host and Origin guards, env names and approval gates are all correct (see the last section). The one major finding is the shared-host rehearsal script: run on the shared host itself, it deletes the production volumes. Most of the minors are resource or documentation gaps in the shared overlay. The two that matter most before acceptance are OPS-2 (the Kafka health check uses most of Kafka's CPU cap) and OPS-3 (the field station's health window is too short for a long catch-up at 0.18 CPU).

---

## OPS-1 (Major, both): on the shared host, `rehearse.sh` deletes the production `lontra-creek` volumes on its first error

- **Where:** `deploy/test/shared-host/rehearse.sh:4-5`, `20-35`. Unchanged on #42.
- **What is wrong:** the CI rehearsal uses the production project name (`-p lontra-creek`) and the production network name (`edge-lontra`). An `EXIT` trap runs `down --volumes`, `docker network rm edge-lontra` and `sudo systemctl stop lontra.slice`. The trap is installed at line 31, before `docker network create ... edge-lontra` at line 35.
  - The only guards are `CI=true`, a set `RUNNER_TEMP`, and Docker's `systemd` cgroup driver. The shared host meets the cgroup-driver condition by design.
  - On the shared host, `edge-lontra` always exists, so line 35 always fails. `set -e` then fires the trap against the live project.
- **Failure scenario:** the rollout's first phase-one gate is "the live Docker rehearsal of the shared-host adapter passes on the shared host (devops's procedure; the CI recipe is in `docs/SHARED_HOST_READINESS.md`)" (`docs/releases/0.2.0-rc.1/ROLLOUT_PLAN.md:72`). `rehearse.sh` is the repository's implementation of that recipe. Two ways it can run there:
  - An operator runs it by hand and exports `CI=true RUNNER_TEMP=...` to get past "Disposable CI host required."
  - It runs from a self-hosted runner, which sets both variables.

  On a host that has already been activated, the script then:
  1. removes `lontra-creek_kafka-data` and `lontra-creek_field-data`, which loses the world checkpoint and the notebooks;
  2. stops `lontra.slice`, which ends every Lontra container;
  3. tries to remove the shared edge's network.

  The comment on line 2 ("Never on a populated shared server") is the only real protection.
- **Repro:** a fake `docker` and `sudo` on `PATH`, with `edge-lontra` reported as already existing:
  ```
  cd $W/rehearse/repo && FAKE_LOG=$W/rehearse/calls.log CI=true RUNNER_TEMP=$W/rehearse/runner PATH=$W/rehearse/bin:$PATH bash deploy/test/shared-host/rehearse.sh
  exit=1
  docker network create --subnet 10.203.43.0/24 --ip-range 10.203.43.128/25 edge-lontra
  docker compose -p lontra-creek -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.shared.yaml -f deploy/compose.shared.lab.yaml --env-file .../lontra-shared/.env down --volumes
  docker rm -f lontra-shared-edge
  docker network rm edge-lontra
  sudo systemctl stop lontra.slice
  ```
  The fake binaries are in `$W/rehearse/bin/`, and the full call log is `$W/rehearse/calls.log`.
- **Suggested fix (smallest):**
  - Refuse to start if `edge-lontra` already exists, if `/etc/apps/lontra` or `/srv/apps/lontra` exists, or if any volume labelled `com.docker.compose.project=lontra-creek` exists.
  - Move the trap after the network is created.
  - Better still, use a distinct project name (for example `lontra-creek-rehearsal`) and pass it to the backup hook as a parameter rather than sharing the production name.

## OPS-2 (Minor, both): the Kafka health check uses most of Kafka's 0.35 CPU cap on the shared host

- **Where:** `deploy/compose.yaml:49` (the health check command, `interval: 10s`) and `deploy/compose.shared.yaml:8` (`cpus: 0.35`). Unchanged on #42.
- **What is wrong:** every 10 s, the health check starts a new JVM (`kafka-broker-api-versions.sh`, `-Xmx128m`) inside the Kafka container. Measured against a real Kafka 4.1.2 broker:
  - Each run costs about 2.9–3.1 CPU-seconds, also when pinned to one CPU.
  - The broker itself idles at about 0.03 CPU.
  - Docker health-check processes run in the container's cgroup, so they count against its CFS quota.
  - At 0.35 CPU, one check needs at least about 8.6 s of wall time. With the 10 s gap after each check, that is about 0.15–0.3 CPU on average: roughly 45–85% of Kafka's allowance, all the time.
- **Failure scenario:** on the shared host, the broker that every live view and notebook depends on is held near its quota. While a check is running, the whole container is throttled for up to 65 ms in every 100 ms period, which stretches startup and request latency. The CPU-throttling measurement that `SHARED_HOST_READINESS.md` makes an acceptance gate would mostly measure the health check.
  - Under load, a check can approach the 20 s timeout. That fails the check without restarting anything, but it makes Kafka's health status unreliable.
  - The September 27 rehearsal reported memory only, so nothing caught this.
  - Visitor-visible latency is inferred, not measured.
- **Repro:** run `bash $W/measure-kafka-healthcheck.sh`. It downloads Kafka 4.1.2, starts a KRaft broker and times the exact health check command:
  ```
  health check: wall=2.186 s user=2.696 s sys=0.274 s
  health check: wall=2.026 s user=2.588 s sys=0.322 s
  health check: wall=2.054 s user=2.683 s sys=0.292 s
  pinned to one CPU: wall=3.249 s user=2.714 s sys=0.166 s
  ```
  Broker idle CPU over 30 s was 0.96 s.
- **Suggested fix:** in `compose.shared.yaml`, override the Kafka health check with a cheap probe, for example `test -f /tmp/lontra-kafka.ready && bash -c '</dev/tcp/127.0.0.1/9092'`. Alternatively, raise its `interval` to 60 s or more. Then record CPU samples in the rehearsal.

## OPS-3 (Minor, both): at the shared 0.18 CPU cap, the field station's health window allows only about 2 weeks of catch-up

- **Where:**
  - `deploy/compose.yaml:84-90`: field-station health check with `start_period: 60s`, `interval: 10s` and `retries: 6`, so it is unhealthy after about 120 s.
  - `deploy/compose.shared.yaml:17`: `cpus: 0.18`.
  - `apps/field-station/src/server/station.ts:153-157`: `/healthz` returns 503 until the catch-up loop finishes.
- **What is wrong:** with no matching checkpoint, the station replays every tick from `FIELD_EPOCH` before it reports healthy.
  - Measured cost: about 29.8 µs of CPU per tick.
  - At 0.18 CPU, the 120 s window covers about 21.6 s of CPU, or roughly 720k ticks: about 16–17 days of study at 2 s ticks, less process startup.
  - Kafka's `start_period` was raised for the shared cap (300 s, with a comment). The field station's was not.
- **Failure scenario:** two cases start the replay from `FIELD_EPOCH`:
  - a first activation with a new `field-data` volume and an epoch more than about 2 weeks old;
  - any `FIELD_GENERATION` bump later in the study, which `DEPLOYMENT_PLAN.md` requires for history-changing releases.

  In either case the field station turns unhealthy before it catches up, and `compose up --wait` fails with "dependency failed to start". The gateway and the router are never started, so the demo is down until the operator runs `up` again after the station recovers by itself. On the uncapped standalone layout, the same window covers about 90 days.
- **Repro:** `cd $W && node catchup.mjs 43200; node catchup.mjs 345600`:
  ```
  {"ticks":43200,"wallMs":1427,"cpuMs":1770.987}
  {"ticks":345600,"wallMs":9965,"cpuMs":10296.917}
  ```
  The rest is arithmetic: 10.3 s ÷ 0.18 ≈ 57 s of wall time for 8 days of ticks.
- **Suggested fix:** in `compose.shared.yaml`, set the field station's `start_period` to cover a worst-case replay, for example 900s. Document the limit next to `FIELD_EPOCH` and `FIELD_GENERATION`. Optionally, have `/healthz` report catch-up progress.

## OPS-4 (Minor, both): `site.yml` exposes the Cloudflare Pages token to every dependency it runs

- **Where:** `.github/workflows/site.yml:22-24`. The `CLOUDFLARE_API_TOKEN` secret is set at job-level `env`. #42 adds the release-pin step, which also gets it.
- **What is wrong:** the token is needed only by the wrangler step, which already receives it through `with: apiToken`. At job level, it is also in the environment of:
  - `npm ci`, including install scripts such as esbuild's;
  - `npm test`;
  - the Astro build, which runs all build-time integration and plugin code.
- **Failure scenario:** a compromised transitive dependency with an install script or build hook reads `CLOUDFLARE_API_TOKEN` during a production dispatch. It can then push its own build to streamotter.dev, outside the environment approval.
- **Repro:** shown by reading `site.yml:18-27`. Every `run:` step inherits job `env`.
- **Suggested fix:** remove `CLOUDFLARE_API_TOKEN` from job `env`. In "Validate configuration", check `${{ secrets.CLOUDFLARE_API_TOKEN != '' }}` through a step-level env. Keep the token only in the wrangler step's `with:`. Optionally, use `npm ci --ignore-scripts` for the site build.

## OPS-5 (Minor, #42): the release-pin guard misses two ways of installing an unpublished StreamOtter

- **Where:**
  - `scripts/check-release-pins.mjs:21`, `33-38`;
  - `.github/workflows/release-pins.yml:10-11`, `36-43`;
  - `images.yml` and `site.yml`, where the guard runs.
- **What is wrong:**
  1. **`npm-shrinkwrap.json` is not checked.** `npm ci` uses it in preference to `package-lock.json`, but the guard reads only `package-lock.json`.
  2. **Only a `vendor/` directory at the root is flagged.** Tarballs in another directory, such as `third_party/`, pass.
  3. **The lockfile check tests only the `https://registry.npmjs.org/` prefix.** A `node_modules/streamotter` entry that resolves to a different package's tarball on the registry passes.
  4. **The workflow file is not protected.** The workflow's comment says "a pull request can't loosen the guard it is checked by". It does run the base branch's copy of the script. But `pull_request` workflows run the PR's own copy of `release-pins.yml`, so a PR can change or skip the step.
- **Failure scenario:** a pre-publish branch keeps a clean-looking `package-lock.json` plus an `npm-shrinkwrap.json` that points at `file:third_party/streamotter-*.tgz`. `release-pins.yml`, `images.yml` and `site.yml` all report "StreamOtter is pinned to registry releases." `site.yml`'s `npm ci` then builds the site from the local tarball. That is exactly what the rollout plan says the guard refuses.
- **Repro:** `node $W/pins/repro-release-pins.mjs`:
  ```
  A shrinkwrap+third_party problems: []
  B foreign registry tarball problems: []
  C npm ci exit: 0
  C installed description: UNPUBLISHED LOCAL BUILD
  C guard problems: []
  ```
  - Case A: the real #42 manifests, plus a shrinkwrap pointing at `file:third_party/...`.
  - Case B: the lockfile's `resolved` points at `streamotter-fork` on the registry.
  - Case C: a real offline `npm ci` installs from the shrinkwrap's local tarball while `package-lock.json` points at the registry. The guard still passes.
- **Suggested fix:**
  - Refuse the build if `npm-shrinkwrap.json` exists, or check it the same way.
  - Require every StreamOtter entry's `resolved` to equal `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz`.
  - Refuse any `file:`, `link:` or `git` `resolved` value anywhere in the lockfile, rather than only under `vendor/`.
  - Protect `.github/workflows/` and `scripts/check-release-pins.mjs` with CODEOWNERS, and make "Release pins" a required check.
  - Correct the comment.

## OPS-6 (Minor, both): the backup hooks refuse a `deploy.lock` with the usual 0644 mode, and the contract doesn't say what mode it needs

- **Where:**
  - `deploy/shared-host/backup.py:209-213`: `secure(lock_path)` requires no group or other permission bits.
  - `deploy/shared-host/BACKUP.md:37` and `ROLLOUT_PLAN.md:49` say only that activation "must acquire" or "takes" `/srv/apps/lontra/deploy.lock`.
- **What is wrong:** if devops's activation creates the lock as usual under root's default umask 022 (for example `exec 9>/srv/apps/lontra/deploy.lock; flock 9`), the file is 0644. From then on, `lontra-snapshot` and `lontra-verify` fail with "Expected root-owned private path". The repository's own standalone `deploy.sh` happens to avoid this because it sets `umask 077` first.
- **Failure scenario:** after the first activation, every scheduled snapshot fails closed. Until someone reads the hook's stderr and runs `chmod 600` on the lock, there is no world-checkpoint backup.
- **Repro:** `python3 -B $W/backup/repro_lock_mode.py` (this patches `ROOT` to a temporary root-owned 0700 directory):
  ```
  lock mode 0o600: ok
  lock mode 0o644: FAILED: Expected root-owned private path: .../srv-apps-lontra/deploy.lock
  ```
- **Suggested fix:** state "root:root 0600" for `deploy.lock` in `BACKUP.md` and in the rollout plan's release layout. Alternatively, have the hook accept 0644 for the lock file only: the lock holds no data, and its parent is already required to be 0700 root.

## OPS-7 (Minor, both): the shared-host docs mislead an operator about secrets permissions, Kafka heap, and one acceptance command

- **Where:**
  - `docs/SHARED_HOST_READINESS.md:161` and `127`;
  - `deploy/compose.shared.yaml:12-14`;
  - `docs/releases/0.2.0-rc.1/ROLLOUT_PLAN.md:78` (main) and `:80` (#42).
- **What is wrong:**
  1. **Secrets permissions.** The readiness doc calls the `LONTRA_SECRETS` directory "Root-only operator files". Kafka (apache/kafka runs as `appuser`, uid 1000) and the node services (uid 1000) read `kafka/broker-keystore.pem` and `kafka/ca.pem` through bind mounts. The standalone `setup.sh:42-44` makes `secrets/kafka` 0755 with 0644 files, deliberately and with a comment.
     - No shared-host doc says how to create the Kafka CA and broker keystore (`deploy/make-certs.sh kafka <dir>`) or what modes they need.
     - The shared host doesn't need `origin/`, but the base compose comment still lists it.
  2. **`KAFKA_HEAP_OPTS`.** It is listed as an operator env name (line 127), but `compose.shared.yaml` hard-codes `-Xms512m -Xmx1536m`. I rendered base plus shared with `KAFKA_HEAP_OPTS=-Xms1g -Xmx1g` in the env file, and the result still had `-Xms512m -Xmx1536m`. A heap change from evidence, as the doc asks for, silently has no effect.
  3. **Acceptance command.** The phase-one acceptance check uses `curl -s ...` to verify an `Access-Control-Allow-Origin` header, but `-s` prints no headers.
- **Failure scenario:**
  - (1) An operator makes the secrets directory 0700 with 0600 files, as "root-only" suggests. Kafka exits with "Cannot read /etc/lontra/kafka/broker-keystore.pem" and the stack never becomes healthy. This fails closed with a clear error.
  - (2) A heap increase never takes effect.
  - (3) The operator cannot see what the CORS check is supposed to show.
- **Repro:** rendering only, no containers started:
  ```
  docker compose -p lontra-creek --env-file $W/compose/lontra.env --env-file $W/compose/current.env -f deploy/compose.yaml -f deploy/compose.shared.yaml config --format json > $W/compose/base.json
  # kafka: "heap":"-Xms512m -Xmx1536m"   (env file: KAFKA_HEAP_OPTS=-Xms1g -Xmx1g)
  ```
- **Suggested fix:**
  - Add a shared-host "Kafka TLS material" step: `make-certs.sh kafka "$LONTRA_SECRETS/kafka"`, the directory 0755, `ca.pem` and `broker-keystore.pem` 0644 (or owned by uid 1000), and `ca-key.pem` 0600 or kept off-host. The protection comes from a 0700 ancestor.
  - Either make the overlay use `${KAFKA_SHARED_HEAP_OPTS:--Xms512m -Xmx1536m}` or drop `KAFKA_HEAP_OPTS` from the shared env list.
  - Change the acceptance command to `curl -si`.

## OPS-8 (Minor, both): L11 from the 2026-10-02 review is still open (stale relay-token recovery instructions)

- **Where:** `deploy/make-secrets.sh:8-14` and `:36`; `apps/field-station/src/lab/proxy-main.ts:6`. The same lines are on #42.
- **What is wrong:** the header's recovery example still tells operators to append `LAB_RELAY_TOKEN` and run `docker compose ... up -d lab-1-kafka`. The script still generates `LAB_RELAY_TOKEN`, and the proxy's comment still names it. Each proxy actually reads `LAB_BENCH_N_RELAY_TOKEN`. On #42, the same heredoc also gains `SANDBOX_SERVICE_TOKEN`, so the stale example sits next to the current one in `OPERATIONS.md`.
- **Failure scenario:** an operator recovering an older env file, for example when enabling the Lab later, follows the header. They add a variable nothing reads. Compose's `:?` then still refuses for `LAB_BENCH_1_RELAY_TOKEN`. This fails closed, but the steps are wrong. Lab is off in both phases, so this is ops-only.
- **Repro:** `grep -n LAB_RELAY_TOKEN deploy/make-secrets.sh apps/field-station/src/lab/proxy-main.ts`.
- **Suggested fix:** as L11 recommended. Change the example to `LAB_BENCH_1_RELAY_TOKEN` and recreate `lab-1-kafka lab-1`. Stop generating `LAB_RELAY_TOKEN`, and fix the proxy's comment.

---

## Not a finding, but worth knowing

- **The exact phase-one configuration has never been started in CI.** That configuration is base plus shared, `KAFKA_AUTHORIZATION=none`, and Lab off.
  - `stack.yml` runs base without the shared overlay, with `acl` and a 3 GB heap.
  - `shared-host.yml` runs the full Lab combination with `acl`. It brings up only the base router (`up --no-deps caddy`) for the Lab-off 404 check.

  I found no divergence that would break it, but the live rehearsal should use exactly this combination.
- **`images.yml` builds arm64 under QEMU.** Every other workflow builds natively on `ubuntu-24.04-arm`, so the published arm64 image comes from a build path no test exercises. There are no native modules in the runtime dependencies (I checked all five 0.2.0-rc.1 packages), so the content should match. Native arm64 runners plus `imagetools create` would remove the difference.

## Checked and found correct

- **Image and labels:**
  - `images.yml` tags `ghcr.io/jfricano/lontra-creek:${{ github.sha }}` and sets `org.opencontainers.image.revision=${{ github.sha }}` and `.source=https://github.com/jfricano/lontra-creek`, for `linux/amd64,linux/arm64`.
  - It runs only for `refs/heads/main` with `LONTRA_IMAGES_ENABLED == 'true'`, in the `registry` environment, with `packages: write` scoped to the job.
  - The GHA cache scope `release` can be written only by this main-branch workflow.
  - `deploy/Dockerfile.dockerignore` is picked up for `file: deploy/Dockerfile`. The Dockerfile copies named paths only and contains no secrets or build arguments.
- **Runtime image:**
  - The final stage runs as `node`, with `/var/lib/lontra` owned by `node`.
  - The gateway command path `node_modules/streamotter/bin/streamotter.js start --config --handlers` exists in both 0.1.0-rc.3 and 0.2.0-rc.1.
  - `streamotter validate` passes `streamotter.production.json` under 0.2.0-rc.1.
  - No StreamOtter 0.2.0-rc.1 package has install scripts or native dependencies.
- **Domain and Origin:** there is no `streamotter.app` reference left in code, deploy or workflow files. The production gateway allows only `https://streamotter.dev`. `site.yml` builds with `PUBLIC_FIELD_STATION_ORIGIN=https://demo.streamotter.dev`.
- **Shared Compose (rendered with Compose 5.3.1, no containers started):**
  - No service publishes a port; `!reset []` removes 443.
  - `!override` leaves Caddy with only `Caddyfile.shared` and `start-caddy-shared.sh`. The origin certificate and `caddy-data` are gone.
  - Only Caddy joins the external `edge-lontra`, with alias `lontra-caddy`.
  - Every service has `cgroup_parent: lontra.slice` and CPU, memory, swap and PID limits that match the readiness tables (3520 MiB, 0.73 CPU, 896 PIDs for the base; 4480 MiB, 1.0 CPU, 1472 PIDs with the Lab).
  - The Kafka heap has no `AlwaysPreTouch`.
  - `KAFKA_AUTHORIZATION` defaults to `none`, and the `none` path of `start.sh` writes the ready file before `exec`.
- **`Caddyfile.shared` and `start-caddy-shared.sh`:**
  - The peer check (`remote_ip` equal to the validated edge IP, else 403) comes before every proxy.
  - The Host check against `DEMO_HOST` returns 404. Caddy's host matcher ignores the port.
  - `/lab/*` returns 404 unless `LONTRA_LAB_ENABLED=1`, which only `compose.shared.lab.yaml` sets.
  - `trusted_proxies` is the single edge IP with strict right-to-left XFF parsing.
  - Identity headers are stripped and XFF and `X-Forwarded-Proto` are regenerated on every hop. Only `/api/*` gets `X-Client-IP`.
  - There is an 8 KB `/api` body cap, and the admin API listens on loopback port 2019, which is what the inherited health check uses.
  - The wrapper rejects empty values, CIDR ranges, lists, leading zeros, octets above 255 and non-dotted forms. An unset variable falls back to the default and an empty one is refused, consistently in Compose and Caddy.
- **Health checks behind the edge:** all four container checks run inside their own containers on loopback, so they don't depend on the edge or the Host check. The node checks cost about 0.03–0.09 CPU-s each.
- **Backup hooks (`backup.py`):**
  - They are read-only against production: `restore` mode runs only in a disposable `lontra-backup-verify-<uuid>` volume, in a `--network none`, `--read-only`, cap-dropped container under `lontra.slice`.
  - They require the exact image ID locally (`--pull never`), and the container and volume are removed in `finally`.
  - The checkpoint is read once from an atomically renamed file.
  - A station restart during capture is detected (comparing `StartedAt`).
  - Docker output is never echoed. Environment and current-env files are parsed literally and fail closed.
  - They take `deploy.lock` with `LOCK_NB`.
  - The file list and Compose order match `BACKUP.md` and the rollout plan's release layout.
  - Python unit tests pass: 7/7.
- **`down --volumes`:** used only in CI workflows, in `rehearse.sh` (OPS-1) and in dev-lab `discard` (typed confirmation, project-scoped). `deploy.sh` on a failed first deploy uses `down` without volumes, and `stop` likewise.
- **Approval gates:**
  - `deploy.yml` requires `LONTRA_DEPLOY_ENABLED`, `production` and main, a hex SHA and a pinned host key.
  - `site.yml` requires `LONTRA_SITE_ENABLED`, main, and the `preview` or `production` environment, and uploads `staging` versus `main`.
  - No PR workflow has secrets, pushes, or uses `pull_request_target`.
  - Workflow expressions are not interpolated into shell except fixed matrix values and PR SHAs.
- **Secrets in logs and images:**
  - CI writes the resolved config (which includes secrets) to `$RUNNER_TEMP` and never uploads it. The only uploaded artifact is the `docker stats` JSONL.
  - No field-station code logs a token, password or secret.
  - `make-secrets.sh` writes with mode 600 and never overwrites.
- **Standalone operations scripts:**
  - `deploy.sh` has the authorization-downgrade refusal and a rollback path.
  - `ssh-command.sh` accepts only `deploy <40-hex>`.
  - `checkpoint.sh` uses `pipefail` and an atomic `mv`.
  - `operations.test.ts` and `kafka-acl-guard.test.ts` pass 10/10 on main and 14/14 (with the release-pin tests) on #42.
- **#42 deploy changes:**
  - The `start.sh` awk change maps `DESCRIBE_CONFIGS` to `describeconfigs`, matching the new grant spelling.
  - `LAB_FAILURE_HANDLING` defaults match between the field station and the benches in `compose.lab.yaml` (`retry`) and in the code (`off`), and therefore also in `compose.lab-spike.yaml`.
  - `compose.sandbox.yaml` publishes nothing, and `Caddyfile.shared` doesn't route the sandbox, which is correct for phase two.
  - The new deploy tests skip unless their origin variable is set, so none of them targets production by default.
- **Release-pin guard on #42:** passes on the real tree. Every StreamOtter lockfile entry resolves to `registry.npmjs.org` at 0.2.0-rc.1, and there is no `vendor/`.
- **Documentation:** env names in `SHARED_HOST_READINESS.md`, `OPERATIONS.md`, `BACKUP.md`, `HOSTING.md` and `DEPLOYMENT_PLAN.md` all exist in code, except the `N` placeholders and OPS-7's heap variable. Workflow, variable and environment names in the rollout plan match the workflows.
