#!/usr/bin/env bash
set -euo pipefail
# Never eval the client command or accept arbitrary SSH commands / file transfers.
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec sudo -n /usr/local/sbin/lontra-deploy "${BASH_REMATCH[1]}"
fi
echo 'Only deploy <40-character commit SHA> is accepted.' >&2
exit 2
