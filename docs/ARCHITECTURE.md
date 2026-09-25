# Architecture — technical implementation

Appendix to [PRD.md](PRD.md) v2. Describes what exists in the repository, what the PRD adds, and the invariants that hold across both. File-level map in §9.

## 1. Principle

**Law is source. Code is a build artifact.** The compiler reads a legal document, produces a policy that is provably grounded in verbatim quotes, and emits *data* — never generated code — that fixed, audited contracts execute.

Three consequences drive every design choice below:

1. **The model never writes code.** LLM output is schema-validated JSON. The compiler converts it to bitmasks and to program bytes drawn from fixed templates. One evaluator contract serves every policy.
2. **Unknown is a value.** Facts are three-valued: true, false, not established. Unknown never satisfies a requirement or clears a prohibition, and it propagates through negation. Missing or expired evidence denies.
3. **Anything the compiler cannot quote, it refuses.** Terms the document leaves open are listed under `unresolved` and block compilation unless `--demo` is passed.

## 2. Pipeline

```text
 documents ─► normalize ─► sha256 (raw + text)
     │
     ▼
 extract ─► AST { rules[], terms[], unresolved[] }        fixture | OpenAI Structured Outputs
     │        each rule/term carries { clause, quote }; quote must be a verbatim substring
     ▼
 validate ─► schema (strict, recursive, additionalProperties:false) · quote check · depth · dedupe
     │
     ▼
 compile
   ├─ rules  ─► NNF ─► DNF ─► (pos, neg) bitmask terms per rule   [src/policy/dnf.js]
   │             └─ equivalence proof vs evaluate.js over all 3^k assignments per rule
   ├─ terms  ─► program template parameters                        [PRD §7.4]
   ├─ clause table ─► { clauseId → ruleId, clause, quote } ─► clauseTableHash
   └─ policyHash = sha256(canonical({ ast, config, factOrder, actionOrder, clauseTableHash, ... }))
     │
     ▼
 emit
   ├─ generated/policy.mjs            off-chain interpreter + data (existing)
   ├─ generated/CompiledPolicy.sol    per-action programs as `bytes` constants + hashes  [src/policy/onchain.js]
   ├─ generated/clause-table.json     decodes a revert to a sentence
   └─ generated/programs/*.bin        SwapVM program bytes per template (to build)
```

### 2.1 AST

Existing: `rules[]` with `action`, `effect ∈ {permit, require, forbid}`, recursive `condition ∈ {fact, all, any, not}`, `source { clause, quote }`, `rationale`.

To add (PRD §7.1): `terms[]` — `{ name, value, unit, source { clause, quote } }`. Same quote validation. Values are decimal strings. Terms are consumed by program templates and by config validation; they never enter the boolean evaluator.

### 2.2 Decision rule (identical off-chain and on-chain)

```
allowed = (∃ permit rule = TRUE) ∧ (∀ require rule = TRUE) ∧ (∀ forbid rule = FALSE)
```

Three-valued: `require` fails on FALSE *or* UNKNOWN; `forbid` fails on TRUE *or* UNKNOWN. The gateway maps this to `approve | review | deny` (PRD §7.2): `deny` if any forbid is TRUE; `review` if not allowed and some relevant fact is UNKNOWN; `approve` otherwise.

## 3. On-chain evaluation

### 3.1 Representation

Each rule's condition is converted to disjunctive normal form. Kleene three-valued logic satisfies De Morgan and distributivity, so NNF→DNF preserves the unknown semantics exactly. A rule becomes a list of terms `(pos, neg)`: facts that must be true, facts that must be false. A fact on both sides is kept — it reads FALSE once known, UNKNOWN until then — which is the correct result.

Runtime state is two words: `known` (which fact bits are established) and `value` (their truth). Bit position = index in `FACTS` (`src/policy/schema.js`); the order is committed inside `policyHash`.

### 3.2 `PolicyEval.sol` (exists)

Pure library. `decide(bytes program, uint256 known, uint256 value) → (bool allowed, uint16 clauseId)`. `program` is `abi.encode(Rule[])` where `Rule { uint8 effect; uint16 clauseId; uint256[] pos; uint256[] neg; }`. Returns the first failing requirement or prohibition, or the first permission when none held (the permission the subject lacks); 0 only for an action with no rules. Gas: decoding ~10 rules is tens of thousands of gas; acceptable for admission and fills; not for hot paths.

