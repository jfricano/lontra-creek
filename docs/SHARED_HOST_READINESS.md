# Lontra Creek readiness for a shared ARM host

September 27, 2026. Preparation only for a **total host budget of 2 OCPUs and
12 GB RAM shared with iYosi and Roost**. Personal Treasury stays on Railway.
No provisioning, deployment, DNS, package publication, spending, or main-branch
merge is authorized by this document. The coordinated assessment at
`/Users/jasonfricano/coding/dev-ops/hosting-assessment.md` was read as context;
its Lontra implementation audit used stale main. Its provider prices and
account assumptions are not reasserted here as current verified entitlements.
The shared infrastructure contract version 0.2 now accepts the private router
on `edge-lontra`, exact shared-edge peer **10.203.43.2**, and selected region
**us-sanjose-1**. Domain names in the example remain subject to domain-manager
approval. No Oracle eligibility, capacity or deployed infrastructure is inferred.

## Candidate and evidence

Main `2397e2c` contains accepted PR20 application/deployment preparation. This
increment is on `codex/shared-host-router`; root integrates it with CI and backup
hooks on `codex/shared-host-adapter`. Record the final integrated SHA and ARM64
image digest before any deployment. Public Lab decisions below remain gates.

Local Caddy **2.11.4** validation passed for both Lab-disabled and enabled
configuration. Local Docker Compose **5.5.1** rendered both overlay combinations
without starting Docker: no service publishes ports, only Caddy joins the edge,
the origin-certificate mount is removed, and every service has CPU/memory/PID
limits. These checks do not establish runtime routing, Docker cgroup enforcement,
ARM performance, shared-host capacity or actual Cloudflare behavior. The root's
shared-host CI must provide the runtime evidence described below. The earlier
standalone ARM setup rehearsal passed on PR20; it is not shared-host evidence.

