# Mirrortech

Turn legal documents into a constrained policy AST, then compile that AST into JavaScript policy evaluation and a permissioned Solidity token configuration. This MVP covers custodial real-world asset tokenization: a Node.js REST API controls the minter wallet, holds all tokens on chain, and records each investor's beneficial balance off chain.

## Run the demo

Requires Node.js 18.17+ and npm. The full chain tests also require [Foundry's Anvil](https://getfoundry.sh/anvil/overview).

```sh
npm ci
npm run demo
```

The demo uses the supplied agreement, a **hand-authored AST fixture**, a persistent mock chain, and mock USD settlement. It starts a temporary REST server, demonstrates a policy denial, onboards an investor, confirms a $100 deposit, mints 100 tokens, retries without double-minting, burns 25 tokens, settles a mock $25 withdrawal, and verifies the remaining 75 tokens. It cleans up its temporary state. No API key or LLM call is needed.

To keep the API running:

```sh
cp .env.example .env
# Replace API_KEY in .env with your own local secret (at least 24 characters).
npm run build
npm start
```

The API listens on `127.0.0.1:3000`. All `/v1` endpoints require `Authorization: Bearer <API_KEY>`. `/health` is public. This is an **operator API**, not investor authentication: its bearer token can update mock compliance and settlement results.

## Pipeline and artifacts

```text
HTML / text document
  → normalized text + original and normalized SHA-256 hashes
  → LLM extraction (or explicitly labeled demo fixture)
  → schema and verbatim source-quote validation
  → deterministic compilation
      ├─ JavaScript evaluator + policy data → REST backend
      └─ Solidity configuration → permissioned ERC-20
```

`npm run build` compiles the **sample fixture**, then compiles Solidity. It writes:

| File | Purpose |
| --- | --- |
| `generated/ast.schema.json` | Strict recursive JSON Schema shared with the LLM |
| `generated/ast.json` | Source metadata, extraction provenance, rules and unresolved terms |
| `generated/policy.json` | Executable AST, explicit deployment assumptions and policy hash |
| `generated/policy.mjs` | Standalone JavaScript module exporting `policy` and `evaluate(action, facts)` |
| `generated/CompiledMirrorToken.sol` | Token deployment parameters derived from the compiled policy |
| `artifacts/*.json` | Solidity ABI, bytecode and build metadata |

Generated files are ignored by git and reproducible from source. The API uses the same trusted interpreter emitted into the JavaScript module; it never evaluates LLM-written JavaScript or Solidity. Policy changes require a new deployment and a separate ledger directory in this MVP.

### AST semantics

A rule specifies `action` (`mint`, `burn`, `transfer`), `effect` (`permit`, `require`, `forbid`), a recursive condition (`fact`, `all`, `any`, `not`), exact source evidence, and a rationale. For example:

```json
{
  "id": "funds-received",
  "action": "mint",
  "effect": "require",
  "condition": { "type": "fact", "name": "depositConfirmed" },
  "source": {
    "clause": "2.2",
    "quote": "confirmation of receipt or crediting of funds for such order"
  },
  "rationale": "Mint only after the custodian confirms funding."
}
```

At least one permission must match, every requirement must be satisfied, and no prohibition may match. Missing facts remain unknown, including inside `not`; unknown requirements or prohibitions deny the operation. Decisions include rule traces and source quotations. Duplicate rule IDs, unsupported facts, extra fields, fabricated quotations and source hash mismatches are rejected.

The included Securitize/BlackRock agreement is a **services agreement**, not a complete offering specification. It references missing documents and omits some schedules. The sample AST is an interpreted subset, and records these limitations under `unresolved`. Compilation rejects unresolved terms unless `--demo` is specified. This flag permits local simulation; it does not resolve legal ambiguity. Quote matching establishes provenance, not legal correctness or completeness.

### Live LLM extraction

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env`, then run:

```sh
npm run extract -- test/human_contracts/ea026411904ex10-9.htm generated/candidate.json
npm run compile -- generated/candidate.json test/human_contracts/ea026411904ex10-9.htm examples/demo-config.json --demo
npm run build:contracts
```

Extraction sends the normalized document to OpenAI's Responses API with [strict Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and `store: false`. It validates source citations locally, rejects incomplete/refused responses, and records model provenance. It does not silently fall back to fixture data. Text, Markdown and HTML documents up to 2 MB are supported; PDF/OCR and long-document chunking are not implemented.

Inspect candidate rules and unresolved terms against the document before relying on them. `npm run build` resets the generated policy to the sample fixture; use `npm run build:contracts` after compiling a custom candidate. `npm run extract -- --fixture` generates only the sample AST without calling an LLM.

## Enforcement

| Layer | Enforced behavior |
| --- | --- |
| Policy interpreter | Source-backed permissions, requirements, prohibitions and explanatory traces |
| Backend invariants | KYC/AML approval, clear sanctions, offering compliance, issuance/redemption attestations, accepted subscriptions, confirmed unspent deposits, sufficient investor balance |
| Solidity | Minter role, custody-only mint/burn, no transfers, maximum supply, enabled actions, admin pause and unique operation IDs |

The Solidity contract uses [OpenZeppelin ERC-20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20) and [AccessControl](https://docs.openzeppelin.com/contracts/5.x/access-control). Its immutable policy hash binds it to the same AST and deployment assumptions as the API. The backend validates that hash, the cap, decimals, custody address and signer role at startup. The backend's wallet signs ordinary Ethereum transactions; this version does not use a separate EIP-712 signature relay.

**The contract trusts the minter for off-chain policy facts.** A policy hash is not proof of KYC or a deposit. Off-chain predicates are intentionally enforced in JavaScript; Solidity enforces the subset it can observe. Someone controlling the minter key can bypass backend decisions, within the contract's on-chain limits.

Demo economics are explicit in `examples/demo-config.json`: six decimal places, one token per mock USD, one million maximum outstanding tokens, backend custody and disabled transfers. These are implementation assumptions, not financial terms extracted from the agreement. No real fund shares or assets are issued.

## REST API

Amounts are **positive decimal strings** with up to six fractional digits (`"100.25"`), never JSON numbers. Responses store balances and payment quantities as integer base-unit strings (`"100250000"`). Token operations require an `Idempotency-Key` header; reusing a key with another payload returns `409`.

| Method | Endpoint | Body / purpose |
| --- | --- | --- |
| GET | `/health` | Mode, policy hash and pending recovery status |
| GET | `/v1/policy` | Compiled policy, assumptions and source evidence |
| POST | `/v1/investors` | `{ "name": "Alice" }` |
| GET | `/v1/investors[/:id]` | Investor records and balances |
| PATCH | `/v1/mock/investors/:id/compliance` | Supported boolean attestations listed below |
| POST | `/v1/deposits` | `{ "investorId": "…", "amount": "100" }`; initially pending |
| POST | `/v1/mock/deposits/:id/confirm` | Simulate receipt of USD |
| POST | `/v1/mints` | `{ "investorId": "…", "depositId": "…", "amount": "100" }` |
| POST | `/v1/redemptions` | `{ "investorId": "…", "amount": "25" }`; burn then create withdrawal |
| POST | `/v1/mock/withdrawals/:id/settle` | Simulate paying an already-burned redemption |
| GET | `/v1/deposits[/:id]` | Deposit status and consumed funding |
| GET | `/v1/operations[/:id]` | Pending/confirmed/failed operations and decision traces |
| GET | `/v1/withdrawals[/:id]` | Withdrawal status |
| GET | `/v1/audit` | Local audit events, including policy denials |

Compliance fields are `kycApproved`, `amlApproved`, `sanctionsClear`, `subscriptionAccepted`, `issuerAuthorized`, `offeringCompliant`, and `redemptionAuthorized`. They default to false. KYB and other entity-specific onboarding checks are folded into the mock KYC result. The operator must explicitly set the applicable facts. The fully runnable HTTP flow is in `scripts/demo.js`.

Typical responses: `400` invalid input, `401` bad bearer token, `403 POLICY_DENIED` with failed facts/rules, `409` idempotency/supply/state conflict, and `503 CHAIN_CONFIRMATION_PENDING` for uncertain transaction outcomes.

## Use a real local EVM

KYC and USD settlement remain mocked. EVM deployments and startup are restricted to development chain ID `31337`.

```sh
# Terminal 1: ephemeral local blockchain
anvil --chain-id 31337

# Terminal 2: configure .env using one of Anvil's printed funded development keys
# MINTER_PRIVATE_KEY=<local development private key>
# RPC_URL=http://127.0.0.1:8545
npm run build
npm run deploy

# Copy the printed TOKEN_ADDRESS into .env, and set:
# CHAIN_MODE=evm
# DATA_DIR=.data/local-evm-1
npm start
```

`ADMIN_ADDRESS` can designate a separate admin; it defaults to the local minter. The admin controls pause and role grants/revocations. Custody is fixed at deployment. Never use a public Anvil key for assets. Use a fresh ledger directory for each new deployment; a chain reset with existing ledger balances fails reconciliation. Deployment details are saved to `generated/deployment.json`.

## Persistence and recovery

The local JSON ledger uses a single-writer process lock, atomic replacement and fsync. Operations are serialized. The backend persists an operation intent before signing and saves the transaction hash before waiting for confirmation. Solidity prevents reuse of the operation ID. Deposits are consumed and investor balances credited only after mint confirmation; withdrawals are created only after burn confirmation.

If an RPC result is uncertain or the backend restarts mid-operation, retry the **same endpoint, body and Idempotency-Key**. The backend polls the existing transaction or checks its on-chain operation ID, then commits ledger effects once. Other mutations are blocked until the pending operation is reconciled. A permanently dropped/replaced transaction currently requires operator investigation; automatic fee replacement and cancellation are not implemented. Failed operations need a new key after correcting their cause.

A hard process kill can leave `server.lock` in the data directory. Remove that lock only after verifying its recorded process has stopped. Do not delete ledger state to recover a transaction. The ledger and chain supply are compared before new token operations; external supply changes stop further operations.

## Verification and scope

```sh
npm test             # AST, extraction adapter, API, ledger, concurrency and recovery
npm run build        # Deterministic fixture compilation + Solidity compilation
npm run test:chain   # Starts/stops its own Anvil; tests Solidity and backend signing
npm run check        # All of the above
```

Tests cover policy denials, fabricated evidence, malformed LLM outputs, authentication, exact arithmetic, duplicate requests, concurrent spending, sanctions/KYC revocation, failed payouts, restart recovery, role restrictions, supply caps, paused operations, blocked transfers and policy mismatch. LLM tests mock the provider; live extraction requires credentials and is separate from the test suite.

This is a local prototype. Real deployment still needs document interpretation/review, real compliance and banking adapters, investor authentication, managed signing, a transactional database and reconciliation worker, reorg/finality handling, tamper-resistant audit storage, and smart-contract review. The local audit log is editable by the operator; one-block local-chain confirmation is not a production finality strategy.
