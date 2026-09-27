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
release=$(mktemp -d "$root/releases/$1.XXXXXX")
cp -R "$root/config/." "$release/"
# Bind-mounted broker scripts must remain readable/executable by container UIDs.
chmod -R a+rX "$release"
if [ -f "$root/lab.enabled" ]; then touch "$release/lab.enabled"; fi
candidate=$(mktemp "$root/releases/.candidate.XXXXXX")
trap 'rm -f "$candidate"' EXIT
cat "$root/stack.env" > "$candidate"
printf 'LONTRA_IMAGE=%s\nLONTRA_CONFIG_DIR=%s\n' "$image" "$release" >> "$candidate"
compose() {
  local envfile=$1 config
  config=$(sed -n 's/^LONTRA_CONFIG_DIR=//p' "$envfile")
  [[ "$config" == "$root/releases/"* && -d "$config" ]] || { echo 'Missing release config snapshot.' >&2; return 2; }
  local args=(-f "$config/compose.yaml")
  [ ! -f "$config/lab.enabled" ] || args+=(-f "$config/compose.lab.yaml")
  docker compose --project-directory "$config" "${args[@]}" --env-file "$envfile" "${@:2}"
}
compose "$candidate" config --quiet
if compose "$candidate" up --detach --wait --wait-timeout 300 --remove-orphans; then
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
    compose "$root/current.env" up --detach --wait --wait-timeout 300 --remove-orphans || { echo 'ROLLBACK FAILED: operator intervention required.' >&2; exit 1; }
    echo 'Previous release restored.' >&2
  else
    compose "$candidate" down
    echo 'First deploy failed; stopped services and retained volumes.' >&2
  fi
  exit 1
fi
