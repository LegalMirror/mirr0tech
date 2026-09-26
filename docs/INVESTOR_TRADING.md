# Authenticated, wallet-signed investor trading

The investor flow is **noncustodial transaction preparation**, not the operator demo/faucet API. The browser wallet signs approvals and swaps. World ID supplies only the configured credential fact; it does not supply KYC/AML, issuer authorization, subscription acceptance, funding confirmation or redemption authorization.

Target public demo: **World Sandbox, Passport/document credential, Sepolia (11155111), and Curvegrid MultiBaas activity**. Local Anvil (31337) is also supported. Sandbox is not production identity assurance, and mock is not Sandbox. Tokens, NAV and reserves in this prototype are demo/test assets, not real fund shares or USD.

**Evidence boundary:** the new tests use injected providers and a real, disposable Anvil deployment. They do not read private `.env` files, contact World, use a public RPC, or obtain live MultiBaas evidence. A local passing swap is not evidence of a World Sandbox login, Sepolia execution, browser end-to-end success or a configured Curvegrid dashboard. The original source-review defects are covered by passing, unskipped regression tests; live evidence still requires the operator steps below.

## Public funds are an explicit allowlist

Construct `InvestorService` with `{ venues, agreements, publishedAgreementIds, clock }`:

- `stack` refers to the explicitly configured stack venue and is the default public entry when its chain binding is available.
- `publishedAgreementIds` is an explicit array of uploaded agreement IDs that the operator chooses to publish. Only allowlisted records with `status: 'deployed'` are exposed.
- Unpublished IDs are rejected **before** looking up the agreement. The service must not enumerate uploaded records, source documents or private analysis.
- Publication is not deployment, funding or eligibility. Unavailable entries may be absent from discovery; a legacy stack can be listed but remains read-only.
- The launcher supplies this option from `INVESTOR_AGREEMENT_IDS` (comma-separated deployed IDs). A public upload is not automatically published to the investor catalogue.

## Required operator setup (separate from investor authority)

1. **Configure real Sandbox authentication.** Follow [WORLD_ID.md](WORLD_ID.md) and [INVESTOR_AUTH.md](INVESTOR_AUTH.md). Configure the matching RP, app, server-only RP signing key and action, set the environment to `sandbox` and credential to `document`, and use Passport schema 9303 with v4 proofs, the actual wallet signal and the challenge nonce. Provision durable nullifier binding storage. Missing live configuration is an error for a Sepolia demonstration, not permission to fabricate a successful proof. Never put signing keys, MultiBaas keys or operator tokens in a frontend bundle.
2. **Deploy and review a cashier-enabled agreement on Sepolia.** Use an explicitly authorized operator workflow and the document/addendum procedure in [CASHIER.md](CASHIER.md). Review the actual agreement, source evidence, compiled policy, configuration commitment, fixed NAV, distinct buy/sell fees and cap. Initialize its real v4 pool and bind the token/oracle/hook/router correctly. Publish that agreement ID only after recording and checking its actual addresses, chain and policy. The legacy `MirrorLiquidityRouter` lacks minimum-output and deadline bounds and is intentionally read-only for investors. Login never upgrades it or deploys a replacement.
3. **Establish independent compliance facts.** The authorized issuer must separately establish each fact required by the compiled mint/burn/transfer policies, including KYC/AML, issuer/offering authorization, subscription/deposit and redemption conditions. Sanctions checks remain independent. World proof verification must not manufacture any of these facts. Evidence and validity windows must be real for the chosen test workflow; do not silently set every bit to true when someone logs in.
4. **Prefund the reserve explicitly.** The cashier pays redemptions only from its available six-decimal asset reserve. An authorized operator must deliberately fund it and disclose the amount/transaction; no investor endpoint faucets, seeds liquidity, funds gas or mints test assets. Investor wallets must independently obtain the correct test asset and Sepolia ETH. No reserve, no redemption guarantee. Neither custody issuance nor a NAV quote proves backing.
5. **Configure Curvegrid for the actual deployment.** Link the exact token, cashier asset, bounded router, cashier hook and shared attestor addresses with their correct deployed ABIs on the supported chain and a deliberate indexing start block. A cashier agreement needs the `MirrorCashierRouter`/`MirrorCashierHook` ABIs, not the legacy router/hook ABIs. Keep credentials server-side. Use the separate `syncFundDeployment()` helper below for a new cashier agreement. `deploymentContracts()`/`syncDeployment()` retain their existing legacy stack behavior; do not pass a new cashier agreement to that legacy registration path. Registration is not proof that indexing has caught up.
6. **Verify the live path manually.** Complete a real Sandbox proof and wallet login; prepare and sign an exact approval; obtain its RPC confirmation; prepare and sign a bounded swap; retain its Sepolia receipt, wallet, router, policy hash, route and output. Then check the same transaction in the Curvegrid dashboard. Redact secrets and raw proof material. Report indexer delay/outage honestly. Also exercise cancellation, wrong-wallet, expired-session, denied-policy and unavailable-provider paths.

