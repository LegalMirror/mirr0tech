# Mirr0rtech dashboard

Next.js 15 App Router, React 19, TypeScript and plain CSS. Static-exportable. Logged-out visitors see the sandbox World ID landing page; after login the default route opens the contract workbench; `/investor` is the separate World Passport / wallet-signed Sepolia flow. `ethers@6.17.0` is used for exact-unit conversion, EIP-191 signature verification and calldata validation—not a backend or custodial wallet. The existing palette and classic dashboard routes remain unchanged.

## Launch commands

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run vendor
pnpm start
# Another terminal:
pnpm --dir dashboard dev
```

Open **http://localhost:3100** and click **Sign in with World ID**. The default mock mode creates a placeholder session without a QR code or World credentials. See [World ID login](../docs/WORLD_LOGIN.md) for session persistence and configuration. The gateway defaults to `http://localhost:3000`; `NEXT_PUBLIC_GATEWAY_URL` overrides it. The local workspace reconnects automatically and retains contracts across reloads.

## Upload flow

**Demo** loads the bundled BUIDL document and optional NAV cashier addendum and generates a deterministic AST without an API key. **Upload files** reads text, Markdown or HTML files and requests OpenAI AST generation with the server's `OPENAI_API_KEY` and optional `OPENAI_MODEL`. No paste mode or operator-key prompt is needed. Files are limited to 2 MB each and a 4 MB JSON request; PDFs are not supported.

The button explains when the workspace needs a connection, files need selecting, or demo files are loading. Source files are saved in `.data/workspace/uploads/<id>/` before generation; records and ASTs persist in `.data/workspace/agreements.json`. A generation failure keeps the upload for retry. Source quotes and AST structure are validated locally. Model output is not labeled as independently verified. An AST that cannot compile remains visible in Analysis with its error.

The workspace starts with no sample contracts. **Explore sample exports** remains an explicit read-only option. The historical hosted public demo gateway retains its separate scoped-token restrictions; the local workspace accepts your own documents.

## Deployment and validation

Server startup is independent of Sepolia. RPC connection happens only when chain status or deployment is requested; no local Anvil deployment is required. Configure a Sepolia RPC, the existing `deployments/sepolia.json` record, and a server-side testnet signer to enable confirmed deployment. Uploads and AST generation also work without a chain connection.

```sh
pnpm --dir dashboard test
pnpm --dir dashboard typecheck
pnpm --dir dashboard build
pnpm --dir dashboard start
```

`build` writes the static site to `dashboard/out/`. `start` in the dashboard package serves it on port 3100; root `pnpm start` runs the workspace API.

### Security and provenance

- The public UI has no operator/viewer secret inputs. Local workspace tokens are held only in memory; local files persist on the server. Demo and investor tokens are held in **separate memory stores**, never localStorage, sessionStorage, cookies, URLs or generated files. Neither token is copied into `operatorKey` or `viewerKey`.
- **Never put operator, World RP, wallet secrets in `NEXT_PUBLIC_*`.** Only the gateway URL is public configuration. The internal adapter's key injection remains a test/operator seam, not a login option in the public UI.
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
