# mirr0tech

**mirr0tech turns a legal agreement for a real-world asset into the smart contracts that enforce it.**

Upload the agreement. mirr0tech extracts every rule with a verbatim quote, compiles the rules into Solidity, proves the compiled logic equals the reading, and deploys a permissioned token and a Uniswap v4 hook. Every on-chain refusal names the clause it enforces.

ETHGlobal Tokyo 2026. Prototype, mock USD, not legal advice, no affiliation with Uniswap, Securitize or BlackRock.

**Frontend:** [legalmirror.github.io/mirr0tech](https://legalmirror.github.io/mirr0tech/) · **Backend:** [mir-api.peeramid.xyz](https://mir-api.peeramid.xyz/health). GitHub Pages serves the static workbench; the HTTPS API runs separately on Coolify. The frontend connects automatically to a quota-limited, anonymous demo workspace, so no API keys are needed.

[![Overview](docs/img/overview.png)](https://legalmirror.github.io/mirr0tech/)

[![Agreement](docs/img/agreement.png)](https://legalmirror.github.io/mirr0tech/agreement)

## The problem

Tokenizing a real-world asset is expensive, and most of the cost is people translating legal documents into code:

- Platforms charge **$50,000 to $100,000 upfront**; Securitize's minimum engagement sits in that range.
- A **$1M–$5M raise costs $75,000–$200,000 in total**; above $25M it can exceed $1M. Some platforms also take 6–10% of the raise plus a token allocation.
- **Legal counsel is extra**: $30,000–$75,000 for a Reg D 506(c) offering, $100,000–$150,000 for Reg A+.
- **Ongoing fees continue after issuance**: $5,000–$25,000 a year for a digital transfer agent, plus commissions on secondary trading.

Source: [Tokenization platform fees](https://tokenizestartup.com/platforms/tokenization-platform-fees/).

Only a handful of incumbent platforms can do this work today, because each deal needs paralegals to read the agreement and engineers to hand-write the contracts. Institutions and small businesses that hold high-value physical assets (a company holding graded Pokémon cards, for example) are priced out.

## The solution

mirr0tech replaces that manual translation:

1. **AI reads the agreement.** A [Noolog](docs/NOOLOG.md) deliberation between several models (Astra, Fable and GPT-OSS-Safeguard) proposes the rules. Each rule must quote the document verbatim, and the models cross-check each other's claims.
2. **The rules become an abstract syntax tree (AST).** The AST is the backend's source of truth: the API, the dashboard and the compiler all read it.
3. **The AST compiles to Solidity** and deploys on chain as a permissioned token and a Uniswap v4 hook.
4. **Formal verification stops hallucinations reaching the chain.** The compiler checks that the on-chain logic matches the reference interpreter on every possible input, and refuses to emit contracts otherwise. A quote that isn't in the document is rejected, and a human approves the policy before it's frozen and hashed on chain.

**Why now:** LLMs can finally read long legal text reliably enough to propose rules, and formal verification makes it cheap to check every proposal mechanically instead of trusting it.

The LLM only proposes. It never runs at transaction time: the chain enforces a frozen, hashed policy, and changing one word of the agreement changes the hash.

## The demo

The Securitize/BlackRock transfer-agent agreement compiles into a permissioned fund token and a Uniswap v4 hook.

1. The issuer uploads the agreement. The workbench shows each clause next to the rule it produced.
2. The issuer chooses which actions require a verified identity (for example `mint` and `transfer`) and which World ID credential counts.
3. The token and hook deploy. Shares mint to custody.
4. An investor verifies with World ID. Shares release to their wallet, and they can add liquidity and swap through the hooked pool.
5. Anyone may create a pool, but a pool without the hook can't take the token (`NoPolicyDoor`). A stranger in the hooked pool is refused with *"Exhibit A — Investor Onboarding"* quoted.

## How we used World ID

**The event that needs trust:** a wallet receiving newly issued fund shares, or trading them. The agreement's Exhibit A says only onboarded investors may hold the fund, so before shares leave custody the chain needs evidence that a real, document-verified person stands behind the receiving wallet.

**Why the document credential is the minimum sufficient assurance:** the agreement requires identity documents at onboarding, so a passport-backed credential (`passport` preset, credential 9303) matches that requirement without disclosing the investor's name, number or nationality. The issuer can choose a lighter credential (`proof_of_human`, `selfie`) for agreements that only need uniqueness or liveness. The choice is the issuer's and is bound to the policy hash.

**How it works:**

- **The issuer sets the permissions.** When constraining an agreement, the issuer picks the credential and the actions that require it, from `mint`, `burn`, `transfer`, `deposit` and `withdraw`. Each choice becomes an `identityVerified` rule in the policy, quoting the clause it enforces (`src/agreements.js:196-215`).
- **The investor proves it.** IDKit requests that credential for the investor's wallet. `src/worldid.js` accepts only a matching, server-validated v4 result, then attests `identityVerified` for that wallet on chain. The nullifier is scoped per action, and the signal binds the proof to the wallet.
- **The chain enforces it.** Every share movement asks the compiled policy first: `MirrorToken._update` checks the receiving wallet (`contracts/MirrorToken.sol:117`), and the hook checks every liquidity change and swap.

**The two paths:**

1. **Verified investor:** proves with World ID, then receives newly issued shares and trades them through the hooked pool.
2. **Ineligible wallet:** has no World ID proof. Issuing shares to it reverts with `TransferRefused`, and its swap is refused before a transaction exists, quoting the clause (`transfer-identity-verified`). Cancelled, wrong-credential and rejected proofs create no fact, so they end on the same refusal.

A World ID credential proves one onboarding condition. It is not a full KYC, AML, sanctions or accreditation decision; those facts stay separate in the policy.

**Login:** the dashboard itself opens with World ID (`src/world-login.js`, [docs/WORLD_LOGIN.md](docs/WORLD_LOGIN.md)): mock by default, sandbox session proofs or staging simulator proofs by `WORLD_LOGIN_MODE`. Login proves a person, not a document; the wallet document check above stays separate.

**Status:** the Sepolia attestations below come from mock proofs. A live World Sandbox proof has not been demonstrated yet.

**Integration debrief.** Friction: IDKit needs an explicit preset and legacy (v3) policy; the RP context must be signed on the server; the v4 verify endpoint can return HTTP 200 with failed proof items inside, so status codes alone can't be trusted; the signal is optional in the SDK but mandatory for a wallet-bound gate. The one improvement with the greatest impact would be a complete server-side example that validates the per-credential result, the wallet signal, cancellation and retry, and durable nullifier binding. Time to first live success: not yet measured. Full trust boundaries: [docs/WORLD_ID.md](docs/WORLD_ID.md).

## How we used Uniswap v4

- **`contracts/MirrorPolicyHook.sol`** implements `beforeAddLiquidity` (line 113), `beforeRemoveLiquidity` (line 122) and `beforeSwap` (line 131). Each calls `_enforce` (line 140), which evaluates the compiled policy for the beneficiary carried in `hookData`, since `sender` is always the router.
- **The hook is the token's only door into Uniswap.** The hook sets a transient approval; `MirrorToken._update` (`contracts/MirrorToken.sol:106`) consumes it through `consumeApproval` (hook line 98) on every PoolManager transfer. A pool without the hook reverts with `NoPolicyDoor`.
- **Address mining.** `src/policy/hookAddress.js` mines the hook address for its permission bits.
- **Tests** run against the real `PoolManager` on Anvil: `test/chain/hook.test.js`, `test/chain/rwa-pool.test.js`.
- **Deployed** on Sepolia against the canonical PoolManager (addresses below).

Developer feedback: [FEEDBACK.md](FEEDBACK.md).

## How we used Noolog

Choose **Noolog** as the generation for an upload (`generation: "noolog"`, or `EXTRACTOR=noolog` as the default). `src/noolog/extract.js` submits the document to the orchestrator under the `legal_rwa_pro` policy (RwaCounsel, RwaScrivener and RwaCompliance), shows its progress line on the record while the seats deliberate (up to three rounds, about ten minutes each on the full agreement), then reads `/details` and `/references` for the verdicts and a confidence score. What the deployment cannot enforce is moved to `unresolved` before validation, so a live answer always compiles. Demo and OpenAI generations are unchanged. More: [docs/NOOLOG.md](docs/NOOLOG.md).

## How we used Curvegrid MultiBaas

The MultiBaas integration (contract registration under policy-hash versions, event indexing behind `GET /v1/stack/events`, and a Cloud Wallet signer) was built and exercised on Sepolia, but is **not in this branch**: the workspace rewrite removed `src/multibaas.js`, `scripts/multibaas-sync.js` and `src/multibaas-signer.js`. They remain in git history (merge of PR #5).

## How it works

```
document ─► normalize + SHA-256 ─► AST { rules, terms, unresolved }, each with a verbatim quote
         ─► DNF bitmasks per rule ─► equivalence proof vs the JS interpreter (all 3^k assignments)
         ─► policyHash + clause-table hash ─► CompiledPolicy.sol
```

- **Three-valued facts.** A fact is true, false or not established. Unknown never satisfies a requirement, and an expired attestation makes every fact unknown. `contracts/PolicyEval.sol` and `src/policy/evaluate.js` decide identically or the compiler refuses to emit.
- **Provenance on every revert.** `LegalClauseViolation(clauseId, policyHash)` names the clause; the clause table's hash is committed on chain, so a front end can't substitute the sentence.
- **No generated code.** Extraction emits schema-validated JSON; the compiler writes bitmasks into fixed, audited templates.

## Setup and testing

Use **Node.js 22.13+** and **pnpm 10.29.2**. Both packages share `pnpm-lock.yaml`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run vendor
```

Add `OPENAI_API_KEY` to the server's `.env` for file generation. `OPENAI_MODEL` is optional (default `gpt-5.4-mini`, with reasoning disabled and a compact first-pass analysis). Keys are never sent to the dashboard. The **Demo** flow works without a key and uses a deterministic fixture.

```sh
# Terminal 1: persistent workspace API at http://localhost:3000
pnpm run start

# Terminal 2: dashboard at http://localhost:3100
pnpm --dir dashboard run dev
```

Open **http://localhost:3100**, click **Sign in with World ID** to enter with a placeholder account, then choose **Upload a contract**. Mock login is the default (`WORLD_LOGIN_MODE=mock`); no QR code or World credentials are needed. Login sessions persist in SQLite; see [sandbox login setup and boundaries](docs/WORLD_LOGIN.md).

Once signed in:

- **Demo** generates an AST from the bundled BUIDL document, optionally with the NAV addendum.
- **Upload files** accepts `.txt`, `.md`, `.htm`, and `.html` (2 MB per file, 4 MB request). It saves the original files locally, sends normalized text to OpenAI's Responses API using [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), validates a version 2.0 legal-document AST with verbatim citations, hierarchy and clause relationships. The completed record is `analyzed`; its graph and JSON download are available independently of the compiler. PDF is not supported.

Files live in `.data/workspace/uploads/<contract-id>/`; records and ASTs live in `.data/workspace/agreements.json`. Set `WORKSPACE_DIR` to change the directory. Reconnecting or restarting preserves the contracts. Failed generation keeps the files and can be retried with **Regenerate**. The local workspace listens only on loopback; remote public demo hosting remains a separate deployment.

### Sepolia deployment

Uploads and AST generation do not require a blockchain. Server startup never connects to an RPC, starts Anvil, or deploys contracts. Sepolia connects lazily when chain status or deployment is requested. For deployment, configure an existing Sepolia stack:

```dotenv
RPC_URL=https://your-sepolia-rpc
EXPECTED_CHAIN_ID=11155111
DEPLOYMENT_PATH=deployments/sepolia.json
DEPLOYER_PRIVATE_KEY=your-testnet-signer-key
# PRIVATE_KEY is also supported; DEPLOYER_PRIVATE_KEY takes precedence.
```

The server checks that the RPC and deployment record target Sepolia. **Deploy** is enabled when a signer is configured and the contract compiles; it requires explicit confirmation. Without a working testnet connection, uploads and generation still work. World ID and investor operations on the full hosted stack are configured separately; see [deployment instructions](deploy/README.md).

### Validate

```sh
pnpm test
pnpm run check                     # all existing policy, venue, stack and cashier chain suites
pnpm --dir dashboard test
pnpm --dir dashboard run typecheck
pnpm --dir dashboard run lint
NEXT_PUBLIC_GATEWAY_URL=https://mir-api.peeramid.xyz pnpm --dir dashboard run build
```

The static build is written to `dashboard/out/`; serve it with `pnpm --dir dashboard start` on port 3100. The browser URL is public configuration, never a place for `API_KEY` or signing keys.

## Workbench and NAV cashier

The workbench follows upload → AST generation → source-linked analysis → optional Sepolia deployment. Start it with `pnpm start` and `pnpm --dir dashboard dev`. Demo generation runs locally; file generation uses `OPENAI_API_KEY`. Source validation and compiler checks do not imply independent model or legal review.

Opt into **NAV cashier addendum** when uploading the bundled fund agreement. The separately authored demo document supplies NAV, subscription/redemption fees and cap; pool fee and tick spacing are deployment settings. The compiler commits typed constructor parameters to the policy, and the hook/router verify them at deployment. See [cashier setup, API and limitations](docs/CASHIER.md).

```sh
pnpm run build:cashier          # optional standalone artifacts/rwa-cashier
pnpm run test:chain:cashier     # real v4 custom-accounting tests on Anvil
```

The cashier is locally tested, **not part of the existing published Sepolia deployment**. It constrains eligible execution through issuance/redemption backed by available mockUSD reserves; it does not guarantee a pinned AMM price or zero LP losses.

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
- **Programs.** `src/onchain/programs.js` derives opcodes from the vendored `LimitOpcodes.sol`, encodes `[opcode][len][args]`, builds hookless Aqua orders and taker traits. Two positions from one addendum: `BuybackFixedPrice` (A1.1) and `BuybackDutchAuction`, the official `DutchAuctionBalanceOut` between rate and curve, floor to the A1.5 ceiling over the window: a tender offer with the agreement as an opcode.
- **Executed.** `test/chain/swapvm.test.js`, `scripts/demo-golden.js`: `ship` → `quote` → `swap` (`pull`/`push`) → refusals → cap, deadline → `dock`; the auction quotes at open, midway and near close, fills, expires.

Feedback: the instruction/router split made an opcode a 40-line job, and `quote()` running the full program statically is what makes pre-trade compliance possible. Friction: `StaticBalances` cannot follow Aqua-preloaded balances (hence `FixedRateBalances`); the full `Opcodes` router plus anything exceeds EIP-170, so `LimitOpcodes`; contracts are not on npm, so `vendor/`; SDK opcode numbering (44) differs from `release/1.1` (46).

## Legal document extraction

Uploaded documents use GPT-5.4 mini with reasoning disabled through the OpenAI Responses API. The light analysis selects up to 24 key nodes and 12 relationships; it does not cover every clause. `src/legal/ast.js` defines the document AST: sections and clauses, semantic child nodes, typed cross-references, and explicit open questions. The server validates all quote occurrences against the named source file, computes character offsets, and rejects duplicate IDs, missing link targets and cyclic hierarchy. Noolog extraction has been removed. Offline compiler demos still use explicitly labelled deterministic fixtures; existing saved compiler policies can still be read. A legal-document AST does not by itself authorize deployment. The exact bundled fund and complete credit sources now have explicit MVP compiler mappings; see [live document and Sepolia integration tests](docs/LEGAL_AST.md#executable-mvp-test-mappings).

In **Contract-AST**, select a source clause or graph node to trace its relationships. **Focus selection** shows adjacent clauses and the structural ancestors; clear it for the full graph. **Human Language** highlights the selected quote in the normalized source. **Download AST JSON** exports the full AST (including all source documents, hashes, nodes, relationships and open questions), regardless of the current graph filter. Use **Regenerate** on an existing uploaded contract to replace its old extraction. See [the AST format](docs/LEGAL_AST.md).

## Onchain modules

`src/onchain/` contains the blockchain implementation: deployment and RPC connections, venue operations, deployment-key selection, Solidity compilation, policy and cashier encoding, SwapVM programs, hook-address mining, revert decoding, and audit-event mapping. Application HTTP routes and middleware live in `src/routes.js`; document extraction and policy validation remain outside the chain runtime.

The gateway signs with `DEPLOYER_PRIVATE_KEY`, falling back to `PRIVATE_KEY`. There is no wallet-settings or key-handover API. `GET /v1/stack/events` returns the gateway's audit records, not a complete chain index. Sepolia initialization remains lazy and does not block workspace startup.

## Dashboard and API

`pnpm --dir dashboard run dev` serves http://localhost:3100. Connect the workbench to `pnpm start`; do not put an operator key in `NEXT_PUBLIC_*`. The default view links clause cards to the AST graph and supports actual uploads, analysis, constraints and deployment. The previous overview and classic lender, exit and audit routes remain available. [Dashboard setup](dashboard/README.md) · [API](docs/API.md).

## Deploy

For a standalone Coolify API resource, use [deploy/Dockerfile.api](deploy/Dockerfile.api) and the exact settings in [deploy/README.md](deploy/README.md). Alternatively, `deploy/docker-compose.remote.yml` runs API + dashboard against external Sepolia RPC, with no Anvil service. The local Compose pair is development-only. [Detailed deployment and World configuration](docs/deploy.md). `.github/workflows/pages.yml` publishes GitHub Pages on every push to `main`.

### The flow from a terminal

```sh
# Keep Terminal 1's local dev:stack process above running; use Terminal 3 for these calls.
node scripts/mirr0.js login http://127.0.0.1:3000 local-dev-stack-operator-key-only
node scripts/mirr0.js upload test/human_contracts/ea026411904ex10-9.htm --name BUIDL
# Replace <id> with the returned agreement id.
node scripts/mirr0.js show <id> --wait compiled
node scripts/mirr0.js constrain <id> --credential document --actions mint,transfer
node scripts/mirr0.js deploy <id> --wait
node scripts/mirr0.js verify <id> Investor
node scripts/mirr0.js fund <id> Investor 10000
node scripts/mirr0.js mint <id> 10000
node scripts/mirr0.js release <id> Investor 5000
node scripts/mirr0.js pool <id> liquidity Investor
node scripts/mirr0.js pool <id> swap Stranger  # refused, with the clause quoted
```

Each command is one call of the [agreements API](docs/AGREEMENTS_API.md). `GET /docs` serves the Swagger UI.

### Against Sepolia and World Sandbox

Set `RPC_URL`, an authorized `DEPLOYER_PRIVATE_KEY`, a private `API_KEY`, and `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, `WORLD_ACTION`, `WORLD_ENVIRONMENT=sandbox`, `WORLD_CREDENTIAL=document` in the server environment or a local `.env` (never in frontend build variables). Then:

```sh
EXPECTED_CHAIN_ID=11155111 DEPLOYMENT_PATH=deployments/sepolia.json DATA_DIR=.data/sepolia SEED=false npm run dev:stack
```

This reuses the existing contracts and doesn't redeploy. Hosted deployment (Coolify, Docker, GitHub Pages): [deploy/README.md](deploy/README.md), [docs/deploy.md](docs/deploy.md).

## Sepolia

`deployments/sepolia.json` is the record.

| Contract | Address |
| --- | --- |
| PolicyAttestor | [`0xB815feD73361792Ff2116f4BAd47BcAA3EEC28ff`](https://sepolia.etherscan.io/address/0xB815feD73361792Ff2116f4BAd47BcAA3EEC28ff) |
| MockSanctionsOracle | [`0x10A9cd9873AA4e9527694Ac06825e21F068A8859`](https://sepolia.etherscan.io/address/0x10A9cd9873AA4e9527694Ac06825e21F068A8859) |
| mUSDC | [`0x68EBB62f76ee7880d7CC71892ec8e3d25565dC67`](https://sepolia.etherscan.io/address/0x68EBB62f76ee7880d7CC71892ec8e3d25565dC67) |
| PolicyOracle (fund) | [`0x56e6d3CcF611a55BA7C40960C6Ab2497A1FD7fD7`](https://sepolia.etherscan.io/address/0x56e6d3CcF611a55BA7C40960C6Ab2497A1FD7fD7) |
| CompiledMirrorToken | [`0x2092e533cb40e61F7C335898258c9F15A487C963`](https://sepolia.etherscan.io/address/0x2092e533cb40e61F7C335898258c9F15A487C963) |
| MirrorPolicyHook | [`0x8218A26F0f3c145D99f673Fc98A362D83c554a80`](https://sepolia.etherscan.io/address/0x8218A26F0f3c145D99f673Fc98A362D83c554a80) |
| MirrorLiquidityRouter | [`0xdCF15E8b14BA3D38D1b024783F656a79d40015eD`](https://sepolia.etherscan.io/address/0xdCF15E8b14BA3D38D1b024783F656a79d40015eD) |
| Uniswap v4 PoolManager (canonical) | [`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`](https://sepolia.etherscan.io/address/0xE03A1074c86CFeDd5C142C4F04F1a1536e203543) |

**One agreement through the whole flow**, from the CLI (`agr_1b8a5c438bb1`, policy `0xf16e378c…`, document credential required on mint and transfer): PolicyOracle [`0x86d395Ce77889AdfC129647c7FA1f8e94A54b207`](https://sepolia.etherscan.io/address/0x86d395Ce77889AdfC129647c7FA1f8e94A54b207) · CompiledMirrorToken [`0xD29Da36A18A24895dB595d9AEdde43F26a3B91dE`](https://sepolia.etherscan.io/address/0xD29Da36A18A24895dB595d9AEdde43F26a3B91dE) · MirrorPolicyHook [`0x326B840E25bdf27B16da9e4619741c691Ec4CA80`](https://sepolia.etherscan.io/address/0x326B840E25bdf27B16da9e4619741c691Ec4CA80) · pool `0xc0f46419…` on the canonical PoolManager.

[oracle](https://sepolia.etherscan.io/tx/0x570f2dc8e60367a47d8962973c968461685b53f0b503ca9406c379e22eef2a71) · [token](https://sepolia.etherscan.io/tx/0x412d8f2e80e6f696774e6dcfca1c743e30494df713ccc15216ccf797180846f5) · [hook at its mined address](https://sepolia.etherscan.io/tx/0xea934fac812b501abcfa1da0e752203cfaadb3e6d3dde82946d2c2e4ac2a97d8) · [pool initialized](https://sepolia.etherscan.io/tx/0x4b874bbdb139aaeb582fb4c60de1c3897a8ff1e60d8c32cf26d42fb5748e675f) · [World ID attestation (mock proof)](https://sepolia.etherscan.io/tx/0xdf388b7126c413370e3598a7282712278775e6c86f87bc9fbece5c3ce5f092fa) · [shares released](https://sepolia.etherscan.io/tx/0x8cbca868a253007f4dc0ce01890c3aacecca431a7988749e636297c3210f6c6f) · [liquidity through the hook](https://sepolia.etherscan.io/tx/0xa2417ada901ed5fdfefca1d9606f9c80026cb3c1e8332bb5267b1f4f24d1c854) · [swap](https://sepolia.etherscan.io/tx/0x7a8a5f04961153ff52e309e05110fd03996867d10ea192128d8f9ea28717b17e) · the stranger's swap refused with the clause (`transfer-identity-verified`, no transaction) · a signed payment [minted](https://sepolia.etherscan.io/tx/0x515fe4165d9570985482d98f6f4244821dd47e1cf61afb6e6a24736dcab88a4f) and [released 125.50 shares](https://sepolia.etherscan.io/tx/0x42c6907716445d9c4893cae4456f5704cb58366acb3f6f9a7c3afb2790a93099) to the investor; the stranger's payment was held (`subscription-documents`).

`deployments/sepolia-agreements.json` is the agreement store (copy it to `generated/agreements-11155111.json` to serve it again) and `deployments/sepolia-agreement-audit.json` its audit.

## Limits

- Screening, AML/KYC and solvency are attested, not proved. A policy hash is no evidence that anyone was screened correctly.
- The sanctions oracle is a mock with the real interface.
- World ID proofs on Sepolia are mocks so far (see above).
- Fact bitmaps are readable per wallet.
- The fund token is non-rebasing, because Uniswap v4 doesn't support rebasing balances.
- The NAV cashier ([docs/CASHIER.md](docs/CASHIER.md)) is tested locally and not deployed on Sepolia.
- Not legal advice; no real counterparty.

## Team

- **Lam Trinh**: product and pitch. X: [@LamTGlobal](https://x.com/LamTGlobal)
- **Tims Pecerskis**: engineering. X: [@iampeersky](https://x.com/iampeersky)
- **Jseam**: engineering. X: [@henlojseam](https://x.com/henlojseam)

## Licenses

First-party code is released under the [MIT License](LICENSE), including the Solidity the compiler generates.

Third-party code is not covered: dependencies, sources fetched into `vendor/` (git-ignored, via `npm run vendor`) and reproduced interfaces keep their original licenses and notices, as stated in each file's header.
