#!/usr/bin/env sh
# Start the Suffix Atlas API if it is not already answering.
set -u
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PORT="${PORT:-8788}"
LOG="${TLD_ATLAS_LOG:-/tmp/opencode/tld-atlas-server.log}"

if node -e "fetch('http://127.0.0.1:${PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$(dirname -- "$LOG")"
cd "$DIR" || exit 1
setsid nohup node server/server.mjs </dev/null >>"$LOG" 2>&1 &
echo "Suffix Atlas API starting on port ${PORT}"