No automatic chain setup, faucet or unrequested operator write is part of this flow. Existing privileged operator routes are not safe substitutes for investor routes.

## Exact service interface and HTTP integration boundary

`src/investor-service.js` exports `InvestorService`; it does not authenticate HTTP requests or mount Express routes. The parent owns the dedicated investor router and `InvestorAuth` adapter. Public discovery must not require an operator token; protected methods must receive the internal session from **`await auth.authenticate(token)`**, never a client-supplied session object.

| Class method | Contract |
| --- | --- |
| `resolveFund(fundId)` | Resolves only `stack` or a published, deployed agreement; returns internal `{ id, name, venue }`. Do not serialize the venue. |
| `config()` | Public safe chain/credential/environment/mock projection. |
| `funds()` | Public metadata for published funds, including read-only reasons where known. Listing is not an RPC health or executable-trade guarantee. |
| `snapshot(session)` | Rechecks session/chain/policy bindings; reads this wallet's balances, router allowances, policy decisions, reserve, supply and capabilities. |
| `quote(session, { buy, amount, route? })` | Indicative fixed-NAV arithmetic and blockers. `route` is `auto`, `amm` or `cashier`; default `auto`. |
| `prepare(session, { kind, buy, amount, route?, minOut?, deadline? })` | `kind: 'approval'` or `'swap'`; builds and simulates an unsigned transaction. Swaps require `minOut`. |
| `confirm(session, { intentId, txHash })` | Looks up a session-bound intent, validates the RPC transaction/receipt and known-contract event, and returns pending/reverted/confirmed or a refusal. |
| `attestIdentity(session)` | Separate bounded issuer-gas operation for only `identityVerified`; not a trade, faucet or general fact-writing endpoint. |
| `activity(session)` | Bounded, wallet/fund/policy-scoped history from MultiBaas or recent RPC logs. Never execution authorization or finality. |

The parent/client route contract under `/v1/investor` maps public `GET /config` and `GET /funds`, authentication `POST /auth/challenge` and `POST /auth/verify`, and protected `GET /me`, `GET /activity`, `POST /identity`, `POST /quote`, `POST /transactions/prepare`, `POST /transactions/confirm`. `src/investor-api.js` mounts this contract; `test/investor-api.test.js` additionally tests HTTP authorization isolation, separately from the service suite. See [INVESTOR_AUTH.md](INVESTOR_AUTH.md) for origin, body, token, revocation and cache requirements. The parent must also test that investor tokens cannot enter any existing operator deployment/funding/fact-writing route.

## Wallet transaction sequence

1. Choose a published fund. Connect the intended wallet on Sepolia; show the credential, environment and chain explicitly.
2. Obtain and sign the login challenge and complete the matching World proof. Login signatures are EIP-191 authentication, not transaction authorization. Keep the returned investor access token private and short-lived.
3. Read the snapshot. A valid login does not imply policy eligibility. If separately requested and permitted, submit the bounded identity attestation; refresh policy decisions afterwards. Do not show KYC/AML as satisfied merely because identity succeeded.
4. Request an indicative quote, for example `{ "buy": true, "amount": "100.25", "route": "cashier" }`. Amounts and `minOut` are positive decimal strings with at most six decimal places; both share and asset tokens must have six decimals for trading.
5. If allowance is insufficient, prepare `{ "kind": "approval", "buy": true, "amount": "100.25", "route": "cashier" }`. Decode/display the **exact** amount and the known router spender. The returned transaction has the investor `from`, the actual input token `to`, zero native value and the bound chain ID. No unlimited approval or backend wallet impersonation is requested. Sign/send it from the connected browser wallet, then confirm using the returned hash and `intentId`.
6. Refresh state and prepare a swap, for example `{ "kind": "swap", "buy": true, "amount": "100.25", "minOut": "100", "route": "cashier" }`. Choose minimum output deliberately; the example is valid only for the documented demo terms. The server defaults the deadline to at most three minutes and never later than session expiry, using the later of chain and server time. An explicit deadline must be a future integer Unix timestamp within that window. Do not invent a slippage tolerance from a quote.
7. Show chain, token pair, exact input, minimum output, expiry and route before requesting the wallet signature. Check wallet/chain again after account or network changes. Sign the prepared transaction without changing its destination/calldata/value. `auto` can execute AMM or cashier; `amm` cannot silently fall back to cashier. A simulation is not a guarantee that allowance, eligibility, reserves, gas or prices remain unchanged before mining.
8. Confirm with RPC. A transaction not yet visible, an absent receipt or a noncanonical receipt block is pending; a canonical status-0 receipt is reverted. Success requires the exact transaction and known-router `Executed` event (or exact token `Approval`). A bound intent cannot change transaction hash. Foreign sessions, changed policies and expired intents require explicit recovery, not a blind resend.

