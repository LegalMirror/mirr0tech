# mirr0tech for Wildcat — Product Requirements (ETHGlobal Tokyo 2026)

| | |
| --- | --- |
| **Status** | **v2** — supersedes v1 (`PRD_v1.pdf`). Decisions are locked unless marked ⚠️. **Sat progress:** G1–G6 built and green on anvil (`npm run demo:golden`); dashboard in progress; gateway endpoints, hosting and submission material open |
| **Owner** | Lam (PM) |
| **Team** | Lam (PM, pitch, legal content, QA) · Eng A (contracts + chain) · Eng B (backend, integrations) · dashboard shared, see §10 |
| **Deadline** | **Sun 27 Sep 2026, 09:00 JST** submission. Internal code freeze **Sun 03:00 JST** |
| **Repo** | `LegalMirror/mirr0tech`, branch `main`. This PRD extends the existing MVP; it does not replace it |
| **Chain** | **Sepolia, one chain.** Official Aqua registry redeployed unmodified from `@1inch/aqua`; our router is a modified SwapVM redeploy — the 1inch rules require official contracts and explicitly allow redeploying a modified SwapVM. Uniswap v4 is canonical on Sepolia. MultiBaas covers every contract. ⚠️ One booth question: confirm the redeployed Aqua registry counts as "official" (it is their code, unmodified). Mainnet fork only as an optional stretch to show a real Wildcat market |
| **Sponsor tracks** | One prize per company. **1inch — Build an Aqua App** (P0) · **Curvegrid — Best RWA Tokenization Project** (P0; ⚠️ or Digital Asset Dashboard, Lam picks) · **third — TBD** (ENS v2 or World ID for Agents, §9) · Uniswap not submitted · Intercepta dropped |
| **Appendices** | [ARCHITECTURE.md](ARCHITECTURE.md) · [SWAPVM_INTEGRATION.md](SWAPVM_INTEGRATION.md) · [MLA_CLAUSE_MAP.md](MLA_CLAUSE_MAP.md) |

> Terms: **MLA** = Wildcat's template Master Loan Agreement. **Term Sheet** = Exhibit A of the MLA, the market's numeric terms. **Lender Check Policy** = the borrower's own document describing its Lender Check Process (the MLA delegates admission to it). **AST** = the structured policy extracted from those documents. **Credential** = Wildcat's on-chain permission for a wallet to deposit. **Role Provider** = the contract Wildcat calls to decide whether to grant a credential. **Borrower** = Wintermute/Selini-style market maker. **Lender** = institution depositing stablecoins.

> ⚠️ **v1 → v2 in one line:** Intercepta is dropped, 1inch SwapVM becomes the primary venue, the Wildcat integration uses the **real** `IRoleProvider` interface instead of a "Wildcat-style" mock hook, and the fact model is re-grounded in the actual template MLA. Full log in §13.

---

## 1. One-sentence pitch

mirr0tech links a tokenized asset's off-chain legal clauses to the on-chain code that executes them through its legal life. It compiles each document into the venue that stage needs: the fund's transfer-agent agreement becomes the token's issuance rules and the Uniswap v4 hook it trades through; when that asset is then lent out under a Wildcat Master Loan Agreement, the agreement becomes the role provider that admits lenders and the 1inch Aqua strategy that gives them an exit — one compiler, one asset, every decision traceable to a verbatim clause.

## 2. Problem

A tokenized asset's legal documents govern its whole life — who may hold it, where it may trade, on what terms it may be lent — and almost none of that reaches the chain. The translation from clause to contract lives in someone's head and a spreadsheet, so the chain enforces an allowlist, not the agreement. Two stages, two failures:

**Stage 1 — issue and trade.** A fund's transfer-agent agreement (the Securitize/BlackRock type) says who may hold its shares and what onboarding they must clear. On chain that becomes a custodial ledger and a hand-maintained allowlist. Putting the token in a pool would breach the agreement, so counsel says no, and tokenized funds holding billions in primary issuance trade with negligible secondary volume. The paper is why, and the paper is what nobody has compiled.

**Stage 2 — lend it out.** Market makers borrow from institutional lenders through **Wildcat**, an undercollateralized private-credit protocol. Each market is governed by the off-chain **MLA**, which explicitly delegates lender admission to an on-chain **Role Provider** running a borrower-defined **Lender Check Process** (MLA §1). Today that delegation is manual:

1. **Manual lender checks.** The borrower's compliance team runs the Lender Check Process by hand, then grants the credential on-chain by hand.
2. **Point-in-time screening.** A lender screened at onboarding is never re-screened unless someone remembers.
3. **Payout risk.** Withdrawals go out without a fresh eligibility check at the moment of payment.
4. **No compliant exit.** A lender in a Fixed Term or a delinquent market is stuck: MLA §12 permits transferring the position only to a wallet holding a valid Deposit Credential, and no venue enforces that, so no venue exists. Positions that could legally trade, don't.

**Common root, both stages.** Nothing proves which clause justified which on-chain action; the link is a person. Reconstructing "why was this wallet allowed, paid, refused or blocked" takes days. And because the enforcement is a list rather than the agreement, it cannot tell the difference between *not permitted* and *not yet checked* — so it either over-admits or over-blocks, silently.

**Who feels it:** the issuer's transfer agent and counsel (stage 1); the borrower's legal & compliance team, lenders who want out, and the borrower's treasury — cheaper capital when lenders have an exit (stage 2).

> ⚠️ **Lam to confirm before the pitch:** which named firms have run Wildcat markets, and a rough "time to onboard one lender today" figure. Present them as **target customers**, never as partners.

## 3. Goals, non-goals, success criteria

**Goals (hackathon) — one asset, two phases**

*Phase 1 — Tokenize and trade it (Securitize agreement → token + Uniswap v4)*

- G1. Compile the Securitize/BlackRock transfer-agent agreement (already in the repo) into the permissioned fund token and issue it to onboarded investors. This is the existing MVP; it runs today.
- G2. Compile the **same agreement** into the Uniswap v4 hook, and make the hook the token's **only door into Uniswap**: anyone may create a pool for the fund token, but only pools carrying the policy hook can hold it. A pool created without the hook is inert (adding liquidity reverts at the token); in a hooked pool an onboarded investor adds liquidity and swaps and a stranger is refused quoting "Exhibit A — Investor Onboarding". Permissionless liquidity under a permissioned agreement. Needs the custody-model change and the hook↔token handshake (§7.3), ~5–7h total.

