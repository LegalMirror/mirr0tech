#!/bin/sh
# Runs as root once so the mounted data directory is writable by `node` (a named volume made by an
# older image is root-owned), then re-executes itself as `node`. With arguments it runs them; with
# none it starts the API and, in local development only, seeds it.
set -e
DATA_DIR="${DATA_DIR:-/app/.data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups sh "$0" "$@"
  fi
  exec su -s /bin/sh node -c 'exec sh "$0" "$@"' -- "$0" "$@"
fi
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
if [ "${SEED:-false}" != "true" ]; then
  exec node scripts/dev-stack.js
fi
if [ "${NODE_ENV:-development}" = "production" ]; then
  echo "SEED=true is for local development only; set SEED=false for the remote API" >&2
  exit 1
fi
node scripts/dev-stack.js &
API=$!
trap 'kill "$API" 2>/dev/null || true' EXIT
trap 'exit 143' TERM INT
READY=false
for i in $(seq 1 120); do
  if ! kill -0 "$API" 2>/dev/null; then
    wait "$API"
    exit 1
  fi
  if node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then READY=true; break; fi
  sleep 1
done
if [ "$READY" != "true" ]; then
  echo "Local API did not become ready; skipping seed" >&2
  exit 1
fi
STACK_URL="http://127.0.0.1:${PORT:-3200}" node scripts/seed-stack.js
wait "$API"
