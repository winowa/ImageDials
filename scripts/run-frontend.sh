#!/usr/bin/env bash
set -euo pipefail
# Optional POSIX compatibility wrapper. The portable entry point is run.mjs.
exec node "$(dirname -- "${BASH_SOURCE[0]}")/run.mjs" frontend
