# Agreements API

The core loop as REST: **upload → OpenAI light extraction → source validation → analyzed AST**, or **compiled → deploying → deployed** for explicitly mapped MVP documents. Offline compiler demos additionally support compile and deploy. Agreement routes in `src/routes.js` are mounted under `/v1` over `src/agreements.js` (store + lifecycle). Same bearer as every route: `API_KEY` for writes, `VIEWER_KEY` for GET. Error envelope `{ error: { code, message } }`. Tests: `test/agreements.test.js`, `test/agreements-api.test.js`, `test/chain/agreements-deploy.test.js`.

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/v1/status` | — | `{ model: { provider, mode: "mock" \| "live", url, model }, compiler: { solidity: { core, swapvm, "uniswap-v4" } }, chain: { chainId, deployer, attestor, poolManager } \| null }` |
| GET | `/v1/agreements` | — | `[summary]` |
| POST | `/v1/agreements` | `{ name, documents: [{ name, text }] }` or `{ name, text, filename? }`; optional `profile` (default `rwa-secondary`), `config` | `201` summary in `extracting`; the run continues in the background |
| GET | `/v1/agreements/:id` | — | summary + `ast` + `export` (`null` until `verified`; then the `ui/policy-<profile>.json` shape: rules with `clauseId`, `dnf`, `quotes`; terms; unresolved; clauseTable; programs; coverage; verification; documents with display text) |
| GET | `/v1/agreements/:id/ast` | — | `{ nodes, edges }` for the Contract-AST view; `409` until an AST exists |
| GET | `/v1/agreements/:id/constraints` | — | `{ identity: { credential, actions, clause, quote } \| null }` |
| PUT | `/v1/agreements/:id/constraints` | `{ identity: { credential?, actions?, quote?, clause? } \| null }` | the summary, recompiled (`compiled`, new `policyHash`, `deployment: null`); `400 QUOTE_NOT_FOUND` when the quote is not verbatim in the document |
| * | `/v1/agreements/:id/stack/*` | as `/v1/stack/*` | the same venue routes over **this agreement's** token, oracle and hook (`wallets`, `explain`, `facts`, `worldid`, `rwa/mint`, `rwa/release`, `rwa/liquidity`, `rwa/swap`, `audit`, `events`); `409` until `deployed` |
| POST | `/v1/agreements/:id/regenerate` | — | `202` summary in `extracting`; allowed from `analyzed`, `verified`, `compiled`, `deployed`, `failed` |
| POST | `/v1/agreements/:id/deploy` | — | `202` summary in `deploying`; `409` unless `compiled`; `503 NO_CHAIN` when the gateway has no signer |

Upload: the document's `name` extension picks the reader (`.txt`, `.md`, `.htm`, `.html`; the short form defaults to `<name>.txt`); the body limit on this route is 4 MB (32 KB elsewhere). Several parts (agreement + policy + addendum) go in one `documents` array and are hashed as one bundle with per-part provenance.

AST graph: new uploads use [legal AST v2](LEGAL_AST.md). `GET /:id` includes the complete `ast`; `GET /:id/ast` projects it into `{ nodes, edges }` with a document/section/clause hierarchy and typed cross-clause relations. The terminal `analyzed` state needs no compiler or chain. Historical and explicit demo compiler records retain their version 1 graph. The UI downloads the complete `ast` from the detail response.

Errors: `400 INVALID_BODY`, `400 UNKNOWN_PROFILE`, `400 INVALID_DOCUMENT` (unsupported extension, empty, over 2 MB), `401 UNAUTHORIZED`, `404 NOT_FOUND`, `409 INVALID_STATE` (wrong state, or a job already in flight), `409 UNSUPPORTED_PROFILE` (no deployment adapter for the selected profile), `413 BODY_TOO_LARGE`, `503 NO_CHAIN`. A background failure is on the record: `status: "failed"`, `error: <message>` for generation; a failed deploy returns to `compiled` with `error: "Deploy failed: …"`. A restart mid-job marks the record `failed` (`Interrupted while extracting`).

## The flow

One agreement, one issuer, one token: **login → upload → (the AST compiles) → put a World ID constraint on it → deploy → the policy-hooked pool is live**. The constraint step is the issuer's trust decision: which credential (`document` for KYC, `proof_of_human` where a person is enough, `selfie` for liveness), on which actions (`mint`, `transfer`, `burn`), anchored to the sentence of the agreement that asks for it. The rule and the credential are inside the policy hash, so the deployed token carries that choice; the gateway's verifier for that agreement accepts only that credential (`WRONG_CREDENTIAL` otherwise, the alternative path).

`scripts/mirr0.js` (`pnpm run cli` or `pnpm exec mirr0`) is the flow from a terminal; `test/chain/flow.test.js` runs it end to end on anvil:

```sh
mirr0 login http://127.0.0.1:3000 local-dev-stack-operator-key-only
mirr0 upload test/human_contracts/ea026411904ex10-9.htm --name BUIDL   # → agr_…  extracting
mirr0 show agr_… --wait compiled && mirr0 ast agr_…
mirr0 constrain agr_… --credential document --actions mint,transfer
mirr0 deploy agr_… --wait                                             # oracle, token, hook, pool
mirr0 facts agr_… Investor kycApproved=true amlApproved=true sanctionsClear=true
mirr0 explain agr_… Investor                                          # refused — transfer-identity-verified
mirr0 verify agr_… Investor                                           # World ID proof (mock without --proof)
mirr0 fund agr_… Investor 10000 && mirr0 mint agr_… 10000 && mirr0 release agr_… Investor 5000
mirr0 pool agr_… liquidity Investor && mirr0 pool agr_… swap Investor # through the hook
mirr0 pool agr_… swap Stranger                                        # POLICY_REFUSED, with the sentence
```

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> uploaded: POST /v1/agreements
    uploaded --> extracting: OpenAI light extraction started
    extracting --> verified: AST and source references validated
    verified --> analyzed: legal AST ready to explore and download
    analyzed --> extracting: POST /regenerate
    verified --> compiled: policyHash, clauseTableHash, DNF programs, Solidity, equivalence proof
    compiled --> compiled: PUT /constraints (new hash)
    deployed --> compiled: PUT /constraints (deploy again)
    compiled --> deploying: POST /deploy
    deploying --> deployed: oracle, token, hook, pool on chain
    deploying --> compiled: deploy error (error set)
    extracting --> failed: extraction or validation error
    verified --> failed: compile error
    compiled --> extracting: POST /regenerate
    deployed --> extracting: POST /regenerate
    failed --> extracting: POST /regenerate
```

Uploaded documents finish at `analyzed`. Only explicit compiler fixtures continue to `compiled`. Deployment requires a compiled policy.

- `verified` — schema, source quotations and structural references validated locally.
- `analyzed` — the document AST is ready for graph exploration and JSON download; no executable policy is implied.
- `compiled` — `compilePolicy` succeeded: `policyHash` over source + AST + config, clause table hash, DNF programs, generated Solidity, equivalence checks passed, coverage resolved.
- `deployed` — `PolicyOracle`, `CompiledMirrorToken` and `MirrorPolicyHook` (CREATE2 salt mined for the hook flags) deployed, the token configured for the venue, the pool initialized on the stack's `PoolManager` (`deployFund`, `src/onchain/deploy.js`). Credit deployments instead create their own policy oracle, role provider, mock asset/market and buyback router (`deployCredit`).

Solidity is compiled at deploy time by `src/onchain/solc.js` (bundles `core` and `uniswap-v4`) with the generated `CompiledPolicy.sol` and `CompiledMirrorToken.sol` supplied in memory. Uploaded documents use `OPENAI_API_KEY`, default model `gpt-5.4-mini`, and reasoning disabled. Explicit `generation: "demo"` uses the bundled compiler fixture without an API call.

## Storage

In-memory map, mirrored to `${DATA_DIR:-generated}/agreements-<chainId>.json` after every change and loaded on boot. One record per agreement, keyed by `id`; `regenerate` keeps the id, and `history` keeps every transition with the `policyHash` in force at that time. The full record holds the uploaded `documents`, the `config`, the AST `envelope` and the full `verification`; responses return the summary below, and `GET /:id` recomputes the export from the record on demand.

## Record (summary)

```json
{
  "id": "agr_5f2c1a9e7b31",
  "name": "BUIDL",
  "profile": "rwa-secondary",
  "status": "compiled",
  "createdAt": "2026-09-26T04:12:09.000Z",
  "updatedAt": "2026-09-26T04:13:40.000Z",
  "source": { "name": "ea026411904ex10-9.htm", "sha256": "9c1e…", "textSha256": "b7a0…" },
  "extraction": { "provider": "openai", "model": "gpt-5.4-mini", "reasoningEffort": "none", "analysisMode": "light", "responseId": "resp_…" },
  "progress": null,
  "verification": { "confidence": { "overall": 0.93, "verified": 22, "total": 25, "counts": { "verified": 22, "contested": 2, "unverified": 1, "wrong": 0, "unknown": 0 } }, "contested": 2 },
  "policyHash": "0x8d2f…",
  "clauseTableHash": "0x41aa…",
  "coverage": { "total": 194, "counts": { "compiled": 9, "unresolved": 3, "not-executable": 182 }, "rules": 9, "terms": 0 },
  "deployment": null,
  "error": null,
  "history": [
    { "status": "uploaded", "at": "2026-09-26T04:12:09.000Z" },
    { "status": "extracting", "at": "2026-09-26T04:12:09.000Z" },
    { "status": "verified", "at": "2026-09-26T04:13:38.000Z" },
    { "status": "compiled", "at": "2026-09-26T04:13:40.000Z", "policyHash": "0x8d2f…" }
  ]
}
```

`progress` while `extracting` on the live engine: `{ job, status, at }` with the orchestrator's status line (`running: round 2 — Starting`). `extraction.demoted` lists what the engine read but this deployment cannot enforce (rules for actions no venue covers, terms no component consumes); those entries are appended to `unresolved` instead of failing the compile.

`deployment` once deployed: `{ chainId, policyHash, oracle, token, hook, hookSalt, poolManager, poolKey: { currency0, currency1, fee, tickSpacing, hooks }, poolId, txs: { oracle, token, hook, configure, pool }, deployedAt }`. The token's on-chain `policyHash()` equals the record's; the hook address carries the mined flag bits.

## Walkthrough

`pnpm run dev:stack` listens on `PORT` (default 3000; the Compose stack uses 3200).

```sh
API=http://127.0.0.1:3000; AUTH='Authorization: Bearer local-dev-stack-operator-key-only'
curl -s $API/v1/status -H "$AUTH" | jq '{model: .model.mode, solc: .compiler.solidity.core, chain: .chain.chainId}'
jq -n --arg name BUIDL --arg filename ea026411904ex10-9.htm --rawfile text test/human_contracts/ea026411904ex10-9.htm '{name: $name, filename: $filename, text: $text}' \
  | curl -s $API/v1/agreements -H "$AUTH" -H 'Content-Type: application/json' -d @- > /tmp/agreement.json
ID=$(jq -r .id /tmp/agreement.json); jq -r .status /tmp/agreement.json                # extracting
until [ "$(curl -s $API/v1/agreements/$ID -H "$AUTH" | jq -r .status)" = compiled ]; do sleep 2; done
curl -s $API/v1/agreements/$ID -H "$AUTH" | jq '{hash: .policyHash, confidence: .verification.confidence.overall, rules: (.export.rules | length)}'
curl -s $API/v1/agreements/$ID/ast -H "$AUTH" | jq '[.nodes[] | select(.kind == "rule")] | map({label, status})'
curl -s -X POST $API/v1/agreements/$ID/deploy -H "$AUTH" | jq .status                  # deploying
until [ "$(curl -s $API/v1/agreements/$ID -H "$AUTH" | jq -r .status)" = deployed ]; do sleep 2; done
curl -s $API/v1/agreements/$ID -H "$AUTH" | jq '{token: .deployment.token, hook: .deployment.hook, pool: .deployment.poolId}'
curl -s -X POST $API/v1/agreements/$ID/deploy -H "$AUTH"                              # 409 INVALID_STATE: not compiled
curl -s -X POST $API/v1/agreements/$ID/regenerate -H "$AUTH" | jq '{status, history: (.history | length)}'
```

OpenAI extraction writes structured `[OpenAI]` JSON events to server stdout: request start, a waiting heartbeat every 15 seconds, response headers, response receipt, local validation start, and completion or failure. Filter by `agreementId` to follow a job; each attempt also has a unique `clientRequestId` sent to OpenAI as `X-Client-Request-Id`. Response logs include the upstream request/response IDs, HTTP status, upstream processing time when provided, token usage, and incomplete-output reason. Logs contain sizes and timings, not uploaded text, generated AST content, API keys, or raw upstream error messages.

`OPENAI_TIMEOUT_MS` controls the request and response-body deadline (default `300000`, maximum `3600000`). The entire document bundle is currently generated in one non-streaming request with up to 6,000 output tokens. Local schema/source-quote validation starts only after that response arrives; `validationMs` separates that work from the overall `elapsedMs`. A waiting heartbeat reports that the request is still pending, not model progress. Increasing the deadline permits longer generations but does not make them faster. Restart the server after changing environment settings; saved failed agreements can then be regenerated.

Exact source-bound MVP compiler mappings preserve the model overview as `documentAst` and expose the executable subset as `ast`. Fund uploads use `rwa-secondary`; credit uploads require the complete MLA, lender-check policy and buyback addendum with `wildcat-credit`. Per-agreement credit deployment now creates a policy-bound role provider, mock market and buyback router on Sepolia. See [LEGAL_AST.md](LEGAL_AST.md#executable-mvp-test-mappings) for live integration-test commands and limitations.

## Wallet-signed Uniswap swaps

The Swap tab follows Deploy. Configure `UNISWAP_API_KEY` on the gateway (never a
`NEXT_PUBLIC_*` variable). The gateway calls the Uniswap Trading API with v4-only
routing and rejects any quote that is not a direct route through the persisted
agreement pool. Token metadata and balances are read by the backend Sepolia RPC.
The browser connects a wallet, reviews the quote, approves Permit2 for the exact
input amount, signs any returned Permit2 message, and signs the swap.
The gateway never signs or broadcasts these transactions.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/v1/agreements/:id/swap/quote` | `{ wallet, direction: "buy" \| "sell", amount, slippageBps }` | Quote ID, input/output base-unit amounts, minimum output, pool ID, spender, expiry |
| POST | `/v1/agreements/:id/swap/approval` | `{ wallet, quoteId }` | Optional unsigned ERC-20 reset and exact-amount approval transactions |
| POST | `/v1/agreements/:id/swap/transaction` | `{ wallet, quoteId, signature? }` | Simulated, unsigned swap transaction and expiry |

`amount` is a positive integer string in the input token's base units; `buy`
spends the paired asset and receives RWA, while `sell` spends RWA. Slippage is
1–500 basis points. Quotes expire after two minutes and are bound to agreement,
wallet, policy hash and pool ID. A restart requires a new quote. These endpoints
are read/preparation operations available to viewers and to the owner of a demo
agreement; all on-chain changes still require the user's wallet signature.

`GET /v1/agreements/:id/swap/state?wallet=0x…` returns chain ID, pool ID,
wallet, RWA/asset metadata and base-unit balances, and active liquidity.
`GET /v1/agreements/:id/swap/receipts/:hash` returns a receipt summary or null.
Both endpoints respect agreement ownership for demo sessions.

This integration uses Universal Router 2.1.2 with standard Permit2 approvals
(`x-permit2-disabled: false`, `permitAmount: EXACT`). Quotes return `spender`
(Permit2), `router` (Universal Router) and optional `permitData`. Sign the exact
returned domain/types/values and include `signature` when preparing the swap.
The backend verifies the permit’s wallet, chain, token, amount, spender and
expiry. Swap transactions are simulated before delivery and carry a deadline.
No alternative pool or custom-router fallback is accepted.

New deployments use `MirrorUniswapHook`, which authenticates wallets through
Universal Router/PositionManager `msgSender()`. Old custom-router pools fail
with `DEPRECATED_ROUTER`; regenerate and redeploy before minting and seeding.
An initialized pool still needs liquidity and API indexing/hook support.

Seeding uses the Uniswap Liquidity API (`/lp/create`, `/lp/check_approval`),
canonical PositionManager and Permit2. Calldata is validated against the selected
pool, backend NFT owner, full-range ticks and reviewed budgets. A signed seed
transaction is persisted before broadcast so retries cannot create another NFT.

References: [Uniswap quote API](https://developers.uniswap.org/docs/api-reference/aggregator_quote),
[Permit2 approvals](https://developers.uniswap.org/docs/trading/swapping-api/concepts/permit2),
[liquidity API](https://developers.uniswap.org/docs/liquidity/liquidity-provisioning-api/integration-guide).

### Backend RWA issuance

`POST /v1/agreements/:id/mint` accepts
`{ "recipient": "0x…", "amount": "100.25", "requestId": "a-unique-request-id" }`.
The amount is a positive decimal string with at most six places; request IDs are
16–80 letters, numbers, underscores or hyphens. Requires an operator bearer or
local workspace session. Viewer and public demo sessions cannot submit mints.

Returns HTTP 202 with an operation. Poll
`GET /v1/agreements/:id/mints/:requestId` for `status` (`pending`, `confirmed`,
`failed`), `stage` (`mint`, `release`, `complete`), `mintTxHash`, `releaseTxHash`,
and any `error`. The backend checks its minter/custodian role, chain, policy hash,
and recipient eligibility before issuance, then mints into custody and releases
to the recipient. To recover an interrupted operation, POST the **same** body and
request ID. Reusing an ID for another recipient or amount returns 409.

Optional mint field `bypassSubscription: true` enables **test subscription
acceptance** on Sepolia (or local chain tests). The backend must hold
`ATTESTOR_ROLE`. It merges only `subscriptionAccepted=true` into the recipient’s
live facts, preserving their expiry with a maximum 24-hour window, and reports
`subscriptionTxHash`. Every other mint/transfer rule still runs. The flag is part
of the request’s identity: changing it requires a new request ID.

### Pool liquidity

- `GET /v1/agreements/:id/liquidity`: backend RWA/mUSDC balances and active pool liquidity.
- `POST /v1/agreements/:id/liquidity/seeds`: operator/workspace-only,
  `{ "requestId": "a-unique-seed-request", "rwaAmount": "100", "usdAmount": "100" }`.
  Amounts are maximum deposit budgets, positive decimal strings with up to six
  places. Returns HTTP 202; the backend approves bounded amounts and creates a
  full-range position through the pool hook’s trusted router.
- `GET /v1/agreements/:id/liquidity/seeds/:requestId`: status, stage, approval and
  seed transaction hashes. Retry the same POST after interruption to reconcile
  the existing transaction or uniquely salted position.

Both backend balances and transfer eligibility are required. Deprecated pools
using the old mUSDC are rejected with `LEGACY_POOL_ASSET`; seeding never creates
or migrates a pool.

The mint endpoint also accepts `simulateDeposit: true` (default **false**).
This explicitly simulates receipt of a bank deposit on Sepolia/local test chains
by merging `depositConfirmed=true` for the recipient and selected policy through
the backend attestor. It returns `depositTxHash` on the mint operation. Other live
facts and their expiry are preserved, capped at 24 hours; no actual payment is
verified or transferred. Normal minting leaves deposit confirmation to the
bank-payment settlement flow. The flag is bound to the request ID, so changing
it requires a new mint request ID. Neither test flag sets KYC/AML or World ID.

Additional opt-in mint field `testAttestations` accepts only these boolean keys:
`issuerAuthorized`, `offeringCompliant`, `identityVerified`, `kycApproved`,
`amlApproved`, and `sanctionsClear`. All default to false. For example:

```json
{
  "recipient": "0x…",
  "amount": "100",
  "requestId": "unique-test-mint-request",
  "bypassSubscription": true,
  "simulateDeposit": true,
  "testAttestations": {
    "issuerAuthorized": true,
    "offeringCompliant": true,
    "identityVerified": true,
    "kycApproved": true,
    "amlApproved": true,
    "sanctionsClear": true
  }
}
```

These flags simulate every current RWA mint/release requirement. The policy
still evaluates normally. Only Sepolia and local chain 31337 accept simulations;
identity simulation does not verify a World ID proof. Selected fact writes
return `<fact>TxHash` fields when a transaction is needed. Existing live facts
are reused. Sanctions clearance calls only the configured mock oracle with its
authorized administrator and returns `sanctionsClearTxHash`. It never attempts
to override the policy’s observable sanctions bit via the attestor. Unknown or
non-boolean flags return `INVALID_MINT`; changed flags under an existing request
ID return `MINT_CONFLICT`.
