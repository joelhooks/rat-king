#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/../../.."
exec pnpm generate:ship-confidence "$@"
