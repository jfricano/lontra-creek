#!/usr/bin/env bash
set -euo pipefail
umask 077
[ "$EUID" -eq 0 ] || { echo 'Run as root.' >&2; exit 2; }
[ "$#" -eq 1 ] && [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected one full lowercase commit SHA.' >&2; exit 2; }
root=/srv/lontra
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deploy is running.' >&2; exit 1; }
image="ghcr.io/jfricano/lontra-creek:$1"
# This root-only override is used by the isolated CI rehearsal, never the SSH entrypoint.
if [ "${LONTRA_REHEARSAL:-0}" != 1 ]; then docker pull "$image"; fi
candidate=$(mktemp "$root/releases/.candidate.XXXXXX")
trap 'rm -f "$candidate"' EXIT
cat "$root/stack.env" > "$candidate"
printf 'LONTRA_IMAGE=%s\n' "$image" >> "$candidate"
compose() { docker compose --project-directory "$root/config" -f "$root/config/compose.yaml" --env-file "$1" "${@:2}"; }
compose "$candidate" config --quiet
if compose "$candidate" up --detach --wait --wait-timeout 300; then
  if [ -f "$root/current.env" ]; then
    cp "$root/current.env" "$root/previous.env"
    cp "$root/current.sha" "$root/previous.sha"
  fi
  mv "$candidate" "$root/current.env"
  printf '%s\n' "$1" > "$root/current.sha"
  echo "Healthy release: $1"
else
  echo 'Candidate failed health checks.' >&2
  if [ -f "$root/current.env" ]; then
    compose "$root/current.env" up --detach --wait --wait-timeout 300 || { echo 'ROLLBACK FAILED: operator intervention required.' >&2; exit 1; }
    echo 'Previous release restored.' >&2
  else
    compose "$candidate" down
    echo 'First deploy failed; stopped services and retained volumes.' >&2
  fi
  exit 1
fi
