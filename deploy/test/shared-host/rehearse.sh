#!/usr/bin/env bash
# Only run on an isolated disposable CI host. Never on a populated shared server.
set -euo pipefail
[ "${CI:-}" = true ] || { echo 'Disposable CI host required.' >&2; exit 2; }
[ "$(docker info --format '{{.CgroupDriver}}')" = systemd ] || { echo 'systemd Docker cgroups required.' >&2; exit 2; }
root=$(pwd)
stack="$RUNNER_TEMP/lontra-shared"
mkdir -p "$stack"
deploy/make-secrets.sh "$stack/.env"
deploy/make-certs.sh kafka "$stack/secrets/kafka" lab-1-kafka lab-2-kafka lab-3-kafka
deploy/make-certs.sh test-origin "$stack/secrets/origin" demo.streamotter.app
{
  echo 'LONTRA_IMAGE=lontra-creek:shared-ci'
  echo "LONTRA_SECRETS=$stack/secrets"
  echo "FIELD_EPOCH=$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)"
  echo 'LONTRA_CGROUP_PARENT=lontra.slice'
} >> "$stack/.env"
base=(docker compose -p lontra-creek -f deploy/compose.yaml -f deploy/compose.shared.yaml --env-file "$stack/.env")
full=(docker compose -p lontra-creek -f deploy/compose.yaml -f deploy/compose.lab.yaml -f deploy/compose.shared.yaml -f deploy/compose.shared.lab.yaml --env-file "$stack/.env")
metrics=''
cleanup() {
  [ -z "$metrics" ] || { kill "$metrics" 2>/dev/null || true; wait "$metrics" 2>/dev/null || true; }
  "${full[@]}" logs --no-color --tail=100 || true
  "${full[@]}" down --volumes || true
  docker rm -f lontra-shared-edge >/dev/null 2>&1 || true
  docker network rm edge-lontra >/dev/null 2>&1 || true
  sudo systemctl stop lontra.slice || true
}
trap cleanup EXIT
sudo install -m 644 deploy/systemd/lontra.slice /run/systemd/system/lontra.slice
sudo systemctl daemon-reload
sudo systemctl start lontra.slice
docker network create --subnet 10.203.43.0/24 --ip-range 10.203.43.128/25 edge-lontra
"${base[@]}" config --format json > "$stack/base.json"
node deploy/test/shared-host/config.mjs "$stack/base.json"
"${full[@]}" config --format json > "$stack/full.json"
node deploy/test/shared-host/config.mjs "$stack/full.json"
# Lab overlay is used only by this synthetic-data rehearsal; public Lab stays gated.
"${full[@]}" up -d --wait --wait-timeout 420
"${full[@]}" ps -q | xargs docker inspect > "$stack/containers.json"
sudo node deploy/test/shared-host/config.mjs "$stack/full.json" "$stack/containers.json"
(
  while true; do docker stats --no-stream --format '{{json .}}'; sleep 5; done
) > "$RUNNER_TEMP/lontra-shared-resources.jsonl" &
metrics=$!
docker run -d --name lontra-shared-edge --network edge-lontra --ip 10.203.43.2 \
  -p 127.0.0.1:443:443 -v "$root/deploy/test/shared-host/Caddyfile.edge:/etc/caddy/Caddyfile:ro" \
  -v "$stack/secrets/origin:/etc/caddy/origin:ro" caddy:2.11.4-alpine
