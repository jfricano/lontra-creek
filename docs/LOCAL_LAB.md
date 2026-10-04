# Run the Failure Lab locally from source

`npm run dev:lab` runs the actual three-bench Kafka Failure Lab on your machine,
built from this checkout: Kafka 4.1.2 over TLS with SCRAM, the field station, the
production gateway, three Lab benches with their relay proxies, the workbench
sandbox (three synthetic slots on the published StreamOtter workbench seam), and
Caddy, in Docker, served only at `https://localhost:8443`. It publishes no image, uses no
hosted service, and deploys nothing.

## Which local mode?

Lontra Creek has three ways to run locally. They are not interchangeable.

| Command | What runs | Kafka | Failure Lab | Needs |
| --- | --- | --- | --- | --- |
| `npm run dev` | Field station replaying the simulation through a development gateway, the Astro dev server, and the StreamOtter workbench, at `http://127.0.0.1:4321` | No (fixture replay) | No | Node 24 |
| `npm run dev:kafka` | The walkthrough on a native, loopback-only, plaintext Kafka broker, with persistent private notebooks (chapter six), at `http://127.0.0.1:4321/field-station/` | Yes, your own Kafka 4.1.2 and JDK 21 install | No | Node 24, `KAFKA_HOME`, `JAVA_HOME` |
| `npm run dev:lab` | The production container topology plus three Lab benches and the workbench sandbox, behind local HTTPS, at `https://localhost:8443/lab/` and `/workbench/` | Yes, in Docker, over TLS with SCRAM | Yes, three benches | Node 24.15+, Docker, Compose 2.24.4+, OpenSSL |

`npm run dev` and `npm run dev:kafka` start no Lab benches; the `/lab/` page
there has no live benches. Only `dev:lab` exercises the real Lab, and only
Docker and Kafka make broker durability observable: the fixture mode cannot
demonstrate it.

## Requirements