The integrated runtime candidate **8e07b31f0bcf935184cdc8ccc5e3136eb13d2bc8**
passed [shared-host rehearsal 36359270595](https://github.com/jfricano/lontra-creek/actions/runs/36359270595)
on **amd64 and arm64** on September 27. Both runs verified ten running services,
zero published application ports, router-only edge membership, actual per-service
caps and aggregate cgroup controls. They passed untrusted-peer/header-spoofing
checks, independent visitor budgets, private-route and Origin restrictions,
real Kafka/Lab scenarios, three concurrent leases and FIFO promotion. The
snapshot/disposable verifier succeeded, rejected a deliberately corrupt backup,
left the active checkpoint unchanged and cleaned its disposable resources.
Lab-disabled routing was also tested while old benches were still running.
All application, browser, standalone stack/Lab and setup checks passed at this
revision. The shared rehearsal skips its two optional main-stack restart tests;
the separate stack workflow supplies restart coverage. This is disposable CI
evidence, not a deployed Oracle host or combined-app capacity result. No registry
image was published; an ARM64 registry digest remains required for activation.

## One shared edge, separate private stacks

The implemented adapter is `deploy/compose.shared.yaml` and
`deploy/Caddyfile.shared`. Apply the shared overlay **after** the base:

```sh
docker compose -f deploy/compose.yaml -f deploy/compose.shared.yaml \
  --env-file /etc/apps/lontra/lontra.env config --format json
```

The opt-in Lab combination is base, `compose.lab.yaml`, `compose.shared.yaml`,
then **`compose.shared.lab.yaml` last**. It adds the bench/relay limits and enables
Lab routing. The default combination contains no benches and returns 404 for
all Lab paths. Compose **2.24.4 or later** is required: `!reset` removes inherited
443 publishing, and `!override` replaces Caddy mounts rather than retaining TLS
secrets. Do not replace these tags with ordinary empty arrays.

Only Caddy joins the pre-existing external `edge-lontra` network with alias
`lontra-caddy`; its listener is HTTP **8080**. It also joins the project-private
network. Kafka, gateway, field station (including 7410), benches and proxies
remain solely on the project network. No app container publishes host ports.
The shared TLS edge owns certificates, public443 and the approved hostname. The
private router does not mount origin certificates or persist TLS/account state.
Its admin API is explicitly container-loopback2019 for its inherited healthcheck.

The router accepts only the immediate peer named by `LONTRA_TRUSTED_EDGE_IP`
(default **10.203.43.2**); every other peer receives403 even if it forges forwarding
headers. The mounted `start-caddy-shared.sh` entrypoint validates exactly one
canonical IPv4 address before Caddy starts: no CIDR, list, whitespace, alternate
numeric format or empty value. Both trust and peer rejection use that same
validated value. Do not bypass the wrapper. A reviewed ingress IP change must
update the shared edge assignment and this variable together, then rerun
spoofing tests; it never permits subnet trust. The router requires the configured
`DEMO_HOST` Host header; other hosts receive404.

The shared edge removes caller `CF-Connecting-IP`, `Forwarded`, `X-Real-IP` and
`X-Client-IP`, replaces `X-Forwarded-For` with its verified visitor address and
sets HTTPS protocol. The router trusts that one peer's XFF using right-to-left
strict parsing, removes alternate identity headers again, and regenerates XFF
and HTTPS protocol on every upstream hop. Only the API hop gets a freshly
computed `X-Client-IP`. Browser Origin, Host, paths and WebSocket upgrades pass
through. A compromised trusted edge remains inside the trust boundary.

| Route on the configured demo host | Private destination | Boundary |
| --- | --- | --- |
| `/streamotter/*` | `gateway:7400` | Production gateway authentication; Origin preserved |
| `/api/*` | `field-station:7402` | Exact site CORS and credentials, 8 KB router cap / 4 KB API cap |
| `/lab/1/socket.io/*` … `/lab/3/socket.io/*` | `lab-1:7400` … `lab-3:7400` | Off by default; exact site Origin before upgrade and lease authentication |
| All other routes | 404 | Includes management, workbench, bench control, internal snapshots and health |

Runtime CI recipe: create an isolated `edge-lontra` with the agreed subnet and
edge at10.203.43.2; resolve both configurations; validate Caddy; verify two visitor
addresses reach distinct station identity buckets; spoof every identity header
from an untrusted edge peer and confirm403; test forged XFF chains from the
trusted edge produce the rightmost untrusted visitor; verify Host/Origin checks,
body cap, private404, Socket.IO upgrade/reconnect, and Lab-disabled404. Confirm
station7410 and bench/proxy controls cannot be reached from the edge-only peer.
Inspect running container limits rather than treating resolved YAML as runtime
enforcement. Run on disposable CI infrastructure; do not change a shared host.

## Ports and environment names

These are container-network ports, **not host ports**. After shared-edge
integration, Lontra publishes no host port itself.

| Component | Listener | Exposure |
| --- | --- | --- |
| Kafka | 9094 SASL_SSL | Lontra private network only |
| Kafka internal/admin/controller | 127.0.0.1:9092 / 9093 | Broker container loopback only |
| Kafka bench listeners | 9101–9103 | Lontra private network, advertised as each relay proxy |
| Field station | 7402 public API; 7410 restricted snapshots/internal API | Only 7402 reachable through allowlisted edge routes |
| Production gateway | 7400 | Only `/streamotter/*` through edge |
| Each bench | 7400 gateway; 7420 bench API; 127.0.0.1:7401 management | Only its Socket.IO path through edge; control internal; management loopback |
| Each relay proxy | 910N forwarding; 9180 control | Lontra private network only, separate token per proxy |
| Lontra router | 8080 HTTP; 127.0.0.1:2019 admin | Only router on edge-lontra; 8080 accepts exact edge peer |

Operator env names, without secret values:

- Image/state/origins: `LONTRA_IMAGE`, `LONTRA_SECRETS`, `FIELD_EPOCH`,
  `FIELD_GENERATION`, `FIELD_TICK_MS`, `SITE_ORIGIN`, `GATEWAY_PUBLIC_ORIGIN`,
  `DEMO_HOST`. `LONTRA_CGROUP_PARENT=lontra.slice` requires the installed shared slice.
  The Kafka heap is set in `compose.shared.yaml`, not from `KAFKA_HEAP_OPTS`; change it there.
  `LONTRA_CONFIG_DIR` is written by the root deploy
  script, not supplied by SSH callers. `PUBLIC_FIELD_STATION_ORIGIN` is a static
  site build-time value, not a secret.
- Production secrets: `FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`,
  `KAFKA_GATEWAY_PASSWORD`, `KAFKA_FIELD_STATION_PASSWORD`.
- Per bench N (1–3): `KAFKA_LAB_N_PASSWORD`, `LAB_BENCH_N_SERVICE_TOKEN`,
  `LAB_BENCH_N_RELAY_TOKEN`. Compose maps the corresponding Kafka value into that
  bench's `KAFKA_LAB_PASSWORD` with `KAFKA_LAB_USERNAME=lab-N`. No other bench's
  or production secret belongs in a bench/proxy container.
- Lab wiring: `LAB_BENCH_API_URLS`, `FIELD_LAB_BENCHES`, `LAB_BENCH`,
  `LAB_SNAPSHOT_ORIGIN`, optional `LAB_LEASE_SECONDS` (at most 300; the field station refuses
  to start above that), `LAB_QUEUE_MAX`.
- Lab rollout: deploy the bench images and the field station together. Since study
  identity (Lab contract section 8), a new bench with an old field station fails
  every reset (401 on `/lab-internal/N/studies/<studyId>/close`), and an old bench
  with a new field station reports no readiness and is never granted a lease.
- CI credentials and guards: `DEPLOY_HOST`, `DEPLOY_KEY`, `DEPLOY_KNOWN_HOSTS`,
  `CLOUDFLARE_API_TOKEN`; variables `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_PAGES_PROJECT`, `LONTRA_IMAGES_ENABLED`, `LONTRA_DEPLOY_ENABLED`,
  `LONTRA_SITE_ENABLED`. Configure required-reviewer environments before enabling.

CORS and session rules need a deliberate staging origin. Random `pages.dev`
previews cannot exercise production same-site/SameSite=Strict sessions. Use an
approved same-site staging hostname with matching browser, field station,
gateway, bench, and edge configuration; never broaden to wildcard Origin.

## Storage and recovery boundaries

| State | Current volume / directory | Recovery requirement |
| --- | --- | --- |
| Kafka streams/notebooks | `lontra-creek_kafka-data` → `/var/lib/kafka/data` | Preserve during deploy/rollback; world streams six-hour retention, notebooks compact/delete two-hour retention; not a durable user database |
| Deterministic world checkpoint | `lontra-creek_field-data` → `/var/lib/lontra` | Shared snapshot/disposable-verify hooks write orchestrator staging; no shared timer active. Legacy standalone copies use `/srv/lontra/backups`. |
| Router state | No shared-router state mount | TLS/account material belongs to shared edge owner |
| Shared secrets and Kafka CA | `/etc/apps/lontra/lontra.env`, directory named by `LONTRA_SECRETS` | `lontra.env` root 0600. Create the Kafka material with `deploy/make-certs.sh kafka "$LONTRA_SECRETS/kafka"`: Kafka and the node services run as uid 1000 and read `ca.pem` and `broker-keystore.pem` (0644, as the script writes them) through bind mounts, so `$LONTRA_SECRETS` and its `kafka/` directory are 0755 under a root-only 0700 ancestor; `ca-key.pem` stays 0600 or off-host. Separately encrypted recovery export |
| Shared release configs | `/srv/apps/lontra/releases/<sha>` and `/srv/apps/lontra/current.env` | Root-owned immutable configuration; current env selects image and `LONTRA_CONFIG_DIR`; retain previous matching image/config |

The shared deployment owner must install root-owned configuration snapshots and
write `/srv/apps/lontra/current.env` only after accepting the active release.
Snapshot the required Compose files, referenced `kafka/start.sh` and shared
Caddyfile, `start-caddy-shared.sh`, plus hook dependencies; preserve relative paths. Keep the
`/srv/apps/lontra` ancestor0700, release directories0755 and configuration
files0644, root-owned and not writable by others, so container UIDs can read
bind-mounted scripts. Active/base env files stay0600. Include the resolved
Lab choice in the release manifest. Existing `/srv/lontra` setup/deploy/checkpoint
scripts serve the standalone layout and do **not** activate this adapter. Do not
run standalone setup on a shared host. The separate shared-host backup hooks
use this active-release layout; their acceptance is tracked by the backup worker.

Shared backup integration is proposed through root-owned
`/usr/local/lib/app-backup-hooks/lontra-{snapshot,verify,export}`, each accepting
one mode-0700 staging-directory argument and failing closed on errors. Lontra
owns the consistent world snapshot, validation and **disposable-target restore**
hooks plus documentation of ephemeral Kafka recovery. The existing
`lontra-checkpoint restore` intentionally changes the active station volume and
therefore cannot serve as the shared verifier: a separate isolated volume/project
restore adapter is supplied by the concurrent backup-hook lane and must pass
its integration checks before acceptance. The shared infrastructure
owner owns export encryption, off-host transport, remote integrity/retention,
serialization and delivery alerts after destination/key-recovery decisions.
No shared hook is installed on a host or accepted for production by this document. Keep application
backup namespaces separate and include the release/epoch/volume recovery manifest.

Local checkpoint copies do not survive VM/disk/account loss and do not back up
Kafka or secrets. An approved encrypted off-host destination, access policy,
retention, restore point/loss tolerance, and notification routing are still
needed. Do not reuse another application's database credentials or backup
prefixes. Never run `down --volumes`, volume fault experiments, or whole-host
restore drills beside live iYosi/Roost data.

## Resource envelope to measure

The existing 3 GB pre-touched Kafka heap was padded for presumed idle-reclamation
behavior. **Do not retain padding for that purpose on the shared host.** Older
CI reported about 3.21 GiB broker RSS / 3.36 GiB total base stack with that heap;
that excludes the new three-bench production load and is not a shared-host or
capacity benchmark. The short shared-host observations below cover the reduced
heap during synthetic CI scenarios; they are not a capacity benchmark.

Start the isolated synthetic-data sizing rehearsal with Kafka
`-Xms512m -Xmx1536m`, without `AlwaysPreTouch`, then measure startup, normal load,
failure scenarios, replay, cleanup, retention growth and backup overhead.
This is a **test starting point**, not a validated production setting. Retain
headroom for JVM non-heap/native memory and the broker page cache. Increase only
from evidence and inside the combined host allocation; do not change someone
else's allocation silently.

Enforced per-service limits in the shared overlays (one instance each):

| Component | Memory / memory+swap ceiling | CPU time ceiling | PID ceiling |
| --- | --- | --- | --- |
| Kafka | 2560 MiB | 0.35 | 512 |
| Field station | 448 MiB | 0.18 | 128 |
| Production gateway | 384 MiB | 0.15 | 128 |
| Private router | 128 MiB | 0.05 | 128 |
| Each of 3 benches | 256 MiB | 0.06 | 128 each |
| Each of 3 relay proxies | 64 MiB | 0.03 | 64 each |

The base combination sums to **3520 MiB / 0.73 CPU / 896 PIDs**; with three
benches it sums to **4480 MiB / 1 CPU / 1472 PIDs**, including the private router.
Memory+swap equals memory to avoid extra swap allowance. Kafka's shared overlay
sets `-Xms512m -Xmx1536m` without pre-touch, independent of the standalone default.
These are maximum bounds, not throughput reservations or measurements. The
shared TLS edge is separately owned/capped by infrastructure.

The September 27 rehearsal artifacts contain 11–13 Docker memory samples per
application container after startup (roughly five seconds between sampling
commands, plus command time). Sampled maxima in MiB:

| Component | amd64 | arm64 | Configured ceiling |
| --- | ---: | ---: | ---: |
| Kafka | 498.10 | 469.00 | 2560 |
| Field station | 102.90 | 100.70 | 448 |
| Production gateway | 59.41 | 72.14 | 384 |
| Private router | 26.43 | 16.36 | 128 |
| Busiest bench | 88.41 | 86.66 | 256 each |
| Busiest relay proxy | 56.11 | 58.75 | 64 each |

These are Docker-reported container memory usage samples, not RSS, continuous
peaks or an aggregate parent measurement. Build workers and the shared test edge
are excluded. Startup precedes sampling, the run is short, and independent
maxima must not be summed as a simultaneous host peak. In particular, one ARM64
relay reached about **92% of its 64 MiB ceiling**; longer representative traffic,
retention growth, CPU throttling and combined-app tests remain necessary before
accepting production headroom. No OOM was found in the final container inspect.

Every shared service also requires `LONTRA_CGROUP_PARENT=lontra.slice`. The
provided `deploy/systemd/lontra.slice` defines an aggregate **5 GiB / 1 CPU /
2048 tasks** ceiling with no swap. The shared infrastructure owner must install
this root-owned unit, reload systemd and start the slice under their approved
host maintenance procedure; nothing in this preparation activates it. Require
unified cgroup v2 and Docker's **systemd** cgroup driver. Do not substitute an
arbitrary parent, run without the slice, or fall back to component-only limits
on an unsupported host. The snapshot/restore hook containers must inherit the
same parent. Confirm the Docker HostConfig parent, actual cgroup paths and
parent `memory.max=5368709120`, `memory.swap.max=0`, `cpu.max` quota/period ratio1,
and `pids.max=2048` before deployment acceptance. This includes replicas and
maintenance under the same ceiling; still serialize maintenance to avoid
starving user traffic. One production gateway remains the supported topology.

Per-service and parent limits are not fit evidence. Measure CPU throttling and
startup with these low caps before acceptance; increase only through a
coordinated budget change. Shared CPU ceilings can exceed physical capacity
and do not promise fit. No host slice has been installed or activated locally.

Build images in CI, never concurrently on this small production host. Track
cgroup CPU throttling, RSS/working set, Java GC pressure, OOM/restarts, socket
count, disk growth and latency under combined representative traffic. The
single production gateway, three benches, limits of 300 production connections
and 12 subscriptions, and Kafka durability setting replication factor one
remain configuration choices to validate, not tested visitor capacity. Reduce
load/bench availability or move the Lab to a separately approved host if this
envelope cannot meet the user flow. Do not claim fit just because summed limits
are below 12 GB.

## Failure Lab and release gates

Only app-level failures are prepared: a bench's calibration check, its own relay
proxy, one non-acknowledging client, and its gateway. No host/network/firewall,
Docker-daemon, kernel, disk-pressure or resource-exhaustion faults may run on this
shared host beside real user data. Host-level fault experiments require isolated
infrastructure and separate authorization.

Known public-bench blocker: unique Kafka credentials currently lack topic/group
ACL confinement (contract R2). A compromised bench could use its credential to
read other Kafka topics. The PM preserved R2 for preparation; the owner must
explicitly disposition it or require ACL enforcement before public benches.
Public development-mode gateways also need the contract's owner acceptance.
Neither risk is resolved by shared networking or per-container resource limits.

Before publication/deployment:

1. Integrate the reviewed backend and this deployment branch, record final SHA,
   and pass amd64/ARM stack, secure Lab, browser and accessibility checks.
2. Rehearse this shared ingress adapter and runtime resource enforcement on
   synthetic data; verify other apps are isolated and unaffected by all four
   approved bench scenarios. Do not run destructive faults on a populated host.
3. Measure combined capacity and a realistic heap, validate secrets migration,
   signed host keys, current/previous image retention, config rollback,
   checkpoint restore, encrypted off-host recovery and delivered alerts.
4. Obtain exact owner decisions for destination/accounts, budget, public image
   visibility, public development benches/R2, protected environments, static
   preview and eventual production/DNS release. Keep workflows disabled until
   the relevant authority and protections exist.

The prepared `setup.sh` edits host Docker/firewall/user/systemd configuration.
On a shared server it needs an integration-owner review and explicit approved
maintenance plan; it is not safe to treat it as an isolated application deploy.
This handoff changes no shared host or other application's files.

Configuration references: [Compose merge tags](https://docs.docker.com/reference/compose-file/merge/),
[Caddy proxy trust](https://caddyserver.com/docs/caddyfile/options#trusted-proxies),
and [immediate-peer matching](https://caddyserver.com/docs/caddyfile/matchers#remote-ip).
