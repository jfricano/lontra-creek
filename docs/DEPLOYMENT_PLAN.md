# Deployment plan

September 25, 2026 · Engineering plan for taking Lontra Creek from local development to `streamotter.app`

[PLAN.md](PLAN.md) owns scope, the story, architecture, consistency rules, and launch criteria. [HOSTING.md](HOSTING.md) is the owner's account and server checklist. This document is the engineering work in between: what to build, in what order, and how each piece is proven before it goes near a server. [TEAM_PLAN.md](TEAM_PLAN.md) assigns the remaining workstreams to the team and orders them into sprints.

## Where things stand

Milestone A (the stack proven in CI) is reached: workstreams 1–4 are merged into `main` in [jfricano/lontra-creek](https://github.com/jfricano/lontra-creek) (public), whose CI passes: `ci.yml` (typecheck, tests, site build on Node 24) and `stack.yml` (the whole stack in containers, tested from outside on amd64 and arm64).

| Piece | State |
| --- | --- |
| `packages/creek-sim` | Done. Deterministic world, checkpoints, emissions with revisions `generation × 10¹² + tick`, den privacy. 18 tests. |
| `apps/field-station` | The StreamOtter project for three environments (`fixture`, `local-kafka`, `production`), fixture and Kafka handlers (the latter compiled for `streamotter start`), signed badges and cookie sessions, `scripts/dev.ts` for `npm run dev`, and the production runner in `src/server/` with visitors' notebooks (workstreams 1 and 2). 56 tests, including a real gateway from npm with the real SDK and `streamotter start` failing closed. |
| `apps/site` | Astro 7. Home page with the live panel (real subscriptions; "Drop my connection" really closes the page's WebSocket) and its unavailable state, brand images and a social preview, a 404 page, `robots.txt`, a sitemap, and placeholder pages for the other seven routes. Calls the demo host at `PUBLIC_FIELD_STATION_ORIGIN` in production (workstream 3). |
| `deploy/` | One image, the compose stack (Kafka 4.1.2 over SASL_SSL with SCRAM, the gateway, the field station, Caddy on 443), certificate and secret scripts, and `test/stack.test.ts`, which `stack.yml` runs from outside on amd64 and arm64 (workstream 4). |
| Not yet | The walkthrough's pages (notebooks are ready for chapter 6), the recorded fallback, server setup and deploy workflows (workstream 5, after HOSTING.md sections 1–3), the Failure Lab, and the other pages. |

## Rules that apply to every step

- **npm only.** Use StreamOtter as the published `streamotter` package at the exact version in `apps/*/package.json` (now `0.1.0-rc.3`). No submodules, workspace links, local paths, or copies of the StreamOtter repository's source. Reading its public docs is fine. A bug found here becomes an issue there; upgrade after a release.
- **Authorship.** Commits are the owner's alone: no `Co-Authored-By` or other attribution lines, in commits or pull requests. The repository's local git identity is set.
- **Owner's approval** before merging to `main`, deploying, creating or changing cloud resources, or anything that costs money. The owner holds every account; never handle their passwords, card details, or private keys.
- **Branches and pull requests.** One branch per workstream below; CI must pass before merge.
- **No Docker on the owner's Mac.** Containers are built and exercised in GitHub Actions. Everything else runs natively with Node 24 or later.
- **Honest claims.** Label the fiction and any recordings; no invented numbers; timings say where they were measured.

## Target shape

```
visitor ─▶ https://streamotter.app          Cloudflare: the static site (Astro build), DNS
       └─▶ https://demo.streamotter.app      Cloudflare proxy (WebSockets on) ─▶ Oracle A1 VM, Ubuntu 24.04 arm64
                                                Caddy :443 (Cloudflare origin certificate)
                                                  /streamotter/*  ─▶ gateway :7400   `streamotter start`, production
                                                  /api/*          ─▶ field station :7402   site API
                                                  /lab/*          ─▶ Failure Lab benches
                                                  anything else   ─▶ 404
                                                Kafka 4.1.2, KRaft, SASL_SSL + SCRAM-SHA-512, compose network only
                                                field station internal API :7410, compose network only
```

- **Origins.** The site at `https://streamotter.app` talks to `https://demo.streamotter.app`. The gateway's `allowedOrigins` is `["https://streamotter.app"]`. `/api` answers CORS for that origin with credentials. The two hosts share the registrable domain, so they are the same *site*: the session cookie (`Secure; HttpOnly; SameSite=Strict; Path=/api`, host-only on `demo.streamotter.app`) is sent with `fetch(..., { credentials: "include" })`.
- **One image, several services.** One Node 24 image containing the workspace (`apps/field-station`, `packages/creek-sim`, production dependencies) runs as the gateway, the field station, and the benches with different commands.
- **Secrets live on the server**, generated by the setup script: badge signing secret, service token, SCRAM passwords, the Kafka CA and certificates. GitHub holds only deploy credentials.

## Workstreams

Each workstream ends with its tests green in CI. Do them in this order; 1–4 need no accounts.

### 1. Production project and Kafka handlers

Done ([#1](https://github.com/jfricano/lontra-creek/pull/1)).

- `src/project.ts` has a `production` environment and writes `streamotter.production.json`.
  - Gateway: host `0.0.0.0`, port 7400, path `/streamotter/socket.io`, `allowedOrigins: ["https://streamotter.app"]`.
  - Connection `field`: brokers `["kafka:9094"]`, `tls: { caFile: "/etc/lontra/kafka/ca.pem" }`, SASL `scram-sha-512` with `{ env: "KAFKA_GATEWAY_USERNAME" }` / `{ env: "KAFKA_GATEWAY_PASSWORD" }`.
  - Source `field`: the five `field.*` / `creek.overview` topics, group `streamotter-lontra-creek-field`, `startFrom: "latest"`, generation `field-prod-1`. The `notebooks` source (`field.notebooks`, its own group, so a notebook problem can't pause the creek) arrives with the notebook channel in workstream 2.
  - Limits: `maxConnections: 300` and `maxSubscriptionsPerConnection: 12`, the starting values from PLAN.md, to be measured on the real host.
  - The `local-kafka` environment (`streamotter.json`) mirrors it with plaintext on `127.0.0.1:19092`.
- `src/kafka-handlers.ts`: `authenticate` verifies badges with `FIELD_STATION_SECRET`; `authorize` uses the shared rules in `src/access.ts` (`holt` only for researchers); `map` uses `fromRecord`, keeps its own channel, and throws (pausing the source, never skipping) on a record it can't read or a view on the wrong topic; `snapshot` calls the field station's internal API (`FIELD_STATION_INTERNAL_URL`, `GET /internal/views/:channel/:id`) with `FIELD_STATION_SERVICE_TOKEN` and the handler's `AbortSignal`, throwing on 404, non-2xx, or a malformed answer. Both secrets are required in production.
- `streamotter start` refuses a `.ts` handler module by its extension (exit 2), before Node is involved. `npm run build -w @lontra-creek/field-station` compiles the handlers with `tsc` (`tsconfig.build.json`, `rewriteRelativeImportExtensions`) into `apps/field-station/dist/`. The compiled module still imports `@lontra-creek/sim` as TypeScript, which Node 24 strips because the workspace link resolves outside `node_modules`; `tsc` doesn't emit it.
- Proof (`npm test`): the published CLI validates all three configs; unit tests for the access rules and every handler; and `streamotter start` with the compiled handlers refuses to load them without the secrets (exit 1) and, with them, stops at the missing Kafka CA (exit 2) without printing any secret.

### 2. The field station's production runner

Done: the runner in [#2](https://github.com/jfricano/lontra-creek/pull/2), notebooks on branch `ws2-notebooks`.

`apps/field-station/src/server/`, entry `main.ts` (`node --disable-warning=TimeoutNegativeWarning src/server/main.ts`), configured entirely by environment variables (`config.ts`): `KAFKA_BROKERS`, `KAFKA_CA_FILE`, the field station's own SCRAM user (`KAFKA_FIELD_STATION_USERNAME`, `KAFKA_FIELD_STATION_PASSWORD`), `FIELD_STATION_SECRET`, `FIELD_STATION_SERVICE_TOKEN`, `FIELD_DATA_DIR`, `FIELD_EPOCH` (fixed ISO time when the hosted study began), `FIELD_TICK_MS` (2000), `FIELD_GENERATION`, `SITE_ORIGIN`, `GATEWAY_PUBLIC_ORIGIN`, and `FIELD_HOST`, `FIELD_PORT` (7402), `FIELD_INTERNAL_PORT` (7410). Production refuses to start without the secrets, the epoch, the origins, or Kafka over TLS with SCRAM.

- **World** (`station.ts`). On start, restore `FIELD_DATA_DIR/world.json` if its seed, generation, epoch, and tick length match; otherwise `createWorld`. Target tick = `floor((now − FIELD_EPOCH) / FIELD_TICK_MS)`. Catch up in slices, queue every current view for republishing (harmless duplicates), checkpoint, then advance on a timer aligned to the epoch. Checkpoint hourly and at shutdown with write-and-rename. Without `FIELD_EPOCH` (development), a restart keeps the checkpoint's epoch. Changing `FIELD_EPOCH` or `FIELD_TICK_MS` for the hosted world needs a higher `FIELD_GENERATION`, like any change to recomputed history.
- **Write, then publish.** Advance the in-memory world (what the internal API serves) before producing. Pending views are kept per channel instance, so while Kafka is down only the latest state of each waits; one batch is in flight at a time, and a view leaves the queue only when the broker acknowledges it. The internal API answers 503 until the world has caught up, so a snapshot is never behind Kafka after a restart.
- **Kafka** (`kafka.ts`). KafkaJS 2.2.4 producer: idempotent, `acks: -1`, one request in flight, keyed by channel instance, the default (Java-compatible) partitioner. Before connecting, it creates missing topics: 3 partitions, replication 1, `retention.ms` of 6 hours. A failed send drops the connection and starts fresh on the next tick.
- **HTTP** (`http.ts`). Public, through Caddy: `GET /api/config` (gateway origin, path, `mode: "kafka"`, tick), `POST /api/badge` (CORS for `SITE_ORIGIN` with credentials; a foreign `Origin` gets 403; the cookie is `Secure` in production), `GET /api/status`. Every `/api` request spends from a per-client budget (30 at once, one a second after that) keyed by the `X-Client-IP` header Caddy sets. `GET /healthz` (200 once caught up and Kafka has acknowledged) is for the container health check, not routed by Caddy. Compose-internal only, on :7410: `GET /internal/views/:channel/:id` with the service token.
- **Notebooks** (walkthrough chapter 6; `notebooks.ts`). The `notebook` channel (params `observerId`, 8–64 characters, the badge's subject; payload: `status` `open` or `expired` and the owner's entries, at most 20, each a study time plus an otter, reach, and activity chosen from lists that leave out dens, with no free text) is on its own `notebooks` source and consumer group, so a notebook problem can't pause the creek, and `authorize` allows only the owner (`params.observerId === principal.subject`). `POST /api/notebook/sightings` takes the session cookie and one choice from each list, at most one a second per notebook. The field station updates the notebook it serves, then queues it for `field.notebooks` keyed by observer, sharing the world's publish queue (`queue.ts`), which sends whatever arrives during a batch right after it. Revisions are the write time in milliseconds, kept strictly increasing. A snapshot of a notebook with no sightings yet is empty and open at revision 0. **No tombstones:** StreamOtter V1 pauses a source on a null record value, so when a session ends its notebook is published once more as expired and empty, and the topic is `cleanup.policy=compact,delete` with two hours' retention and ten-minute segments, so old records age out without deletes. Expired notebooks stay in memory as long as the topic keeps them, so snapshots never go back. On start, the field station reads `field.notebooks` from the beginning with a throwaway consumer group (retrying until Kafka answers), keeps each notebook's highest revision, and closes those whose session ended meanwhile; `/healthz` waits for that. With `npm run dev` (no Kafka) every notebook is empty and sightings aren't accepted.
- Proof for notebooks (`test/notebooks.test.ts`, `test/server.test.ts`): only listed choices are accepted; nothing is written before the rebuild; revisions are the write time and keep rising, including in the same millisecond and after a restart; one sighting a second and the latest twenty; expiry publishes explicit expired state, never a tombstone; a rebuild keeps the highest revision and closes ended sessions; published records fit the channel's schema and the gateway's map handler; and the site API accepts sightings only with the owner's session cookie and the site's origin. The stack test (workstream 4) logs a sighting through Caddy and sees it arrive over Kafka, is refused someone else's notebook, and finds the notebook rebuilt after a field station restart.
- Proof for the runner (`npm test`, `test/server.test.ts`, a fake producer and a controllable clock): startup at the wall clock's tick with every view republished; every published view already served; while Kafka is down, ticking continues and the catch-up has one record per view at its latest revision; one batch in flight; a restart from a checkpoint lands exactly where a fresh world would be; a new generation outranks every earlier revision; mismatched checkpoints are ignored; the HTTP APIs' CORS, cookies, budgets, health, and service-token checks; and production's configuration refusals.

### 3. The site's production wiring

Done ([#5](https://github.com/jfricano/lontra-creek/pull/5)), except the recording.

- `src/scripts/field-api.ts` calls `${PUBLIC_FIELD_STATION_ORIGIN}/api/…` with `credentials: "include"`. The variable is set at build time (`https://demo.streamotter.app` for production) and empty in development, where Vite proxies `/api`.
- The unavailable state: when `/api/config` fails, or the gateway can't be reached within 15 seconds (the SDK keeps trying, and the notice clears on connecting), the live panel says the demo isn't answering, hides its connection controls, and shows how to run the demo locally. Still to do: a labeled recording of the live panel, once there's a hosted run to record.
- `src/pages/404.astro`, `public/robots.txt`, and `src/pages/sitemap.xml.ts`, which lists the home page and every page marked `ready`; placeholder pages and the 404 are `noindex`.
- `public/social-preview.png` (1200 × 630), made by `scripts/brand-assets.mjs` from the logo, and the Open Graph and Twitter card tags that use it.

### 4. Containers and a full-stack test in CI

Done ([#3](https://github.com/jfricano/lontra-creek/pull/3), merged to `main` as #4).

- `deploy/Dockerfile`: `node:24.21.0-bookworm-slim` for linux/amd64 and linux/arm64. A build stage installs the field station's workspace with dev dependencies and compiles the gateway's handlers; the final stage has `npm ci --omit=dev` for the field station's workspace only (34 packages, 12 MB of `node_modules`; none of the site's), the sources it runs, the compiled handlers, and the unprivileged `node` user. `deploy/Dockerfile.dockerignore` keeps the context small.
- `deploy/compose.yaml`, driven by one env file (`deploy/make-secrets.sh` writes the secrets; `LONTRA_IMAGE`, `LONTRA_SECRETS`, and `FIELD_EPOCH` are added per host):
  - `kafka`: `apache/kafka:4.1.2` with `deploy/kafka/start.sh` as its entrypoint: KRaft single node, `SASL_SSL` with SCRAM-SHA-512 on 9094 (advertised as `kafka:9094`) with a PEM keystore, a plaintext listener on the container's loopback for the broker and its health check, and both SCRAM users created when the storage is formatted. Heap `-Xms3g -Xmx3g -XX:+AlwaysPreTouch`, sized to hold the host above Oracle's idle-memory threshold (PLAN.md, Budget protection). Measured in CI with `docker stats`: with `-Xms2g` alone the broker kept 452 MiB resident, since the JVM holds only the heap it has touched; pre-touching a 2 GB heap gave 2.19 GiB, and the whole stack 2.35 GiB, about 20% of the host's 12 GB before the operating system, too close to the threshold and under the 25% alert. With 3 GB the broker holds 3.21 GiB and the stack about 3.36 GiB, 28% before the operating system. A volume for its data.
  - `field-station`: `node --disable-warning=TimeoutNegativeWarning src/server/main.ts`, a volume for its checkpoints, healthy once caught up and acknowledged by Kafka.
  - `gateway`: `streamotter start --config streamotter.production.json --handlers dist/kafka-handlers.js`, after the field station is healthy (it creates the topics). A TCP health check, since V1 has no production health endpoint; a 15-second stop grace period.
  - `caddy`: `caddy:2.11.4-alpine`, port 443 only, certificates from files (the Cloudflare origin certificate in production), `/streamotter/*` to the gateway, `/api/*` to the field station with the visitor's address in `X-Client-IP` (from `CF-Connecting-IP`, trusted only from Cloudflare's published ranges), security headers, an 8 KB body limit, and 404 for everything else. The stock Caddy image has no rate limiter, so the field station keeps the per-client request budget.
  - Health checks for every service, `init: true` for the Node services, `restart: unless-stopped`, and rotated JSON logs.
- `deploy/make-certs.sh kafka <dir>` makes the Kafka CA and the broker's certificate for `kafka`; `deploy/make-certs.sh test-origin <dir> <host>` makes CI's stand-in for the origin certificate.
- `.github/workflows/stack.yml`, on pull requests and `main`, on `ubuntu-24.04` and `ubuntu-24.04-arm`: build the image natively, make throwaway secrets and certificates, map `demo.streamotter.app` to the runner, `docker compose up --wait` with a study epoch a day in the past (43,200 ticks to catch up), then run `deploy/test/stack.test.ts` through Caddy with the test CA. It checks that only the site API and the gateway are exposed; badges come with a `Secure; HttpOnly; SameSite=Strict` cookie; a page from another origin is refused with `FORBIDDEN`; `station LC-02` goes authorizing, synchronizing, live from a snapshot, then newer revisions in order; a volunteer's `holt A` request is refused with `FORBIDDEN` and receives nothing, while the field biologist sees Holt A; after `docker compose restart gateway` the view goes stale, then live again from a fresh snapshot; a visitor logs a sighting and sees it arrive in their notebook over Kafka, and another visitor is refused that notebook with `FORBIDDEN`; and after `docker compose restart field-station` the world continues from its checkpoint and the notebook from `field.notebooks`. Measured in CI: the stack is healthy about 30 seconds after `up`.
- The same test passes against the same broker script, Caddyfile, compiled handlers, and runner run natively (Node 24.21, Kafka 4.1.2, Caddy 2.11.4), which is how to iterate without Docker.
- The multi-arch manifest is published by `images.yml` in workstream 5; CI builds and runs each architecture's image natively.

### 5. Server setup and deployment

Starts after the owner completes HOSTING.md sections 1–3.

- `deploy/setup.sh`, idempotent, run over SSH:
  - Installs Docker.
  - Opens 443 in the host firewall (Oracle's Ubuntu images ship `iptables` rules that reject it).
  - Creates `/srv/lontra`.
  - Generates secrets into a root-only env file, and the Kafka CA and certificates.
  - Installs the Cloudflare origin certificate the owner copies over.
- Monitoring: an OCI Monitoring alarm on memory under 25% and on instance down, emailing the owner (Always Free includes Monitoring and Notifications); a nightly checkpoint backup to an Always Free block-volume backup or Object Storage.
- `.github/workflows/images.yml`: on `main`, build and push `ghcr.io/jfricano/lontra-creek:<sha>` (multi-arch).
- `.github/workflows/deploy.yml`: manual, a GitHub `production` environment with the owner as required reviewer. SSH to the host with a restricted deploy key, pin the new image tag, `docker compose up -d`, wait for `/healthz`, and on failure roll back to the previous tag.
- `.github/workflows/site.yml`: build the site with `PUBLIC_FIELD_STATION_ORIGIN=https://demo.streamotter.app` and deploy it to Cloudflare (Workers static assets or Pages) with a scoped API token.
- Staging is the real host before the apex goes public: deploy the demo host, point `demo.streamotter.app` at it, and deploy the site to a Cloudflare preview URL. The owner decides when `streamotter.app` itself goes live.

### 6. The Failure Lab (ships with the launch)

- A fixed pool of three benches. Each is a development-mode gateway started with `createGateway` by `apps/field-station/src/lab/bench-main.ts` ([PLAN.md](PLAN.md#the-failure-lab-lab) says why not `streamotter dev`), with its own project `lontra-creek-lab-N`, its own copy of the creek on `lab-N.*` topics, its own consumer group, and its management API bound to loopback inside its container.
- The field station leases benches (five minutes, a queue, reset between leases) and exposes a redacted trace feed from each bench's management API. Management routes are never proxied.
- Scenarios:
  - **Fouled sensor:** remove LC-03's calibration table, so the map handler throws; restore it and resume.
  - **Flash flood:** cut the relay, then restore it.
  - **Satellite laptop:** a raw Socket.IO client on the bench that never sends receipts.
  - **Relay restart:** restart the bench gateway.
- **The relay cut** is proven (E2.0, [#17](https://github.com/jfricano/lontra-creek/pull/17); `deploy/compose.lab-spike.yaml`, `deploy/test/lab-spike.test.ts`, `.github/workflows/lab-spike.yml`). Kafka clients reconnect to the broker's *advertised* address, so each bench's whole path to Kafka goes through a proxy that is also what the broker advertises to it:
  - **Broker.** One extra SASL_SSL listener per bench (`KAFKA_BENCH_LISTENERS` in `deploy/kafka/start.sh`, named `BENCH1`…), advertised as that bench's proxy, `lab-N-kafka:910N`. The bench's bootstrap address is the same, so every connection KafkaJS makes (bootstrap, group coordinator, partition leaders) crosses the proxy. The broker's certificate names each proxy (`deploy/make-certs.sh kafka <dir> lab-1-kafka …`), since TLS runs end to end through it. Benches authenticate as their own SCRAM user (`KAFKA_LAB_USERNAME`, `KAFKA_LAB_PASSWORD`), created when the storage is formatted. Without these variables the broker's configuration is exactly as before.
  - **Proxy.** `apps/field-station/src/lab/proxy.ts`, in our own image, as a Compose service named `lab-N-kafka` that forwards `:910N` to `kafka:910N`. `POST /cut` on its control API (port 9180, the service token as bearer) closes the listener, so new connections are refused, and resets every connection it carries; `POST /restore` listens again on the same port. Chosen over stopping the proxy's container, which also works (measured below): the field station can call it on the Compose network without Docker's socket, which is root-equivalent; it acts at once, while a stop waits on the process's shutdown and removes the name from Docker's DNS; and it involves no container lifecycle, so it repeats cleanly.
  - **Feed.** With `FIELD_LAB_BENCHES=N`, the field station publishes each creek record, in the same batch, to every bench's copy of its topic (`lab-1.field.gauges`, …) over its own connection to `kafka:9094`, never through a proxy. Same key and value, so the bench's records match the snapshots the field station serves; one hour's retention; no notebooks.
  - **What StreamOtter 0.1.0-rc.3 does.** During the cut KafkaJS's fetches and heartbeats stop, and the source's watchdog marks it degraded after 12 seconds without broker activity, so subscriptions go stale with `SOURCE_UNAVAILABLE`. KafkaJS keeps retrying, at most 5 seconds apart; after the restore its first fetch or heartbeat makes the source healthy, and subscriptions resynchronize from a fresh snapshot. After a cut longer than the consumer's 30-second session, the broker has dropped the member: KafkaJS rejoins (`UNKNOWN_MEMBER_ID`), and commits of records processed in between fail, so those records come again; revisions kept increasing and the source stayed healthy.
  - **Measured** stale after the cut and live after the restore (each test cycle restores as soon as the bench is stale, except the long cut); the demo host's gateway, watched through Caddy, never changed state and kept receiving readings during every cut:

  | Cycle (September 26, [run 36296379017](https://github.com/jfricano/lontra-creek/actions/runs/36296379017), containers) | amd64 (`ubuntu-24.04`): stale / live | arm64 (`ubuntu-24.04-arm`): stale / live |
  | --- | --- | --- |
  | Proxy cut, restored at stale | 12.1 s / 3.5 s | 12.3 s / 4.7 s |
  | Proxy cut for 45 s | 12.1 s / 2.8 s | 12.3 s / 4.8 s |
  | Proxy cut again, restored at stale | 12.2 s / 4.5 s | 12.4 s / 3.4 s |
  | Proxy's container stopped, started at stale | 12.2 s / 7.1 s | 12.4 s / 2.7 s |

  Against the bounds of 20 and 30 seconds, the worst were 12.4 s to stale and 7.1 s to live. A native run on the owner's Mac (Kafka 4.1.2, Node 24.21, no containers) gave 12.3–12.4 s and 1.0–5.3 s. Live times include KafkaJS's retry backoff and the fresh snapshot, so they vary by a few seconds from run to run; the Lab shows the timings measured on its own deployment.

  - **For E2.1:** the bench's `authenticate` is still the badge check; replace it with lease-bound tokens. The management API's token lives in `bench-main.ts`; the bench API (reset, scenario actions, redacted traces) belongs in that process. The proxy's control API is what the flash flood scenario calls. `createKafkaHandlers` takes a `topicPrefix`; the fouled sensor's calibration table can live in the bench's own map handler. Resetting a bench between leases needs its consumer group moved to the latest offsets (or a new generation) while it's stopped.
  - **For E2.3:** per bench, one gateway service (`node src/lab/bench-main.ts`, `LAB_BENCH=N`) listening on 7400 at path `/lab/N/socket.io`, and one proxy service named `lab-N-kafka` (`node src/lab/proxy-main.ts`, `LAB_BENCH=N`); the broker's `KAFKA_BENCH_LISTENERS`, `KAFKA_LAB_USERNAME`, and `KAFKA_LAB_PASSWORD` (which `deploy/make-secrets.sh` doesn't generate yet); `FIELD_LAB_BENCHES=3` on the field station; `make-certs.sh kafka <dir> lab-1-kafka lab-2-kafka lab-3-kafka`. Caddy routes `/lab/N/*` to `lab-N:7400` without stripping the prefix; the proxies' control port and the benches' management port are never routed or published. The spike's published loopback ports are for its test only.

### 7. The rest of the site

- **Field station:** the six chapters over the live stack.
- **When it breaks:** each failure mode with its state and `StreamError`.
- **Playground:** `validateProjectConfig` from `streamotter/contracts` in the browser; check the bundle size.
- **Workbench:** a tour from Playwright screenshots of `npx streamotter dev` with a fixture project, captured in CI.
- **Docs:** a map of links.
- **Releases:** the pinned version and its limits.
- **Recorded fallback** for the live panel.

### 8. Launch

Everything in [PLAN.md's launch criteria](PLAN.md#launch-criteria) on the real deployment, the measured limits recorded in PLAN.md, then the owner's go-ahead for DNS on the apex.

## Milestones

| Milestone | Contains | Needs from the owner |
| --- | --- | --- |
| A. Stack proven in CI | Workstreams 1, 2, and 4 (notebooks may follow), plus 3's wiring. **Reached.** | Nothing |
| B. Staging on the real host | Workstream 5 | HOSTING.md sections 1–3 |
| C. Complete | Workstreams 6 and 7 | Content review |
| D. Launch | Workstream 8 | Go-ahead |

## Pitfalls already met

- **Astro 7 detaches its dev server when it detects an AI agent.** The root `npm run dev` passes `--ignore-lock` to keep it in the foreground.
- **`cookie` versions.** Socket.IO's server needs `cookie` 0.7 and npm hoists it; Astro's prerender output resolves `cookie` from the site, so the site depends on `cookie` 2.0.1 directly.
- **Astro's `Picture`** puts `class` on the `<img>`; use `pictureAttributes` to style the `<picture>`.
- **StreamOtter's schema dialect** has no nullable types or unions. Enumerations come from the simulation; `contract-check.ts` fails the type check on any drift. After changing `project.ts`, run `node scripts/configs.ts` and `npx streamotter generate` for both apps.
- **Changing simulation logic changes recomputed history.** Raise `FIELD_GENERATION` for the hosted world, or replayed ticks reuse revisions with different data and the source pauses on `REVISION_CONFLICT`.
- **Node type stripping** skips files under `node_modules`; npm workspace symlinks resolve outside it, which is why `@lontra-creek/sim` runs as TypeScript.
- **The tool sandbox** on the owner's Mac can't read `~/Desktop` or `~/Documents`; ask before reaching outside the project.
- **Oracle A1:** capacity can be short when creating the instance, and an instance whose CPU, network, and memory all stay under 20% for a week may be reclaimed.
- **`.app` is HTTPS-only** in every browser.
- **`streamotter start` refuses `.ts` handler modules** by extension, so the gateway's handlers are compiled (`npm run build -w @lontra-creek/field-station`).
- **No tombstones on StreamOtter sources.** V1 pauses a source on a null record value; represent deletion as explicit state.
- **Production gateways require the browser's `Origin`.** Node's `ws` client under the SDK sends none, and the SDK has no option for it, so `deploy/test/stack.test.ts` adds the header a page would send. A foreign origin completes the WebSocket upgrade and is then refused in the Socket.IO handshake with `FORBIDDEN`.
- **A JVM heap isn't resident until touched.** `-Xms` alone left Kafka at 452 MiB; `-XX:+AlwaysPreTouch` makes the heap count toward the host's memory use (2.19 GiB for a 2 GB heap).