*Phase 2 — Lend it out (Wildcat MLA → role provider + Aqua exit)*

- G3. Compile the **real Wildcat template MLA** + Term Sheet + a short borrower **Lender Check Policy** into a source-quoted policy, with the proof that the on-chain evaluator decides identically to the off-chain one.
- G4. Admit, deny and re-screen lenders on **Sepolia** through a contract implementing Wildcat's **real `IRoleProvider`**, called by a minimal mock market, with hybrid human approval for unknowns and no override for prohibitions.
- G5. **Lender exit on 1inch Aqua**: the borrower *ships* a buyback strategy — capital stays in its wallet — whose program contains the compiled MLA as an instruction; an admitted lender fills it; an unadmitted wallet is refused at **quote time** with the clause quoted.
- G6. Payment-time eligibility: withdrawals re-evaluated at the moment of payment (`mayWithdraw`), not at onboarding.
- G6b. **P1, the link:** the market's loaned `Asset` is the Phase-1 fund token itself, so the borrower must be admitted under the fund's agreement to borrow it and two policies stack on one transfer. Attempt only if G5 is green by Sat 18:00 (needs policy-gated transfers on `MirrorToken`, ~3h). P0 lends mUSDC.

*Both*

- G7. A compliance **dashboard** showing policy ↔ clause, approval queue, investors and lenders, exits, and the audit stream.
- G8. Meet every hard requirement of the selected sponsor tracks (§9).

**Non-goals (explicitly out of scope)**

- Deploying a real Wildcat V2 market on Sepolia. We ship a **minimal mock market** whose `deposit()` calls our real role provider, and we label it as such. (Stretch: a mainnet-fork script registering the provider on a real market by impersonating its borrower.)
- Real KYC/KYB providers, real screening vendors, real fiat or funds. Mock USDC only.
- Interest accrual, penalty APR, delinquency and default state machine (roadmap).
- PDF/OCR ingestion, long-document chunking, legal correctness guarantees.
- Investor/lender self-service auth. The API stays an **operator API**.

**Demo success criteria (must all be true at freeze)**

- [ ] Golden path in §4 runs on Sepolia from the dashboard in < 5 minutes, with no terminal, both acts.
- [ ] Act 1: one investor minted and pooled; one stranger refused at the pool with the clause on screen.
- [ ] Act 2: one **denied** onboarding, one **held** payout, one **refused** exit fill — each with the clause quote.
- [ ] `quote()` on the Aqua strategy reverts for an unadmitted taker **before any transaction is sent**.
- [ ] Every sponsor checklist item in §9 is ticked for the tracks we submit to.
- [ ] Public GitHub repo, README complete, demo video uploaded, live demo URL works.

## 4. Demo script (the golden path)

This is the spec. If a feature doesn't show up in this script, it's P1 or lower. One asset, start to finish.

**Act 1 — Tokenize and trade (Securitize agreement)**

| # | Screen | What happens | Sponsor shown |
| --- | --- | --- | --- |
| 1 | **Policy** | Officer opens the Securitize/BlackRock transfer-agent agreement. **Compile** → rules with clause and highlighted quote, `policyHash`, unresolved terms, equivalence badge | — |
| 2 | **Issue** | Investor onboarded (KYC/AML/sanctions attested), deposit confirmed → **mint** to custody. Un-onboarded investor → denied with the clause. (Existing MVP flow) | Curvegrid |
| 3a | **Trade** | **Deploy hook** from *this* `policyHash` (address mined so its low bits declare its permissions). A **random wallet** creates a fund-token/USDC pool with the hook. Works — nobody asked the issuer | Uniswap (if third slot) |
| 3b | **Trade** | The same wallet creates a pool **without** the hook. `initialize` succeeds; the first `addLiquidity` **reverts at the token**: *no policy, no door.* | Uniswap |
| 3c | **Trade** | In the hooked pool: onboarded investor adds liquidity and swaps → ok. Stranger tries → `LegalClauseViolation`, UI renders "Exhibit A — Investor Onboarding". *"The issuer published one hook address. Every pool the world creates under it enforces the prospectus; every pool without it is inert."* | Uniswap |

**Act 2 — Lend it out (Wildcat MLA)**

| # | Screen | What happens | Sponsor shown |
| --- | --- | --- | --- |
| 4 | **Policy** | Switch document: Wildcat template MLA + "Demo MM Ltd" Term Sheet + Lender Check Policy + buyback addendum. **Compile** → rules, terms, `policyHash`, unresolved list. *Same compiler, different paper.* | — |
| 5 | **Policy** | **Deploy** via MultiBaas: attestor, role provider, mock market registering the provider, Aqua registry (official code), mirr0tech router. Policy hash on-chain | Curvegrid |
| 6 | **Lenders** | *Lender A*: operator attests the Lender Check Process facts → **auto-approved**; `getCredential(A)` returns a timestamp; A deposits → succeeds | — |
| 7 | **Queue** | *Lender B*: `mlaCountersigned` unknown → **review**; officer ticks the attestation → credential issued | — |
| 8 | **Lenders** | *Lender C*: mock Chainalysis oracle flags C → `forbid` → **denied, no override**; C's deposit reverts | — |
| 9 | **Exit** | Borrower treasury **ships a buyback strategy to Aqua**: buy position tokens at 0.96, up to N, deadline. No USDC moves. Program shown: `Deadline · PolicyGuard(policyHash) · LimitSwap · InvalidateTokenIn`; `strategyHash` shown | 1inch |
| 10 | **Exit** | Lender A **Quote** → price. **Fill** → Aqua `pull`s USDC from the borrower's wallet to A, `push`es position tokens to the strategy. Hash chain: `document → policyHash → program → strategyHash` | 1inch |
| 11 | **Exit** | Stranger **Quote** on the same strategy → reverts `LegalClauseViolation`; UI renders MLA §12(b) and the Token Transferability clause | 1inch |
| 12 | **Lenders** | Officer revokes A's `sanctionsClear`. A's next **Quote** reverts; `mayWithdraw(A)` → blocked, citing §13. Nothing redeployed; the strategy simply stopped filling. Borrower `dock()`s to show the bid is revocable | 1inch |
| 13 | **Audit** | Timeline of every decision across both acts, served by **MultiBaas event queries** (`Attested`, `Revoked`, `CredentialDecision`, `PolicyChecked`, fills), each row expandable to rule trace + clause quote + a **MultiBaas transaction-explorer** link. Close: change one word in either document → new `policyHash` → the hook and the strategy no longer apply. *"Every on-chain action is traceable to a sentence in the contract."* | Curvegrid |

