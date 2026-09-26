# Launch on Coolify

## API only — Dockerfile build

Create a **separate application** for mirr0tech. The public repository can be imported directly from `https://github.com/LegalMirror/mirr0tech.git`; a GitHub App integration is not required.

| Coolify field | Value |
| --- | --- |
| Branch | `main` |
| Build strategy | Dockerfile |
| Base directory | `/` |
| Dockerfile location | `/deploy/Dockerfile.api` |
| Exposed port | **3200** |
| Host port mappings | Empty; use Coolify's HTTPS proxy |
| Watch paths | Empty to watch the repository, not `src/pages/**` |
| Pre/post-deployment commands | Empty; this is not a PHP application |
| Volume mount destination | **`/app/.data`**, read/write |
| Healthcheck | Keep the detected Dockerfile healthcheck |

Set the API's HTTPS domain and **Save changes** before deploying. The current API domain is `https://mir-api.peeramid.xyz`.

### Runtime variables

These are non-secret settings. The Dockerfile supplies most defaults; explicit runtime values must agree:

```ini
PORT=3200
HOST=0.0.0.0
NODE_ENV=production
EXPECTED_CHAIN_ID=11155111
DEPLOYMENT_PATH=deployments/sepolia.json
DATA_DIR=/app/.data
AUDIT_PATH=/app/.data/audit-11155111.json
SEED=false
PUBLIC_DEMO=true
WORLD_ENVIRONMENT=sandbox
WORLD_CREDENTIAL=document
WORLD_ACTION=humanity
```

`humanity` must be the action registered for **your** World app/RP. `sandbox` means the access-controlled World Sandbox app, not our local synthetic verifier or the browser staging simulator. Configure `staging` instead only when using that corresponding World environment. A supported v4 Passport credential and actual provider verification still need to be demonstrated; an environment flag alone does not establish them.

Add the actual values for these **runtime-only** secrets/configuration:

- `RPC_URL` — Sepolia RPC endpoint. An existing `ETH_SEPOLIA_RPC_URL` must be mapped to this name.
- `DEPLOYER_PRIVATE_KEY` — authorized testnet operator key. An existing `REGISTRAR_KEY` can be mapped to this name, but its wallet must have the required roles; renaming or funding it does not grant permissions.
- `API_KEY` — a separate, random operator bearer secret of at least 24 characters, **not** an Ethereum private key.
- `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY` — matching registered World v4 app/RP settings. The RP key is not the Ethereum key.
- Optional: a distinct `VIEWER_KEY`, and `MULTIBAAS_URL` / `MULTIBAAS_API_KEY` for Curvegrid indexing.

Investor setup additionally uses `INVESTOR_AGREEMENT_IDS` (comma-separated deployed cashier IDs) and optionally `INVESTOR_ALLOWED_ORIGINS` (comma-separated frontend origins; production defaults to `https://legalmirror.github.io`). These publish only fund metadata for the wallet/World ID login flow; private uploads stay private. Do not enable synthetic investor mock login on Sepolia. New cashier addresses must be registered with Curvegrid using their deployed ABIs; see [investor trading setup](../docs/INVESTOR_TRADING.md).

Keep secret **Buildtime off, Runtime on**. Do not copy unrelated IPFS, Privy, mnemonic or other application credentials into this resource. Leave `NOOLOG_API_KEY` unset to use the existing deterministic mock analysis adapter; setting it opts into live provider calls and document sharing.

Startup reuses the committed Sepolia stack. **Do not run `npm run deploy:stack`, `npm run deploy:sepolia` or `npm run seed:stack` as startup/pre-deployment commands.** Those are explicit operator/development operations, not API launch commands. Root `npm start` is the legacy custodial service; the image correctly starts `scripts/dev-stack.js`.

### Readiness check

Open `https://mir-api.peeramid.xyz/health`. Expected: HTTP **200**, JSON `status: "ok"`, `stack.chainId: 11155111`.

The Dockerfile probe uses Node and requires no curl/wget. If configuring an HTTP check yourself: GET, HTTP, `localhost`, port `3200`, path `/health`, expected code `200`, **empty expected response text**. The response is JSON, not plain `OK`.

- `INSUFFICIENT_FUNDS` during stack deployment means the service tried to deploy instead of reusing its record; inspect `DEPLOYMENT_PATH` and the deployed commit.
- `seed failed` means old code or incorrect `SEED` settings are still in use.
- A failed process will never become healthy by extending healthcheck retries. Inspect Runtime Logs.

## Frontend

GitHub Pages already builds the static dashboard with `NEXT_PUBLIC_GATEWAY_URL=https://mir-api.peeramid.xyz`. No frontend server is needed for that deployment. With `PUBLIC_DEMO=true` (the API image default), the workbench automatically obtains an anonymous workspace token, with no operator/viewer key prompt. Tokens are confined to that visitor's agreement lifecycle; source isolation and durable deployment quotas remain enforced. The backend's `API_KEY` is for maintenance only and is never sent to public visitors. Set `PUBLIC_DEMO=false` to disable public contract creation. [Limits and isolation](../docs/PUBLIC_DEMO.md).

To serve the frontend locally against the hosted backend:

```sh
npm ci
npm run vendor
npm --prefix dashboard ci
NEXT_PUBLIC_GATEWAY_URL=https://mir-api.peeramid.xyz npm --prefix dashboard run dev
```

Open `http://localhost:3100`. For a static production build, replace `run dev` with `run build`, then use `npm --prefix dashboard start` to serve `dashboard/out/` on port 3100.

A separate Coolify frontend may use `/deploy/Dockerfile.dashboard`, port **3100**, and **only** the public API URL as `NEXT_PUBLIC_GATEWAY_URL` at build time. Never pass the operator or RP signing keys as frontend build arguments.

## Compose alternatives

- Remote: `deploy/docker-compose.remote.yml` — API + dashboard, external Sepolia RPC, persistent API data, no Anvil service. Set its required runtime variables and attach HTTPS domains in Coolify. Its World environment defaults to staging; set `WORLD_ENVIRONMENT=sandbox` for your Sandbox configuration.
- Local: `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up --build` — development-only Anvil + API + frontend, ports bound to loopback. Do not deploy the local override publicly.

See [the root README](../README.md#run-it) for the two-terminal local launch, and [detailed deployment notes](../docs/deploy.md) for persistence and verification boundaries.
