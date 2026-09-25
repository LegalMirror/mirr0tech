# MLA clause map — what compiles, from where

Appendix to [PRD.md](PRD.md) §7.1. Source: the Wildcat template MLA (`docs.wildcat.finance/legal/master-loan-agreement`), an illustrative Exhibit A Term Sheet, a one-page borrower **Lender Check Policy**, and a one-clause **Buyback Addendum**. Owner: Lam (content), Eng B (fixture).

Every row that says *quote* must be a verbatim substring of the normalized document or the compiler refuses it. Quotes below are the intended anchors; verify against the committed text.

## 1. Key finding

The template MLA **does not define admission criteria**. It delegates them:

> *Lender Check Process* means any process of due diligence, anti-money laundering and/or know your customer screening which the Borrower has chosen to implement …
> *Role Provider* means … an Ethereum smart contract or Wallet Address deployed or controlled by the Borrower which sets forth a Lender Check Process, the successful completion of which grants a Lender a Deposit Credential.

So the MLA is the **authorizing** document — it makes the Role Provider binding — and the borrower's Lender Check Policy is the **content**. mirr0tech compiles the second and deploys it as the first. The template also states it does not require lender personal details, which matches the attestor holding facts rather than identity.

## 2. Actions

| Action | Meaning | MLA basis |
| --- | --- | --- |
| `deposit` | may this wallet receive a Deposit Credential | §1 *Deposit Credential*, *Lender Check Process*, *Role Provider* |
| `withdraw` | may this wallet be paid / have a withdrawal processed now | §2(f), §12(c), §13(c) |
| `transfer` | may Market Tokens move to this wallet (secondary sale, buyback fill) | §1 *Token Transferability* (ii), §12(a)–(b) |

## 3. Facts

| Fact | Kind | Source of truth | MLA / policy anchor (quote) |
| --- | --- | --- | --- |
| `sanctionsClear` | observable | Chainalysis oracle via Sentinel (mock on Sepolia) | §13(b) "the Oracle shall serve as the definitive source for determining whether any Wallet Address associated with a Party is subject to sanctions" |
| `mlaCountersigned` | attested | borrower confirms the lender countersigned | §20 "By clicking on the `Sign` (or similar) button, the Borrower and the Lender intend to be legally bound" |
| `lenderCheckPassed` | attested | borrower's compliance function per the Lender Check Policy | §1 "the successful completion of which grants a Lender a Deposit Credential" |
| `amlKycProvided` | attested | lender supplied the information | §3(j) "provide such information considered reasonably necessary to allow the other Party to conduct appropriate anti-money laundering and know your customer checks" |
| `notInsolvent` | attested (representation) | lender's rep, borrower records it | §3(e) "it is not insolvent and is not subject to any bankruptcy or insolvency proceedings" |
| `screeningCurrent` | derived | attestation not expired | Lender Check Policy: re-screen every 30 days (borrower text) |
| `openTermState` | observable | market state | §1 *Open Term State*; §2(f) "may request a Withdrawal via the Market while the latter is in an Open Term State" |
| `borrowerOverride` | attested, `BORROWER_ROLE`, expiring | borrower | §13(c)(y) "if the Borrower explicitly overrides the sanction via the Market, which they may do if they determine the Oracle designation was erroneous" |

Facts from the current codebase that are **not** grounded in the real MLA and should be dropped or renamed: `jurisdictionPermitted`, `accreditedInvestor`, `lenderCapacityAvailable`, `lockupElapsed`, `withdrawalWindowOpen`, `venueApproved`, `mlaExecuted` (→ `mlaCountersigned`), `kycApproved`/`amlApproved` (→ `amlKycProvided` + `lenderCheckPassed`). Jurisdiction and accreditation may reappear **if** the borrower's Lender Check Policy states them — then they quote that document, not the MLA.

## 4. Rules (fixture)

