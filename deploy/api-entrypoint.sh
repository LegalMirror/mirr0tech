#!/bin/sh
# Starts the stack API (which deploys both acts to RPC_URL), then seeds the golden-path state once
# the API answers. With no RPC_URL the API spawns its own anvil.
set -e
node scripts/dev-stack.js &
API=$!
for i in $(seq 1 120); do
  if node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
if [ "${SEED:-true}" = "true" ]; then STACK_URL="http://127.0.0.1:${PORT:-3200}" node scripts/seed-stack.js || echo "seed failed (continuing)"; fi
wait $API