Confirmations say **`mined-not-finalized`**. Polling must not cache success across a reorg, and MultiBaas activity must not turn pending/reverted RPC results into success. If an intent/session expires after a transaction was sent, inspect the wallet/explorer receipt and refresh authentication; do not assume failure and submit a duplicate trade. Intents and rate budgets are process-local and are not durable recovery records.

## Identity attestation limits

- The authenticated credential grants only the `identityVerified` bit. Existing known/value bits are preserved, including explicit false compliance facts; the original screening timestamp and shorter existing expiry are retained. A fresh/expired fact record must not resurrect old KYC/AML bits.
- Expiry is bounded by the session, the current shorter attestation window and the on-chain `uint32` limit. Reattesting identity does not refresh the independent compliance window.
- The current implementation limits attempts to three per wallet/chain per day, imposes a five-minute cooldown, and caps global attempts at 64 per day per service instance. Concurrent writes for a wallet share a lock. Pending submissions are reconciled rather than automatically resent. Failures still consume the budget.
- Mock identity writes are local-only. `InvestorAuth` additionally requires explicit `allowLocalMock: true`, chain 31337 and a non-production process for mock login. Never advertise local mocked identity as World Sandbox success.
- These controls are in-memory and per process. Restarts/multiple workers need an explicit operational policy; they do not provide a durable distributed issuer-gas budget.

## MultiBaas and the Curvegrid dashboard

The new helper in this checkout is **`indexedAddressEvents(client, addresses, { limit = 50 })`**, not `indexedWalletEvents`. It issues separate address-scoped SDK queries (argument 7 is `contractAddress`), with offset 0, a bounded limit and a five-second timeout. `InvestorService.activity()` then independently validates ABIs/signatures and filters subjects/wallets, router approvals, asset counterparties, current policy and cashier terms. It strips unrecognized provider fields, deduplicates and returns at most 100 events.

- MultiBaas results are `indexed-events` or `no-indexed-events`, always `complete: false`. Empty results can mean delayed/unconfigured indexing, not “no transaction happened.”
- An indexer outage falls back to the last 2,000-block lookback of known-contract RPC logs with bounded processing; if RPC also fails, return `activity-unavailable`, not invented history.
- Shared asset or attestor contracts do not authorize displaying another fund's approvals or attestation policy. No unscoped/global event query is a fallback.
- The dashboard is an indexed activity/audit view. Only the RPC confirmation path can establish the service's mined execution result. Neither one claims finalized history or complete indexing.

### Explicit cashier registration

`syncFundDeployment(record, { fundId, abis, client?, startingBlock, log? })` registers the five investor activity contracts: share token, cashier asset, bounded router, cashier hook and attestor. It does not deploy anything, sign a transaction, fund reserves, grant compliance or publish an agreement.

- `record` is the **merged venue record**, including `chainId`, the shared `attestor` address and `rwa: { ...deployment }`. A bare `deployFund()` result is not sufficient. `rwa.cashier.enabled` must be exactly `true`; local Anvil registration is rejected because a hosted MultiBaas instance cannot index that private node.
- `rwa.cashier.hookAbi` and `routerAbi` come from the actual cashier deployment record. `abis` supplies the deployed `token`, `asset` and `attestor` ABI arrays, JSON ABI strings or ethers `Interface` instances. Required event signatures are checked before API writes. No legacy hook/router or compiled bytecode fallback is used; registration is deliberately ABI-only.
- `startingBlock` is required: an absolute block-number string, a relative lookback such as `'-50000'`, or `'latest'`. Choose it to cover the deployment/trades within your Curvegrid plan. `'latest'` deliberately excludes older history.
- Labels are scoped to the fund ID, chain, policy, role, address and ABI. Existing address aliases—including the base stack's `attestor`—are reused without calling `setAddress` on them. Only previously unregistered addresses receive new scoped aliases; links use the literal contract address. The helper neither repoints global legacy aliases nor overwrites their contract definitions.
- Each request has a five-second timeout. Returned `created`, `aliased` and `linked` flags describe API operations only. A link conflict is **not** reported as successful indexing; inspect its existing configuration. Other failures, including plan/rate-limit/outage errors, stop the operation with an error. Earlier accepted API writes are not rolled back; inspect partial progress before deliberately retrying.

