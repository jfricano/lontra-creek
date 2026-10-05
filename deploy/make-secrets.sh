#!/usr/bin/env bash
# Writes the stack's secrets as a Compose env file, readable by its owner only.
# An existing file is kept: new secrets would lock the field station out of the
# Kafka users created when the broker's storage was formatted.
#
#   deploy/make-secrets.sh <env-file>
#
# Because an existing file is kept as written, a variable added to the heredoc
# below after a host's env file was first generated never reaches that host on
# its own. Reach it by hand: generate one value with the same method this script
# uses, append it, and restart whichever service reads it, for example:
#
#   printf 'LAB_BENCH_1_RELAY_TOKEN=%s\n' "$(openssl rand -hex 32)" >> <env-file>
#   docker compose --env-file <env-file> up -d lab-1-kafka lab-1
set -euo pipefail

[ $# -eq 1 ] || { echo "Usage: $0 <env-file>" >&2; exit 2; }
file="$1"
if [ -e "$file" ]; then
  echo "$file already exists; keeping it."
  exit 0
fi

secret() {
  openssl rand -hex 32
}

umask 077
mkdir -p "$(dirname "$file")"
cat > "$file" <<ENV
# Lontra Creek stack secrets, generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by deploy/make-secrets.sh.
FIELD_STATION_SECRET=$(secret)
FIELD_STATION_SERVICE_TOKEN=$(secret)
KAFKA_GATEWAY_PASSWORD=$(secret)
KAFKA_FIELD_STATION_PASSWORD=$(secret)
LAB_RELAY_TOKEN=$(secret)
KAFKA_LAB_1_PASSWORD=$(secret)
LAB_BENCH_1_SERVICE_TOKEN=$(secret)
LAB_BENCH_1_RELAY_TOKEN=$(secret)
KAFKA_LAB_2_PASSWORD=$(secret)
LAB_BENCH_2_SERVICE_TOKEN=$(secret)
LAB_BENCH_2_RELAY_TOKEN=$(secret)
KAFKA_LAB_3_PASSWORD=$(secret)
LAB_BENCH_3_SERVICE_TOKEN=$(secret)
LAB_BENCH_3_RELAY_TOKEN=$(secret)
ENV
echo "Wrote $file."