### 3.3 `CompiledPolicy.sol` (generated)

Library of constants: `POLICY_HASH`, `CLAUSE_TABLE_HASH`, `FACT_*` bit constants, `ACTION_*` indices, and `program(uint8 action) → bytes` returning the encoded rules for that action. Every venue contract imports it, so a deployment is bound to one document at compile time, not by a constructor argument.

### 3.4 Equivalence proof (exists)

`compilePolicy` replays every rule through `evaluateTerms` (bitmask) and `evaluatePolicy` (tree interpreter) over all `3^k` assignments of the `k` facts the rule mentions and throws on the first disagreement. `test/dnf.test.js` repeats it for whole-policy decisions; `test/chain/credit.test.js` repeats it on a real EVM via `MirrortechRoleProvider.explain` against randomized fact sets for every action. For a finite fact space this exhaustive check *is* the proof; theorem-proving the general NNF→DNF conversion is roadmap.

## 4. Facts: observable vs attested

| Kind | Where it comes from | Who can be wrong | Example |
| --- | --- | --- | --- |
| **Observable** | read on-chain at decision time | the oracle / the market | `sanctionsClear` (Chainalysis oracle, MLA §13), `openTermState` (market) |
| **Attested** | signed into `PolicyAttestor` with an expiry | the attestor | `lenderCheckPassed`, `mlaCountersigned`, `amlKycProvided`, `notInsolvent` |
| **Derived** | computed from attestation state | — | `screeningCurrent` = attestation not expired |

Venue contracts assemble `(known, value)` by taking the attestor's words and OR-ing observable bits on top. **Observable facts never come from the attestor.** This keeps the trust statement precise: the chain proves what it can see; the borrower's compliance function is trusted for the rest, and that trust is time-boxed.

### 4.1 `PolicyAttestor.sol` (exists; changes in PRD §7.3)

- `attest(subject, policyHash, known, value, issuedAt, validUntil)` — `ATTESTOR_ROLE`
- `attestWithSignature(...)` — EIP-712, relayable by anyone; the attestor never needs a hot key
- `revokeFacts(subject, policyHash, bits)` — `WATCHER_ROLE`; **no reason string** (privacy)
- `factsOf(subject, policyHash) → (known, value, issuedAt)` — returns zeros once expired
- `override(subject, policyHash, bits, validUntil)` — `BORROWER_ROLE`, the MLA §13(c)(y) path; logged; expiring (to add)

A fresh `attest` replaces the record, so a borrower override is reset by re-screening — the override lives and dies with the attestation window it was granted in.

**Continuous screening is a property, not a feature.** Expiry zeroes `known`, every fact becomes unknown, the policy denies. Worst-case staleness = the attestation window, which the compiler bounds by the Lender Check Policy's re-screening interval.

### 4.2 Privacy

`factsOf` is public: anyone can read a wallet's fact bitmap. Mitigations now: no identity, no reasons, no free text on-chain; the real MLA already avoids lender personal data. Roadmap: hashed fact commitments with selective disclosure, or a ZK proof of `decide()`.

## 5. Venues

All venues import `CompiledPolicy` and `PolicyEval`, read the same attestor, and revert with the same error:

```solidity
error LegalClauseViolation(uint16 clauseId, bytes32 policyHash);
```

A front end decodes `clauseId` through `clause-table.json` and verifies the table against the on-chain `CLAUSE_TABLE_HASH` before rendering the quote, so the sentence shown cannot be substituted.

### 5.1 Wildcat — `MirrortechRoleProvider.sol` (exists)

Implements `IRoleProvider` from `wildcat-finance/v2-protocol` verbatim (`contracts/wildcat/IRoleProvider.sol`):

- `isPullProvider() → true`
- `getCredential(account) → uint32` — evaluates `ACTION_DEPOSIT`; returns the screening timestamp or 0. Wildcat applies its own TTL on top; the tighter expiry wins.
- `validateCredential(account, data)` — accepts an inline signed attestation and admits in one transaction
- `explain(account, action) → (allowed, clauseId, screenedAt, known, value)` — the audit answer as a view
- `mayWithdraw(account)`, `mayTransfer(account)`