P1 beats slotted in if ready: **G6b** — the market's `Asset` is the Act-1 fund token, so the borrower is checked against *both* agreements when it draws; **third-slot option A, ENS** — subname `lender-a.credit.<borrower>.eth` at step 6 with `mirr0tech.status` records, flipped to `suspended` at step 12; **third-slot option B, World ID for Agents** — at step 12 the payout agent holds A's payment and requests a fresh human verification from the borrower's officer before the §13(c)(y) override can be applied; show the denied/expired path where the payment stays held.

## 5. Users & key user stories

| As a… | I want to… | So that… | Priority |
| --- | --- | --- | --- |
| Compliance officer | upload the MLA and see each executable rule next to the clause it came from | I can check the machine's reading before anything goes live | P0 |
| Compliance officer | have clean lenders auto-approved and only unknowns queued for me | my time goes to edge cases | P0 |
| Compliance officer | never be able to approve a sanctioned wallet | a mis-click can't become a legal breach | P0 |
| Lender | sell my position to an admitted buyer before the withdrawal cycle allows | I have an exit with a price instead of a queue | P0 |
| Borrower treasury | stand a buyback bid without parking capital | lenders accept a lower rate because they can leave | P0 |
| Treasury ops | have withdrawals screened at the moment of payment | we never pay a newly sanctioned wallet | P0 |
| Auditor / counterparty | see why any wallet was allowed, paid, refused or blocked | we can answer regulators in minutes | P0 |
| Lender | get a human-readable identity showing my status | counterparties verify me without seeing my data | P1 |
| Compliance officer | revoke a lender and have credential + ENS status update together | state never drifts across systems | P1 |

## 6. Solution & architecture

Full detail in [ARCHITECTURE.md](ARCHITECTURE.md). Summary:

```text
 MLA + Term Sheet + Lender Check Policy (Markdown)
   │
   ▼
 [Extract]  fixture (default) | OpenAI (live)   — source-quote validation, unresolved → refuse
   │
   ▼
 [Compile]  AST → DNF bitmasks → equivalence proof → policyHash
   │         emits: policy.mjs · CompiledPolicy.sol · clause-table.json · SwapVM program template
   │
   ├──► PolicyAttestor        facts per wallet, with expiry + revocation        (shared)
   ├──► MirrortechRoleProvider  Wildcat IRoleProvider: getCredential / mayWithdraw / explain
   ├──► MirrortechRouter       SwapVM router + PolicyGuard instruction         (1inch)
   └──► MirrorPolicyHook       Uniswap v4 hook                                  (P2)

 mirr0tech gateway (Node/Express, existing): fact engine · 3-outcome decision · attest/revoke ·
   order builder + signer · audit log · REST for the dashboard
```

One compiler, one evaluator (`PolicyEval.sol`), several venues. The policy never varies the bytecode; it varies two `uint256` words and a program template. The LLM never writes code.

### 6.1 What we keep from the current repo (do not rewrite)

- Document normalization, SHA-256 provenance, verbatim-quote validation, strict AST schema, fail-closed evaluator, LLM extraction with no silent fallback, idempotency/recovery/audit in the service layer.
- **Already built on `main` working tree (Fri):** DNF compiler + on-chain `PolicyEval` + equivalence proof; `PolicyAttestor`; `MirrortechRoleProvider` (real Wildcat interface); Uniswap v4 hook tested against a real `PoolManager`; anvil test harness. See ARCHITECTURE.md §9 for the file map.

### 6.2 What changes vs v1

| Area | v1 | v2 |
| --- | --- | --- |
| Domain | Wildcat credit only | **Both**: Wildcat credit as the primary story; the RWA fund token (Securitize agreement, `custodial-rwa` profile) kept as the second agreement, compiled to the v4 hook (G2) |
| Primary venue | Wildcat-style mock hook | Real `IRoleProvider` + **SwapVM buyback** |
| Screening | Intercepta live API | Attested facts + on-chain Chainalysis oracle (mock on Sepolia) |
| AST `action` | `credential`, `payout`, `deposit` | `deposit` (= credential), `withdraw` (= payout eligibility), `transfer` (= SwapVM fill) |
| Facts | v1 §7.1 list | §7.1 below, grounded in the real MLA |
| Numeric terms | none | **Term Sheet terms** compiled to a program template (buyback) — P0; to market parameters — P2 |
| Contracts | `MirrorAccessHook`, `MockWildcatMarket`, `MockUSDC` | `PolicyAttestor`, `MirrortechRoleProvider`, `MirrortechRouter` (+`PolicyGuard`), `MockWildcatMarket`, `MockUSDC`, `MockSanctionsOracle` |
| Agent | Treasury agent, Intercepta-screened | Payout eligibility agent using `mayWithdraw` — P1 |
| ENS / MultiBaas | P0 | P1 |

## 7. Functional requirements

Priority: **P0** = in the demo · **P1** = if P0 is green by Sat 18:00 JST · **P2** = stretch / pitch-only.

### 7.1 Policy & legal content (owner: Lam + Eng B)