- Node 24.15 or later (the failure journal's floor), and `npm ci` already run in
  this checkout. On this branch `npm ci` installs StreamOtter 0.2.0-rc.1 from the
  pre-publish tarballs in `vendor/` ([vendor/README.md](../vendor/README.md)).
- Docker (Engine or Desktop) with the daemon running, and the Docker Compose v2
  plugin, 2.24.4 or later (the local overlay uses `!override`).
- OpenSSL, for the throwaway secrets and test certificates.
- Port 8443 free on 127.0.0.1.
- Network access to pull the pinned Kafka, Caddy and Node base images and npm
  packages on the first build. Kafka runs with a 512 MB heap here; the other
  ten containers are small Node and Caddy processes.

The launcher checks each of these before doing anything and says what is
missing.

## Start

```sh
npm ci
npm run dev:lab
```

`up` (the default command) does the following, in order:

1. Checks the prerequisites above.
2. Prepares `.local/lab/` (git-ignored; see below): stack secrets
   (`deploy/make-secrets.sh`), a private Kafka CA and broker certificate
   (`deploy/make-certs.sh kafka`), a throwaway test CA and `localhost`
   certificate for Caddy (`deploy/make-certs.sh test-origin`), the gateway
   configuration with `https://localhost:8443` as its only allowed origin, and
   the local settings in `.local/lab/.env`, including the study epoch
   (`FIELD_EPOCH`) and the sandbox service token (`SANDBOX_SERVICE_TOKEN`,
   appended once to an env file made before the sandbox existed). Anything already there is kept, so a restart resumes the
   same study with the same secrets and test CA.
3. Builds the site for the `https://localhost:8443` origin, and the image
   `lontra-creek:local` from `deploy/Dockerfile`. The image stays on this machine.
4. Starts the Compose project `lontra-local-lab` from `deploy/compose.yaml`,
   `deploy/compose.lab.yaml`, `deploy/compose.sandbox.yaml` and
   `deploy/compose.local-lab.yaml`, and waits up to five minutes for every
   service to report healthy.
5. Checks and prints the URLs below, and how to handle the test certificate.

| URL | What it is |
| --- | --- |
| `https://localhost:8443/` | The built site |
| `https://localhost:8443/lab/` | The Failure Lab page |
| `https://localhost:8443/api/status` | Field station health and study status (Kafka connection, tick) |
| `https://localhost:8443/api/lab/status` | Lab status: each bench's state, queue length, next free time |
| `https://localhost:8443/workbench/` | The workbench sandbox page |
| `https://localhost:8443/api/sandbox/status` | Sandbox status: availability, the running StreamOtter and workbench versions, each slot's state |

Only `127.0.0.1:8443` is published. Kafka, the bench and sandbox APIs, relay
controls, slot gateways, and management listeners are not host ports; Caddy
routes only each slot's `/sandbox/N/socket.io/` for this origin. The static site and API share one
HTTPS origin, so the Lab's secure `Strict` session cookies work without
changing browser cookie policy. No hosts-file change is needed: `localhost`
resolves to your own machine.

`npm run dev:lab -- up --no-build` restarts with the existing site build and
image, skipping both builds.

The local Lab runs Kafka with least-privilege ACLs (`KAFKA_AUTHORIZATION=acl`)
and the benches with the `quarantine` failure-handling profile and the local
exercises (`LAB_FAILURE_HANDLING=quarantine`, `LAB_LOCAL_EXERCISES=1`, set by
`deploy/compose.local-lab.yaml`), so every source-failures scenario, LC11-S01
to S09, is offered here. The hosted Lab's default is `retry` with no local
exercises, which offers only the calibration blip (Lab contract 12.2). To try
that profile locally, export `LAB_FAILURE_HANDLING=retry LAB_LOCAL_EXERCISES=0`
before `up`; the field station and every bench read the same value.

## Commands

Pass options after `--`, for example `npm run dev:lab -- logs -f caddy`.

| Command | Effect |
| --- | --- |
| `up` (default) | Check, prepare, build, start, and print URLs. Safe to repeat. |
| `status` | `docker compose ps` for the project, then probe the six URLs. |
| `logs [--follow] [service...]` | The last 200 log lines, optionally streaming, optionally for named services (`caddy`, `kafka`, `field-station`, `gateway`, `lab-1`, `lab-1-kafka`, `sandbox`, and so on). |
| `stop` | Remove the containers and network. **Keeps** the volumes and `.local/lab/`. |
| `discard [--yes]` | **Deletes** the local study: the project's containers and volumes, and `.local/lab/`. Asks first. |

Every command also takes `--dir <path>` (default `.local/lab`) and
`--project <name>` (default `lontra-local-lab`). The directory must be under
this repository's `.local/` and ignored by git, so secrets and study data can
never be committed or land where something serves them (such as
`apps/site/dist`). `.local/` itself is refused, as is `dev:kafka`'s
`.local/kafka-dev` (or its `LONTRA_KAFKA_DATA_DIR`) and any directory inside
or containing it. `up` also refuses an existing directory that has files but
no `dev-lab.json`, so `discard` never deletes another tool's data. The project
name is recorded in `<dir>/dev-lab.json` on the first `up`, and later commands
use it. A second local Lab therefore needs both its
own `--dir` and its own `--project`, and cannot run at the same time as the
first, because port 8443 is fixed by `deploy/compose.local-lab.yaml` and
`deploy/Caddyfile.local-lab`.

## Stop versus discard

**Stop** (`npm run dev:lab -- stop`) ends the containers and keeps everything
that makes up the current study: the Kafka log, the field station's
checkpoints, each bench's study volume (`lab-1-state` to `lab-3-state`: its
`study.json`, journal, and discarded-study summaries), Caddy's data volume,
and `.local/lab/` with the secrets, test CA and study epoch. The next `npm run dev:lab` resumes the same study; the field
station catches up to the wall clock from its checkpoint. This is the only
way the launcher stops the stack, and it never deletes a volume.

