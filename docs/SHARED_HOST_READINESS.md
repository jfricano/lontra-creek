# Lontra Creek readiness for a shared ARM host

September 27, 2026. Preparation only for a **total host budget of 2 OCPUs and
12 GB RAM shared with iYosi and Roost**. Personal Treasury stays on Railway.
No provisioning, deployment, DNS, package publication, spending, or main-branch
merge is authorized by this document. The coordinated assessment at
`/Users/jasonfricano/coding/dev-ops/hosting-assessment.md` was read as context;
its Lontra implementation audit used stale main. Its provider prices and
account assumptions are not reasserted here as current verified entitlements.

## Candidate and evidence

The deployment preparation branch is `feat/server-setup`, through `7ed9f09`
(configuration snapshots), following `62a545f`, `d4cac97`, and `46f5e5d`.
Root integration is `codex/site-completion`, in the `docs-research-spikes`
worktree; it contains newer walkthrough, Lab UI, content, captured local
recording and lifecycle fixes. The backend engineer's `codex/lab-completion`
commit `1c89a0b` is the required secure Lab dependency. Independent review
verified the fixes for protected-topic feed exclusion, configured Origin,
nonblocking restart, read-only feed/token availability during restart, and
immediate reset invalidation; 18 targeted HTTP/lease/redaction/environment/relay
tests independently passed. Native Kafka scenario results remain the author's
evidence; Caddy and three-bench container checks are still pending. Record the **final integrated SHA** after that
review; neither an old main checkout nor this document's branch SHA is a
complete release candidate on its own.

Prepared now: guarded image/static/deploy workflows, root-only setup, forced SSH
command, health-gated deployment, release-specific configuration rollback,
three-bench topology, world-checkpoint backup/restore, local health checks,
disabled timers, and disabled OCI alarm definitions. Six local deployment,
checkpoint and alarm-generation tests plus typecheck pass. These tests do not
prove ARM container startup, shared-host capacity, real SSH, Cloudflare, OCI
alarms, or backup notification delivery. See [operator evidence](../deploy/OPERATIONS.md).

The prepared deployment is currently **standalone ingress**, not shared-host
ready. Do not run its unmodified setup/Compose on an occupied host: Caddy binds
443; no resource caps or cross-application ingress network are configured in
the base stack. The steps below are a concrete integration contract to implement
and rehearse with the host integration owner before release acceptance.

## One shared edge, separate private stacks

Use one host-owned TLS edge. Keep the `lontra-creek` Compose project and its
private network separate from iYosi/PostGIS and Roost/SQLite. Do not attach
Kafka, field station's internal listener, benches, or proxies to another
application's network. Do not mount the host Docker socket into any app.

Recommended integration: keep Lontra's Caddy as a private HTTP router and attach
**only that router** to an external host-owned ingress network. Give it no host
published port and a non-TLS internal listener (for example 8080). The shared
edge owns 443, the `demo.streamotter.app` virtual host and TLS; it forwards that
host to `lontra-caddy:8080`. Other apps get separate virtual hosts and upstreams.
This keeps Lontra's strict route allowlist in its own versioned config.

This requires a reviewed shared-host Compose/Caddy adapter; simply deleting the
443 mapping leaves the current TLS Caddyfile incompatible with the proposed
HTTP upstream. Do not silently overlay Compose port arrays (they can merge and
leave 443 published); validate the **resolved** Compose config and host listeners.
The root-owned operator deployment must snapshot this adapter with each release.

Preserve WebSocket upgrade headers and browser `Origin` without rewriting them.
The edge must strip caller-supplied client-IP headers and set the verified
client address. Replace Lontra's current Cloudflare-only trust model with trust
for the **specific shared-edge network/address** plus the edge's verified
Cloudflare policy. Forwarding the original `CF-Connecting-IP` header through an
untrusted/private hop without configuring this chain either loses per-visitor
rate limits or trusts spoofed addresses. Test both spoofed headers and distinct
visitors. Do not trust every RFC1918 address or every container on the host.

