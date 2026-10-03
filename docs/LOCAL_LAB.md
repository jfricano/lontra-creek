# Run the Failure Lab locally from source

This runs the actual three-bench Kafka Lab without publishing an image or using
a hosted service. Requirements: Node 24+, npm, OpenSSL, Docker, and Docker Compose
2.24.4 or later. Docker may fetch the pinned Kafka, Caddy and Node base images.
The Lab is separate from `npm run dev` (fixture walkthrough) and `npm run dev:kafka`
(local Kafka walkthrough). Those modes do not start Lab benches.

Status: the secure bench scenarios have been exercised on native Kafka locally;
the container topology is checked by the Lab CI on amd64/arm64. This particular
browser-preview overlay is a documented source-build recipe, not yet executed
on this Mac because Docker is unavailable.

From the repository root, prepare an isolated, git-ignored local directory:

```sh
npm ci
mkdir -p .local/lab
export LOCAL_LAB_DIR="$PWD/.local/lab"
deploy/make-secrets.sh "$LOCAL_LAB_DIR/.env"
deploy/make-certs.sh kafka "$LOCAL_LAB_DIR/secrets/kafka" lab-1-kafka lab-2-kafka lab-3-kafka
deploy/make-certs.sh test-origin "$LOCAL_LAB_DIR/secrets/origin" localhost
node --input-type=module <<'JS'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const dir = process.env.LOCAL_LAB_DIR;
const config = JSON.parse(readFileSync('apps/field-station/streamotter.production.json', 'utf8'));
config.gateway.allowedOrigins = ['https://localhost:8443'];
writeFileSync(`${dir}/streamotter.production.json`, JSON.stringify(config, null, 2));
appendFileSync(`${dir}/.env`, `\nLONTRA_IMAGE=lontra-creek:local\nLONTRA_SECRETS=${dir}/secrets\nLOCAL_LAB_DIR=${dir}\nFIELD_EPOCH=${new Date().toISOString()}\nSITE_ORIGIN=https://localhost:8443\nGATEWAY_PUBLIC_ORIGIN=https://localhost:8443\nDEMO_HOST=localhost\nKAFKA_HEAP_OPTS=-Xms512m -Xmx512m\n`);
JS
PUBLIC_FIELD_STATION_ORIGIN=https://localhost:8443 npm run build -w @lontra-creek/site
docker build -f deploy/Dockerfile -t lontra-creek:local .
docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.local-lab.yaml --env-file "$LOCAL_LAB_DIR/.env" up -d --wait --wait-timeout 300
```

The override publishes only `127.0.0.1:8443`; Kafka, bench APIs, relay controls
and management listeners are not host ports. Open `https://localhost:8443/lab/`.
The static site and API use the same HTTPS origin, so secure Strict session
cookies work without changing browser cookie policy. No hosts-file change is
needed: `localhost` resolves to your own machine.

The generated CA and leaf certificate are throwaway development material. For a
browser preview, trust `.local/lab/secrets/origin/ca.pem` only in a dedicated local
test browser profile and remove that trust afterwards. Do not replace production
origin certificates with these files. Command-line verification can trust the CA
for only its own process:

```sh
LAB_SERVES_SITE=1 LAB_API_ORIGIN=https://localhost:8443 LAB_SITE_ORIGIN=https://localhost:8443 NODE_EXTRA_CA_CERTS="$LOCAL_LAB_DIR/secrets/origin/ca.pem" node --test --test-force-exit deploy/test/lab.test.ts
```

`LAB_SERVES_SITE=1` tells the suite that `/lab/` is a real static page here;
production's separate demo-only host returns 404 for that path. All private
backend and Origin assertions still run.

The local overlay runs Kafka with least-privilege ACLs (`KAFKA_AUTHORIZATION`
defaults to `acl` there; see `deploy/kafka/start.sh` and the Lab contract,
section 10.9): each bench's Kafka user reaches only its own `lab-N.*` topics
and `streamotter-lab-N-` groups. To check every principal's grants and refusals:

```sh
STACK_KAFKA_EXEC="docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.local-lab.yaml --env-file $LOCAL_LAB_DIR/.env exec -T" STACK_KAFKA_BENCHES="1 2 3" node --test --test-force-exit deploy/test/kafka-acls.test.ts
```

An existing local Kafka volume picks the ACLs up on its next start; no
migration is needed for local data.

Stop without deleting Kafka data:

```sh
docker compose -p lontra-local-lab -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.local-lab.yaml --env-file "$LOCAL_LAB_DIR/.env" down
```

To restart, reuse the same secrets, epoch and data. To reset the study completely,
use the same command with `down --volumes` (this intentionally deletes only this
local Compose project's Kafka/checkpoint volumes), then prepare a fresh local
directory. Nothing here deploys publicly or publishes the source-built image.
