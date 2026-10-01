#!/bin/sh
# Validate before Caddy interprets the value as matcher/proxy configuration.
set -eu
LONTRA_TRUSTED_EDGE_IP=${LONTRA_TRUSTED_EDGE_IP-10.203.43.2}
invalid() {
  echo 'LONTRA_TRUSTED_EDGE_IP must be one canonical IPv4 address (no CIDR/list).' >&2
  exit 2
}
case "$LONTRA_TRUSTED_EDGE_IP" in
  ''|*[!0-9.]*|.*|*.|*..*) invalid ;;
esac
validate_ip() {
  set -f
  IFS=.
  set -- $LONTRA_TRUSTED_EDGE_IP
  [ "$#" -eq 4 ] || invalid
  for octet do
    case "$octet" in
      0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9]) ;;
      *) invalid ;;
    esac
    [ "$octet" -le 255 ] || invalid
  done
}
validate_ip
export LONTRA_TRUSTED_EDGE_IP
exec caddy "$@"