| Route on `demo.streamotter.app` | Internal destination | Boundary |
| --- | --- | --- |
| `/streamotter/*` | `gateway:7400` | Production gateway; browser Origin preserved |
| `/api/*` | `field-station:7402` | Exact configured site CORS, credentials, 8 KB edge cap and 4 KB API body cap |
| `/lab/1/socket.io/*` … `/lab/3/socket.io/*` | `lab-1:7400` … `lab-3:7400` | Exact configured site Origin required before WebSocket upgrade; leased authentication |
| All other routes | 404 | Includes management, workbench, bench control, internal snapshots, health |

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
| Lontra router (proposed) | 8080 HTTP | Shared ingress network only |

Operator env names, without secret values:

- Image/state/origins: `LONTRA_IMAGE`, `LONTRA_SECRETS`, `FIELD_EPOCH`,
  `FIELD_GENERATION`, `FIELD_TICK_MS`, `SITE_ORIGIN`, `GATEWAY_PUBLIC_ORIGIN`,
  `DEMO_HOST`, `KAFKA_HEAP_OPTS`. `LONTRA_CONFIG_DIR` is written by the root deploy
  script, not supplied by SSH callers. `PUBLIC_FIELD_STATION_ORIGIN` is a static
  site build-time value, not a secret.
- Production secrets: `FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`,
  `KAFKA_GATEWAY_PASSWORD`, `KAFKA_FIELD_STATION_PASSWORD`.
- Per bench N (1–3): `KAFKA_LAB_N_PASSWORD`, `LAB_BENCH_N_SERVICE_TOKEN`,
  `LAB_BENCH_N_RELAY_TOKEN`. Compose maps the corresponding Kafka value into that
  bench's `KAFKA_LAB_PASSWORD` with `KAFKA_LAB_USERNAME=lab-N`. No other bench's
  or production secret belongs in a bench/proxy container.
- Lab wiring: `LAB_BENCH_API_URLS`, `FIELD_LAB_BENCHES`, `LAB_BENCH`,
  `LAB_SNAPSHOT_ORIGIN`, optional `LAB_LEASE_SECONDS`, `LAB_QUEUE_MAX`.
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
| Deterministic world checkpoint | `lontra-creek_field-data` → `/var/lib/lontra` | Validated nightly local copies under `/srv/lontra/backups`, restore drill before timers enabled |
| Router state | `lontra-creek_caddy-data` | Reassess after shared-edge adapter; TLS/account material belongs with its actual edge owner |
| Secrets and Kafka CA | `/srv/lontra/stack.env`, `/srv/lontra/secrets` | Root-only host ancestor; separately encrypted recovery export to approved destination |
| Release configs | `/srv/lontra/releases` plus current/previous env and SHA records | Keep both retained releases and matching image tags; do not prune required rollback configs/images |

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
capacity benchmark. No new heap/capacity measurement is claimed here.

Start the isolated synthetic-data sizing rehearsal with Kafka
`-Xms512m -Xmx1536m`, without `AlwaysPreTouch`, then measure startup, normal load,
failure scenarios, replay, cleanup, retention growth and backup overhead.
This is a **test starting point**, not a validated production setting. Retain
headroom for JVM non-heap/native memory and the broker page cache. Increase only
from evidence and inside the combined host allocation; do not change someone
else's allocation silently.

Proposed bounded envelope for the integration owner to implement and test:

| Lontra component | Memory ceiling for rehearsal | Process limit starting point |
| --- | --- | --- |
| Kafka | 2560 MiB | 512 |
| Field station | 448 MiB | 128 |
| Production gateway | 384 MiB | 128 |
| Each of 3 benches | 256 MiB | 128 each |
| Each of 3 relay proxies | 64 MiB | 64 each |
| Shared edge / private router | Account separately in host budget | 128 initially |

The application ceilings sum to 4352 MiB. Put Lontra in an aggregate host-managed
cgroup with a **5 GiB memory ceiling and one OCPU CPU-time budget** as an initial
containment target, plus per-bench CPU/process ceilings so one scenario cannot
consume that entire allocation. Validate the Docker cgroup driver/parent wiring;
plain YAML comments or reservations are not enforced limits. These are proposed
limits, not yet present in the current Compose or tested. They leave the
remaining memory and CPU for the OS, shared edge, iYosi/PostGIS, Roost, filesystem
cache and maintenance; the host owner must allocate and measure those explicitly.

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
2. Implement and rehearse shared ingress and enforced resource limits on
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
