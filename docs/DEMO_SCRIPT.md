# Demo script — 3 minutes, two acts, one asset

Fallback with no stack at all: https://legalmirror.github.io/mirr0tech/ (static build, mock parties, Sepolia links).
Run: `pnpm run dev:stack` (API on :3200) and the dashboard in gateway mode (or the hosted stack; for Sepolia:
`RPC_URL=… DEPLOYER_PRIVATE_KEY=… DEPLOYMENT_PATH=deployments/sepolia.json AUDIT_PATH=deployments/sepolia-audit.json pnpm run dev:stack`, no seed needed). The seed
(`pnpm run seed:stack`) leaves the state below in place; the presenter only has to click. Every line in
*italics* is narration. Numbers match PRD §4.

## Open (15 s)

*The paper behind a tokenized asset says who may hold it, where it may trade, how it may be lent. None of
that reaches the chain — it becomes a spreadsheet and an allowlist. mirr0tech compiles the paper itself.*

## Act 1 — tokenize and trade (60 s)

0. **Overview**: one asset, both acts, who stands where, the Sepolia links. *One agreement in, the code that admits, refuses and pays out.*
1. **Agreement** screen, act *Fund*. Show the Securitize/BlackRock agreement with every quoted span lit
   and the coverage bar. Click a lit paragraph. *Eight rules, each one a verbatim quote from the hashed
   document. Terms it leaves open are flagged, not guessed.* Point at the pipeline: quote → rule → logic →
   bytes → contract → what-would-happen. *The interpreter and the on-chain bitmask agree on every input —
   the compiler proves that before it emits a byte.*
2. **Lenders/Investors**: the Investor is onboarded, the Stranger is not. *Shares were minted to custody and
   released only to the onboarded wallet — the stranger's release was refused by Exhibit A.*
3. **Trade** screen: two pools exist, both created by the Stranger. *Anyone may create a pool. The one
   without the hook initialised fine — and the first deposit into it reverted at the token: no policy, no
   door.* Then the hooked pool: Investor allowed, Stranger refused, quote rendered. *The issuer published
   one hook address. Every pool under it enforces the prospectus; every pool without it is inert.*

## Act 2 — lend it out (75 s)

4. **Agreement**, act *Loan*. *Same compiler, different paper: Wildcat's template Master Loan
   Agreement, the borrower's own Lender Check Policy, one addendum clause.* Click the §1 "Role Provider"
   paragraph. *The agreement delegates admission to a role provider — so that is what we compiled it into.*
5. **Lenders**: A admitted, B in review, C flagged. Click B. *No countersignature — the policy quotes Lender
   Check Policy 2.1. Unknown is a real value here; it never admits.* Click C. *Designated by the oracle the
   agreement names as definitive. No override for the officer; only the borrower's §13(c)(y) path.*
6. **Exit**: the shipped buyback. *The borrower stands a bid for its own debt at the addendum's 0.96 — on 1inch
   Aqua, so no capital moved. Look at the program: Deadline, then the agreement itself as an opcode, then
   the price, the curve, the cap.* Show Lender A's fill (96,000 for 100,000). Then the Stranger's quote:
   refused at quote time, clause 4.2 quoted. *Refused before a transaction exists.*
   If time allows, the auction variant: *same addendum, clause A1.5 — the bid opens at 0.96 and improves to 1.00
   over six hours, so the lender chooses when to accept. A tender offer, compiled from one sentence.*
7. **Lenders** → flag Lender A (sanction toggle). Back to **Exit** → quote as A: refused, MLA 13(a).
   **Lenders** → A's payment eligibility: blocked, 13(c). *Nothing was redeployed. The same strategy stopped
   filling for that wallet, and the payment desk stopped paying it — from one oracle read.*

## Close (30 s)

8. **History**: the timeline — every decision with its clause and tx hash. *This is what takes a compliance
   team days to reconstruct.*
9. Change one word in the agreement (prepared tab): the hash changes. *The deployed provider, hook and
   strategy keep enforcing the agreement exactly as signed. Law stays law; the code is its build artifact.*

*mirr0tech links a tokenized asset's off-chain legal clauses to the on-chain code that executes them.*

## Fallbacks

- Terminal instead of UI: `pnpm run demo:golden` prints the same story, refusals with quotes included.
- If the chain restarted: `pnpm run seed:stack` rebuilds the state in ~40 s.
