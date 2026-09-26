# Remote deployment: Coolify + Sepolia + World staging

Use **`deploy/docker-compose.remote.yml`** for the hosted operator demonstration. It runs the API and dashboard, uses external Sepolia RPC, and persists agreement/audit/World binding state in `api-data`. It does not run or publicly expose Anvil. Coolify terminates HTTPS.

This is deployment configuration, **not evidence that a server has been provisioned**. You still need a Coolify resource/server, DNS, runtime secrets and a funded, authorized Sepolia signer.

## Coolify setup

1. Create a Docker Compose resource for `LegalMirror/mirr0tech`, branch `main`, base directory `/`, Compose file `deploy/docker-compose.remote.yml`.
2. Set the required runtime/build variables below. Keep runtime secrets out of build arguments.
3. Attach an HTTPS domain to **api, port 3200**, and one to **dashboard, port 3100**. DNS must point to your Coolify server; do not add public host ports to the Compose file.
4. Deploy. The API validates configuration before attempting transactions, checks RPC chain **11155111**, reuses `deployments/sepolia.json`, and reports readiness at `/health`. A wrong chain is refused rather than silently deploying elsewhere.
5. Open the dashboard and use **Connect**. Operator/viewer credentials stay in that browser tab's memory. Do not distribute the operator key to investors or place it in `NEXT_PUBLIC_*`.
6. Upload the actual bundled agreement, inspect analysis/AST, select the World constraint, then deploy its own token/hook. The optional NAV cashier is a new per-agreement deployment; it is not present in the old Sepolia record.

If using the existing GitHub Pages dashboard, a separate dashboard container is optional: connect that site to the new HTTPS API. The API still needs the same secrets and persistent volume.


## Required configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `RPC_URL` | API runtime secret | HTTPS Sepolia RPC endpoint; includes any provider key |
| `API_KEY` | API runtime secret | Unique high-entropy operator bearer token, at least 24 characters; never the public local-demo default |
| `DEPLOYER_PRIVATE_KEY` | API runtime secret | Funded testnet operator with the existing deployment's attestor/token/admin rights |
| `WORLD_APP_ID` | API runtime | Registered World v4 development `app_...` |
| `WORLD_RP_ID` | API runtime | Matching registered `rp_...` |
| `WORLD_RP_SIGNING_KEY` | API runtime secret | Signs RP requests; not an Ethereum wallet key |
| `NEXT_PUBLIC_GATEWAY_URL` | Dashboard build argument | Public **HTTPS API origin**, no credentials, query or fragment |

The committed deployment's original operator is `0xF0121f93b1a1bAd73AdDC316B57684bD93D3254e`. An arbitrary funded key is not sufficient: it must hold the required roles. Do not paste keys into chat, source control, build logs, or a public frontend configuration.

The API Dockerfile now defaults to the existing Sepolia deployment (`EXPECTED_CHAIN_ID=11155111`, `DEPLOYMENT_PATH=deployments/sepolia.json`), persistent `DATA_DIR=/app/.data`, and `SEED=false`. Public-chain startup refuses a missing or mismatched record instead of spending gas on a new stack; fresh stack deployment remains an explicit `deploy:stack` command. The remote entrypoint runs Node directly and refuses demo seeding in production, so crashes are no longer hidden behind a seed-readiness loop.

The remote Compose configuration sets:

- `NODE_ENV=production` to prohibit the synthetic World mock and the public default API key.
- `EXPECTED_CHAIN_ID=11155111`; `DEPLOYMENT_PATH=deployments/sepolia.json`.
- `WORLD_ENVIRONMENT` defaults to `staging` but can be set to `sandbox` for the authorized World Sandbox app; `WORLD_CREDENTIAL=document`.
- `DATA_DIR=/app/.data`, `AUDIT_PATH=/app/.data/audit-11155111.json`.
- No automatic golden-path seeding. Its synthetic World proofs are not valid in provider-backed staging.

Optional: a distinct `VIEWER_KEY` for read-only access; `WORLD_ACTION` (default `onboard-investor`, must match the registered action); `SOURCE_COMMIT` for build attribution.

Leaving `NOOLOG_API_KEY` empty uses the existing deterministic mock analysis adapter. Set it only to opt into live model calls and sending uploaded document text to that provider. This setting does **not** mock World verification.

## World Passport/NFC simulation: verify the capability

