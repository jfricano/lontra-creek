#!/usr/bin/env bash
set -euo pipefail
umask 077
[ "$EUID" -eq 0 ] || { echo 'Run as root.' >&2; exit 2; }
root=/srv/lontra
[ "$#" -ge 1 ] || { echo 'Usage: lontra-checkpoint backup | verify <file.gz> | restore <file.gz>' >&2; exit 2; }
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deploy or checkpoint operation is running.' >&2; exit 1; }
config=$(sed -n 's/^LONTRA_CONFIG_DIR=//p' "$root/current.env")
[[ "$config" == "$root/releases/"* && -d "$config" ]] || { echo 'Missing release config snapshot.' >&2; exit 2; }
args=(-f "$config/compose.yaml")
[ ! -f "$config/lab.enabled" ] || args+=(-f "$config/compose.lab.yaml")
compose() { docker compose --project-directory "$config" "${args[@]}" --env-file "$root/current.env" "$@"; }
helper=$(cat "$config/checkpoint.mjs")
case "$1" in
  backup)
    [ "$#" -eq 1 ] || exit 2
    install -d -m 700 "$root/backups"
    file="$root/backups/world-$(date -u +%Y%m%dT%H%M%SZ).json.gz"
    temp=$(mktemp "$root/backups/.checkpoint.XXXXXX")
    trap 'rm -f "$temp"' EXIT
    compose exec -T field-station node --input-type=module -e "$helper" backup | gzip > "$temp"
    gzip -t "$temp"
    mv "$temp" "$file"
    # Keep fourteen days of completed, root-only local checkpoints.
    find "$root/backups" -maxdepth 1 -type f -name 'world-*.json.gz' -mtime +14 -delete
    echo "Saved $file"
    ;;
  verify|restore)
    [ "$#" -eq 2 ] && [ -f "$2" ] || exit 2
    file=$(realpath "$2")
    # Validate before stopping anything; the short-lived container never runs the station.
    gzip -dc "$file" | compose run --rm --no-deps -T field-station node --input-type=module -e "$helper" verify
    [ "$1" = restore ] || exit 0
    # Shutdown saves the current world, so stop before replacing it.
    compose stop gateway field-station
    gzip -dc "$file" | compose run --rm --no-deps -T field-station node --input-type=module -e "$helper" restore
    compose up --detach --wait --wait-timeout 300
    echo 'Checkpoint restored and services healthy; verify live subscriptions.'
    ;;
  *) exit 2 ;;
esac
