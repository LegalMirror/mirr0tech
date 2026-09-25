# Deploy

Pattern borrowed from the kjul/ETHGlobal_Online_2026 repo: one Dockerfile per app with a readiness
healthcheck, a production compose that publishes **no host ports** (Coolify's proxy reaches `expose`d
ports on the project network), all configuration as environment, and a `.env.coolify.example` to
paste into the project.

## Services (`deploy/docker-compose.yml`)

| Service | Image | Port | Role |
| --- | --- | --- | --- |
| `anvil` | `ghcr.io/foundry-rs/foundry` | 8545 | throwaway local chain (skipped when `RPC_URL` points elsewhere) |
| `api` | `deploy/Dockerfile.api` | 3200 | compiles all three policy profiles at build time; on boot deploys both acts to `RPC_URL` (`src/deploy.js`), serves `/v1/stack`, `/v1/policy`, `/v1/lenders`, `/v1/audit`, then seeds the golden-path state (`scripts/seed-stack.js`) |
| `dashboard` | `deploy/Dockerfile.dashboard` | 3100 | static Next.js site built with `NEXT_PUBLIC_GATEWAY_URL` pointing at the API's public URL |

A restart of `anvil` or `api` redeploys and reseeds — the chain is a demo fixture, not state. Point
`RPC_URL` at Sepolia with `DEPLOYER_PRIVATE_KEY`, `AQUA=0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`
and the canonical `POOL_MANAGER`/`WETH` to keep a deployment; then `MULTIBAAS_*` registers it.

## Coolify

1. New resource → **Docker Compose** → this repository, branch `main`, compose file `deploy/docker-compose.yml`.
2. Environment: paste `deploy/.env.coolify.example`, set `API_KEY` (secret) and `NEXT_PUBLIC_GATEWAY_URL` to the domain you attach to `api`, `NEXT_PUBLIC_GATEWAY_KEY` = `API_KEY`.
3. Domains: attach one to `api` (port 3200) and one to `dashboard` (port 3100). The API answers CORS for any origin; the bearer token is the gate.
4. Deploy. The API's healthcheck waits for the on-chain deployment (start period 120 s), so the proxy cuts over only when `/health` reports both policy hashes.
5. Change `NEXT_PUBLIC_*` → rebuild the dashboard (they are inlined at `next build`).

## Locally

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up --build
# API      http://127.0.0.1:3200/health
# dashboard http://127.0.0.1:3100   (built with NEXT_PUBLIC_GATEWAY_URL from your shell, e.g. http://127.0.0.1:3200)
```

Without Docker: `npm run dev:stack` (anvil + API on :3200) and `NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:3200 NEXT_PUBLIC_GATEWAY_KEY=local-dev-stack-operator-key-only npm --prefix dashboard run dev`.