- **P0** `test/human_contracts/wildcat-mla.md`: the Wildcat template MLA verbatim + illustrative Exhibit A (borrower "Demo MM Ltd", asset mUSDC, transferability level **(ii) Known Lenders / valid Deposit Credentials**, fixed term maturity, withdrawal cycle). No real counterparty names. ⚠️ Wildcat describes the template as "open-source"; Lam confirms the license before committing the full text; otherwise link and commit excerpts.
- **P0** `test/human_contracts/lender-check-policy.md`: a one-page borrower policy defining the Lender Check Process (entity verification, beneficial owners, executed MLA, screening cadence 30 days). **This is where admission rules come from** — the MLA delegates them (§1 *Lender Check Process*, *Role Provider*).
- **P0** `test/human_contracts/buyback-addendum.md`: a one-clause addendum authorizing the standing buyback (price, cap, expiry). It is **not** in the template; we say so on the slide — *the venue's terms are a clause you can put in the agreement.*
- **P0** Fact set. Unknown = fail closed. **Observable** facts are read on-chain; **attested** facts are signed into `PolicyAttestor` with expiry.

| Fact | Source | Type | Clause | Used by |
| --- | --- | --- | --- | --- |
| `sanctionsClear` | Chainalysis oracle (mock on Sepolia) | observable | §13(b) | deposit, withdraw, transfer |
| `mlaCountersigned` | operator attestation | attested | §20, Exhibit A signatures | deposit, transfer |
| `lenderCheckPassed` | operator attestation per Lender Check Policy | attested | §1 *Lender Check Process* | deposit, transfer |
| `amlKycProvided` | operator attestation | attested | §3(j) | deposit |
| `notInsolvent` | operator attestation (representation) | attested | §3(e) | deposit |
| `screeningCurrent` | attestation not expired | derived | Lender Check Policy | deposit, withdraw, transfer |
| `openTermState` | market state | observable | §1 *Open Term State*, §2(f) | withdraw |
| `borrowerOverride` | borrower role, logged, expiring | attested | §13(c)(y) | withdraw (sanctions escrow release only) |

- **P0** Hand-authored fixture AST: ~10 rules quoting the MLA / Lender Check Policy verbatim, including `forbid not sanctionsClear` on **all three** actions and a `transfer` permit citing §12(a)–(b). Full mapping in [MLA_CLAUSE_MAP.md](MLA_CLAUSE_MAP.md).
- **P0** Everything the MLA leaves undecided goes in `unresolved` (jurisdiction eligibility, Process Agent, oracle-error allocation, governing law, default remedies).
- **P0** **Terms** (numeric, quoted) added to the AST schema: `buybackPrice`, `buybackCap`, `buybackDeadline` from the addendum; Term Sheet fields captured but compiled only to display (P2: to market parameters).
- **P1** Live extraction shown as "LLM candidate vs reviewed fixture" diff. Fixture is the default.
- **P1** Clause highlighting: character offsets per quote.

### 7.2 Decision engine & hybrid automation (owner: Eng B)

| Outcome | Condition | What happens |
| --- | --- | --- |
| **approve** | every `require` true, a `permit` true, no `forbid` true, all facts known | auto: attest facts → credential granted (+ ENS P1) |
| **review** | no `forbid` true, at least one fact unknown | approval queue; officer sets attestations; re-evaluate |
| **deny** | any `forbid` true | hard stop. **No officer override.** The only override is the borrower's §13(c)(y), which is a separate role, logged, expiring |

- **P0** `evaluate.js` returns `approve | review | deny` (today: allowed + trace). Unknown never yields approve.
- **P0** Re-evaluation idempotent and traced.
- **P0** The same decision on-chain: `MirrortechRoleProvider.explain(wallet, action)` returns `(allowed, clauseId)` — the dashboard shows both and they must agree (they are proven to).

### 7.3 Contracts (owner: Eng A)