| id | action | effect | condition | anchor |
| --- | --- | --- | --- | --- |
| `deposit-admission` | deposit | permit | all(`mlaCountersigned`, `lenderCheckPassed`, `amlKycProvided`) | §1 *Role Provider* |
| `deposit-not-insolvent` | deposit | require | `notInsolvent` | §3(e) |
| `deposit-screening-current` | deposit | require | `screeningCurrent` | Lender Check Policy |
| `deposit-sanctions` | deposit | forbid | not(`sanctionsClear`) | §13(a)–(b) |
| `withdraw-open-term` | withdraw | permit | all(`openTermState`, `lenderCheckPassed`) | §2(f), §12(c) |
| `withdraw-screening-current` | withdraw | require | `screeningCurrent` | Lender Check Policy |
| `withdraw-sanctions` | withdraw | forbid | all(not(`sanctionsClear`), not(`borrowerOverride`)) | §13(c) |
| `transfer-known-lender` | transfer | permit | all(`mlaCountersigned`, `lenderCheckPassed`, `screeningCurrent`) | §12(b) "provided that such Third Party Beneficiary successfully completes any Lender Check Processes as may be specified via Role Providers by the Borrower"; §1 *Token Transferability* (ii) |
| `transfer-sanctions` | transfer | forbid | not(`sanctionsClear`) | §13(a) |

Note on `withdraw-sanctions`: the MLA's remedy for a sanctioned lender is escrow, not silence (§13(c)). The rule blocks the *payment to the wallet*; escrow creation is the Sentinel's job and is out of scope. The override bit models §13(c)(y) exactly: it clears the block only for that wallet, only while it lasts, only by the borrower.

## 5. Terms (numeric, quoted)

**From Exhibit A (display in P0; compile to market parameters in P2)**

| Term | Term Sheet field |
| --- | --- |
| `capacity` | Maximum Amount of Digital Asset To Be Loaned |
| `baseAprBps` | Base APR |
| `penaltyAprBps` | Penalty APR |
| `reserveRatioBps` | Minimum Reserve Ratio |
| `withdrawalCycleSeconds` | Withdrawal Cycle Duration |
| `gracePeriodSeconds` | Maximum Grace Period Duration |
| `minimumDeposit` | Minimum Deposit Amount |
| `fixedTermEnd` | Fixed Term Maturity |
| `transferability` | Market Token Transferability — **must be (ii)** for `transfer` rules to be meaningful; the compiler refuses a `transfer` permit if the Term Sheet says (iii) |

**From the Buyback Addendum (compile to the SwapVM template in P0)**

| Term | Addendum text (to write) |
| --- | --- |
| `buybackPrice` | "The Borrower will purchase Market Tokens at not less than {{price}} per unit of Equivalent Loaned Asset" |
| `buybackCap` | "up to an aggregate of {{cap}}" |
| `buybackDeadline` | "until {{date}}, unless earlier revoked by notice via the Communication Platform" |

The addendum is **not** in Wildcat's template. Slide wording: *the venue's terms are a clause you can put in the agreement.*

## 6. Unresolved (must be listed; blocks compile without `--demo`)

| Clause | Why it stays paper |
| --- | --- |
| §4 Default, §5 Remedies | event-of-default state machine, notice periods, cure — not compiled |
| §6 Limitations on liability, §7 Loss of access | not executable |
| §11 Governing law, Process Agent | jurisdiction and service of process |
| §13(e) Sanctions disputes | evidentiary process, human judgement |
| Lender Check Policy specifics | whatever the borrower's policy leaves to discretion (e.g. "risk rating") |
| Jurisdiction eligibility | only if the Lender Check Policy defines it as a boolean; otherwise unresolved |

## 7. Wildcat mechanics we rely on but do not implement

- **Sentinel + Sanctions Escrow** (§13(c)) — protocol-side; we read the oracle, we don't escrow.
- **Deposit Credential TTL** — set by the borrower on `addRoleProvider`; tighter of TTL and attestation expiry wins.
- **Token Transferability level** — market parameter; our `transfer` rules assume level (ii).
- **Known Lender status** — assigned by the market on deposit or on a permitted transfer; our role provider is what makes a transfer permitted.
