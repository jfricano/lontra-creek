# Run the Failure Lab locally from source

`npm run dev:lab` runs the actual three-bench Kafka Failure Lab on your machine,
built from this checkout: Kafka 4.1.2 over TLS with SCRAM, the field station, the
production gateway, three Lab benches with their relay proxies, and Caddy, in
Docker, served only at `https://localhost:8443`. It publishes no image, uses no
hosted service, and deploys nothing.

## Which local mode?

Lontra Creek has three ways to run locally. They are not interchangeable.

| Command | What runs | Kafka | Failure Lab | Needs |
| --- | --- | --- | --- | --- |
| `npm run dev` | Field station replaying the simulation through a development gateway, the Astro dev server, and the StreamOtter workbench, at `http://127.0.0.1:4321` | No (fixture replay) | No | Node 24 |
| `npm run dev:kafka` | The walkthrough on a native, loopback-only, plaintext Kafka broker, with persistent private notebooks (chapter six), at `http://127.0.0.1:4321/field-station/` | Yes, your own Kafka 4.1.2 and JDK 21 install | No | Node 24, `KAFKA_HOME`, `JAVA_HOME` |
| `npm run dev:lab` | The production container topology plus three Lab benches, behind local HTTPS, at `https://localhost:8443/lab/` | Yes, in Docker, over TLS with SCRAM | Yes, three benches | Node 24, Docker, Compose 2.24.4+, OpenSSL |

`npm run dev` and `npm run dev:kafka` start no Lab benches; the `/lab/` page
there has no live benches. Only `dev:lab` exercises the real Lab, and only
Docker and Kafka make broker durability observable: the fixture mode cannot
demonstrate it.

## Requirements

- Node 24 or later, and `npm ci` already run in this checkout.
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
   (`FIELD_EPOCH`). Anything already there is kept, so a restart resumes the
   same study with the same secrets and test CA.
3. Builds the site for the `https://localhost:8443` origin, and the image
   `lontra-creek:local` from `deploy/Dockerfile`. The image stays on this machine.
4. Starts the Compose project `lontra-local-lab` from `deploy/compose.yaml`,
   `deploy/compose.lab.yaml` and `deploy/compose.local-lab.yaml`, and waits up to
   five minutes for every service to report healthy.
5. Checks and prints the URLs below, and how to handle the test certificate.

| URL | What it is |
| --- | --- |
| `https://localhost:8443/` | The built site |
| `https://localhost:8443/lab/` | The Failure Lab page |
| `https://localhost:8443/api/status` | Field station health and study status (Kafka connection, tick) |
| `https://localhost:8443/api/lab/status` | Lab status: each bench's state, queue length, next free time |

Only `127.0.0.1:8443` is published. Kafka, the bench APIs, relay controls and
management listeners are not host ports. The static site and API share one
HTTPS origin, so the Lab's secure `Strict` session cookies work without
changing browser cookie policy. No hosts-file change is needed: `localhost`
resolves to your own machine.

`npm run dev:lab -- up --no-build` restarts with the existing site build and
image, skipping both builds.

## Commands

Pass options after `--`, for example `npm run dev:lab -- logs -f caddy`.

| Command | Effect |
| --- | --- |
| `up` (default) | Check, prepare, build, start, and print URLs. Safe to repeat. |
| `status` | `docker compose ps` for the project, then probe the four URLs. |
| `logs [--follow] [service...]` | The last 200 log lines, optionally streaming, optionally for named services (`caddy`, `kafka`, `field-station`, `gateway`, `lab-1`, `lab-1-kafka`, and so on). |
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
checkpoints, Caddy's data volume, and `.local/lab/` with the secrets, test CA
and study epoch. The next `npm run dev:lab` resumes the same study; the field
station catches up to the wall clock from its checkpoint. This is the only
way the launcher stops the stack, and it never deletes a volume.

**Discard** (`npm run dev:lab -- discard`) is separate and destructive. It lists
the project's volumes and the local directory, then asks you to type the
project name. Only that exact answer proceeds; anything else cancels. In a
non-interactive shell (a script or CI), it refuses unless `--yes` is given.
Confirmed, it runs `docker compose down --volumes --remove-orphans` for this
project only and deletes the local directory. It refuses to delete a directory
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
image, and had all eleven services healthy at `https://localhost:8443` in
about 75 seconds, with all three benches ready about ten seconds later (a fresh
study from the existing image, `up --no-build`, took under a minute). `deploy/test/lab.test.ts` then
passed all seven tests against it (lease, relay cut and restore, fouled sensor,
satellite timeout, gateway restart, token and edge isolation). `stop` kept the
three volumes and the study epoch, `up --no-build` resumed with them, the
port-in-use check and the discard guard (non-interactive refusal, wrong typed
answer) refused as described, and a confirmed `discard` removed exactly the
project's volumes and `.local/lab/`. The Lab's container topology is also
checked by the Lab CI on amd64 and arm64. macOS and Windows hosts have not
been tried; the launcher calls `bash` for the repository's certificate and
secret scripts.

## What the launcher runs (manual recipe)

The same steps by hand, for debugging or for a machine without the launcher.
They use the same directory, files and project name, so the launcher's
`status`, `stop` and `discard` work on a stack started this way.

```sh
npm ci
mkdir -p .local/lab
export LOCAL_LAB_DIR="$PWD/.local/lab"
deploy/make-secrets.sh "$LOCAL_LAB_DIR/.env"
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
docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.local-lab.yaml --env-file "$LOCAL_LAB_DIR/.env" up -d --wait --wait-timeout 300
```

The local overlay runs Kafka with least-privilege ACLs (`KAFKA_AUTHORIZATION`
defaults to `acl` there; see `deploy/kafka/start.sh` and the Lab contract,
section 10.9): each bench's Kafka user reaches only its own `lab-N.*` topics
and `streamotter-lab-N-` groups. To check every principal's grants and refusals:

```sh
STACK_KAFKA_EXEC="docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.local-lab.yaml --env-file $LOCAL_LAB_DIR/.env exec -T" STACK_KAFKA_BENCHES="1 2 3" node --test --test-force-exit deploy/test/kafka-acls.test.ts
```

An existing local Kafka volume picks the ACLs up on its next start; no
migration is needed for local data.

Stop, keeping data (what `stop` runs):

```sh
docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.local-lab.yaml --env-file "$LOCAL_LAB_DIR/.env" down
```

Discard (what `discard` runs after confirmation): the same command with
`down --volumes --remove-orphans`, which deletes only this local Compose
project's Kafka, checkpoint and Caddy volumes, then `rm -rf .local/lab`.
