# Mirr0rtech dashboard

Next.js 15 App Router, React 19, TypeScript and plain CSS. Static-exportable; no frontend server or new runtime dependencies. The default route is a dark contract workbench over the existing [Agreements API](../docs/AGREEMENTS_API.md). The previous dashboard remains available.

## Run and validate

```sh
npm install                         # repository root, once: compiler dependencies
npm --prefix dashboard ci
npm --prefix dashboard run dev      # generates sample exports; http://localhost:3100
npm --prefix dashboard run build    # exports samples + static site in dashboard/out/
npm --prefix dashboard test
npm --prefix dashboard run typecheck
npm --prefix dashboard run lint
```

`npm run ui:export` at the repository root writes `dashboard/public/data/{index,custodial-rwa,rwa-secondary,wildcat-credit}.json`. It compiles the fixtures with `{ demo: true }`; these exports are real compiler artifacts, **not evidence of a live extraction or deployment**. The sample library needs these generated files. Build and dev generate them automatically. Export failures are shown in the UI with the command needed to produce them. No fallback silently turns a failed live connection into a sample.

## Workbench flow

1. Open `/`. Until a gateway URL **and** a viewer/operator key are configured, it opens the **Sample** library (RWA selected by default). Search and select contracts; inspect linked source cards and AST nodes. The graph supports action filtering, keyboard selection, zoom and fit. Human Language shows the full documents with the existing quote highlighter and paragraph coverage.
2. Open **Connection**. The GitHub Pages build prefills `https://mir-api.peeramid.xyz`; enter a viewer key for read-only access or the backend's `API_KEY` as the operator key for mutations. You can also set **only** `NEXT_PUBLIC_GATEWAY_URL` at build time. Remote gateways must use HTTPS; HTTP is allowed for localhost / loopback. A static HTTPS deployment may be unable to reach an HTTP gateway due to browser mixed-content rules.
3. **Upload Contracts** defaults to downloadable **Demo documents**: the real BUIDL source. Explicitly check the NAV option to include the separately authored `nav-cashier-addendum.md` and `rwa-cashier-config.json` with `cashier.enabled=true`. Inspect the selected source files and JSON before submitting the real `POST /v1/agreements`. These assets are copied from the backend fixtures by `npm run demo:sync` (also run by dev/build); they are not pre-baked upload responses. The dialog also accepts pasted text/Markdown/HTML or a bundle of `.txt`, `.md`, `.htm`, `.html` files. No PDF support. Limits match the server: 2 MB per document, 4 MB for the JSON request. Files go to the gateway and, when configured, its extraction provider. A mock gateway can only generate recognized demo documents; new documents require the server's live model configuration.
4. Generation is automatic after upload. The detail and list views poll every 2 seconds while jobs are in flight; settled details poll every 10 seconds, list/status every 15 seconds. Polls are serial and cancellable; obsolete responses are discarded. Read failures retry after 5 seconds. Writes are never automatically retried. Requests time out after 30 seconds; a timed-out write may still be running on the server, so refresh before retrying.
5. In **Deploy**, review policy coverage and configure the issuer's **World ID constraint**: credential, actions and verbatim source quote. Saving uses `PUT /constraints`, recompiles the policy and clears the current deployment record. Existing chain contracts remain unchanged. Constraint edits are not a new extraction deliberation.
6. **Regenerate** and **Deploy** require confirmation and an operator session. Deployment also requires `compiled`, a reported signer and a supported token profile. The credit profile uses its existing stack venue and cannot be deployed per agreement. Confirmation is rejected if the selected policy changes while it is open. The backend remains the authority on state and authorization.
7. The **Analysis** view opens after upload. It shows recorded lifecycle transitions (not invented streaming progress), Noolog claim verdicts with their quotes, filters for contested/unverified claims, evaluator counter-positions, unresolved interpretations, and exhaustive compiler checks. The existing backend mock Noolog adapter produces the report when no live model is configured. Its report is labeled **Simulated Noolog analysis**; no frontend-generated verdicts or false live claim are used. Trace any source-backed claim directly into the AST.
8. **World ID** is a first-class view, also reachable from a workbench-wide trust prompt. It explains the issuer's credential choice, the verbatim clause, protected actions and privacy boundary. Configure the rule in Deploy; then return to World ID for the wallet-bound proof flow. Deployment addresses and hash mismatches remain in Deploy.

The **API** view shows the current agreement response and documented routes, supports manual refresh and downloads the compiled policy export. The **Deploy** view also retains the browser policy evaluator, explicitly labeled as a local simulation. It does not transact or attest facts.

### Security and provenance

- Bearer keys are entered at runtime and held in module memory only. Neither key is written to localStorage, sessionStorage, cookies, URLs, a generated file, or an environment variable. Reload or **Disconnect** clears them. Normal client-side navigation to classic routes shares the session.
- **Never put an operator key in `NEXT_PUBLIC_*`.** The previous public gateway-key default has been removed. Existing deployments must stop providing that variable and enter their key through Connection. Do not publish private viewer keys either.
- GETs prefer the viewer key (falling back to the session operator key). Writes require the explicit operator key, even if a viewer key happens to have additional server permissions. Requests omit cookies, disable caching and refuse redirects. These are client-side safeguards, not a replacement for backend authorization.
- The gateway must allow this dashboard's exact origin and authorization/content-type/idempotency-key headers through CORS, including **PUT** for constraints. Backend CORS configuration is outside `dashboard/**`.
- **Sample**, **mock extraction**, and **live extraction evidence** are distinct. A verified-claims badge requires a non-mock report with a job ID, evaluators, claims and source/extraction provenance. It is not a blanket “Verified” claim. The evidence dialog exposes hashes, claim verdicts, contested counts and the original report.
- Compiler evidence is labeled **exhaustive equivalence checks**, not Z3. Demo compilation and unresolved terms remain visible. A compiled export is not a deployment; a gateway deployment record is not an independent RPC verification.
- NAV, reserve backing, redemption liquidity and settlement at NAV require separate arrangements. No unknown NAV/cashier backend is assumed or presented as live.
- Uploaded HTML is rendered as text through React/the existing document reader, never injected into the page.

## World ID: judge-ready trust moment

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
