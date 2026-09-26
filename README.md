# mirr0tech

**mirr0tech compiles a tokenized asset's legal agreement into the token's issuance rules and the Uniswap v4 hook it trades through.**

An agreement goes in. A deliberation generates its policy: rules, terms and open items, each quoting the sentence it came from, each with a verdict and a confidence. The issuer adds the World ID constraint the agreement asks for, deploys, and the token's pool is live. Every refusal, off chain (`403 POLICY_REFUSED`) and on chain (`LegalClauseViolation(clauseId, policyHash)`), names its sentence.

ETHGlobal Tokyo 2026. Prototype, testnet, mock USD, not legal advice, no affiliation with Uniswap, World, Curvegrid, Stripe, Wildcat, 1inch, Securitize or BlackRock.

**Live:** [legalmirror.github.io/mirr0tech](https://legalmirror.github.io/mirr0tech/) — static dashboard build: the agreement with every enforced sentence, the Sepolia timeline. The gateway is a local or Coolify run.

[![Overview](docs/img/overview.png)](https://legalmirror.github.io/mirr0tech/)

[![Agreement](docs/img/agreement.png)](https://legalmirror.github.io/mirr0tech/agreement)

## The flow from a terminal

`npx mirr0` (`scripts/mirr0.js`) is the front end; every command is one call of the [agreements API](docs/AGREEMENTS_API.md). `test/chain/flow.test.js` runs exactly this on anvil; the same sequence ran on Sepolia ([below](#sepolia)).

```sh
npm run dev:stack &                      # anvil + the stack + the gateway on :3000
npx mirr0 login http://127.0.0.1:3000 local-dev-stack-operator-key-only
npx mirr0 upload test/human_contracts/ea026411904ex10-9.htm --name BUIDL && npx mirr0 show <id> --wait compiled
npx mirr0 constrain <id> --credential document --actions mint,transfer   # the World ID trust decision, in the hash
npx mirr0 deploy <id> --wait                                             # oracle, token, hook, pool
npx mirr0 verify <id> Investor && npx mirr0 fund <id> Investor 10000 && npx mirr0 mint <id> 10000 && npx mirr0 release <id> Investor 5000 && npx mirr0 pool <id> liquidity Investor
npx mirr0 pool <id> swap Stranger                                        # refused, with the sentence
```

What each step prints: `show` — `verified → compiled`, the confidence, the hash; `ast` — agreement → actions → rules → facts, a verdict glyph per node; `constrain` — `identityVerified` under mint and transfer, a new hash; `deploy` — oracle, hook at its mined address, pool id; `explain` before `verify` — refused, `transfer-identity-verified` and the sentence, after — allowed; `pool … swap Stranger` — `POLICY_REFUSED` with the sentence, no transaction; `audit` — every decision with clause and tx. `GET /docs` is the Swagger UI over all of it.

## What it is made of

- **Generation and verification** (`src/noolog/`). A Noolog deliberation (extractor + critic, model `nsed:deep`) proposes rules, terms and open items, each quoting the document verbatim; every claim gets a verdict (`verified | contested | unverified | wrong`), the report a confidence. The AST is validated against the text (schema, every quote a verbatim substring) before it compiles. Without `NOOLOG_API_KEY` an in-process mock serves the same routes.
- **World ID constraint** (`PUT /v1/agreements/:id/constraints`). The issuer picks the credential (`document` for KYC, `proof_of_human`, `selfie`) and the actions (`mint`, `transfer`, `burn`); the rule quotes the sentence that asks for it, the credential goes into the config, both into the hash. `400 QUOTE_NOT_FOUND` when the quote is not in the document.
- **Compiler and hash** (`src/policy/`). Three-valued facts: true, false, unknown; unknown never satisfies, an expired attestation makes every fact unknown. DNF bitmasks per rule, proved equivalent to the JS interpreter over every assignment; `policyHash` over source + AST + config; the clause table's hash committed on chain. Generated Solidity holds constants only; one evaluator (`contracts/PolicyEval.sol`) serves every policy.
- **Per-agreement deploy** (`POST /deploy`, `src/deploy.js`). Solidity compiled at runtime; `PolicyOracle`, `CompiledMirrorToken`, `MirrorPolicyHook` (CREATE2 address mined for its permission bits) and a pool on the canonical v4 `PoolManager`. The hook decides on `beforeAddLiquidity`, `beforeRemoveLiquidity`, `beforeSwap`; a transient handshake makes it the token's only door: a hookless pool initializes, its first deposit reverts at the token (`NoPolicyDoor`).
- **Payments in** (`POST /webhooks/payments`). Stripe-signed (`Stripe-Signature`, HMAC over `t.body`, 5-min tolerance), no bearer. A settled USD event with `metadata.wallet` attests `depositConfirmed`; the policy decides the mint: shares released, or **held** with the sentence. Idempotent by event id; always 2xx once verified, so the rail never retries a decision.
- **Key custody** (`PUT /v1/settings/signing`). The gateway starts on a file key; `{ provider: "multibaas", azure, key }` registers the Azure Key Vault key with MultiBaas, hands the operator roles and gas to the Cloud Wallet and signs from it thereafter; the choice persists across restarts. Proven on anvil with a stand-in vault.
- **Indexing** (`src/multibaas.js`). Every contract registered with MultiBaas under a policy-hash version; `GET /v1/stack/events` serves the indexed events behind the audit.
- **API contract.** `GET /openapi.json` (OpenAPI 3.1) and `GET /docs` (Swagger UI), both open, no bearer.
- **Dashboard** (`dashboard/`). Next.js; the clause highlighter maps every paragraph to what it compiled to and walks a rule from quote to DNF to bytes to contract.

Routes: [docs/AGREEMENTS_API.md](docs/AGREEMENTS_API.md) (the flow), [docs/API.md](docs/API.md) (stack, webhook, custody, repository map), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PRD.md](docs/PRD.md).

## Sepolia

The base stack and one agreement's own deployment run on Sepolia against the canonical `PoolManager`; `deployments/sepolia.json` is the record (`DEPLOYMENT_PATH=deployments/sepolia.json npm run dev:stack` serves it without redeploying). Policy hashes are the same bytes as the local build. MultiBaas: 13 contracts registered, 10 linked and indexed under the dev plan. Not yet on Sepolia: an HSM-signed transaction (no Cloud Wallet on the dev MultiBaas deployment; proven on anvil).

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
| PolicyOracle (credit) | [`0x0d1Bf438432997f0ccd18E80B45510d7064389cD`](https://sepolia.etherscan.io/address/0x0d1Bf438432997f0ccd18E80B45510d7064389cD) |
| MirrortechRoleProvider | [`0x91f3F5c3d452C0F53319387AcdF311Cc4d28a76F`](https://sepolia.etherscan.io/address/0x91f3F5c3d452C0F53319387AcdF311Cc4d28a76F) |
| MockWildcatMarket | [`0x172a0577Be38DE23a91274e149957e8d109daB44`](https://sepolia.etherscan.io/address/0x172a0577Be38DE23a91274e149957e8d109daB44) |
| MirrortechRouter (SwapVM + PolicyGuard) | [`0x71b61324b041c8469602dB051Fea7534024fe0f6`](https://sepolia.etherscan.io/address/0x71b61324b041c8469602dB051Fea7534024fe0f6) |
| 1inch Aqua (canonical) | [`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`](https://sepolia.etherscan.io/address/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) |

One agreement through the whole flow on Sepolia, from the CLI (`agr_1b8a5c438bb1`, policy `0xf16e378c…`, constraint: document credential on mint and transfer): PolicyOracle [`0x86d395Ce77889AdfC129647c7FA1f8e94A54b207`](https://sepolia.etherscan.io/address/0x86d395Ce77889AdfC129647c7FA1f8e94A54b207) · CompiledMirrorToken [`0xD29Da36A18A24895dB595d9AEdde43F26a3B91dE`](https://sepolia.etherscan.io/address/0xD29Da36A18A24895dB595d9AEdde43F26a3B91dE) · MirrorPolicyHook [`0x326B840E25bdf27B16da9e4619741c691Ec4CA80`](https://sepolia.etherscan.io/address/0x326B840E25bdf27B16da9e4619741c691Ec4CA80) · pool `0xc0f46419…` on the canonical PoolManager.
[oracle](https://sepolia.etherscan.io/tx/0x570f2dc8e60367a47d8962973c968461685b53f0b503ca9406c379e22eef2a71) · [token](https://sepolia.etherscan.io/tx/0x412d8f2e80e6f696774e6dcfca1c743e30494df713ccc15216ccf797180846f5) · [hook at its mined address](https://sepolia.etherscan.io/tx/0xea934fac812b501abcfa1da0e752203cfaadb3e6d3dde82946d2c2e4ac2a97d8) · [pool initialized](https://sepolia.etherscan.io/tx/0x4b874bbdb139aaeb582fb4c60de1c3897a8ff1e60d8c32cf26d42fb5748e675f) ·
[World ID proof attested](https://sepolia.etherscan.io/tx/0xdf388b7126c413370e3598a7282712278775e6c86f87bc9fbece5c3ce5f092fa) · [shares released](https://sepolia.etherscan.io/tx/0x8cbca868a253007f4dc0ce01890c3aacecca431a7988749e636297c3210f6c6f) · [liquidity through the hook](https://sepolia.etherscan.io/tx/0xa2417ada901ed5fdfefca1d9606f9c80026cb3c1e8332bb5267b1f4f24d1c854) · [swap](https://sepolia.etherscan.io/tx/0x7a8a5f04961153ff52e309e05110fd03996867d10ea192128d8f9ea28717b17e) · the stranger's swap refused with the sentence (`transfer-identity-verified`, no transaction) ·
a signed payment [minted](https://sepolia.etherscan.io/tx/0x515fe4165d9570985482d98f6f4244821dd47e1cf61afb6e6a24736dcab88a4f) and [released 125.50 shares](https://sepolia.etherscan.io/tx/0x42c6907716445d9c4893cae4456f5704cb58366acb3f6f9a7c3afb2790a93099) to the investor; the stranger's payment was held (`subscription-documents`). `deployments/sepolia-agreements.json` is the agreement store (copy it to `generated/agreements-11155111.json` to serve it again) and `deployments/sepolia-agreement-audit.json` its audit.

Golden path on Sepolia, as the audit records it:
[identity verified with a World ID document](https://sepolia.etherscan.io/tx/0xbfa9779df88b5aeb5b7587a5a2ad6368226ebd045757dcd80f0889b57861b748) ·
[shares released to the verified investor](https://sepolia.etherscan.io/tx/0x3baa0a49d05a385f88584ddfd6eb80d12def27226a683811d773171d7704f1cf) ·
[hooked pool created](https://sepolia.etherscan.io/tx/0x168ee3e5a5f60e2c1f4eae9abadcc4a50517af35cf6deec20120a8bdcc3622f3) on the canonical PoolManager ·
[liquidity through the hook](https://sepolia.etherscan.io/tx/0x5c29af26ac59903924890347f0902ee4773d9e8a6f1bc2cb0b304d51a077ad88) ·
[swap](https://sepolia.etherscan.io/tx/0xc315cb93ce6eb203e612a7caf0e55d7d8acbfaef90da73b3fb1870f22d777ad6) ·
[Lender A admitted and deposits](https://sepolia.etherscan.io/tx/0x35f150eb239754991595604735eebdf34cd8bd47ba7597415580b19e12c40c89) ·
[buyback shipped to the canonical Aqua](https://sepolia.etherscan.io/tx/0xf732931467f914badca599ffc884bef8379ccd5e8903ed68b1b24a8ada615c6f) ·
[Lender A fills through SwapVM + PolicyGuard](https://sepolia.etherscan.io/tx/0x5564bf23bfa078e91e1b9178bf78e3e3507db7361abb963e99e7c5444c2f0467).

## How we used World ID

Exhibit A of the fund agreement says onboarding starts with "Know-your-customer (KYC)… checks during onboarding of investors". KYC is an identity check, so the proportionate credential is a **Passport/NFC document** (`issuer_schema_id` 9303), not a proof of human. The issuer locks that choice into the agreement's hash with `mirr0 constrain`; it compiles to the fact `identityVerified`, required to be issued shares and to enter the pool. `src/worldid.js` verifies the proof with World (`POST /api/v4/verify/{rp_id}`, `rp_context` signed server-side), accepts only the agreement's credential (`WRONG_CREDENTIAL`), refuses a proof whose signal is another wallet (`INVALID_PROOF`), binds the nullifier so one person onboards one wallet (`HUMAN_ALREADY_BOUND`), and attests the fact with an expiry; the hook reads it like any other fact. `mirr0 verify --proof file.json` posts an IDKit result; without `WORLD_RP_ID` a mock proof runs every path. Trust moment, credential choice, alternative paths and the integration debrief: [docs/WORLD_ID.md](docs/WORLD_ID.md).

## How we used Noolog

New to Noolog? [docs/NOOLOG.md](docs/NOOLOG.md): what it is, the docs MCP server (`.mcp.json` wires it into this checkout), the API and SDK links.

The policy is generated by a deliberation, not by one model call. `src/noolog/extract.js` posts the document (and the hand-authored reading as a draft) to Noolog's chat-completions endpoint (model `nsed:deep`); the answer is the winning proposal, the `x-nsed-session-id` header names the job, and `GET /deliberation/{job}/details` + `/references` give every claim its verdict, the evaluators' counter-positions on contested items, the convergence and a confidence per rule, term and open item. That report is `verification` on every record and export: `mirr0 show` prints the confidence, `mirr0 ast` a glyph per node, the dashboard the counts, contested items and every claim under its sentence. Without `NOOLOG_API_KEY` the in-process mock (`src/noolog/mock.js`) serves the same routes, status codes and schemas (checked against `noolog-wire` and `quorum-rs`) with a mechanical critic: a quote not in the text is wrong, one that repeats or is too short is contested, an open item is unverified. `test/noolog.test.js` runs the loop over HTTP: a forged quote is refuted and dropped from the generated policy.

## How we used Curvegrid MultiBaas

`src/multibaas.js` uploads every contract's ABI and bytecode under a label and a policy-hash version (`policy-<hash8>`), aliases and links each address (`attestor`, `fund_hook`, …), so MultiBaas indexes the attestor's `Attested`/`Revoked`/`Overridden`, the hook's `PolicyChecked` and the credit venue's events; `GET /v1/stack/events` serves them and the audit reads that. `node scripts/multibaas-sync.js deployments/sepolia.json` registered the Sepolia deployment (13 contracts; the dev plan links 10 and indexes from the link, `MULTIBAAS_STARTING_BLOCK`). `src/multibaas-signer.js` is the operator key in a vault: the gateway signs attestations, mints and deploys through a MultiBaas Cloud Wallet (`/chains/ethereum/hsm/submit`); only the signature leaves the HSM. The issuer configures it in the platform: `PUT /v1/settings/signing` takes the Azure Key Vault account and key (or an existing Cloud Wallet), hands the operator roles and gas to it, and the gateway signs from the vault from then on ([docs/API.md](docs/API.md), Key custody). The dev deployment has no HSM wallet yet, so this is proven on anvil with an unlocked account standing in for the vault (`test/chain/signing.test.js`); `test/multibaas.test.js` and `test/multibaas-signer.test.js` cover the client against a fake.

Feedback: `createContract` / `setAddress` / `linkAddressContract` is the right granularity for a compiler that emits versioned contracts; we missed a supported-chain check and an idempotent upsert for re-syncs.

## Also in the repo

**The credit venue.** The [Wildcat template MLA](https://docs.wildcat.finance/legal/master-loan-agreement), an illustrative Lender Check Policy and a one-clause buyback addendum (`test/human_contracts/`) compile through the same compiler into a Wildcat `IRoleProvider` (`contracts/MirrortechRoleProvider.sol`: `getCredential` admits lenders, `mayWithdraw` re-checks at payment) and a 1inch Aqua strategy whose SwapVM program carries the agreement as an opcode (`contracts/swapvm/`: `PolicyGuard` evaluates maker and taker at every fill and at `quote()`). Built, tested (`npm run test:chain`) and deployed on Sepolia against the canonical Aqua (addresses and the last three golden-path links above); out of the demo flow. [docs/SWAPVM_INTEGRATION.md](docs/SWAPVM_INTEGRATION.md) · [docs/MLA_CLAUSE_MAP.md](docs/MLA_CLAUSE_MAP.md) · `npm run demo:golden` runs it with the fund flow on a fresh anvil.

## Run it

Node 18+ and [Foundry](https://getfoundry.sh) (`anvil`). Everything runs locally.

```sh
npm ci && npm run vendor                                           # vendor/ ← 1inch SwapVM + Aqua sources (credit venue)
npm run build && npm run build:secondary && npm run build:credit   # artifacts/<profile>/
npm run dev:stack                                                  # anvil + base stack + gateway on PORT (default 3000; Compose 3200)
npm run check                                                      # unit + chain tests; test/chain/flow.test.js is the flow
```

`.env.example` lists every setting; all optional locally: `NOOLOG_API_KEY` (mock deliberation without), `WORLD_RP_ID` + `WORLD_RP_SIGNING_KEY` (mock proofs without), `MULTIBAAS_URL` + `MULTIBAAS_API_KEY` (indexing, Cloud Wallet), `PAYMENT_WEBHOOK_SECRET` (the webhook answers `503 NO_WEBHOOK_SECRET` without it), `RPC_URL` + `DEPLOYER_PRIVATE_KEY` + `DEPLOYMENT_PATH=deployments/sepolia.json` to serve Sepolia.

Dashboard: `npm --prefix dashboard run dev` serves http://localhost:3100 on exported data; with `NEXT_PUBLIC_GATEWAY_URL` and `NEXT_PUBLIC_GATEWAY_KEY` it runs live against the gateway ([dashboard/README.md](dashboard/README.md)). Deploy: `deploy/` is a Coolify-shaped Compose stack (`anvil` + `api` + `dashboard`), [docs/deploy.md](docs/deploy.md); `.github/workflows/pages.yml` publishes the static dashboard to GitHub Pages on every push.

## Limits

Screening, countersignature, AML/KYC and solvency are attested, not proved; a policy hash is no evidence that anyone was screened correctly. The sanctions oracle is a mock with the real interface (so is the credit venue's Wildcat market; the real one is mainnet-only). Fact bitmaps are readable per wallet. The token is non-rebasing because Uniswap v4 has no rebasing balances. Not legal advice; no real counterparty.

## Team

⚠️ To be filled in before submission: names and handles.

## Licenses

Repository code: MIT. `vendor/` (git-ignored, fetched by `npm run vendor`) holds 1inch SwapVM and Aqua under their source-available Degensoft licenses; the router is a modified redeployment as the hackathon rules permit. `contracts/wildcat/IRoleProvider.sol` reproduces Wildcat's MIT-licensed interface.
