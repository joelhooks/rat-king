#!/usr/bin/env bash
# Run on the host that holds the command issuer's signing identity.
set -euo pipefail

if [[ $# != 2 || $1 != seed ]]; then
  printf '%s\n' 'Usage: bash apps/ratking-sh/edge.sh seed <public-plan.json>' >&2
  exit 2
fi

: "${RAT_KING_OPERATOR_IDENTITY:?Set the command issuer identity secret name}"
: "${RATKING_IDENTITY_ISSUER:?Set the deployed public issuer pin}"

umask 077
state="${XDG_STATE_HOME:-$HOME/.local/state}/rat-king/public-edge"
mkdir -p -- "$state"
log="$state/seed.log"

if ! secrets --no-update-check lease "$RAT_KING_OPERATOR_IDENTITY" \
  --ttl 1m --client-id rat-king-edge-seed 2>/dev/null \
  | node "$(dirname -- "${BASH_SOURCE[0]}")/seed-identity.ts" "$2" >>"$log" 2>&1; then
  printf 'Identity seed failed; see %s (check issuer lease if stdin was empty).\n' "$log" >&2
  exit 1
fi

printf 'Identity seed verified; see %s.\n' "$log"
