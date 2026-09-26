# mirr0tech

**mirr0tech links a tokenized asset's off-chain legal clauses to the on-chain code that executes them.**

A legal document goes in. Out comes a policy grounded in verbatim quotes, hashed to the document, and compiled into each venue the asset passes through: the token's issuance rules, the Uniswap v4 hook it trades through, the Wildcat role provider that admits lenders, the 1inch Aqua strategy that gives a lender an exit. Every on-chain refusal names its clause.

ETHGlobal Tokyo 2026. Prototype, mock USD, not legal advice, no affiliation with Wildcat, 1inch, Uniswap, Securitize or BlackRock.

**Live:** [legalmirror.github.io/mirr0tech](https://legalmirror.github.io/mirr0tech/) — the story, the agreements with every enforced sentence, who may lend and why, the Aqua exit, the Sepolia timeline (static build; the live gateway is a local or Coolify run).

[![Overview](docs/img/overview.png)](https://legalmirror.github.io/mirr0tech/)

[![Agreement](docs/img/agreement.png)](https://legalmirror.github.io/mirr0tech/agreement)

## Run it

Node 18+ and [Foundry](https://getfoundry.sh) (`anvil`). Everything runs locally.

```sh
npm ci && npm run vendor                                           # vendor/ ← 1inch SwapVM + Aqua sources
npm run build && npm run build:secondary && npm run build:credit   # artifacts/<profile>/
npm run demo:golden                                                # both acts end to end on a fresh anvil
npm run check                                                      # unit + chain tests, all three profiles
```

## The demo

**Act 1 — tokenize and trade.** The Securitize/BlackRock transfer-agent agreement compiles into a permissioned fund token and a Uniswap v4 hook. Shares mint to custody and release only to an onboarded investor. Anyone may create a pool; one without the hook cannot take the token (`NoPolicyDoor`), and a stranger in the hooked pool is refused with *"Exhibit A — Investor Onboarding"* quoted.

**Act 2 — lend it out.** The Wildcat template Master Loan Agreement, the borrower's Lender Check Policy and a one-clause buyback addendum compile into a Wildcat `IRoleProvider` and a 1inch Aqua strategy. Lender A deposits; Lender B, uncountersigned, goes to review; Lender C, designated by the sanctions oracle, is denied with no override. The borrower ships a standing buyback to Aqua (virtual balance, no capital moves) whose program contains the agreement as an opcode. Lender A fills at the addendum's 0.96; a stranger is refused at quote time; a later designation makes the same strategy unfillable for that wallet and blocks its payment, nothing redeployed.

## How it works

```
document(s) ─► normalize + SHA-256 ─► AST { rules, terms, unresolved }, each with a verbatim quote
            ─► DNF bitmasks per rule ─► equivalence proof vs the JS interpreter (all 3^k assignments)
            ─► policyHash + clause-table hash ─► CompiledPolicy.sol + program templates
```

- **Three-valued facts.** True, false, or not established. Unknown never satisfies a requirement, and an expired attestation makes every fact unknown, so screening is continuous. `contracts/PolicyEval.sol` and `src/policy/evaluate.js` decide identically or the compiler refuses to emit.
- **Observable vs attested.** Sanctions come from the oracle the agreement names, the market's term state from the market; the compliance function attests the rest into `PolicyAttestor` with an expiry. `PolicyOracle` assembles both for every venue.
- **Provenance on every revert.** `LegalClauseViolation(clauseId, policyHash)` / `CounterpartyRefused(subject, clauseId, policyHash)`; the clause table's hash is committed on chain, so the sentence a front end shows cannot be substituted.
- **No generated code.** Extraction emits schema-validated JSON; the compiler emits bitmasks into fixed templates; one audited evaluator serves every policy.

## Venues

| Venue | Contract | The agreement there |
| --- | --- | --- |
| Wildcat V2 | `MirrortechRoleProvider.sol`, Wildcat's real `IRoleProvider` | `getCredential` admits lenders, `mayWithdraw` re-checks at payment, `explain` says why. One `addRoleProvider` call registers it. |
| 1inch Aqua + SwapVM | `swapvm/MirrortechRouter.sol` (`SwapVM` + `LimitOpcodes` + two instructions), `PolicyGuard.sol`, `FixedRateBalances.sol` | The agreement runs inside the maker's program: `PolicyGuard` evaluates maker and taker at every fill and every `quote()`; strategies ship to the unmodified Aqua registry. |
| Uniswap v4 | `MirrorPolicyHook.sol` | Admission on liquidity and swaps, address mined for its permission bits, and a transient handshake that makes the hook the token's only door into Uniswap. |

## Source documents

`test/human_contracts/`: the [Wildcat template MLA](https://docs.wildcat.finance/legal/master-loan-agreement) verbatim with illustrative fields (fictional "Demo MM Ltd"); an illustrative Lender Check Policy and buyback addendum (the MLA delegates admission to the borrower's process, §1); a public Securitize/BlackRock services agreement, interpreted as a subset. Open terms (default remedies, governing law, sanctions disputes) are listed as `unresolved` and block compilation unless `--demo` is passed.

## How we used 1inch Aqua and SwapVM

- **Official contracts.** Aqua unmodified (the canonical registry on Sepolia); `MirrortechRouter` is `SwapVM` + `LimitOpcodes` with two instructions appended, no opcode renumbered (`contracts/swapvm/MirrortechRouter.sol:31-49`).
- **Instructions.** `PolicyGuard._policyGuard` (`PolicyGuard.sol:38-50`) reads `ctx.query.maker/taker` and calls `PolicyOracle.decide`; view-only, so `quote()` refuses before a transaction exists. `FixedRateBalances` (`FixedRateBalances.sol:27-45`) pins the addendum's rate over preloaded Aqua balances.
- **Programs.** `src/policy/programs.js` derives opcodes from the vendored `LimitOpcodes.sol`, encodes `[opcode][len][args]`, builds hookless Aqua orders and taker traits. Two positions from one addendum: `BuybackFixedPrice` (A1.1) and `BuybackDutchAuction`, the official `DutchAuctionBalanceOut` between rate and curve, floor to the A1.5 ceiling over the window: a tender offer with the agreement as an opcode.
- **Executed.** `test/chain/swapvm.test.js`, `scripts/demo-golden.js`: `ship` → `quote` → `swap` (`pull`/`push`) → refusals → cap, deadline → `dock`; the auction quotes at open, midway and near close, fills, expires.

Feedback: the instruction/router split made an opcode a 40-line job, and `quote()` running the full program statically is what makes pre-trade compliance possible. Friction: `StaticBalances` cannot follow Aqua-preloaded balances (hence `FixedRateBalances`); the full `Opcodes` router plus anything exceeds EIP-170, so `LimitOpcodes`; contracts are not on npm, so `vendor/`; SDK opcode numbering (44) differs from `release/1.1` (46).

## How we used Noolog

The extraction is generated by a Noolog deliberation, not by one model call. `src/noolog/extract.js` sends the document (and the hand-authored reading as a draft) to the OpenAI-compatible endpoint (`POST /v1/chat/completions`, model `nsed:deep`); the answer is the winning proposal, the `x-nsed-session-id` header names the job, and `GET /deliberation/{job}/details` + `/references` give every claim its verdicts (`verified | contested | unverified | wrong`), the evaluators' counter-positions on contested items, the winner, the convergence and a confidence per rule, term and open item. That report ships as `verification` in every policy export; the dashboard shows it on the Agreement screen (counts, contested items, every claim, the schema on real data) and under every sentence. With no `NOOLOG_API_KEY` the in-process mock (`src/noolog/mock.js`) serves the same routes, status codes and schemas (checked against `noolog-wire` and `quorum-rs`) with a mechanical critic: a quote that is not in the text is wrong, one that repeats or is too short is contested, an open item is unverified. `test/noolog.test.js` runs the loop over HTTP: a forged quote is refuted and dropped from the generated extraction; the MLA's repeated sentences come back contested.

## How we used Curvegrid MultiBaas

`src/multibaas.js` uploads every contract's ABI and bytecode under a label and a policy-hash version (`policy-<hash8>`), aliases and links each address (`attestor`, `fund_hook`, `role_provider`, `swapvm_router`, …), so MultiBaas indexes `Attested`/`Revoked`/`Overridden`, `CredentialDecision`, `PolicyChecked`, Aqua's `Pushed`/`Pulled` and the router's `Swapped`. The stack API serves them at `GET /v1/stack/events` and the audit screen reads that. `npm run deploy:sepolia` deploys and registers; `test/multibaas.test.js` covers it against a fake client.

Feedback: `createContract` / `setAddress` / `linkAddressContract` is the right granularity for a compiler that emits versioned contracts; we missed a supported-chain check and an idempotent upsert for re-syncs.

## Dashboard and API

`npm --prefix dashboard run dev` serves http://localhost:3100 on exported data; with `NEXT_PUBLIC_GATEWAY_URL` and `NEXT_PUBLIC_GATEWAY_KEY` it runs live against `npm run dev:stack` (anvil + operator API). The clause highlighter maps every paragraph to what it compiled to and walks a rule from quote to DNF to bytes to contract; the Lenders, Decisions, Exit and History screens drive the chain. Routes and repository map: [docs/API.md](docs/API.md).

## Deploy

`deploy/` is a Coolify-shaped Compose stack (`anvil` + `api` + `dashboard`): [docs/deploy.md](docs/deploy.md). `.github/workflows/pages.yml` publishes the static dashboard to GitHub Pages on every push.

### Sepolia

Both acts run on Sepolia against the canonical venues; `deployments/sepolia.json` is the record (`DEPLOYMENT_PATH=deployments/sepolia.json npm run dev:stack` serves it without redeploying). Policy hashes are the same bytes as the local build.

| Contract | Address |
| --- | --- |
| PolicyAttestor | [`0xAE7C29817d1d38C873097b5b0FBB16b81B02D079`](https://sepolia.etherscan.io/address/0xAE7C29817d1d38C873097b5b0FBB16b81B02D079) |
| MockSanctionsOracle | [`0xC422CEFE3041Aa161128DdD1345051cBF8E8D5cD`](https://sepolia.etherscan.io/address/0xC422CEFE3041Aa161128DdD1345051cBF8E8D5cD) |
| mUSDC | [`0x96E131fb063Db27D7f9077C24DD953054beD19A0`](https://sepolia.etherscan.io/address/0x96E131fb063Db27D7f9077C24DD953054beD19A0) |
| PolicyOracle (fund) | [`0xc9301248cB175C3B1978d559C15153841C749FfB`](https://sepolia.etherscan.io/address/0xc9301248cB175C3B1978d559C15153841C749FfB) |
| CompiledMirrorToken | [`0x7B7e2db76b862e77f1910c73F3FE22987B56AFE0`](https://sepolia.etherscan.io/address/0x7B7e2db76b862e77f1910c73F3FE22987B56AFE0) |
| MirrorPolicyHook | [`0x008505d4ce3c99f52BB8dA311E66ec1aF8F24A80`](https://sepolia.etherscan.io/address/0x008505d4ce3c99f52BB8dA311E66ec1aF8F24A80) |
| MirrorLiquidityRouter | [`0x3d2dd14dbBF28D00412e92c399d0bA136E226922`](https://sepolia.etherscan.io/address/0x3d2dd14dbBF28D00412e92c399d0bA136E226922) |
| Uniswap v4 PoolManager (canonical) | [`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`](https://sepolia.etherscan.io/address/0xE03A1074c86CFeDd5C142C4F04F1a1536e203543) |
| PolicyOracle (credit) | [`0x4369706eAAE3f228F965Ec0Fc1120B442EB9D4E8`](https://sepolia.etherscan.io/address/0x4369706eAAE3f228F965Ec0Fc1120B442EB9D4E8) |
| MirrortechRoleProvider | [`0x2541fcC3b63518A79981a6C637AC8364a94A664f`](https://sepolia.etherscan.io/address/0x2541fcC3b63518A79981a6C637AC8364a94A664f) |
| MockWildcatMarket | [`0xFd99ea7F7C63C3c0BBFf56c7EB629B3760c19E93`](https://sepolia.etherscan.io/address/0xFd99ea7F7C63C3c0BBFf56c7EB629B3760c19E93) |
| MirrortechRouter (SwapVM + PolicyGuard) | [`0x5B6637fdae665AF9EBD4179C4a6a74C1B61aAe0C`](https://sepolia.etherscan.io/address/0x5B6637fdae665AF9EBD4179C4a6a74C1B61aAe0C) |
| 1inch Aqua (canonical) | [`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`](https://sepolia.etherscan.io/address/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) |

Golden path on Sepolia, as the audit records it:
[hooked pool created](https://sepolia.etherscan.io/tx/0xa22610f0ae976bf538ce0ba0396084910ccdcc9fb6bd417d8ba69e0ed3ab850a) on the canonical PoolManager ·
[liquidity through the hook](https://sepolia.etherscan.io/tx/0xf87a0b8f25294007698a160a6553661637557cb3b29c3fdd5baa4a108f03c15b) ·
[swap](https://sepolia.etherscan.io/tx/0x9a2cbc65c98d65e2a12a2f19e3e09ed3e3e09a41f158401167bfa6b1fc524210) ·
[Lender A admitted and deposits](https://sepolia.etherscan.io/tx/0x3a3074b0f8634c65d5be398965fdfb5cb6c44b55540488687e24d0de47dbf2b7) ·
[buyback shipped to the canonical Aqua](https://sepolia.etherscan.io/tx/0x604a19d5dacbb37ded2937eece8d0fbc7d39a8806b22c3fc27ac1dab0c746cb8) ·
[Lender A fills through SwapVM + PolicyGuard](https://sepolia.etherscan.io/tx/0xd42e703d2f20eaccbd0387c1257786340720172054c70dfc759f6d4fd37de82d) ·
[tender offer posted with DutchAuctionBalanceOut](https://sepolia.etherscan.io/tx/0x2a2dba2abd9a1b30afe95c48a6805b09487d6ec00e98b16daadef1d2a4c75602) and quoted at 0.9602 minutes into its window.
The refusals (stranger release, hookless pool, stranger liquidity, Lender C deposit, stranger quote) never became transactions.

## Limits

Screening, countersignature, AML/KYC and solvency are attested, not proved; a policy hash is no evidence that anyone was screened correctly. The sanctions oracle and the Wildcat market are mocks with the real interfaces (the real market is mainnet-only). Fact bitmaps are readable per wallet. The fund token is non-rebasing because Uniswap v4 does not support rebasing balances. Not legal advice; no real counterparty.

## Team

⚠️ To be filled in before submission: names and handles.

## Licenses

Repository code: MIT. `vendor/` (git-ignored, fetched by `npm run vendor`) holds 1inch SwapVM and Aqua under their source-available Degensoft licenses; the router is a modified redeployment as the hackathon rules permit. `contracts/wildcat/IRoleProvider.sol` reproduces Wildcat's MIT-licensed interface.
