#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8088}"
echo "MUA2 viewer: http://localhost:${PORT}"
python3 -m http.server "$PORT"