Existing, in working tree: `PolicyEval.sol`, `PolicyAttestor.sol`, `MirrortechRoleProvider.sol`, `wildcat/IRoleProvider.sol`, `MirrorPolicyHook.sol` (tested against Uniswap's `PoolManager`), generated `CompiledPolicy.sol`.

**Act 1 — the token and its only door (G2)**

- **P0** `MirrorToken` custody-model change: mint to investor wallets (not custody); `_update` permits a transfer when both parties are admitted under the compiled policy (attestor lookup, `ACTION_TRANSFER`), reverts otherwise. The RWA profile must emit a `transfer` permit quoting the agreement's onboarding clause (`checkCustodialConfig` rejects transfer permits today → new `rwa-secondary` profile or a venue flag). ~4–6h; touches the most-tested contract and the service layer — schedule it as such.
- **P0** Hook↔token **handshake**: on a successful check, `MirrorPolicyHook` writes `tstore(APPROVED_SUBJECT, subject)` (EIP-1153 transient, cleared at tx end). `MirrorToken._update`, for any transfer to or from `PoolManager`, requires `hook.approvedSubject() == the non-PoolManager party`. A pool without the hook never sets the flag, so its first settlement reverts at the token; a rogue router that routes tokens through itself fails the subject match. ~1h.
- **P0** Test: a hookless pool for the token initializes but cannot take liquidity; a hooked pool created by an arbitrary wallet works; stranger refused with clause. Extends `test/chain/hook.test.js`.
- Scope claimed for the hook, and no more: admission on `beforeAddLiquidity` / `beforeRemoveLiquidity` / `beforeSwap`, plus the handshake. No quota, lockup, fee-curve or LVR claims. Custody answer: street-name — `PoolManager` holds as a broker does; beneficial owners are checked at the boundary by the hook.

**Act 2**


- **P0** `MockSanctionsOracle.sol`: `isSanctioned(address) view`, admin-settable. Same function shape as Chainalysis so the role provider reads it as an observable fact.
- **P0** `MockWildcatMarket.sol`: `deposit()` reverts unless `roleProvider.getCredential(msg.sender) != 0`; `requestWithdrawal()` reverts unless `roleProvider.mayWithdraw(msg.sender)`; issues a plain (non-rebasing) position token. Labeled "mock" in code, README and pitch.
- **P0** `MockUSDC.sol` (6 decimals, open mint).
- **P0** `PolicyAttestor`: remove reason strings from `Revoked` event (privacy, §8); add `override` fact path with role + expiry.
- **P0** `MirrortechRoleProvider`: read `sanctionsClear` from the oracle and OR it into the known/value words before deciding (observable facts never come from the attestor).
- **P0** Deploy script for Sepolia **through MultiBaas** (contract upload + deploy, addresses linked) → `generated/deployment.json`; **verified on Etherscan**.
- **P2 (stretch)** `scripts/seed-fork.js`: mainnet fork, impersonate a live V2 market's borrower, `addRoleProvider` with our provider — proof against a real market, disclosed as forked.
- **P0** Counsel sign-off: EIP-712 signature over `policyHash` stored with the deployment and shown on the Policy screen.
- **P1** Merkleized clause table (per-rule leaves, root on-chain).

### 7.4 SwapVM venue (owner: Eng A; spec in [SWAPVM_INTEGRATION.md](SWAPVM_INTEGRATION.md))

- **P0** `PolicyGuard` instruction: `build(policyHash, action)`, `exec(ctx)` reads `ctx.query.maker` / `ctx.query.taker`, calls attestor + oracle, `PolicyEval.decide`, reverts `LegalClauseViolation(clauseId, policyHash)`. View-only so it runs in `quote()`.
- **P0** `MirrortechRouter is SwapVM, Opcodes` dispatching `PolicyGuard`; deployed to Sepolia (canonical router is not on Sepolia).
- **P0** Program template `BuybackFixedPrice`: `Deadline · PolicyGuard · StaticBalances · LimitSwap · InvalidateTokenIn`. Compiler fills it from the addendum terms. Program bytes are part of the compile output.
- **P0** **Aqua mode** (the track: *"Create a custom Aqua app that implements a sophisticated DeFi position. If you use SwapVM, you may modify SwapVM opcodes and define your own instructions… Projects that utilize SwapVM will be scored higher."* — `PolicyGuard` + our router is exactly the invited shape): borrower approves Aqua once, `aqua.ship(router, strategy, tokens, amounts)` records a virtual balance, no capital moves; `dock()` withdraws the bid. Program uses Aqua balances (no `StaticBalances`). Aqua registry redeployed on Sepolia **unmodified** from `@1inch/aqua`; our router is the app. README states both redeployments and cites the rule that allows them.
- **P0** Gateway: build the strategy from compiled terms; `quote` and `swap` from the dashboard via a taker helper contract or direct call.
- **P0** Tests on anvil: ship → admitted fill succeeds → balances move via `pull`/`push`; unadmitted `quote` reverts with clause; revocation makes a live strategy unfillable; `dock` removes it; deadline; cap.
- **P1 — the "sophisticated position" item.** `PoolPriceAdjuster` instruction: the issuer's Act-1 bid follows the v4 pool's TWAP plus a spread, **capped at NAV** — an on-chain ETF-style redemption window that narrows the pool discount continuously from cash that never leaves the fund. ~20 lines on top of `PolicyGuard`; it is the difference between "a position" and "a sophisticated position" in the judging text. Manipulation answer: TWAP + NAV cap.
- **P1** Signature mode (EIP-712 order from a cold wallet, no Aqua) as the "also works without a registry" beat.
- **P1** Maker-hook variant (`preTransferOut`) for compatibility with the canonical router on mainnets.
- **P2** `BuybackDutchAuction` template.

### 7.5 Integrations (owner: Eng B)

**Third prize slot — one of the two, Lam decides Sat am (§9):**

*Option A — ENSv2 on Sepolia (P1)* — unchanged from v1 §7.4: parent `credit.<team>.eth`, subname per approved lender, `mirr0tech.status|policyHash|credentialExpiry` records, Enhanced Access Control so the gateway edits only `mirr0tech.*`, `suspended` on revoke. Cheaper if the Fri-night spike landed. ⚠️ Eng B reports spike status.

*Option B — World ID for Agents (P1)* — the human approval layer on a protected agent action. The payout agent holds a payment (sanctions hit); applying the MLA §13(c)(y) borrower override requires a **fresh** World ID verification from the borrower's officer, validated in the gateway, before the `override` fact is attested. Demo the success path and a denied/expired path where the payment stays held. Needs the payout agent (§7.6) → promotes it to P1. Fit is strong: the track wants "a meaningful action that needs a human identity or approval layer, not a login screen", and that is exactly what the override is. Bigger pool ($7.5k, up to 3 winners) and less crowded than ENS; ~4h including the debrief they require.

**Curvegrid — P0 submission, MultiBaas P0.** We submit to one Curvegrid prize; **Best RWA Tokenization Project** is the natural fit ("compliance-aware transfer logic", "permissions, allowlists, approval workflows" are its listed ideas); ⚠️ Lam may pick **Best Digital Asset Dashboard** instead. MultiBaas is formally optional, but everything runs *through* it on Sepolia: contract deploy, mint/burn and attestations via TXM + cloud wallet (attestor and minter keys in Azure Key Vault), event webhooks into the audit stream, event queries behind the Audit screen, transaction explorer as demo-day insurance. That is the "how you used MultiBaas" section written by the demo itself. Fallback if a specific call is blocked by Sat 14:00: ethers direct for that call; README documents what worked and what didn't (they ask for that feedback).

**Screening vendor adapter (P2)** — `src/integrations/screener.js` interface `screen(address) → facts[]`; Intercepta/TRM/Chainalysis-API are adapters behind it. Not a track.

### 7.6 Payout eligibility agent (owner: Eng B, P1)

Narrow and deterministic: read market state, plan interest payouts, call `mayWithdraw(lender)` for each, pay or **hold**, emit `{ lender, amount, decision, clauseId, quote, txHash? }`. LLM writes the explanation only (P2). Required **only** if the third slot is World ID for Agents (the agent is the thing that requests human verification); otherwise cut first if behind.

### 7.7 Dashboard (owner: shared; Lam owns copy and flow)

- **P0 Policy**: document viewer with highlighted quotes; rules; **terms**; unresolved; `policyHash`; equivalence badge; counsel signature; Compile / Deploy.
- **P0 Lenders**: add lender; status chips (approved / review / denied / suspended); credential expiry; attestation facts; oracle status.
- **P0 Queue**: pending reviews with trace, attestation checkboxes, Approve / Reject.
- **P0 Exit**: borrower's order card (program decoded as instruction list, hash chain); Quote / Fill as any wallet; decoded `LegalClauseViolation` with the clause rendered from `clause-table.json` **verified against the on-chain `clauseTableHash`**.
- **P0 Audit**: reverse-chronological stream, each row expandable to trace + tx.
- **P1 Agent**: run payout cycle; paid / held with explanations.

### 7.8 API changes (owner: Eng B) — built as `/v1/stack/*`, see README "Stack API"

Keep conventions: decimal-string amounts, `Idempotency-Key`, operator bearer auth, typed errors.

| Method | Endpoint | Purpose | Pri |
| --- | --- | --- | --- |
| GET | `/v1/policy` | Compiled policy, terms, quotes, clause table, hashes, counsel signature | P0 |
| POST | `/v1/lenders` | `{ name, address }` → evaluation | P0 |
| GET | `/v1/lenders[/:id]` | Lender, facts, decision, credential, on-chain `explain` | P0 |
| PATCH | `/v1/lenders/:id/attestations` | Set attested facts → attest on-chain → re-evaluate | P0 |
| POST | `/v1/lenders/:id/approve` · `/reject` | Resolve a review item | P0 |
| POST | `/v1/lenders/:id/revoke` | Clear facts on-chain (+ ENS `suspended` P1) | P0 |
| POST | `/v1/orders` | Build + sign a buyback order from compiled terms | P0 |
| GET | `/v1/orders[/:hash]` | Order, program decoded, fills | P0 |
| POST | `/v1/orders/:hash/quote` | Static quote for a given taker (surfaces the clause on refusal) | P0 |
| GET | `/v1/audit` | Audit stream | P0 |
| POST | `/v1/agent/run` · GET `/v1/payouts` | Payout cycle | P1 |
| POST | `/v1/webhooks/multibaas` | Event ingestion | P1 |

Old `investors/mints/redemptions/deposits` endpoints: leave unused; delete tests only if they block CI.

## 8. Non-functional & security requirements

- **Fail closed**: unknown fact, RPC uncertainty, expired attestation → no approval, no payout, no fill.
- **No LLM code execution**; LLM output is schema-validated data only. The compiler emits bitmasks and program bytes from templates, never Solidity.
- **Proven equivalence**: the compiler refuses to emit if the on-chain DNF disagrees with the JS interpreter on any three-valued assignment; the chain test repeats this on a real EVM.
- **Privacy**: attestations are facts, never reasons or identity. **No reason strings in events.** No KYC data on-chain or in ENS. Known limitation, stated on a slide: fact bitmaps are readable per wallet; roadmap is hashed facts / ZK.
- **Override**: no officer override of a `forbid`. The only override is the MLA's own §13(c)(y) borrower override, implemented as a separate role with expiry and audit.
- **Bounded staleness**: worst-case time a stale screening can be relied on = the attestation window, set from the Lender Check Policy (30 days). State it as a property.
- **Secrets** only in `.env`; dashboard never sees the API key. **Separate wallets**: deployer/admin, attestor, borrower-treasury (signs orders), watcher (revokes). Testnet keys only.
- **Audit integrity**: "local audit log". Say "tamper-evident" only if P2 hash-chaining lands.
- **Disclaimers** in README and UI: prototype, testnet, not legal advice, no affiliation with Wildcat, 1inch, or any named firm. Aqua/SwapVM are source-available (Degensoft license) — fine for the hackathon; flagged for product use.

## 9. Sponsor requirement checklists

Verified from the live prize page, Sat 26 Sep 01:30 JST. Seven partners: World $15k · ENS $10k · Uniswap $10k · 1inch $7k · Sui $5k · Curvegrid $3k · Intercepta $2.5k. **Rule: a team qualifies for one prize per company.** We submit to **1inch**, **Curvegrid**, and one TBD third. "Continuity Track" prizes exist on most tracks — ⚠️ Lam checks whether mirr0tech qualifies (it pre-dates the event).

**1inch — Build an Aqua App ($5,000: $2,500 / $1,500 / $1,000) — P0**
Text: *"Create a custom Aqua app that implements a sophisticated DeFi position. If you use SwapVM, you may modify SwapVM opcodes and define your own instructions. The final positions must be demonstrated through tests scripts or a UI. Projects that utilize SwapVM will be scored higher."*
- [ ] **Official Aqua/SwapVM contracts used** — Aqua registry redeployed unmodified from `@1inch/aqua` on Sepolia; our router is a *redeployment of a modified SwapVM contract*, which the rules allow verbatim; ⚠️ confirm the registry redeploy at the booth
- [ ] **On-chain token transfers executed in the demo** — `pull`/`push` visible in the fill tx on Sepolia
- [ ] **Proper git history** — no single-commit dump on the final day; Friday's prototype committed today in logical commits, then commit-as-you-go
- [ ] SwapVM used, with a custom instruction (`PolicyGuard`; P1 `PoolPriceAdjuster` for the "sophisticated" axis)
- [ ] Position demonstrated by **test scripts** (`test/chain/swapvm.test.js`) — the UI is a bonus for this track, not a requirement
- [ ] `ship`/`dock` shown; capital never leaves the borrower's wallet; program decoded; `PolicyGuard` explained as "the MLA as an opcode"
- [ ] README: how Aqua/SwapVM are used, files/lines, deployed addresses, developer-experience feedback

**Curvegrid — Best RWA Tokenization Project ($1,000) — P0** (⚠️ or Best Digital Asset Dashboard; one per company)
- [ ] README: one-sentence summary · team intro with social handles · clear setup and testing instructions
- [ ] README: how MultiBaas was used and feedback (challenges, wins) — if used; otherwise say it was evaluated and why not
- [ ] Repo artifacts: contracts, tests, documentation — judged on idea and technical execution

**Third slot, option C — Uniswap Foundation: Best Uniswap Stack Contribution ($6,000, 3 places) — P1, contingent on G2**
The claim: **permissionless pools for a transfer-restricted token** — hook-address-in-`PoolKey` + transient storage + the token gate make the hook the token's only door into Uniswap, so anyone can create liquidity and every pool enforces the prospectus. That is a hook-native mechanism with no token-only equivalent, presented for the **fund token** (Securitize agreement), never for Wildcat positions. Needs G2 landed (~5–7h) plus the paperwork below.
- [ ] `FEEDBACK.md` in the repo; Developer Feedback Form submitted with its link
- [ ] README points to `contracts/MirrorPolicyHook.sol`, `src/policy/hookAddress.js`, `test/chain/hook.test.js` with line references
- [ ] Scope claimed: admission on `beforeAddLiquidity`/`beforeRemoveLiquidity`/`beforeSwap` against Uniswap's own `PoolManager`; no quota/lockup/fee/LVR claims
- [ ] Custody answer ready: the pool is admitted as a venue; no value enters or leaves without an admitted party at the boundary

**Third slot, option A — ENS: Best Use of ENSv2 ($6,000, 3 places) — P1**
- [ ] ENSv2 on Sepolia; subname hierarchy per borrower; Enhanced Access Control delegating only `mirr0tech.*` records to the gateway; Permissioned Resolver per subname
- [ ] Records read back by the dashboard (status, policyHash, expiry); functional, not hard-coded
- [ ] Live demo link + open source
- [ ] Bonus: agent updates status on hold

**Third slot, option B — World: Best Use of World ID for Agents ($7,500, up to 3 × $2,500) — P1**
- [ ] Integrate the event's World ID for Agents dev environment (sandbox.auth.world.org)
- [ ] Full journey: agent requests verification → officer completes → gateway validates → protected action (override attestation / payout release) executes
- [ ] Unsuccessful path: denied / expired / cancelled → payment stays held, override not applied
- [ ] Validation in the backend only; no client secrets exposed; unvalidated client response is never authorization
- [ ] Integration debrief: time to first success, friction, missing capability, one highest-impact improvement

**Intercepta — dropped.** Requires x402 agent-to-agent payments with a live Intercepta call before signing; a different product.

**ETHGlobal general** — meaningful commit history across the weekend, demo video, description, screenshots, live URL.

## 10. Workstreams, owners, timeline

Times are **JST**. Now ≈ **Sat 01:30**. ~31.5h to deadline, ~25.5h to freeze.

| Workstream | Owner | P0 scope |
| --- | --- | --- |
| WS1 Legal & policy | Lam (content) + Eng B (code) | MLA doc + Lender Check Policy + addendum; fact set; fixture; terms in schema; 3-outcome evaluator |
| WS2 Contracts & chain | Eng A | Oracle + mock market + mUSDC; attestor/provider changes; Sepolia deploy + verify |
| WS3 SwapVM venue | Eng A | `PolicyGuard`, router, template, anvil tests, order signing |
| WS4 Gateway & API | Eng B | attestations → chain, orders endpoints, audit |
| WS5 Dashboard | Eng B (Sat pm) + Lam | 5 screens from §7.7 |
| WS6 Pitch & submission | Lam | Script, video, README, sponsor forms |

⚠️ Lam: confirm who owns what and what from the v1 Fri-night milestones actually landed (ENS spike, MultiBaas). This timeline assumes neither is blocking.

| When (JST) | Milestone | Exit check |
| --- | --- | --- |
| ~~Sat 05:00~~ **done Sat 04:00** | Real MLA + Lender Check Policy + addendum committed; facts and terms in the schema; fixture quotes verified; oracle, attestor override, mock market; component compiler | `npm test` green (26) |
| ~~Sat 10:00~~ **done Sat 03:00** | `PolicyGuard` + `FixedRateBalances` + router (23.0 KB) on anvil: ship, quote, fill, refusals, revocation, dock | `npm run test:chain` green (21) |
| ~~Sat 14:00~~ **done Sat 04:00** | Act 1 token door + handshake; one-call deployment; golden path both acts; stack API over HTTP | `npm run demo:golden`, `test:chain:rwa` (26), `test:chain:stack` green |
| **Sat 18:00** | Dashboard reads the stack API; clause highlighter live; go/no-go on the third slot (ENS / World / Uniswap) | Lam runs the golden path from the UI |
| **Sat 24:00** | Dashboard P0 complete; hosted (Coolify pattern from the kjuis repo) or local recording plan settled; Sepolia only if it buys something the video needs | Lam runs the golden path from the UI 2× |
| **Sun 03:00** | **Code freeze.** Bug fixes only | Tag `v0.2-freeze` |
| **Sun 03:00–07:00** | Video, README team section, sponsor forms, screenshots | Video uploaded |
| **Sun 08:00** | **Submit** (1h buffer) | Confirmed |

Rules of engagement: small PRs to `main`, **commit at least every couple of hours — the 1inch rules disqualify a single final-day commit**, any P0 slipping > 2h → tell Lam, cut using §11. Friday's uncommitted prototype lands today as separate commits (compiler · contracts · tests · docs).

## 11. Scope cut order (if behind)

1. Dutch auction template (P2) · Merkleized clause table (P1) · signature-mode order (P1)
2. MultiBaas (opportunistic) → ethers direct
3. Third-slot integration (ENS or World) — cut if not green by Sat 22:00; submit two prizes rather than three broken ones
4. Payout agent (P1) — cut with option B
5. Live LLM extraction diff (P1)
6. **Never cut:** source-quoted rules, equivalence proof, real `IRoleProvider`, Aqua `ship` + `PolicyGuard` with quote-time refusal, one approved + one denied + one refused fill, Sepolia deploy, Curvegrid README requirements

## 12. Risks & mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Judges read "official Aqua contracts" as canonical address only | Low | Rules explicitly allow a modified SwapVM redeploy; registry is their code unmodified; confirm at the booth Sat; fallback: run the 1inch demo on a mainnet fork against the canonical registry (rules accept local forks) |
| SwapVM `main` ABI ≠ deployed v1.0.x; custom opcode needs own router | Certain | Pin `@1inch/swap-vm` npm version; own router on Sepolia is required anyway; document |
| `ctx.query.taker` is not the beneficiary in some flows | Low–Med | Read the router source in the spike; check `recipient`; test with a taker contract |
| Template MLA license unclear | Low | Wildcat calls it open-source; confirm; fall back to excerpts |
| Wildcat V2 not deployable on Sepolia | Certain | Mock market calling the **real** provider interface; label it; P2 fork script against a real market |
| Privacy: fact bitmaps readable per wallet | Certain | No reasons/identity on-chain; state the limitation; roadmap ZK |
| Scope too big for 3 people / 25h | High | §11; golden path first, polish last; ENS/MultiBaas/agent are all cuttable |

## 13. Decisions log (v1 → v2)

| Topic | v1 | v2 | Why |
| --- | --- | --- | --- |
| Primary venue | Wildcat-style mock hook | Real `IRoleProvider` + SwapVM buyback | Wildcat exposes the exact socket; SwapVM makes the policy an instruction; both are already prototyped |
| Intercepta | P0 track + agent | **Dropped** as a track; vendor adapter P2 | MLA §13 names the Chainalysis oracle as the definitive sanctions source — an on-chain observable fact, not a vendor call. The x402 agent-payment requirement is a separate product. A screening API remains one adapter among many |
| Uniswap v4 | not in v1 | third-slot **option C**, contingent on G2 | Wrong venue for private credit — we argued that ourselves. Right venue for a transfer-restricted fund token (the Securitize case). Kept for one specific claim, not for symmetry: the hook as the token's only door into Uniswap, making pool creation permissionless under a permissioned agreement — a property a token gate cannot deliver because `PoolManager` is a singleton |
| 1inch mode | — | Aqua mode P0, signature mode P1 | Track is literally "Build an Aqua App". Same program either way |
| Chain | Sepolia (v1) | **Sepolia, one chain (unchanged)** | 1inch rules require official contracts and explicitly allow redeploying a modified SwapVM; the registry is redeployed unmodified. Uniswap v4 canonical on Sepolia; MultiBaas covers everything; ENS possible. A mainnet fork is a stretch for showing a real Wildcat market, not a requirement |
| Curvegrid | P0 (v1) | P0 submission, RWA Tokenization (⚠️ or Dashboard) | One prize per company; the RWA track's listed ideas describe this product. MultiBaas optional — used only where it removes work |
| Third slot | ENS (v1) | TBD: ENS **or** World ID for Agents, Lam decides | World's pool is larger, less crowded, and "human approval on a protected agent action" fits the §13(c)(y) override exactly. ENS is cheaper if the spike landed |
| Exit liquidity | none | Borrower/credit-buyer standing bid on SwapVM, signature mode | Standing bid without parked capital; buyer prices each fill; direct transfer avoids custody, rebasing and painting problems |
| Sanctions authority | Intercepta | Chainalysis oracle per MLA §13 (mock on Sepolia) | Grounded in the document; observable, not attested |
| Override | none (v1 "no override") | MLA §13(c)(y) borrower override only, separate role, logged, expiring | Real compliance systems have an appeal path; the MLA already defines it |
| Actions | `credential`, `payout`, `deposit` | `deposit`, `withdraw`, `transfer` | Match the codebase and the MLA's own vocabulary; `transfer` is what §12 restricts and what a fill is |
| Facts | v1 §7.1 | §7.1, split observable / attested | Real MLA does not require lender personal data; admission is delegated to the Lender Check Policy |
| Numeric terms | none | Terms in the AST, compiled to a program template | SwapVM needs numbers with quotes; Term Sheet is the source |
| Privacy | "no KYC on-chain" | + no reason strings in events; limitation stated | Revocation reasons on-chain are a defamation risk |
| ENS, MultiBaas | P0 | P1 | Orthogonal to the product; keep if the spikes landed, cut otherwise |
| Audit log | "local" | unchanged | Accuracy in front of judges |

## 14. Open questions

1. ⚠️ Curvegrid: RWA Tokenization or Digital Asset Dashboard? Does mirr0tech qualify for Continuity Track prizes? (Lam, Sat am)
2. ⚠️ Third company: ENS, World ID for Agents, or Uniswap (via G2)? Depends on Q3 and on whether G2 lands. (Lam, Sat am; revisit Sat 18:00)
3. ⚠️ Which v1 Fri-night spikes landed: ENSv2 subname, MultiBaas deployment? (Eng B / Eng A) — nothing in the repo depends on either
4. ~~Aqua registry redeploy~~ — the canonical registry exists on Sepolia (`0x1111113ccf…`); `AQUA=` in `.env` reuses it, nothing redeployed. Locally the vendored `Aqua.sol` is deployed unmodified
5. ⚠️ Template MLA license — full text or excerpts? (Lam)
6. Parent ENS name, if ENS is the third slot. (Eng B)
7. Hosting: gateway (Render/Fly/Railway) + dashboard (Vercel). (Eng A)
8. Demo video length limit. (Lam)

## 15. References

- Wildcat: [Template MLA](https://docs.wildcat.finance/legal/master-loan-agreement) · [Hooks](https://docs.wildcat.finance/technical-overview/security-developer-dives/hooks) · [Market access via policies/hooks](https://docs.wildcat.finance/using-wildcat/day-to-day-usage/market-access-via-policies-hooks) · [v2-protocol `IRoleProvider.sol`](https://github.com/wildcat-finance/v2-protocol/blob/main/src/access/IRoleProvider.sol)
- 1inch: [Aqua](https://github.com/1inch/aqua) · [SwapVM](https://github.com/1inch/swap-vm) · npm `@1inch/aqua`, `@1inch/swap-vm` · [OpenZeppelin audit](https://www.openzeppelin.com/news/1inch-aqua-and-swapvm-mvp-v1.0-audit)
- ENS: [ENSv2 overview](https://docs.ens.domains/ensv2/overview/) · Curvegrid: [MultiBaas docs](https://docs.curvegrid.com/multibaas/)
- ETHGlobal Tokyo 2026 [prizes](https://ethglobal.com/events/tokyo2026/prizes)
- Appendices: [ARCHITECTURE.md](ARCHITECTURE.md) · [SWAPVM_INTEGRATION.md](SWAPVM_INTEGRATION.md) · [MLA_CLAUSE_MAP.md](MLA_CLAUSE_MAP.md) · repo README
