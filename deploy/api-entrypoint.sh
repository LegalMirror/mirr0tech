#!/bin/sh
# Seeding is opt-in local development only. In the remote path Node is the main process,
# so startup failures exit immediately instead of hiding behind a readiness polling loop.
set -e
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
