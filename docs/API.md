# Stack API, operator API and repository map

## Stack API

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