A borrower registers it with `addRoleProvider(provider, timeToLive)` on their hooks contract. No fork, no market change. On Sepolia a `MockWildcatMarket` stands in for the market and calls the real provider interface.

### 5.2 1inch SwapVM — `MirrortechRouter` + `PolicyGuard` + `FixedRateBalances` (exists)

Specified in [SWAPVM_INTEGRATION.md](SWAPVM_INTEGRATION.md). Summary: a guard instruction carrying `policyHash ‖ action` evaluates maker and taker at fill *and* at quote time through `PolicyOracle.decide`; a fixed-rate instruction pins the addendum's price over Aqua's preloaded balances; a `LimitOpcodes` router dispatches both; `src/policy/programs.js` fills the template from `generated/buyback-terms.json`. The strategy ships to an unmodified Aqua registry; the router is a modified SwapVM redeploy, which the track allows.

Hash chain, none of it built by us:

```
document sha256 ⊂ policyHash ⊂ program bytes ⊂ order.data ⊂ orderHash (EIP-712)
```

### 5.3 Uniswap v4 — `MirrorPolicyHook.sol` (exists, handshake built)

`beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap`, all evaluated against `ACTION_TRANSFER` — the agreement has no concept of a swap or a position, only of a transfer, and all three are transfers. Subject comes from `hookData` written by a trusted router (`contracts/test/MirrorLiquidityRouter.sol`) because the pool manager passes the router, not the person, as `sender`. Address mined via `src/policy/hookAddress.js`; constructor rejects any address whose low bits don't match. Tested against Uniswap's own `PoolManager` in `test/chain/hook.test.js`.

**The hook is the token's only door into Uniswap.** `PoolManager` is a singleton, so a token-level allowlist can only block it entirely or admit it wholesale — it cannot see which pool a transfer belongs to. The hook can, because its address is part of the `PoolKey`. Handshake:

1. On a successful check the hook writes `tstore(APPROVED_SUBJECT, subject)` — EIP-1153 transient storage, gone at the end of the transaction.
2. `MirrorToken._update`, for any transfer to or from `PoolManager`, calls `hook.consumeApproval()` (token-only) which returns the subject **and clears it**, so one admitted operation opens the door for exactly one settlement leg; a same-transaction hookless leg finds nothing.
3. A pool created without the hook never sets the flag: `initialize` succeeds, the first settlement reverts at the token. A rogue router that moves tokens through itself fails the subject match — correct, since the hook trusts exactly one router.

Result: anyone may create a pool for the token; only hooked pools can hold it; the issuer publishes one address and never operates a venue. This is the property Act 1 exists to demonstrate.

**Asset class.** The hook is the venue for the **RWA fund token** compiled from the Securitize transfer-agent agreement, not for Wildcat positions: a transfer-restricted fund share is what a permissioned pool is for, and its agreement has an onboarding clause a `transfer` permit can quote. Known limits (stated, not hidden): singleton custody answered by the street-name analogy; adverse selection on passive liquidity is mild for a near-NAV asset; rebasing balances are unsupported by v4, and the token is non-rebasing by design. Scope for any submission is admission plus the handshake — no quota, lockup, fee or LVR claims.

## 6. Component model (built: `src/policy/components.js`)

The compiler is a **resolver** over a library of audited components. Each component declares what it covers, what it needs, and what it emits. Every rule and term must be claimed by a component or it is `unresolved`.

| Component | Covers | Requires | Emits |
| --- | --- | --- | --- |
| `PolicyEval` | boolean rules | — | DNF bitmasks |
| `Attestor` | attested facts, expiry, override | — | deployment |
| `SanctionsOracle` | `sanctionsClear` | — | address binding |
| `WildcatAdmission` | deposit / withdraw / transfer eligibility | `PolicyEval`, `Attestor`, `SanctionsOracle` | role provider |
| `SwapVMBuyback` | exit terms: price, cap, deadline | `PolicyEval`, `Attestor` | program bytes (template) |
| `V4TransferGate` | transfer restriction at a pool | `PolicyEval`, `Attestor` | hook |
| `CustodialToken` | mint/burn under custody (RWA profile) | `PolicyEval` | ERC-20 constructor args |

