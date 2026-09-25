# Deploy

Coolify pattern from kjul/ETHGlobal_Online_2026: one Dockerfile per app, readiness healthchecks,
no host ports in the production compose, everything as environment.

| Service (`deploy/docker-compose.yml`) | Port | Role |
| --- | --- | --- |
| `anvil` | 8545 | throwaway chain, skipped when `RPC_URL` is set |
| `api` (`deploy/Dockerfile.api`) | 3200 | compiles the three profiles at build; on boot deploys both acts to `RPC_URL` or reuses `DEPLOYMENT_PATH`; serves `/v1/*`; seeds the golden path when `SEED=true`; the audit persists in the `api-data` volume |
| `dashboard` (`deploy/Dockerfile.dashboard`) | 3100 | static Next.js, `NEXT_PUBLIC_*` inlined at build |

**Sepolia.** Set `RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `DEPLOYMENT_PATH=deployments/sepolia.json`
(the committed record; matching chain id → no redeploy), `SEED=false` after the first boot, and
`MULTIBAAS_*` to register the contracts. The canonical `AQUA`, `POOL_MANAGER`, `WETH` are in
`.env.coolify.example`.

## Coolify

1. Resource → Docker Compose → this repo, branch `main`, file `deploy/docker-compose.yml`.
2. Paste `deploy/.env.coolify.example`; set `API_KEY`, `NEXT_PUBLIC_GATEWAY_URL` (the `api` domain), `NEXT_PUBLIC_GATEWAY_KEY`.
3. Attach domains to `api` (3200) and `dashboard` (3100). CORS is open; the bearer token is the gate.
4. Deploy. `api` becomes healthy once `/health` reports both policy hashes (start period 120 s).

`NEXT_PUBLIC_GATEWAY_KEY` is compiled into the browser bundle: anyone opening the dashboard can read it.
Fine for the demo; do not reuse it as a production operator key.

## Locally

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up --build
# or without Docker:
npm run dev:stack   # anvil + API on :3200
NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:3200 NEXT_PUBLIC_GATEWAY_KEY=local-dev-stack-operator-key-only npm --prefix dashboard run dev
```