**Discard** (`npm run dev:lab -- discard`) is separate and destructive. It lists
the project's volumes and the local directory, then asks you to type the
project name. Only that exact answer proceeds; anything else cancels. In a
non-interactive shell (a script or CI), it refuses unless `--yes` is given.
Confirmed, it runs `docker compose down --volumes --remove-orphans` for this
project only and deletes the local directory. The bench study volumes go with
it, so each bench's current study and its discarded-study summaries are gone
too. It refuses to delete a directory
the launcher did not make (one without `dev-lab.json`). Images are kept. The
next `npm run dev:lab` starts a new study with new secrets and a new test CA,
so remove the old CA from any test browser profile that trusted it.

## The test certificate

Caddy serves `localhost` with a certificate from a throwaway CA generated in
`.local/lab/secrets/origin/ca.pem`. The launcher never adds it, or anything
else, to a system, keychain, or browser trust store, and never asks to.

- **Browser:** use a dedicated local test browser profile. Either accept the
  certificate warning for `localhost` there, or import `ca.pem` into that
  profile only, and remove it when you are done. Do not trust it in your
  everyday profile or system-wide.
- **Command line:** trust the CA for one process only:

  ```sh
  curl --cacert .local/lab/secrets/origin/ca.pem https://localhost:8443/api/lab/status
  ```

  The launcher's own URL checks pass the CA to each request the same way.
- Never use these files in place of the production origin certificate.

## Verify the Lab end to end

With the stack up, the Lab suite runs against it:

```sh
LAB_SERVES_SITE=1 LAB_API_ORIGIN=https://localhost:8443 LAB_SITE_ORIGIN=https://localhost:8443 \
  NODE_EXTRA_CA_CERTS="$PWD/.local/lab/secrets/origin/ca.pem" \
  node --test --test-force-exit deploy/test/lab.test.ts
```

`LAB_SERVES_SITE=1` tells the suite that `/lab/` is a real static page here;
production's separate demo-only host returns 404 for that path. All private
backend and Origin assertions still run.

The workbench sandbox suite runs against the same stack: status and versions,
a session through every allowlisted operation, a 64 KB candidate through Caddy,
previews of `station` and `jobProgress` through `/sandbox/N/socket.io/`, closed
edge paths, and a reset ending the old study's previews:

```sh
SANDBOX_API_ORIGIN=https://localhost:8443 SANDBOX_SITE_ORIGIN=https://localhost:8443 \
  NODE_EXTRA_CA_CERTS="$PWD/.local/lab/secrets/origin/ca.pem" \
  node --test --test-force-exit deploy/test/sandbox.test.ts
```

## The workbench sandbox

`deploy/compose.sandbox.yaml` adds one `sandbox` container, from the same image,
with three synthetic slots (`SANDBOX_SLOTS`, default 3) on the published
StreamOtter workbench seam (WHC-1): each slot runs the creek's `station` channel
and the `streamotter init` example's `jobProgress` on fixture sources, never
Kafka. `https://localhost:8443/workbench/` mounts the published
`@streamotter/workbench` UI, served from the site's own origin, once you choose
**Start a sandbox session**. Its contract is
[docs/contracts/sandbox-api.md](contracts/sandbox-api.md), and its design
[LC11-ADR-04](releases/v1.1/decisions/LC11-ADR-04-workbench-sandbox-architecture.md).

| Inside the Compose network | What it is | Routed by Caddy |
| --- | --- | --- |
| `sandbox:7620` | The sandbox API; only the field station calls it, with `SANDBOX_SERVICE_TOKEN` | No |
| `sandbox:7601` to `sandbox:7603` | Slot N's development gateway | Only `/sandbox/N/socket.io/*`, for the site's exact Origin (403 otherwise) |
| Loopback inside the container | Each study's management handler, answering only a per-study key | No |

