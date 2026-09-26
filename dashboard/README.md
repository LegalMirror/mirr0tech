# Mirr0rtech dashboard

Next.js 15 App Router, React 19, TypeScript and plain CSS. Static-exportable. The default route stays the contract workbench; `/investor` is the separate World Passport / wallet-signed Sepolia flow. `ethers@6.17.0` is used for exact-unit conversion, EIP-191 signature verification and calldata validation—not a backend or custodial wallet. The existing palette and classic dashboard routes remain unchanged.

## Launch commands

Run dependency/setup commands from the repository root:

```sh
npm ci
npm run vendor
npm --prefix dashboard ci
npm --prefix dashboard run export
```

### Local frontend → hosted Sandbox/Sepolia API

```sh
cd dashboard
NEXT_PUBLIC_GATEWAY_URL=https://mir-api.peeramid.xyz ./node_modules/.bin/next dev -p 3100
```

Open **http://localhost:3100/** for anonymous demo contract creation and **http://localhost:3100/investor** for investor sign-in. The investor API defaults to `https://mir-api.peeramid.xyz` when the build variable is absent. The backend must allow the dashboard origin for investor challenges; a working CORS response alone is not investor authorization.

### Local frontend → local API

Run the gateway from a separate terminal at the repository root. To reuse the existing Sepolia deployment with server credentials already configured in its runtime environment:

```sh
EXPECTED_CHAIN_ID=11155111 DEPLOYMENT_PATH=deployments/sepolia.json DATA_DIR=.data/sepolia SEED=false WORLD_ENVIRONMENT=sandbox WORLD_CREDENTIAL=document npm run dev:stack
```

Then run the frontend from `dashboard/`:

```sh
NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:3000 ./node_modules/.bin/next dev -p 3100
```

