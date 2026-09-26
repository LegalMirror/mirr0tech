# Agreements API

The core loop as REST: **upload → generate → verify → compile → deploy**. `src/agreements-api.js` (routes) over `src/agreements.js` (store + lifecycle), mounted under `/v1` by `src/app.js`. Same bearer as every route: `API_KEY` for writes, `VIEWER_KEY` for GET. Error envelope `{ error: { code, message } }`. Tests: `test/agreements.test.js`, `test/agreements-api.test.js`, `test/chain/agreements-deploy.test.js`.

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/v1/status` | — | `{ model: { provider, mode: "mock" \| "live", url, model }, compiler: { solidity: { core, swapvm, "uniswap-v4" } }, chain: { chainId, deployer, attestor, poolManager } \| null }` |
| GET | `/v1/agreements` | — | `[summary]` |
| POST | `/v1/agreements` | `{ name, documents: [{ name, text }] }` or `{ name, text, filename? }`; optional `profile` (default `rwa-secondary`), `config` | `201` summary in `extracting`; the run continues in the background |
| GET | `/v1/agreements/:id` | — | summary + `export` (`null` until `verified`; then the `ui/policy-<profile>.json` shape: rules with `clauseId`, `dnf`, `quotes`; terms; unresolved; clauseTable; programs; coverage; verification; documents with display text) |
| GET | `/v1/agreements/:id/ast` | — | `{ nodes, edges }` for the Contract-AST view; `409` until `compiled` |
| GET | `/v1/agreements/:id/constraints` | — | `{ identity: { credential, actions, clause, quote } \| null }` |
| PUT | `/v1/agreements/:id/constraints` | `{ identity: { credential?, actions?, quote?, clause? } \| null }` | the summary, recompiled (`compiled`, new `policyHash`, `deployment: null`); `400 QUOTE_NOT_FOUND` when the quote is not verbatim in the document |
| * | `/v1/agreements/:id/stack/*` | as `/v1/stack/*` | the same venue routes over **this agreement's** token, oracle and hook (`wallets`, `explain`, `facts`, `worldid`, `rwa/mint`, `rwa/release`, `rwa/liquidity`, `rwa/swap`, `audit`, `events`); `409` until `deployed` |
| POST | `/v1/agreements/:id/regenerate` | — | `202` summary in `extracting`; allowed from `verified`, `compiled`, `deployed`, `failed` |
| POST | `/v1/agreements/:id/deploy` | — | `202` summary in `deploying`; `409` unless `compiled`; `503 NO_CHAIN` when the gateway has no signer |

Upload: the document's `name` extension picks the reader (`.txt`, `.md`, `.htm`, `.html`; the short form defaults to `<name>.txt`); the body limit on this route is 4 MB (32 KB elsewhere). Several parts (agreement + policy + addendum) go in one `documents` array and are hashed as one bundle with per-part provenance.

AST graph: `nodes: [{ id, kind, label, status?, … }]`, `kind ∈ agreement | action | rule | fact | term | unresolved`; rule and term nodes carry `status ∈ verified | contested | unverified` and `confidence` from the verification report, rules also `effect`, `clauseId`, `clause`; `edges: [{ from, to }]` run agreement → action → rule → fact, agreement → term, agreement → unresolved.

Errors: `400 INVALID_BODY`, `400 UNKNOWN_PROFILE`, `400 INVALID_DOCUMENT` (unsupported extension, empty, over 2 MB), `401 UNAUTHORIZED`, `404 NOT_FOUND`, `409 INVALID_STATE` (wrong state, or a job already in flight), `409 UNSUPPORTED_PROFILE` (the credit profile has no token to deploy per agreement), `413 BODY_TOO_LARGE`, `503 NO_CHAIN`. A background failure is on the record: `status: "failed"`, `error: <message>` for generation; a failed deploy returns to `compiled` with `error: "Deploy failed: …"`. A restart mid-job marks the record `failed` (`Interrupted while extracting`).

## The flow

One agreement, one issuer, one token: **login → upload → (the AST compiles) → put a World ID constraint on it → deploy → the policy-hooked pool is live**. The constraint step is the issuer's trust decision: which credential (`document` for KYC, `proof_of_human` where a person is enough, `selfie` for liveness), on which actions (`mint`, `transfer`, `burn`), anchored to the sentence of the agreement that asks for it. The rule and the credential are inside the policy hash, so the deployed token carries that choice; the gateway's verifier for that agreement accepts only that credential (`WRONG_CREDENTIAL` otherwise, the alternative path).

`scripts/mirr0.js` (`npm run cli --` or `npx mirr0`) is the flow from a terminal; `test/chain/flow.test.js` runs it end to end on anvil:

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
    uploaded --> extracting: deliberation started
    extracting --> verified: AST validated against the text, verdicts attached
    verified --> compiled: policyHash, clauseTableHash, DNF programs, Solidity, equivalence proof
    compiled --> compiled: PUT /constraints (new hash)
    deployed --> compiled: PUT /constraints (deploy again)
    compiled --> deploying: POST /deploy
    deploying --> deployed: oracle, token, hook, pool on chain
    deploying --> compiled: deploy error (error set)
    extracting --> failed: deliberation or validation error
    verified --> failed: compile error
    compiled --> extracting: POST /regenerate
    deployed --> extracting: POST /regenerate
    failed --> extracting: POST /regenerate
```

One background run carries a record from `extracting` to `compiled`; `deploy` is the only manual step after upload.

- `verified` — the deliberation completed; the AST validated (`validateAst`: schema, every quote a verbatim substring, depth, no duplicate ids); the verification report is attached.
- `compiled` — `compilePolicy` succeeded: `policyHash` over source + AST + config, clause table hash, DNF programs, generated Solidity, equivalence checks passed, coverage resolved.
- `deployed` — `PolicyOracle`, `CompiledMirrorToken` and `MirrorPolicyHook` (CREATE2 salt mined for the hook flags) deployed, the token configured for the venue, the pool initialized on the stack's `PoolManager` (`deployFund`, `src/deploy.js`).

Solidity is compiled at deploy time by `src/solc.js` (bundles `core` and `uniswap-v4`) with the generated `CompiledPolicy.sol` and `CompiledMirrorToken.sol` supplied in memory. The deliberation starts from a draft when the document is one of the demo agreements (the hand-authored fixture whose quotes hold in the text). With the mock model (`NOOLOG_API_KEY` unset) a draft is required: a new document fails with `Reading a new document needs the model`. With the live model any document is read.

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
  "extraction": { "provider": "noolog", "model": "nsed:legal_rwa_pro", "responseId": "mirr0tech-rwa-secondary-9c1e…", "agents": ["RwaScrivener", "RwaCompliance"], "demoted": [{ "kind": "rule", "id": "withdraw-redemption-payment", "action": "withdraw", "clause": "2.2" }] },
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

`npm run dev:stack` listens on `PORT` (default 3000; the Compose stack uses 3200).

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
