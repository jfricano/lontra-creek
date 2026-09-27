#!/usr/bin/env bash
set -euo pipefail
[ "$EUID" -eq 0 ] || { echo 'Run as root.' >&2; exit 2; }
root=/srv/lontra
config=$(sed -n 's/^LONTRA_CONFIG_DIR=//p' "$root/current.env")
[[ "$config" == "$root/releases/"* && -d "$config" ]] || { echo 'Missing release config snapshot.' >&2; exit 2; }
args=(-f "$config/compose.yaml")
[ ! -f "$config/lab.enabled" ] || args+=(-f "$config/compose.lab.yaml")
compose() { docker compose --project-directory "$config" "${args[@]}" --env-file "$root/current.env" "$@"; }
status=0
services=$(compose config --services)
[ -n "$services" ] || { echo 'No configured services.' >&2; exit 1; }
while IFS= read -r service; do
  id=$(compose ps -q "$service")
  if [ -z "$id" ] || [ "$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")" != 'running healthy' ]; then
    echo "UNHEALTHY: $service" >&2
    status=1
  fi
done <<< "$services"
if [ ! -d "$root/backups" ] || ! find "$root/backups" -name 'world-*.json.gz' -mmin -1500 -print -quit | grep -q .; then
  echo 'No completed checkpoint backup within 25 hours.' >&2
  status=1
fi
[ "$status" -ne 0 ] || echo 'All configured services healthy; checkpoint backup recent.'
exit "$status"