Server-only prerequisites: `RPC_URL`, an authorized/funded testnet signer, the backend's internal operator configuration, matching registered `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, and the app's actual registered `WORLD_ACTION`. Do not put any of those secrets in frontend variables. For public investor trading, the backend must publish a cashier-enabled agreement via its investor service. The existing legacy stack is read-only. **The investor UI signs on Sepolia only**; local Anvil can exercise the anonymous agreement demo but is not presented as a Sandbox Passport success. See [root launch instructions](../README.md#run-it) and [API/Coolify setup](../deploy/README.md) for backend startup, publishing and persistence.

### Static build and validation (from `dashboard/`)

```sh
npm run export
NEXT_PUBLIC_GATEWAY_URL=https://mir-api.peeramid.xyz ./node_modules/.bin/next build
./node_modules/.bin/tsc --noEmit
npm test
npm run lint
npm start
```

`npm start` serves `out/` at port 3100. GitHub Pages needs only the static export and the public API URL; use the deployment's existing base-path settings. The normal `npm run dev`, `npm run build`, and `npm run typecheck` wrappers stamp build metadata first. **This working tree has a user-owned `zimport` typo in `scripts/build-info.mjs`; those wrappers are currently blocked.** The direct commands above deliberately bypass that file and reuse the existing generated `lib/build-info.json`; they do not fix or overwrite the user edit. A clean checkout without that local typo can use the normal wrappers.

`npm run ui:export` at the repository root writes `dashboard/public/data/{index,custodial-rwa,rwa-secondary,wildcat-credit}.json`. It compiles the fixtures with `{ demo: true }`; these exports are real compiler artifacts, **not evidence of a live extraction or deployment**. The sample library needs these generated files. Build and dev generate them automatically. Export failures are shown in the UI with the command needed to produce them. No fallback silently turns a failed live connection into a sample.

## Workbench flow

1. Open `/`. The workbench makes one bounded attempt to read public `GET /v1/demo/config` and create `POST /v1/demo/session`. Anyone can create contracts in this isolated anonymous demo workspace; no World login, operator key or viewer key is requested. If the demo API is missing, disabled or unreachable, the **Sample** library remains explicitly read-only. A failed attempt does not loop.
2. **Connection** contains only gateway URL, start/retry and disconnect controls. Demo tokens stay in memory and authorize only the agreed agreement/status paths. Reloading creates a new workspace; expiration requires an explicit new-workspace action and never replays an upload/deploy. Previous/private agreement records are not fetched. Remote gateways require HTTPS; local HTTP is allowed on loopback. Samples support clause/AST selection, graph filtering/zoom, source reading and paragraph coverage.
3. **Upload Contracts** defaults to downloadable **Demo documents**: the real BUIDL source. Explicitly check the NAV option to include the separately authored `nav-cashier-addendum.md` and `rwa-cashier-config.json` with `cashier.enabled=true`. Inspect the selected source files and JSON before submitting the real `POST /v1/agreements`. These assets are copied from the backend fixtures by `npm run demo:sync` (also run by dev/build); they are not pre-baked upload responses. The dialog also accepts pasted text/Markdown/HTML or a bundle of `.txt`, `.md`, `.htm`, `.html` files. No PDF support. Limits match the server: 2 MB per document, 4 MB for the JSON request. Files go to the gateway and, when configured, its extraction provider. The public demo backend accepts only the bundled BUIDL source (optionally the authored NAV addendum with its matching config), and only the two RWA profiles. Paste/file controls can submit the same base source; use Demo documents for the complete NAV bundle/config. Arbitrary documents and live/custom Noolog extraction are not allowed in anonymous scope.
4. Generation is automatic after upload. The detail and list views poll every 2 seconds while jobs are in flight; settled details poll every 10 seconds, list/status every 15 seconds. Polls are serial and cancellable; obsolete responses are discarded. Read failures retry after 5 seconds. Writes are never automatically retried. Requests time out after 30 seconds; a timed-out write may still be running on the server, so refresh before retrying.
5. In **Deploy**, review policy coverage and configure the issuer's **World ID constraint**: credential, actions and verbatim source quote. Saving uses `PUT /constraints`, recompiles the policy and clears the current deployment record. Existing chain contracts remain unchanged. Constraint edits are not a new extraction deliberation.
6. **Regenerate** and **Deploy** require confirmation and a valid scoped demo workspace for the selected, owned agreement. Deployment also requires `compiled`, a reported signer and a supported token profile. The credit profile uses its existing stack venue and cannot be deployed per agreement. Confirmation is rejected if the selected policy changes while it is open. The backend remains the authority on state and authorization.
7. The **Analysis** view opens after upload. It shows recorded lifecycle transitions (not invented streaming progress), Noolog claim verdicts with their quotes, filters for contested/unverified claims, evaluator counter-positions, unresolved interpretations, and exhaustive compiler checks. The existing backend mock Noolog adapter produces the report when no live model is configured. Its report is labeled **Simulated Noolog analysis**; no frontend-generated verdicts or false live claim are used. Trace any source-backed claim directly into the AST.
8. **World ID** explains the contract's credential choice, clause and privacy boundary. Anonymous demo tokens cannot access agreement `/stack` or classic admin methods. Use the separate **Investor dashboard** for a publicly published fund's Passport login and wallet operations. Configuring a demo identity rule or deploying a demo contract grants no investor or operator privileges.

The **API** view shows the current agreement response and documented routes, supports manual refresh and downloads the compiled policy export. The **Deploy** view also retains the browser policy evaluator, explicitly labeled as a local simulation. It does not transact or attest facts.

### Security and provenance

- The public UI has no operator/viewer secret inputs. Demo and investor tokens are held in **separate memory stores**, never localStorage, sessionStorage, cookies, URLs or generated files. Neither token is copied into `operatorKey` or `viewerKey`.
- **Never put operator, World RP, wallet or MultiBaas secrets in `NEXT_PUBLIC_*`.** Only the gateway URL is public configuration. The internal adapter's key injection remains a test/operator seam, not a login option in the public UI.
- Demo requests are allowlisted to own agreement list/read/upload/AST/constraints/regenerate/deploy and status paths. `/stack`, classic admin routes, private policy reads and investor endpoints are rejected before fetch with a demo token. Classic screens retain sample reads, but public sessions cannot mutate their admin data. Investor auth calls only `/v1/investor/*` and uses no issuer credentials. All requests omit cookies, disable caching and refuse redirects; the backend remains authoritative.
- The gateway must allow this dashboard's exact origin and authorization/content-type/idempotency-key headers through CORS, including **PUT** for constraints. Backend CORS configuration is outside `dashboard/**`.
- **Sample**, **mock extraction**, and **live extraction evidence** are distinct. A verified-claims badge requires a non-mock report with a job ID, evaluators, claims and source/extraction provenance. It is not a blanket “Verified” claim. The evidence dialog exposes hashes, claim verdicts, contested counts and the original report.
- Compiler evidence is labeled **exhaustive equivalence checks**, not Z3. Demo compilation and unresolved terms remain visible. A compiled export is not a deployment; a gateway deployment record is not an independent RPC verification.
- NAV, reserve backing, redemption liquidity and settlement at NAV require separate arrangements. No unknown NAV/cashier backend is assumed or presented as live.
- Uploaded HTML is rendered as text through React/the existing document reader, never injected into the page.

## Investor dashboard: wallet → Passport → eligibility → swap

`/investor` auto-reads public `/v1/investor/config` and `/funds`, without an API key. Missing/outdated routes and empty publication lists have explicit pending-update states. It does not query private agreements or turn a demo token into investor authorization.

1. Connect a Sepolia-capable **injected EIP-1193 wallet**. World MiniKit `sendTransaction` is not a Sepolia signer. Chain/account changes and disconnection clear the investor session and invalidate outstanding work. An already-open wallet prompt can still complete in the wallet, so inspect its history before retrying.
2. Choose a public fund, request `/auth/challenge`, inspect its exact EIP-191 message, then explicitly sign it with `personal_sign`. The client checks wallet, fund, policy hash, origin, World nonce, chain and expiry. It never rewrites the server message.
3. Complete the configured **Passport** request through theD: judge-ready trust moment

1. Start from **Upload Contracts → Demo documents** and inspect the real source. If demonstrating NAV terms, explicitly opt into the separate authored addendum/config. Submit and review **Analysis → Contract-AST → World ID**.
2. Explain the chosen credential as minimum sufficient **for the credential condition**, not the whole agreement. A document credential does not tell the issuer who someone is, complete KYC/AML, clear sanctions, or establish accreditation. Proof of Human is not a promise that bots or abuse disappear; Selfie Check is not strict uniqueness.
3. On a deployed, hash-matching policy, select a gateway wallet. The view reads `/stack/wallets/:wallet` and `/stack/wallets/:wallet/explain?policy=rwa&action=…` for each protected action. Selecting a wallet is not a wallet-key ownership proof.
4. Confirm the exact wallet, required credential and disclosure before proceeding. The IDKit preset uses **that exact wallet address as `signal`**. A fresh server context must match the policy credential. Mock/staging/production are distinct; incomplete live configuration cannot silently fall back to a mock proof.
5. IDKit's complete result is forwarded **unchanged** to the gateway (including action, signal hashes and integrity bundle). `onSuccess` only closes the widget. Workbench success requires `worldid.verify`, `status: ok`, an attestation transaction hash, the correct wallet and identity fact, **then a fresh wallet read containing that fact**. A returned receipt followed by a failed read remains pending, not “verified.”
6. Show the refreshed action decisions and remaining rules. KYC/AML, sanctions, issuer approval and other requirements remain in force. “Policy allows” is not a guarantee that a transfer, redemption or trade executes. Existing identity facts without a receipt from this flow are not attributed to a live verifier.
7. Demonstrate cancellation/unavailable credential/wrong credential as refusals—not weaker-credential fallbacks. Retry obtains a fresh signed request. After timeout or an ambiguous submission, refresh actual access before retrying. The backend remains responsible for verification, replay protection, wallet binding and attestation.

**Privacy:** wallet, policy hash and attested facts are public on-chain. The dashboard forwards the proof to the gateway for server verification, not raw passport/selfie data. The gateway stores a nullifier-to-wallet binding, so this is not anonymous to the operator; World App handles its own credential data.

**Live gaps:** a production run requires a registered World app/RP, server signing key, matching action/environment, an eligible World App credential, operator authorization, a funded signer and a deployed matching policy. These are not provisioned by the frontend. One-time proofs have provider replay restrictions; this flow does not invent recurring session proofs or renewal. The backend verifier is independently responsible for enforcing these requirements. The UI's confirmation is a gateway receipt/read check, not an independent RPC audit.

Official integration references were checked through `https://docs.world.org/mcp`: [IDKit integration](https://docs.world.org/world-id/idkit/integrate), [credentials](https://docs.world.org/world-id/idkit/credentials), and [server verification](https://docs.world.org/api-reference/developer-portal/verify). The project uses its installed IDKit v4 API. No credentials or documents were sent to the documentation service.

## Routes

| Route        | View                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| `/`          | Contracts workbench: Human Language / Analysis / Contract-AST / World ID / API / Deploy |
| `/overview`  | Previous two-act overview and proof links                                               |
| `/agreement` | Original profile-based quote → rule → DNF → bytes → enforcing contract pipeline         |
| `/lenders`   | Existing investors/lenders, attested facts, expiry, revocation and World ID widget      |
| `/queue`     | Existing unknown-fact review queue                                                      |
| `/exit`      | Existing v4 trade / Aqua buyback views                                                  |
| `/audit`     | Existing reverse-chronological decisions and traces                                     |

Classic routes retain light/dark/system themes. The workbench has its own scoped dark IDE palette, narrow desktop sidebars, independently scrolling source/graph panes and adjustable split. Tablet views use a top view switch; mobile uses an expandable contract library and stacked panes. Both layouts expose actual environment statuses. Controls are keyboard accessible, selected clauses/nodes expose pressed state, dialogs use native focus containment and Escape, and reduced-motion preferences are honored.

A sample link can pick a profile: `/?profile=rwa-secondary`. Classic profile links and saved profile selection continue to work, e.g. `/exit?profile=wildcat-credit`. Runtime credentials deliberately do not survive a full page reload.

## Architecture

- `app/_workbench/Workbench.tsx`: session, navigation, mode and confirmation orchestration.
- `app/_workbench/useWorkbench.ts`: live/sample reads, lifecycle polling, stale-response protection.
- `app/_workbench/PolicyPanes.tsx`: source cards, connected graph, full document view and verification evidence.
- `app/_workbench/Forms.tsx`: connection, document upload and issuer constraints.
- `app/_workbench/ServiceViews.tsx`: export/API, deployment record and local evaluator.
- `app/_workbench/IdentityView.tsx` / `lib/identity.ts`: clause/credential rationale, server-attested wallet flow and refreshed action decisions.
- `app/_components/WorldIdWidget.tsx`: shared IDKit request transport; no client-side authorization.
- `app/_workbench/AnalysisView.tsx`: actual lifecycle, per-claim review and AST tracing.
- `lib/demo.ts` / `scripts/sync-demo.mjs` / `public/demo/`: inspectable documents and opt-in config for real uploads.
- `lib/agreements.ts`: typed existing REST contract, request methods, state gates, upload validation and polling.
- `lib/session.ts`: non-persistent connection and bounded authenticated transport.
- `lib/workbench.ts`: export-derived sample graph, graph layout, DNF display and provenance labels.
- `lib/adapter/`: existing profile screens; now shares runtime session credentials. Without a gateway it retains the static/mock adapter. Samples in the workbench use static exports directly, never mock party activity as chain evidence.

Tests cover endpoint/method/body/auth mappings, viewer write refusal, non-persistence, timeouts/errors, upload limits and formats, lifecycle gates, polling cancellation/recovery, real-export graph relationships, provenance labels, escaping and accessible rendered controls. The existing evaluator, segmentation, export and adapter suites remain in place.
