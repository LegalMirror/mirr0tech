# mirr0tech

**mirr0tech links a tokenized asset's off-chain legal clauses to the on-chain code that executes them.**

A legal document goes in. A policy comes out that is provably grounded in verbatim quotes from that document, hashed to it, and compiled into the venue each stage of the asset's life needs — the token's issuance rules, the Uniswap v4 hook it trades through, the Wildcat role provider that admits lenders, and the 1inch Aqua strategy that gives a lender an exit the agreement permits. Every refusal on chain names the clause that caused it.

Built at ETHGlobal Tokyo 2026. Prototype, local chain, mock USD, not legal advice, no affiliation with Wildcat, 1inch, Uniswap, Securitize, BlackRock or any named firm.

## Run it

Requires Node.js 18+ and [Foundry](https://getfoundry.sh) (`anvil`). Everything runs on a local chain.

```sh
npm ci
npm run vendor          # clones the source-available 1inch SwapVM + Aqua sources into vendor/
npm run build           # fund agreement, custodial profile  → artifacts/custodial-rwa/
npm run build:secondary # fund agreement + transfer rules    → artifacts/rwa-secondary/
npm run build:credit    # loan agreement bundle              → artifacts/wildcat-credit/
npm run demo:golden     # both acts, end to end, on a fresh anvil
```

`npm run check` runs every unit and chain test (`test/`, `test/chain/`) across all three profiles.

## What the demo shows

**Act 1 — tokenize and trade.** The Securitize/BlackRock transfer-agent agreement compiles into a permissioned fund token and into a Uniswap v4 hook. Shares are minted to custody, released only to an onboarded investor, and pooled only through a pool that carries the hook: anyone may create such a pool without asking the issuer, a pool *without* the hook initializes but cannot take the token (`NoPolicyDoor`), and a stranger in the hooked pool is refused with *"Exhibit A — Investor Onboarding"* quoted.

**Act 2 — lend it out.** The Wildcat template Master Loan Agreement, the borrower's Lender Check Policy and a one-clause buyback addendum compile into a Wildcat `IRoleProvider` and a 1inch Aqua strategy. Lender A is screened and deposits; Lender B without a countersignature goes to review, quoting the policy; Lender C, designated by the sanctions oracle, is denied with no override. The borrower ships a standing buyback to Aqua — a virtual balance, no capital moves — whose program contains the agreement as an opcode. Lender A is quoted the addendum's 0.96 and fills against the borrower's wallet; a stranger is refused *at quote time*; a later sanctions designation makes the same strategy unfillable for that wallet and blocks its payment, with nothing redeployed. Change one word in the agreement and the hash changes.

## How it works

```
document(s) ─► normalize + SHA-256 ─► AST { rules, terms, unresolved }  each with a verbatim quote
            ─► DNF bitmask terms per rule ─► equivalence proof vs the JS interpreter (all 3^k assignments)
            ─► policyHash, clause table hash ─► CompiledPolicy.sol (programs as bytes) + program templates
```

- **Facts are three-valued.** True, false, or not established. Unknown never satisfies a requirement or clears a prohibition and propagates through negation. An attestation that expires makes every fact unknown, so screening is continuous by construction. `contracts/PolicyEval.sol` decides from two `uint256` words; `src/policy/evaluate.js` is the same decision off chain, and the compiler refuses to emit if they ever disagree.
- **Observable vs attested.** Sanctions come from the oracle the agreement names as definitive (`MockSanctionsOracle` locally, Chainalysis-shaped) and the market's term state from the market; the borrower's compliance function attests the rest into `PolicyAttestor` with an expiry. `PolicyOracle` assembles both once for every venue.
- **Provenance on every revert.** `LegalClauseViolation(clauseId, policyHash)` / `CounterpartyRefused(subject, clauseId, policyHash)`; `clauseId` indexes a clause table whose hash is committed on chain, so the sentence a front end renders cannot be substituted. When no permission holds, the refusal names the permission the subject lacks.
- **No generated code.** The model (when extraction is live) emits schema-validated JSON only. The compiler emits bitmasks and fills fixed program templates; one audited evaluator serves every policy.

## Venues

| Venue | Contract | What the agreement does there |
| --- | --- | --- |
| Wildcat V2 | `contracts/MirrortechRoleProvider.sol` implements Wildcat's real `IRoleProvider` (`contracts/wildcat/IRoleProvider.sol`) | `getCredential` admits lenders; `mayWithdraw` re-checks at payment time; `explain` answers "why was this wallet allowed or blocked" as a view. A borrower registers it with one `addRoleProvider` call. |
| 1inch Aqua + SwapVM | `contracts/swapvm/MirrortechRouter.sol` (a modified SwapVM redeploy, `LimitOpcodes` + two instructions), `PolicyGuard.sol`, `FixedRateBalances.sol`; programs from `src/policy/programs.js` | The agreement runs **inside the maker's program**: `PolicyGuard` evaluates maker and taker at every fill and every `quote()`; `FixedRateBalances` pins the addendum's price over Aqua's preloaded balances. Strategies ship to an **unmodified** Aqua registry. |
| Uniswap v4 | `contracts/MirrorPolicyHook.sol` (+ `contracts/test/MirrorLiquidityRouter.sol`) | Admission on add/remove liquidity and swap, address mined for its permission bits, and a transient handshake that makes the hook the token's **only door** into Uniswap: `MirrorToken` refuses any pool-manager transfer unless the hook admitted that subject in the same transaction. |

## Source documents

- `test/human_contracts/wildcat-mla.md` — the [Wildcat template MLA](https://docs.wildcat.finance/legal/master-loan-agreement), verbatim, with its template fields filled with illustrative values for a fictional borrower ("Demo MM Ltd"). Wildcat describes the template as open source.
- `test/human_contracts/lender-check-policy.md`, `buyback-addendum.md` — illustrative borrower documents. The MLA delegates admission to the borrower's Lender Check Process (§1); the addendum is the clause a borrower adds so a standing buyback can be compiled. Neither is in Wildcat's template and both say so.
- `test/human_contracts/ea026411904ex10-9.htm` — a public Securitize/BlackRock services agreement; the fixture is an interpreted subset and records its own gaps under `unresolved`.

Terms the documents leave open (default remedies, governing law, sanctions disputes, what counts as satisfactory due diligence) are listed under `unresolved` and block compilation unless `--demo` is passed.

## Repository map

| Path | Role |
| --- | --- |
| `src/policy/` | `document.js` normalization + bundles · `schema.js` facts, actions, AST schema · `dnf.js` DNF + equivalence · `onchain.js` emits `CompiledPolicy.sol` · `compile.js` profiles, proof, hashes · `programs.js` SwapVM programs/orders · `fixture.js`, `mla-fixture.js` hand-authored ASTs · `extract.js` live LLM extraction · `hookAddress.js` CREATE2 mining |
| `contracts/` | `PolicyEval`, `PolicyAttestor`, `PolicyOracle`, `MirrorToken`, `MirrortechRoleProvider`, `MirrorPolicyHook`, `swapvm/`, mocks (`MockSanctionsOracle`, `MockWildcatMarket`, `test/MockERC20`) |
| `src/deploy.js`, `scripts/deploy-stack.js` | one call deploys both acts against any RPC (anvil default; canonical `POOL_MANAGER`/`AQUA`/`WETH` via env on a public chain) |
| `src/refusal.js` | decodes a revert, through Uniswap's wrapper if needed, into the clause |
| `src/venues.js`, `src/venues-api.js`, `scripts/dev-stack.js` | operator service and REST routes over the deployed stack; local runner |
| `scripts/demo-golden.js`, `scripts/demo-credit.js`, `scripts/demo.js` | both acts · Act 2 lender lifecycle · the original custodial issuance demo (REST) |
| `test/`, `test/chain/` | unit tests incl. the equivalence proof · anvil tests: `evm` (token + operator signer), `rwa-pool` (Act 1), `credit` (role provider), `swapvm` (Aqua strategy), `hook` (v4), `stack` |
| `docs/` | `PRD.md`, `ARCHITECTURE.md`, `SWAPVM_INTEGRATION.md`, `MLA_CLAUSE_MAP.md` |
| `dashboard/` | Next.js dashboard: clause highlighter with the six pipeline steps, lenders/queue/exit/audit screens; static export by default, live against the stack API with `NEXT_PUBLIC_GATEWAY_URL` + `NEXT_PUBLIC_GATEWAY_KEY` (see `dashboard/README.md`) |
| `generated/`, `artifacts/<profile>/` | build output, git-ignored; each artifact directory carries its policy and clause table |

Compilers: repository contracts on solc 0.8.37; Uniswap's `PoolManager` pins 0.8.26 (`solc-v4`); SwapVM and Aqua pin 0.8.30 via IR (`solc-swapvm`). `scripts/build-contracts.js` bundles them and reports bytecode sizes.

## How we used 1inch Aqua and SwapVM

- **Official contracts, redeployed.** `Aqua.sol` is deployed unmodified from the vendored source; `MirrortechRouter` is `SwapVM` + the official `LimitOpcodes` set with two instructions appended so no existing opcode changes number (`contracts/swapvm/MirrortechRouter.sol:31-49`).
- **Custom instructions.** `PolicyGuard._policyGuard` (`contracts/swapvm/PolicyGuard.sol:38-50`) reads `ctx.query.maker` / `ctx.query.taker` and calls `PolicyOracle.decide`; it is view-only so `quote()` refuses before any transaction. `FixedRateBalances._fixedRateBalances` (`contracts/swapvm/FixedRateBalances.sol:27-45`) sets the rate registers over preloaded Aqua balances.
- **Program, order, taker data.** `src/policy/programs.js` parses opcode numbers from the vendored `LimitOpcodes.sol`, encodes `[opcode][len][args]`, builds the hookless Aqua order (`useAquaInsteadOfSignature`), and packs taker traits (threshold + deadline, `useTransferFromAndAquaPush`).
- **On-chain execution.** `test/chain/swapvm.test.js` and `scripts/demo-golden.js`: `ship` → `quote` → `swap` with `pull`/`push` → refusals → cap and deadline → `dock`.

Developer feedback: the instruction/router split made adding an opcode a 40-line job, and `quote()` running the full program in a static context is what makes pre-trade compliance possible at all. Friction: `StaticBalances` cannot be used once Aqua preloads balances (hence `FixedRateBalances`); the full `Opcodes` router with any addition exceeds EIP-170 under solc-js settings, so `LimitOpcodes` was the practical base; the npm packages are SDKs only, so contracts must be vendored from GitHub; the SDK's opcode numbering (44) differs from `release/1.1` (46), so we derive numbers from the vendored source.

## How we used Curvegrid MultiBaas

`src/multibaas.js` registers a deployment with a MultiBaas instance: every contract's ABI and bytecode is uploaded under a label and a **policy-hash version** (`policy-<hash8>`), each address is aliased (`attestor`, `fund_token`, `fund_hook`, `role_provider`, `aqua`, `swapvm_router`, …) and linked, so MultiBaas indexes `Attested`/`Revoked`/`Overridden`, `CredentialDecision`, `PolicyChecked`, Aqua's `Pushed`/`Pulled` and the router's `Swapped`. The stack API serves them at `GET /v1/stack/events?contract=…&event=…` when configured, and the audit screen reads that; the transaction explorer decodes calls without Etherscan verification.

```sh
MULTIBAAS_URL=… MULTIBAAS_API_KEY=… RPC_URL=<sepolia> DEPLOYER_PRIVATE_KEY=… AQUA=0x1111113ccf1426a8e30e2bff5e005d929bf6a90a npm run deploy:sepolia
```

MultiBaas only sees chains it supports, so development and every test stay on anvil; the sync is a post-deploy step on Sepolia. `test/multibaas.test.js` covers the registration against a fake client. Feedback: the SDK's `createContract` / `setAddress` / `linkAddressContract` triple is exactly the right granularity for a compiler that emits versioned contracts — version = policy hash is a natural fit; we would have liked a supported-chain check in the SDK and an idempotent "upsert" so re-syncs need no conflict handling.

## Dashboard

```sh
npm --prefix dashboard install
npm --prefix dashboard run dev                 # exports both policies, serves http://localhost:3100 on static data
NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:3200 NEXT_PUBLIC_GATEWAY_KEY=local-dev-stack-operator-key-only npm --prefix dashboard run dev   # live, against `npm run dev:stack`
```

The clause highlighter shows the document with every quoted span lit, and for a selected rule: quote → rule → DNF terms → program bytes → enforcing contract and revert → a what-would-happen evaluator that runs the interpreter and the bitmask decision side by side. With the gateway set, lenders, facts, decisions and the audit come from the chain; the dashboard's PolicyData is recomputed by the same export code, so its `policyHash` equals the deployed one.

## Stack API — drive both acts without a terminal

```sh
npm run dev:stack   # anvil + deployed stack + operator API at http://127.0.0.1:3000/v1/stack
```

Bearer token `local-dev-stack-operator-key-only` (or `API_KEY`). Demo wallets (`Investor`, `Stranger`, `Lender A/B/C`, `Operator`) are the local chain's unlocked accounts. Every action lands in `GET /v1/stack/audit` with its tx hash or its decoded refusal.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/v1/stack`, `/policies`, `/wallets`, `/wallets/:w` | deployment, both policies with clause tables, wallet balances and standing |
| GET | `/wallets/:w/explain?policy=rwa\|credit&action=…` | the on-chain decision, the clause, the facts as known/true/false/unknown |
| POST/DELETE | `/wallets/:w/facts` `{policy, facts}` | attest / revoke facts (`days` optional) |
| POST | `/wallets/:w/sanction` `{sanctioned}`, `/wallets/:w/override`, `/wallets/:w/fund` `{amount}` | oracle designation, the borrower's §13(c)(y) override, mock funding + approvals |
| POST | `/rwa/mint` `{amount}`, `/rwa/release` `{wallet, amount}`, `/rwa/pools` `{wallet, hooked}`, `/rwa/liquidity`, `/rwa/swap` | Act 1 |
| POST/GET | `/credit/deposit`, `/credit/withdraw` `{wallet, amount}`; `/credit/buyback` (ship / read: program disassembled, hash chain, Aqua balances); `/credit/buyback/quote`, `/fill` `{wallet, amount}`, `/dock` | Act 2 |

Refusals return `403 { error: { code: "POLICY_REFUSED", details: { refusal: { name, clause: { clause, quote, ruleId } } } } }`.

## Operator API (custodial issuance)

The original MVP's REST gateway (`npm start`, bearer token, `Idempotency-Key`, restart recovery) still drives Act 1's issuance: `GET /v1/policy`, `POST /v1/investors`, `POST /v1/deposits`, `POST /v1/mints`, `POST /v1/redemptions`, `GET /v1/audit`, plus mock compliance/settlement endpoints. `npm run demo` exercises it on a mock chain; `CHAIN_MODE=evm` uses the deployed token (`.env.example`).

## Deploy

`deploy/` holds a Coolify-shaped Docker Compose stack — `anvil` + `api` (deploys and seeds on boot) + `dashboard` — with a local override for trying it here; see [docs/deploy.md](docs/deploy.md).

## Honest limits

The venue enforces what it can observe. Screening results, countersignature, AML/KYC information and solvency are **attested**, not proved — a policy hash is not evidence that anyone was screened correctly. The sanctions oracle and the Wildcat market are mocks with the real interfaces; the real Wildcat market is mainnet-only. Fact bitmaps are readable per wallet (no identities or reasons are stored on chain, but presence of a designation is visible). The fund token is non-rebasing by design because Uniswap v4 does not support rebasing balances. A pool's singleton custody is answered by the hook checking the beneficial owner at the boundary. This is a prototype on a local chain with mock USD; it is not legal advice and describes no real counterparty.

## Team

⚠️ To be filled in before submission: names and handles.

## Licenses

Repository code: MIT. `vendor/` (git-ignored, fetched by `npm run vendor`) contains 1inch SwapVM and Aqua under their source-available Degensoft licenses; the router is a modified redeployment as permitted for the hackathon. `contracts/wildcat/IRoleProvider.sol` reproduces Wildcat's MIT-licensed interface.