The field station and the sandbox share `SANDBOX_SERVICE_TOKEN`, a 32-byte random
value in `.local/lab/.env`. `deploy/make-secrets.sh` writes it into a new env
file; for an env file made before the sandbox existed, `up` appends one once.
The sandbox starts only with an allowlisted environment (`SANDBOX_*`,
`SITE_ORIGIN`, `NODE_ENV`, and what the container sets), so no
`FIELD_STATION_*` value, Kafka credential, or Lab token reaches it, and it
publishes no port.

Lab benches and sandbox slots share one place limit: a client address holds at
most two places across both (`too-many-places` otherwise). A session ends after
a minute without a check-in from the page.

## Source-failure exercises

The Lab page's **Source failures** track runs the V1.1 exercises (LC11-S01–S09)
on a borrowed bench: open `https://localhost:8443/lab/#source-failures`, choose
**Borrow a bench**, then **Start this scenario** on a story the page lists as
available, and follow the incident panel. What each story shows, how a scenario
gets offered, and what has been verified where are in
[SOURCE_FAILURE_EXERCISES.md](releases/v1.1/SOURCE_FAILURE_EXERCISES.md); the
interface is the [Lab contract, section 12](contracts/lab-api.md#12-the-source-failures-track-v11).

Whether a story is offered is the backend's answer, not the page's. Ask it
directly:

```sh
curl --cacert .local/lab/secrets/origin/ca.pem https://localhost:8443/api/lab/capabilities
```

A story the summary doesn't list as available stays listed with its reason:
`not-integrated` while the installed release isn't one this Lab was verified
against for that story (for 0.2.0-rc.1 a story joins that set only after its
real-Kafka test passes here), or `deployment-restricted` when the benches'
failure-handling profile (`LAB_FAILURE_HANDLING`) or `LAB_LOCAL_EXERCISES`
doesn't cover it. Which stories the local stack offers is recorded in
[STATUS.md](releases/v1.1/STATUS.md).

On this stack all eight new stories are offered: `npm run dev:lab` runs the benches with the
`quarantine` profile, `LAB_LOCAL_EXERCISES=1` and Kafka ACLs on. The hosted default
(`LAB_FAILURE_HANDLING=retry`, no ACLs) offers only Calibration blip (S06).

The source-failures exercises (Lab contract 12.9) run as a visitor through
Caddy and check the broker itself through `docker compose exec`: the
quarantine topic's copies, committed offsets, and leftover groups. S08 also
restarts a bench container, and S09 deletes a quarantine copy. A scenario is
admitted to `VERIFIED_WITH` only after this suite passes for it:

```sh
C="docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.sandbox.yaml -f deploy/compose.local-lab.yaml --env-file .local/lab/.env"
LAB_API_ORIGIN=https://localhost:8443 LAB_SITE_ORIGIN=https://localhost:8443 \
  NODE_EXTRA_CA_CERTS="$PWD/.local/lab/secrets/origin/ca.pem" \
  LAB_STACK_EXEC="$C exec -T" LAB_STACK_RESTART="$C restart" \
  node --test --test-force-exit deploy/test/lab-source-failures.test.ts
```

Without `LAB_STACK_EXEC` the broker checks, and S09, are skipped; without
`LAB_STACK_RESTART`, S08 runs only its gateway restart. S2's lease expiry in
`deploy/test/lab.test.ts` waits out a whole lease (up to five minutes), so it
runs only with `LAB_EXPIRY_TEST=1`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Port 8443 on 127.0.0.1 is in use` | Another local Lab or another program holds it. `npm run dev:lab -- stop` for a local Lab; there is only one port 8443. |
| `npm ci` in the image build fails with `SELF_SIGNED_CERT_IN_CHAIN` | Your network re-signs HTTPS; use `--extra-ca` (below). |
| Compose says `SANDBOX_SERVICE_TOKEN` is required | A hand-made env file without it. Append one as `deploy/OPERATIONS.md` (Workbench sandbox overlay) shows, then recreate `field-station` and `sandbox` together. `npm run dev:lab` does this for you. |
| `/workbench/` says the sandbox is not enabled | The field station has no `SANDBOX_API_URL`: the stack was started without `deploy/compose.sandbox.yaml`. Start it with `npm run dev:lab`, or add that file to a manual `docker compose` command. |
| `/api/sandbox/status` reports `seam-unavailable` | The installed StreamOtter has no WHC-1 manifest. Run `npm ci`, then `up` (with builds). |
| The site build fails with `Workbench assets: … Re-pin apps/site/src/scripts/workbench-seam.ts` | The installed `@streamotter/workbench` differs from the version and integrity the site pins. Re-pin from the installed `workbench-host.json`, as the file's comment says. |
| Every source-failure story is listed as unavailable | See the capability summary's reason (above). With Lab benches running, that is the backend's answer, not a fault. |
| `npm test` reports eight cancelled tests in `lab-coverage.test.ts` | It ran on Node 22. Use Node 24.15 or later. |
| Starting a sandbox session answers `too-many-places` | This address already holds two places across the Lab and the sandbox. Return a bench or end a session. |

## Behind a TLS-intercepting proxy

If `npm ci` inside the image build fails with `SELF_SIGNED_CERT_IN_CHAIN` or a
similar certificate error, your network re-signs HTTPS traffic. Pass the
proxy's CA bundle for the build only:

```sh
npm run dev:lab -- up --extra-ca /path/to/proxy-ca-bundle.pem
```

The launcher writes an adapted copy of `deploy/Dockerfile` to
`.local/lab/build/` whose `npm ci` steps read that bundle as a BuildKit secret
(`--secret id=ca`) through `NODE_EXTRA_CA_CERTS`. The bundle is not copied into
any image layer, and `deploy/Dockerfile` is unchanged. Without the flag,
nothing about the build changes.

## Status

On October 3, 2026, `npm run dev:lab` ran end to end in a Linux (amd64)
container with Docker 29.6.2 and Compose 5.3.1, behind a TLS-intercepting proxy
(so with `--extra-ca`): a cold `up` pulled the base images, built the site and
image, and had all ten services healthy at `https://localhost:8443` in
about 75 seconds, with all three benches ready about ten seconds later (a fresh
study from the existing image, `up --no-build`, took under a minute). `deploy/test/lab.test.ts` then
passed all seven tests against it (lease, relay cut and restore, fouled sensor,
satellite timeout, gateway restart, token and edge isolation). `stop` kept the
three volumes the stack had then (the bench study volumes came later) and the
study epoch, `up --no-build` resumed with them, the
port-in-use check and the discard guard (non-interactive refusal, wrong typed
answer) refused as described, and a confirmed `discard` removed exactly the
project's volumes and `.local/lab/`. The Lab's container topology is also
checked by the Lab CI on amd64 and arm64. macOS and Windows hosts have not
been tried; the launcher calls `bash` for the repository's certificate and
secret scripts.

On October 4, 2026, with the workbench sandbox added (W9a), a cold `up` in the
same kind of container (with `--extra-ca`, its own `--dir` and `--project`)
had all eleven services healthy, all three benches ready, and the sandbox
`available` on StreamOtter 0.2.0-rc.1 with host contract 1 and all three slots
ready. `deploy/test/sandbox.test.ts` passed all five tests against it, and
again after `stop` and `up --no-build`; that restart, with
`SANDBOX_SERVICE_TOKEN` removed from the env file first, appended a new token
once. Only Caddy's port was published: the sandbox API, the slot gateways, and
each slot's loopback management listener were not reachable from the host.

On October 4, 2026, with the source-failures exercises (W9b, StreamOtter
0.2.0-rc.1, quarantine profile, ACLs on), `deploy/test/lab-source-failures.test.ts`
passed LC11-S01 to S09 and A32 against a cold `up` of the same kind (its own
`--dir` and `--project`), as did `deploy/test/lab.test.ts` with
`LAB_EXPIRY_TEST=1`, `lab-private-checks.mjs` on every bench and the field
station, and `deploy/test/kafka-acls.test.ts`. A bench container restarted in
place resumed its study; one recreated after being killed failed on its
journal lock, which names the old container's host name, and the field
station's reset replaced its study within a minute (Lab contract 8b).

## What the launcher runs (manual recipe)

The same steps by hand, for debugging or for a machine without the launcher.
They use the same directory, files and project name, so the launcher's
`status`, `stop` and `discard` work on a stack started this way.

```sh
npm ci
mkdir -p .local/lab
export LOCAL_LAB_DIR="$PWD/.local/lab"
deploy/make-secrets.sh "$LOCAL_LAB_DIR/.env"            # includes SANDBOX_SERVICE_TOKEN
deploy/make-certs.sh kafka "$LOCAL_LAB_DIR/secrets/kafka" lab-1-kafka lab-2-kafka lab-3-kafka
deploy/make-certs.sh test-origin "$LOCAL_LAB_DIR/secrets/origin" localhost   # only once: it always makes a new CA
node --input-type=module <<'JS'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const dir = process.env.LOCAL_LAB_DIR;
const config = JSON.parse(readFileSync('apps/field-station/streamotter.production.json', 'utf8'));
config.gateway.allowedOrigins = ['https://localhost:8443'];
writeFileSync(`${dir}/streamotter.production.json`, JSON.stringify(config, null, 2));
appendFileSync(`${dir}/.env`, `\nLONTRA_IMAGE=lontra-creek:local\nLONTRA_SECRETS=${dir}/secrets\nLOCAL_LAB_DIR=${dir}\nFIELD_EPOCH=${new Date().toISOString()}\nSITE_ORIGIN=https://localhost:8443\nGATEWAY_PUBLIC_ORIGIN=https://localhost:8443\nDEMO_HOST=localhost\nKAFKA_HEAP_OPTS=-Xms512m -Xmx512m\n`);
writeFileSync(`${dir}/dev-lab.json`, JSON.stringify({ project: 'lontra-local-lab', createdAt: new Date().toISOString() }, null, 2) + '\n');
JS
PUBLIC_FIELD_STATION_ORIGIN=https://localhost:8443 npm run build -w @lontra-creek/site
docker build -f deploy/Dockerfile -t lontra-creek:local .
docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.sandbox.yaml -f deploy/compose.local-lab.yaml --env-file "$LOCAL_LAB_DIR/.env" up -d --wait --wait-timeout 300
```

The local overlay runs Kafka with least-privilege ACLs (`KAFKA_AUTHORIZATION`
defaults to `acl` there; see `deploy/kafka/start.sh` and the Lab contract,
section 10.9): each bench's Kafka user reaches only its own `lab-N.*` topics
and `streamotter-lab-N-` groups. To check every principal's grants and refusals:

```sh
STACK_KAFKA_EXEC="docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.sandbox.yaml -f deploy/compose.local-lab.yaml --env-file $LOCAL_LAB_DIR/.env exec -T" STACK_KAFKA_BENCHES="1 2 3" node --test --test-force-exit deploy/test/kafka-acls.test.ts
```

An existing local Kafka volume picks the ACLs up on its next start; no
migration is needed for local data.

Stop, keeping data (what `stop` runs):

```sh
docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.sandbox.yaml -f deploy/compose.local-lab.yaml --env-file "$LOCAL_LAB_DIR/.env" down
```

Discard (what `discard` runs after confirmation): the same command with
`down --volumes --remove-orphans`, which deletes only this local Compose
project's six volumes (Kafka, checkpoint, Caddy, and the three bench study
volumes), then `rm -rf .local/lab`.