printf '127.0.0.1 demo.streamotter.app\n' | sudo tee -a /etc/hosts >/dev/null
for i in $(seq 1 30); do curl -sSf --cacert "$stack/secrets/origin/ca.pem" https://demo.streamotter.app/api/config >/dev/null && break; sleep 1; done
peer() {
  docker run --rm --network edge-lontra --ip "$1" --add-host demo.streamotter.app:10.203.43.2 \
    -e NODE_EXTRA_CA_CERTS=/ca.pem -v "$stack/secrets/origin/ca.pem:/ca.pem:ro" \
    -v "$root/deploy/test/shared-host/peer.mjs:/peer.mjs:ro" lontra-creek:shared-ci node /peer.mjs "$2"
}
peer 10.203.43.4 attacker
peer 10.203.43.5 other
export NODE_EXTRA_CA_CERTS="$stack/secrets/origin/ca.pem"
export STACK_ORIGIN=https://demo.streamotter.app
export LAB_API_ORIGIN=https://demo.streamotter.app
export LAB_SITE_ORIGIN=https://streamotter.app
node --test --test-force-exit deploy/test/stack.test.ts
node --test --test-force-exit deploy/test/lab.test.ts
for bench in 1 2 3; do "${full[@]}" exec -T "lab-$bench" node --input-type=module - bench < deploy/test/lab-private-checks.mjs; done
"${full[@]}" exec -T field-station node --input-type=module - field < deploy/test/lab-private-checks.mjs
# Install shared activation metadata only on this disposable runner.
release="/srv/apps/lontra/releases/$GITHUB_SHA"
sudo install -d -m 700 /srv/apps/lontra /etc/apps/lontra /usr/local/lib/app-backup-hooks
sudo install -d -m 755 "$release/kafka"
for file in compose.yaml compose.lab.yaml compose.shared.yaml compose.shared.lab.yaml Caddyfile.shared start-caddy-shared.sh; do sudo install -m 644 "deploy/$file" "$release/$file"; done
sudo install -m 644 deploy/kafka/start.sh "$release/kafka/start.sh"
sudo touch "$release/lab.enabled"
sudo install -m 600 "$stack/.env" /etc/apps/lontra/lontra.env
printf 'LONTRA_CONFIG_DIR=%s\nLONTRA_IMAGE=lontra-creek:shared-ci\n' "$release" > "$stack/current.env"
sudo install -m 600 "$stack/current.env" /srv/apps/lontra/current.env
sudo install -m 700 deploy/shared-host/backup.py /usr/local/lib/app-backup-hooks/lontra-backup.py
for hook in snapshot verify; do sudo install -m 700 "deploy/shared-host/lontra-$hook" "/usr/local/lib/app-backup-hooks/lontra-$hook"; done
stage=$(sudo mktemp -d /tmp/lontra-shared-backup.XXXXXX)
world_hash() { "${full[@]}" exec -T field-station node -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/var/lib/lontra/world.json')).digest('hex'))"; }
before=$(world_hash)
sudo /usr/local/lib/app-backup-hooks/lontra-snapshot "$stage"
sudo /usr/local/lib/app-backup-hooks/lontra-verify "$stage"
sudo test -s "$stage/lontra-verified.json"
[ "$(world_hash)" = "$before" ]
curl -sSf --cacert "$stack/secrets/origin/ca.pem" https://demo.streamotter.app/api/status >/dev/null
# Corruption must fail closed without a live-volume write or leaked resources.
sudo rm "$stage/lontra-verified.json"
printf 'broken' | sudo tee "$stage/lontra-world.json" >/dev/null
if sudo /usr/local/lib/app-backup-hooks/lontra-verify "$stage"; then echo 'Corrupt backup accepted' >&2; exit 1; fi
sudo test ! -e "$stage/lontra-verified.json"
[ "$(world_hash)" = "$before" ]
[ -z "$(docker volume ls -q --filter label=lontra.backup=disposable)" ]
[ -z "$(docker ps -aq --filter name=lontra-backup-verify-)" ]
# Default shared router denies Lab traffic even if an old bench still exists.
"${base[@]}" up -d --no-deps --wait caddy
[ "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$stack/secrets/origin/ca.pem" -H 'Origin: https://streamotter.app' 'https://demo.streamotter.app/lab/1/socket.io/?EIO=4&transport=websocket')" = 404 ]
"${full[@]}" up -d --no-deps --wait caddy
"${full[@]}" ps -q | xargs docker inspect > "$stack/containers-final.json"
sudo node deploy/test/shared-host/config.mjs "$stack/full.json" "$stack/containers-final.json"
echo 'Shared-host network, trust, resources and real Kafka scenarios passed.'
