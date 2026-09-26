#!/usr/bin/env bash
# Writes the stack's secrets as a Compose env file, readable by its owner only.
# An existing file is kept: new secrets would lock the field station out of the
# Kafka users created when the broker's storage was formatted.
#
#   deploy/make-secrets.sh <env-file>
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
ENV
echo "Wrote $file."