The bootstrap owner can call the helper after resolving the explicitly published venue:

```js
await syncFundDeployment(venue.record, {
  fundId,
  abis: {
    token: venue.c.token.interface,
    asset: venue.c.cashierAsset.interface,
    attestor: venue.c.attestor.interface,
  },
  client: venue.multibaas,
  startingBlock,
  log: console.log,
});
```

For a deliberate operator-only invocation from the repository root, set shell variables `FUND_RECORD`, `FUND_ID`, `FUND_ABIS` and `STARTING_BLOCK` to the actual merged-record JSON path, published agreement ID, deployed ABI-map JSON path and chosen indexing start block. The ABI-map JSON has `token`, `asset`, `attestor` keys. These are command inputs, not new bootstrap configuration options. Supply `MULTIBAAS_URL` and `MULTIBAAS_API_KEY` securely in the operator process environment; confirm that the MultiBaas instance is configured for this record's chain.

```sh
node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { syncFundDeployment } from "./src/multibaas.js";
const [recordPath, fundId, abisPath, startingBlock] = process.argv.slice(1);
const record = JSON.parse(await readFile(recordPath, "utf8"));
const abis = JSON.parse(await readFile(abisPath, "utf8"));
console.log(JSON.stringify(await syncFundDeployment(record, { fundId, abis, startingBlock }), null, 2));
' -- "$FUND_RECORD" "$FUND_ID" "$FUND_ABIS" "$STARTING_BLOCK"
```

This command **writes external Curvegrid API resources** and consumes plan capacity; it is not run by the automated tests or automatically on investor login. It reads only the supplied public deployment/ABI files and does not load `.env`. Registration is additive and opt-in; the parent still owns launch-script wiring. Independently inspect the actual transaction/event in the Curvegrid dashboard before claiming live indexing.

## Tests and integration handoff

Run from the repository root:

```sh
node --test test/investor-service.test.js
node --test test/chain/investor.test.js
```

`npm run test:chain:investor` runs this chain suite and is included in `npm run check`. `scripts/dev-stack.js` wires both the service and auth module into `src/investor-api.js`. These tests do not modify contracts, artifacts or deployment records. The unit file is already selected by the existing `test/*.test.js` root test glob.

The chain suite compiles the cashier policy, token, router, hook and real v4 PoolManager **in memory**, following `test/chain/cashier.test.js`, then deploys them to its own temporary Anvil. It verifies signed approvals, mint/burn settlement, output/deadline bounds, stale-policy reverts, foreign-wallet refusal, pending receipts, rollback handling and identity-only behavior. Operator fixture deployment/funding is explicit and outside the service. It uses only public disposable Anvil keys.

### Regression guarantees and remaining integration work

The tests labeled `REGRESSION` cover the original review findings and now pass:

1. **Published configuration pinning.** `InvestorService.#cashier` requires matching hook/router configuration hashes **and** `policy.cashier.configurationHash`, in addition to the existing pool/address/terms bindings.
2. **Identity receipt binding.** The service captures the authorized signer and attestor destination before submitting, then stores those with the submitted hash. A receipt must match all three, carry a nonnegative safe-integer block number and valid block hash, and match the current canonical block's number/hash. Only numeric status 1 plus the expected attestor event can confirm identity. Mismatched/malformed receipts retain the pending job rather than granting a credential or resending. Issuer rotation does not rewrite an existing pending transaction's expected sender.
3. **Session isolation.** `InvestorAuth` issues a unique private session ID. The service requires a nonempty bounded ID and includes it in every intent binding; there is no null-ID fallback. Two logins in the same clock second cannot confirm each other's intents. The regression uses real wallet challenge signatures and a fake World verifier/registry, without live proof calls.
4. **Scoped cashier registration.** Fake SDK tests verify correct cashier ABIs/asset, deterministic per-fund labels, preservation of shared/base aliases, explicit indexing bounds, conflicts, registration races and fail-closed malformed/outage responses. They do not claim real Curvegrid connectivity or event availability.

HTTP route isolation is tested in `test/investor-api.test.js`. New cashier deployments retain their token/asset ABIs; `npm run multibaas:sync:fund -- <agreement-id> <starting-block>` explicitly registers one from the configured durable agreement store. Older deployment records without these ABIs can use the explicit ABI-map procedure above. The launcher shares a process-local issuer write queue between public deployments and identity attestations. Real Sandbox/Sepolia/dashboard evidence still requires the manual flow. These tests are not permission to auto-deploy, auto-fund or fabricate compliance to make a demo green.