Rules for components: **parameters, never shape.** A clause fills a slot in a versioned template; it never assembles instructions ad hoc (SwapVM: "instruction order is security-critical"). Component ids and versions go into `policyHash` so the hash names the exact blocks that enforce the document. Each component ships with the **clause template** a lawyer pastes into the agreement to authorize it — the library is half code, half legal text.

Built as `src/policy/components.js`: a registry where each component declares `coversRule`/`coversTerm`, its contracts (with the compiler bundle each needs), an optional config `check`, and its clause template. `resolveComponents(ast, config)` links every rule to an enforcing venue component and every term to a consumer, or throws; `compilePolicy` puts the resolved `{id, version}` list and the coverage map inside `policyHash`, and `scripts/build-contracts.js` builds exactly the contracts the resolved components declare (`generated/components.json`). Profiles are named component sets. `test/components.test.js` proves coverage for every fixture, that an orphan rule or term is a compile error, and that bumping a component version changes the hash.

## 7. Gateway (Node/Express, existing)

Unchanged responsibilities for custodial issuance: operator auth, idempotency keys, operation intents before signing, restart recovery, audit log. **Built for the two-act stack** (`src/venues.js`, `src/venues-api.js`, mounted at `/v1/stack`): attest/revoke/override/sanction, Act 1 mint/release/pool actions, Act 2 deposit/withdraw and the Aqua buyback (ship, quote, fill, dock) with the program disassembled and the hash chain, `explain` for any wallet/action, and an in-memory audit of every action with tx hash or decoded refusal. Refusals are `403 POLICY_REFUSED` with the clause. `scripts/dev-stack.js` runs anvil + deployment + API in one process; `test/chain/gateway.test.js` drives both acts over HTTP. With `MULTIBAAS_URL`/`MULTIBAAS_API_KEY` set on a supported chain, `src/multibaas.js` registers every deployed contract (ABI under a policy-hash version, aliased and linked) and `GET /v1/stack/events` serves MultiBaas-indexed events; locally it serves the in-memory audit.

Wallet separation: deployer/admin · attestor · watcher · borrower-treasury (signs orders) · agent (P1). No wallet holds two roles.

## 8. Deployment

- **Sepolia, one chain, through MultiBaas**: `MirrorToken`, `MirrorPolicyHook` (canonical v4 `PoolManager` is on Sepolia), attestor, role provider, `MockSanctionsOracle`, `MockWildcatMarket`, mUSDC, position token, **Aqua registry redeployed unmodified from `@1inch/aqua`**, `MirrortechRouter` (a modified SwapVM redeploy, which the 1inch rules allow). Deploy, TXM-signed transactions, webhooks and event queries via MultiBaas; verified on Etherscan; addresses in `generated/deployment.json`.
- **Stretch — mainnet fork script**: impersonate a live Wildcat V2 market's borrower and `addRoleProvider` with our provider, to show the integration against a real market. Disclosed as forked; not on the demo's critical path.
- **Local**: anvil via `test/chain/anvil.js`; `npm run test:chain`; `npm run demo:credit`.

Compilers: repository contracts on solc 0.8.37 (`solc`); v4 bundle on 0.8.26 (`solc-v4`) because `PoolManager` pins it; SwapVM pins 0.8.30 — add a `solc-swapvm` alias the same way (`scripts/build-contracts.js` bundles).

## 9. File map

**Exists on `main` working tree (uncommitted as of Sat 01:30 JST)**

