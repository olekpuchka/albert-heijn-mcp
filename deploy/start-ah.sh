#!/bin/sh
# JustRunMyApp: run with "sh /app/start-ah.sh".
# Keep /app on persistent storage. This installs npm's latest stable release
# on each restart; an npm/network failure is logged before starting the
# previously installed package.
set -eu
cd /app
export PATH="/app/runtime24/bin:$PATH"

echo "[startup] Checking npm for the latest albert-heijn-mcp release"
if npm install albert-heijn-mcp@latest --save-exact --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-timeout=15000; then
  echo "[startup] Package update completed"
else
  echo "[startup] WARNING: update failed; attempting to start the installed version" >&2
fi

exec /app/runtime24/bin/node /app/node_modules/albert-heijn-mcp/dist/index.js --transport streamable-http --remote