[World's IDKit integration guide](https://docs.world.org/world-id/idkit/integrate) links the [official simulator](https://simulator.worldcoin.org/) with `environment: staging`. The documented simulator example uses a legacy credential; **v4 Passport/NFC simulator support has not yet been confirmed for this integration**.

The application requests the v4 `passport()` preset, schema **9303**, a wallet-bound signal and no legacy fallback. For a successful demonstration, the simulator must actually supply that credential and World's server must accept it. If it cannot, show credential unavailable and ask World support for the appropriate test environment. Do not relabel a synthetic proof or an Orb/legacy proof as NFC verification.

Sandbox is a separate access-controlled World App environment; it is not a synonym for staging. For a registered Sandbox app/action, set `WORLD_ENVIRONMENT=sandbox` and `WORLD_ACTION` to that exact action (for example, `humanity`). The workbench passes both to IDKit unchanged. This enables the Sandbox flow but does not assert that a Passport credential is available there; unsupported credentials must remain refused. [World integration and evidence boundary](WORLD_ID.md).

New uploads bind a configured non-default action into their policy hash. Existing records retain their original action; reapply the World ID constraint and redeploy to adopt a changed registered action. Merely restarting with another `WORLD_ACTION` must not reinterpret an existing deployment. If you prepared a Coolify export before changing these variables, update the exported runtime values too.

### Readiness versus proof success

- `/health` must return HTTP 200 and `stack.chainId: 11155111`.
- Authenticated `/v1/status` reports chain/model/compiler.
- Authenticated `/v1/stack/worldid/context` must report `mock: false`, the selected `environment` (`staging` or `sandbox`), `credential: document`, the registered action, and a signed RP context. This proves request preparation, **not** a successful credential verification.
- After agreement deployment, use its `/v1/agreements/<id>/stack/worldid/context` and proof endpoint so its configured credential/policy is enforced.
- Obtain a supported simulator proof, verify it through World on the server, then inspect the chain attestation receipt and refreshed access decision. Exercise cancellation/rejection without granting a new fact.

No real simulator proof or upstream verification is supplied by the deployment files.

## Who signs what

IDKit collects identity proofs. The RP key signs World requests. The issuer key attests facts/deploys policy contracts. A user wallet signs their Ethereum transactions.

World App's MiniKit `sendTransaction` is documented for **World Chain mainnet (480)**, not the current Sepolia pool; `walletAuth` signs a SIWE authentication message, not a swap. A Sepolia-capable browser wallet is the appropriate investor signer for this deployment. Arbitrary investor-wallet transaction preparation/session authentication is still separate from the current operator/demo-wallet transaction routes. Do not give an investor the operator API key as a substitute.

## Persistence and security

Keep one API replica with a durable `api-data` volume. It contains agreements, audits and scoped World nullifier bindings. Back it up; do not delete it to reset a failed proof. Changing the action/credential/environment changes the binding namespace. Multiple API replicas need a transactional shared store instead of the prototype's files.

`.dockerignore` excludes `.env*`, local ledger/cache directories and common key files from image builds. No operator or RP signing secret is a dashboard build argument. CORS supports the workbench's PUT constraints route; bearer authorization remains the API gate. This is a privileged operator prototype, not public investor authentication. Restrict access as appropriate and use test funds only.

## Local development

Without Docker:

```sh
pnpm install --frozen-lockfile
pnpm run build && pnpm run build:secondary && pnpm run build:credit
pnpm run dev:stack
# In another terminal:
pnpm --dir dashboard run dev
```

The API defaults to `127.0.0.1:3000`, dashboard to port 3100. With no World registration configured, this local path uses **our synthetic mock**, not the official simulator.

The legacy local Compose pair explicitly enables development mode and binds host ports to loopback:

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up --build
```

Its API uses port 3200. Never deploy that development override on a public server.

## Troubleshooting

- **`503 UNAVAILABLE: Demo state persistence failed; operator intervention required`** — the API could not write `DATA_DIR` (`/app/.data`) and closed public work; the log line `demo workspaces: cannot persist … EACCES` names the cause. It happens when the `api-data` volume was created by an older image and is root-owned. The image's entrypoint now starts as root, `chown`s the volume to `node`, and drops privileges, so a redeploy repairs it; the API also refuses to start when `DATA_DIR` is not writable (`DATA_DIR … is not writable (uid …)`), so the problem shows in the logs at boot instead of on the first upload. A one-off repair without redeploying: `docker run --rm -v <stack>_api-data:/d alpine chown -R 1000:1000 /d`. `GET /health` reports `demo: ok | broken`.