| Path | Role |
| --- | --- |
| `src/policy/schema.js` | `FACTS`, `ACTIONS`, AST schema, validation |
| `src/policy/dnf.js` | NNF/DNF, mask evaluation, `buildProgram` |
| `src/policy/onchain.js` | ABI-encode programs, emit `CompiledPolicy.sol`, clause table hash |
| `src/policy/compile.js` | profiles, equivalence proof, `policyHash`, artifact emission |
| `src/policy/mla-fixture.js` | hand-authored fixture quoting the Wildcat template MLA, the Lender Check Policy and the addendum |
| `src/policy/components.js` | component registry, profiles, resolver (coverage, hash-committed component set, build targets, clause templates) |
| `src/policy/programs.js` | SwapVM opcode table (parsed from vendored `LimitOpcodes.sol`), instruction encoders, buyback template, order and taker packing |
| `contracts/PolicyOracle.sol` | fact assembly (attested ∪ derived ∪ observable) and the decision every venue calls |
| `contracts/MockSanctionsOracle.sol`, `contracts/MockWildcatMarket.sol` | Sepolia stand-ins for the Chainalysis oracle and a V2 market |
| `contracts/swapvm/PolicyGuard.sol`, `FixedRateBalances.sol`, `MirrortechRouter.sol` | 1inch venue |
| `test/chain/swapvm.test.js` | ship → quote → fill → refusals → cap/deadline → dock on anvil |
| `test/chain/rwa-pool.test.js` | Act 1: custody → release → hookless pool refused at the token → hooked pool admits/refuses |
| `examples/rwa-secondary-config.json` | `rwa-secondary` profile: the fund agreement with the transfer rules a v4 hook enforces |
| `scripts/vendor.sh` | clones the source-available SwapVM/Aqua sources into `vendor/` (gitignored) |
| `src/deploy.js`, `scripts/deploy-stack.js`, `test/chain/stack.test.js` | one-call deployment of both acts against any RPC; canonical venue addresses via env |
| `src/refusal.js` | revert → clause decoder (unwraps Uniswap's `WrappedError`) |
| `scripts/demo-golden.js` | both acts end to end on anvil — the demo script as a terminal run |
| `src/venues.js`, `src/venues-api.js`, `scripts/dev-stack.js` | operator service and REST routes over the deployed stack; local runner |
| `src/multibaas.js`, `scripts/multibaas-sync.js`, `test/multibaas.test.js` | MultiBaas registration of a deployment (post-deploy on a supported chain) |
| `src/dashboard-api.js`, `test/chain/dashboard-api.test.js` | the dashboard adapter's routes (`/v1/policy*`, `/v1/lenders*`, `/v1/audit`) served live from the stack |
| `dashboard/`, `scripts/export-ui.js` | Next.js dashboard and the export that recomputes PolicyData for it |
| `src/policy/hookAddress.js` | CREATE2 salt mining for v4 |
| `contracts/PolicyEval.sol` | three-valued evaluator |
| `contracts/PolicyAttestor.sol` | facts, expiry, revocation, EIP-712 relay |
| `contracts/MirrortechRoleProvider.sol` | Wildcat `IRoleProvider` |
| `contracts/wildcat/IRoleProvider.sol` | vendored interface |
| `contracts/MirrorPolicyHook.sol` | Uniswap v4 hook (P2) |
| `contracts/test/MirrorLiquidityRouter.sol`, `MockERC20.sol` | v4 test fixtures |
| `scripts/compile.js --mla`, `scripts/build-contracts.js`, `scripts/demo-credit.js` | build + demo |
| `examples/wildcat-config.json` | credit profile config |
| `test/dnf.test.js`, `test/chain/{anvil,credit,hook}.test.js` | proofs and chain tests |
| `test/human_contracts/wildcat-mla.md`, `lender-check-policy.md`, `buyback-addendum.md` | source documents: Wildcat template MLA with an illustrative Term Sheet, the borrower's policy, the addendum |

Builds write `artifacts/<profile>/` so the `custodial-rwa`, `rwa-secondary` and `wildcat-credit` builds coexist; `generated/` holds the last compiled policy.

**To build (PRD §7)**

| Path | Role |
| --- | --- |
| `scripts/deploy-sepolia.js` | deployment + verification |
| `src/orders.js`, gateway routes for lenders/orders/audit | API |
| `dashboard/` | UI |

## 10. Invariants to keep true

1. Same `policyHash` ⇒ same decision, off-chain and on-chain, for every `(action, known, value)`. Enforced by the compile-time proof and the chain test.
2. Unknown never approves. Enforced by `PolicyEval` and `evaluate.js`; tested for negation and contradiction.
3. Expiry never grants. `factsOf` returns zeros after `expiresAt`; time passing can only remove facts.
4. A revert's `clauseId` indexes a table whose hash is on-chain. The UI verifies before rendering.
5. Observable facts are read, not attested. A venue never accepts `sanctionsClear` from the attestor.
6. No generated Solidity, no generated program shapes. Bitmasks and template parameters only.
7. No reasons, identity, or free text on-chain.
8. The fund token cannot reach `PoolManager` except through a pool that ran the hook in the same transaction. Enforced by the transient handshake; tested by the hookless-pool case.
