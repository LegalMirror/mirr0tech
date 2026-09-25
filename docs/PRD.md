# mirr0tech for Wildcat — Product Requirements (ETHGlobal Tokyo 2026)

| | |
| --- | --- |
| **Status** | v1, ready to build. Decisions are locked unless marked ⚠️ |
| **Owner** | Lam (PM) |
| **Team** | Lam (PM, pitch, legal content, QA) · Eng A (contracts + chain) · Eng B (backend, integrations, agent) · dashboard shared, see §10 |
| **Deadline** | **Sun 27 Sep 2026, 09:00 JST** submission. Internal code freeze **Sun 03:00 JST** |
| **Repo** | `LegalMirror/mirr0tech`. This PRD extends the existing MVP; it does not replace it |
| **Sponsor tracks** | Curvegrid (RWA Tokenization + AI Agent) · Intercepta (Safe Agent-to-Agent Payments) · ENS (Best Use of ENSv2) |

> Terms: **MLA** = Master Loan Agreement. **AST** = the structured JSON policy we extract from the MLA. **Credential** = Wildcat's on-chain permission for a wallet to deposit into a market. **Borrower** = Wintermute/Selini-style market maker. **Lender** = institution depositing stablecoins.

---

## 1. One-sentence pitch

**mirr0tech turns a Wildcat Master Loan Agreement into an executable policy. It then screens, credentials and pays institutional lenders on-chain, and every decision traces back to a verbatim clause. Legal teams at borrowers like Wintermute and Selini stop translating contracts into allowlists by hand.**

## 2. Problem

Market makers such as Wintermute and Selini borrow stablecoins from institutional lenders through **Wildcat**, an undercollateralized private-credit protocol. Each market is governed by an off-chain **Master Loan Agreement** (Wildcat publishes a template MLA). The agreement and the chain are only loosely connected:

1. **Manual lender checks.** The borrower's legal/compliance team runs its "Lender Check Process" by hand (KYC/KYB, AML, sanctions, jurisdiction, signed MLA), then manually grants the wallet a deposit credential on-chain.
2. **Legal-to-code translation risk.** The link between an MLA clause and the on-chain allowlist lives in someone's head and spreadsheet. Nothing proves which clause justified which on-chain action.
3. **Point-in-time screening.** A lender screened at onboarding can become sanctioned later. The MLA says what must happen then; enforcing it is manual.
4. **Payout risk.** Interest and principal repayments go out to lender wallets without a fresh screen at the moment of payment.
5. **Audit pain.** Reconstructing "why was this wallet allowed / paid / blocked" for regulators or counterparties takes days.

**Who feels it:** the borrower's legal & compliance team (primary), the borrower's treasury/ops (secondary), and institutional lenders waiting to be onboarded (tertiary).

> ⚠️ **Lam to confirm before the pitch:** that Wintermute and Selini have in fact run Wildcat markets, and a rough "time to onboard one lender today" figure (hours or days). That figure is the pitch's headline metric. Present them as **target customers**, never as partners, unless they have agreed to it.

## 3. Goals, non-goals, success criteria

**Goals (hackathon)**

- G1. Ingest a real-shaped MLA (Wildcat template + illustrative term sheet) and produce a source-quoted policy AST.
- G2. Onboard a lender end-to-end on **Sepolia**: live Intercepta screen → policy decision → ENSv2 subname → Wildcat-style credential, with **hybrid** human approval.
- G3. A **treasury agent** that pays lenders and blocks or holds a payout when Intercepta flags the recipient, showing its reasoning.
- G4. A compliance **dashboard** showing policy ↔ clause, approval queue, lenders, payouts and the audit stream.
- G5. Meet every hard requirement of the three sponsor tracks (§9).

**Non-goals (explicitly out of scope)**

- Real Wildcat V2 contracts or mainnet. We ship a **minimal Wildcat-style mock** (§6.2).
- Real KYC/KYB providers, real fiat or real funds. Mock USDC only.
- Investor/lender self-service auth. The API stays an **operator API**.
- PDF/OCR ingestion, long-document chunking, legal correctness guarantees.
- Interest accrual math, penalty APR, delinquency and default state machine (named in the pitch as roadmap).

**Demo success criteria (must all be true at freeze)**

- [ ] Golden path in §4 runs on Sepolia from the dashboard in < 4 minutes, with no terminal.
- [ ] At least one **denied/held** path for onboarding and for payout is shown live, with the clause quote.
- [ ] Every sponsor checklist item in §9 is ticked.
- [ ] Public GitHub repo, README complete, demo video uploaded, live demo URL works.

## 4. Demo script (the golden path)

This is the spec. If a feature doesn't show up in this script, it's P1 or lower.

| # | Screen | What happens | Sponsor shown |
| --- | --- | --- | --- |
| 1 | **Policy** | Officer opens the MLA (Wildcat template + "Borrower: Demo MM Ltd" term sheet). Clicks **Compile**. Rules appear, each with its clause number and highlighted quote. Policy hash shown. Optional: **Re-extract with LLM** button shows live extraction | — |
| 2 | **Policy** | Click **Deploy market**. Market + hook deployed/registered through **MultiBaas** with the policy hash stored on-chain | Curvegrid |
| 3 | **Lenders** | Add *Lender A* (clean mainnet address). Gateway calls **Intercepta** live → clean. Policy: all facts true → **auto-approved** | Intercepta |
| 4 | **Lenders** | Gateway issues `lender-a.credit.<borrower>.eth` on **ENSv2 Sepolia** with text records `mirr0tech.status=approved`, `mirr0tech.policyHash`, `mirr0tech.credentialExpiry`. Then grants the Wildcat-style credential on-chain | ENS, Curvegrid |
| 5 | **Lenders** | Lender A deposits 10,000 mUSDC into the market → succeeds. Event appears via MultiBaas webhook | Curvegrid |
| 6 | **Queue** | Add *Lender B* with a missing fact (e.g. `mlaSigned` unknown). Policy returns **needs review**. Officer sees the trace, clicks **Approve** after ticking the attestation → credential issued | — |
| 7 | **Lenders** | Add *Lender C*: a **real sanctioned mainnet address**. Intercepta flags it → policy `forbid` → **denied, no override** (hard rule). Deposit attempt from C's wallet reverts on-chain | Intercepta |
| 8 | **Agent** | Treasury agent runs the interest payout cycle: reads market state via MultiBaas, plans payouts to A and B, **re-screens each recipient with Intercepta before signing**. | Intercepta, Curvegrid AI |
| 9 | **Agent** | Pays A ✅. B's address has since been flagged (demo: switched to a flagged address, see §12) → payout **held**, credential revoked, ENS status → `suspended`, explanation cites the MLA's sanctions clause | Intercepta, ENS |
| 10 | **Audit** | Timeline of every decision with rule trace + clause quote + tx hash. Close with: "every on-chain action is traceable to a sentence in the contract." | — |

## 5. Users & key user stories

| As a… | I want to… | So that… | Priority |
| --- | --- | --- | --- |
| Compliance officer | upload an MLA and see each executable rule next to the clause it came from | I can check the machine's reading before anything goes live | P0 |
| Compliance officer | have clean lenders auto-approved and only exceptions queued for me | my time goes to edge cases | P0 |
| Compliance officer | never be able to approve a sanctioned wallet | a mis-click can't become a legal breach | P0 |
| Treasury ops | have payouts screened at the moment of payment | we never pay a newly sanctioned wallet | P0 |
| Lender | get a human-readable identity (`lender-a.credit.<borrower>.eth`) showing my status | counterparties can verify me without seeing my KYC data | P0 |
| Auditor / counterparty | see why any wallet was allowed, paid or blocked | we can answer regulators in minutes | P0 |
| Compliance officer | revoke a lender and have credential + ENS status update together | state never drifts across systems | P1 |

## 6. Solution & architecture

```text
 MLA (Markdown/HTML)                                   Sepolia
   │                                            ┌──────────────────────────┐
   ▼                                            │ MockWildcatMarket        │
 [Extract]  fixture (default) | OpenAI (live)   │   deposit() checks hook  │
   │  source-quote validation                   │ MirrorAccessHook         │
   ▼                                            │   credential(lender)     │
 [Compile] → policy.json + policyHash ─────────►│   policyHash (immutable) │
   │                                            │ MockUSDC                 │
   ▼                                            └──────────▲───────────────┘
 ┌───────────────── mirr0tech gateway (Node/Express) ──────┼────────────┐
 │ Fact engine ── Intercepta API (sanctionsClear, amlApproved)          │
 │ Policy evaluator (existing trusted interpreter, fail-closed)         │
 │ Decision: approve │ review (queue) │ deny                            │
 │ Enforcer ──► MultiBaas REST (deploy, grant/revoke, payouts, events)  │
 │          ──► ENSv2 Sepolia (subname + text records)                  │
 │ Treasury agent (scheduled/manual) ──► same fact engine + policy      │
 │ Ledger + audit (existing JSON store, idempotency, recovery)          │
 └──────────────────────────────▲───────────────────────────────────────┘
                                │ REST (operator API key)
                         Dashboard (web)
```

### 6.1 What we keep from the current repo (do not rewrite)

- Document normalization, SHA-256 provenance and verbatim-quote validation (`src/policy/document.js`, `schema.js`).
- Strict JSON-schema AST, fail-closed evaluator with rule traces (`evaluate.js`).
- LLM extraction via OpenAI Structured Outputs (`extract.js`), no silent fallback.
- Idempotency keys, operation intents before signing, restart recovery, audit log (`service.js`, `store.js`).
- Security stance: **never execute LLM-written code**; the LLM only emits data validated against the schema.

### 6.2 What changes

| Area | Today | Change |
| --- | --- | --- |
| Domain | RWA fund token (mint/burn investors) | Wildcat credit market (lenders, credentials, payouts) |
| AST `action` enum | `mint`, `burn`, `transfer` | `credential`, `payout`, `deposit` (keep old values out) |
| `FACTS` | RWA facts | See §7.1 |
| Contract | `MirrorToken.sol` (custodial ERC-20) | `MockWildcatMarket.sol` + `MirrorAccessHook.sol` + `MockUSDC.sol` (keep MirrorToken in repo, unused) |
| Chain lock | chain ID 31337 only | Allow **Sepolia (11155111)** + 31337 for tests |
| Chain calls | ethers directly | Via **MultiBaas** REST for deploy, calls, events. Keep ethers for tests |
| Demo doc | Securitize/BlackRock services agreement | Wildcat **template MLA** + illustrative term sheet |
| UI | none | Dashboard (§7.6) |

## 7. Functional requirements

Priority: **P0** = required for the demo · **P1** = do if P0 is done by Sat 18:00 · **P2** = stretch / pitch-only.

### 7.1 Policy & legal content (owner: Lam + Eng B)

- **P0** Prepare `test/legal/wildcat-mla.md`: the Wildcat template MLA plus an **illustrative** Exhibit A term sheet (borrower "Demo MM Ltd", asset mUSDC, base APR, lender check process description). No real counterparty names in the document itself. ⚠️ Check the template's license/terms before committing it to a public repo; if unclear, link to it and commit only excerpts.
- **P0** New fact set (booleans; unknown = fail closed):

| Fact | Source | Used by |
| --- | --- | --- |
| `sanctionsClear` | Intercepta (live) | credential, deposit, payout |
| `amlApproved` | Intercepta risk grade below threshold (live) | credential, payout |
| `kycApproved` | Operator attestation (mock) | credential |
| `mlaSigned` | Operator attestation (mock) | credential |
| `lenderCheckPassed` | Operator attestation per the MLA's Lender Check Process | credential |
| `credentialActive` | On-chain hook read | deposit, payout |
| `reservesSufficient` | On-chain market read by the agent | payout |

- **P0** Hand-authored fixture AST for the MLA (same pattern as `src/policy/fixture.js`): ~6–8 rules, each quoting the MLA verbatim. Must include a `forbid` rule on `not sanctionsClear` for **both** `credential` and `payout`.
- **P0** Everything the MLA leaves undecided goes in `unresolved` (e.g., jurisdiction eligibility isn't a boolean the MLA defines; Process Agent appointment; oracle-error risk allocation).
- **P1** Live extraction on the MLA via the existing OpenAI path, shown as a side-by-side "LLM candidate vs reviewed fixture" diff. The demo must still run on the fixture if the API is slow.
- **P1** Clause highlighting: `GET /v1/policy` returns character offsets for each quote so the UI can highlight it.

### 7.2 Decision engine & hybrid automation (owner: Eng B)

Evaluation result maps to three outcomes:

| Outcome | Condition | What happens |
| --- | --- | --- |
| **approve** | every `require` satisfied, a `permit` matches, no `forbid` matches, and all facts known | auto-execute: ENS subname + credential grant |
| **review** | no `forbid` matches, but at least one fact is **unknown** or an attestation is missing | into the approval queue; the officer sets the missing attestations, then re-evaluate |
| **deny** | any `forbid` matches (e.g., sanctions) | hard stop. **No officer override.** Audit + dashboard alert |

- **P0** Extend `evaluate.js` to return `approve | review | deny` (today it's permit/deny with trace). Unknown facts must never produce `approve`.
- **P0** Re-evaluation is idempotent and fully traced in the audit log.

### 7.3 Contracts (owner: Eng A)

Model on Wildcat V2's **access-control hooks / role-provider** pattern, kept minimal. ⚠️ We're copying the concept, not the interface; label it "Wildcat-style" in README and pitch.

- **P0** `MockUSDC.sol`: 6 decimals, open `mint` for the demo.
- **P0** `MirrorAccessHook.sol`
  - `bytes32 immutable policyHash`, `PROVIDER_ROLE` (gateway wallet), `DEFAULT_ADMIN_ROLE`.
  - `grantCredential(address lender, uint64 expiry, bytes32 operationId)` / `revokeCredential(address lender, bytes32 operationId)`; operation IDs unique (reuse the `processed` pattern).
  - `isCredentialed(address) view` (active and not expired).
  - Events: `CredentialGranted`, `CredentialRevoked` (include `policyHash`).
- **P0** `MockWildcatMarket.sol`
  - `deposit(uint256)` reverts unless `hook.isCredentialed(msg.sender)`; tracks lender balances.
  - `payout(address lender, uint256 amount, bytes32 operationId)` callable only by `TREASURY_ROLE` (agent wallet) and only if `isCredentialed(lender)`.
  - `totalAssets`, `balanceOf(lender)` views for the agent.
- **P0** Foundry/Node tests: credentialed deposit ok, uncredentialed reverts, revoked blocks payout, expiry, duplicate op ID, roles.
- **P0** Deploy script for Sepolia; addresses to `generated/deployment.json`; **verified on Etherscan**.
- **P1** Withdrawal request flow (open-term) for realism.

### 7.4 Integrations (owner: Eng B, Eng A for MultiBaas deploy)

**Intercepta (P0)**
- `src/integrations/intercepta.js`: one function `screen(address) → { sanctionsClear, amlApproved, grade, reasons[], raw, checkedAt }`.
- Called **live** on: lender onboarding, and **before every payout is signed** (hard requirement).
- Screen **real mainnet addresses**, even though payments run on Sepolia (track requirement). Keep a demo list: 2 clean well-known addresses and 1 known-sanctioned address, each mapped to a Sepolia demo wallet.
- Timeout/unavailable → facts become **unknown** → `review` (onboarding) or **held** (payout). Never approve on error.
- Store the raw response in the audit record. Get the free key at intercepta.io/ethglobal.

**ENSv2 on Sepolia (P0)**
- Borrower parent name, e.g. `credit.<team-name>.eth` (use a name we own; do not register or imply `wintermute.eth`).
- On approve: create subname `<lender-slug>.credit.<…>.eth` → lender address; set text records `mirr0tech.status` (`approved|suspended`), `mirr0tech.policyHash`, `mirr0tech.credentialExpiry`, `mirr0tech.auditUrl`.
- Use ENSv2 per-record permissions (Permissioned Resolver) so the gateway wallet can edit **only** the `mirr0tech.*` records. That delegation is what makes ENS "central, not cosmetic"; show it in the pitch.
- Subnames should be non-transferable by the lender if ENSv2 supports that; otherwise document it as a known limitation.
- ⚠️ ENSv2 is a beta and its Sepolia state has been reset before. Eng B does a **spike first (Fri night, ≤2h)**: register parent, create a subname, set a text record from a script. If it fails, fall back to ENS v1 on Sepolia and tell Lam immediately (this affects eligibility for the ENS track).
- Dashboard shows the resolved name, never raw addresses where a name exists.

**Curvegrid MultiBaas (P0)**
- Create a MultiBaas deployment on Sepolia; upload the 3 contract ABIs; link deployed addresses.
- Gateway calls grant/revoke/payout through MultiBaas REST (signing via MultiBaas or local wallet + MultiBaas tx submission, whichever is faster to set up; document which).
- **Event webhooks** (`CredentialGranted`, `Deposit`, `Payout`) → `POST /v1/webhooks/multibaas` → audit stream.
- README section "How we use MultiBaas" + feedback (required).

### 7.5 Treasury agent (owner: Eng B, P0 core / P1 LLM)

Goal: a **policy-aware transaction agent** (Curvegrid AI Agent track) whose payments are screened (Intercepta track).

- **P0** `src/agent/treasury.js`, triggered by `POST /v1/agent/run` (dashboard button) and optionally on an interval.
- Loop per cycle:
  1. Read market state via MultiBaas (lender balances, reserves).
  2. Plan payouts (demo: fixed interest amount per lender, pro-rata).
  3. For each recipient: **Intercepta screen → facts → policy `payout` evaluation**.
  4. `approve` → sign & send `payout` → record tx. `deny`/unknown → **hold**, revoke credential, set ENS status `suspended`, raise alert.
  5. Emit a decision record: `{ lender, ens, amount, decision, failedRules, clauseQuotes, interceptaReasons, txHash? }`.
- **P0** The decision is deterministic (policy engine). **P1** An LLM writes the human-readable explanation from the decision record (read-only; it cannot change the decision).
- **P2** x402: expose `GET /v1/agent/report` behind an x402 paywall, or have the lender-side agent pay a deposit via x402. The track says x402 is *preferred*, not required.
- Agent wallet holds `TREASURY_ROLE` only. It cannot grant credentials.

### 7.6 Dashboard (owner: shared; Lam owns copy and flow)

Stack: whatever is fastest for the team (suggest Next.js + Tailwind, or plain Vite). Calls the gateway via a server-side proxy so the API key never reaches the browser.

- **P0 Policy**: document viewer with highlighted quotes; rule list (action, effect, condition, clause, rationale); unresolved terms; policy hash; Compile / Deploy buttons.
- **P0 Lenders**: add lender (name, address, demo mainnet address for screening); status chips (approved / review / denied / suspended); ENS name; credential expiry; Intercepta grade + reasons.
- **P0 Queue**: pending reviews with the trace ("missing: `mlaSigned` — clause 3(j) …"), attestation checkboxes, Approve / Reject.
- **P0 Agent**: "Run payout cycle" button; live list of planned → paid / held payouts with explanations and Etherscan links.
- **P0 Audit**: reverse-chronological stream, filter by lender, each row expandable to trace + raw Intercepta response + tx.
- **P1** Wildcat-style market summary card (total deposits, lenders, reserves). This also helps with the Curvegrid "Digital Asset Dashboard" framing.

### 7.7 API changes (owner: Eng B)

Keep the conventions: decimal-string amounts, `Idempotency-Key` on state changes, operator bearer auth, typed errors.

| Method | Endpoint | Purpose | Pri |
| --- | --- | --- | --- |
| GET | `/v1/policy` | Compiled policy + quotes (+ offsets P1) | P0 |
| POST | `/v1/policy/compile` | Compile fixture or uploaded candidate | P1 |
| POST | `/v1/lenders` | `{ name, address, screeningAddress? }` → runs screen + evaluation | P0 |
| GET | `/v1/lenders[/:id]` | Lender, facts, decision, ENS, credential | P0 |
| PATCH | `/v1/lenders/:id/attestations` | Set `kycApproved`, `mlaSigned`, `lenderCheckPassed` → re-evaluate | P0 |
| POST | `/v1/lenders/:id/approve` · `/reject` | Resolve a `review` item (rejected if any `forbid` matches) | P0 |
| POST | `/v1/lenders/:id/revoke` | Revoke credential + ENS `suspended` | P1 |
| POST | `/v1/lenders/:id/rescreen` | Fresh Intercepta call | P1 |
| POST | `/v1/agent/run` | Run a payout cycle | P0 |
| GET | `/v1/payouts[/:id]` | Payout decisions + tx | P0 |
| POST | `/v1/webhooks/multibaas` | Event ingestion (verify MultiBaas signature) | P0 |
| GET | `/v1/audit` | Audit stream | P0 |

Old `investors/mints/redemptions/deposits` endpoints: remove or leave unused. Don't spend time migrating tests for them; delete those tests if they block CI.

## 8. Non-functional & security requirements

- **Fail closed** everywhere: unknown fact, API timeout, RPC uncertainty → no approval, no payout.
- **No LLM code execution**; LLM output is schema-validated data only (existing guarantee; keep the tests).
- **Secrets** (`API_KEY`, Intercepta, OpenAI, MultiBaas, private keys) only in `.env`; nothing in git; dashboard never sees the API key.
- **Separate wallets**: deployer/admin, gateway (`PROVIDER_ROLE`), agent (`TREASURY_ROLE`). Testnet keys only.
- **Privacy**: no KYC data on-chain or in ENS records, only status, policy hash, expiry.
- **Audit integrity**: the Gemini draft calls the audit log "unalterable". **It isn't**: today it's an editable local JSON file. Say "tamper-evident" only if we do P2: hash-chain the audit entries and anchor the head hash on-chain or in an ENS text record.
- **Disclaimers** in README and UI footer: prototype, testnet, not legal advice, no affiliation with Wildcat, Wintermute or Selini.

## 9. Sponsor requirement checklists

⚠️ Taken from the ETHGlobal prize page summary on 25 Sep. **Lam re-reads the live prize pages Saturday morning** and updates this section. Also confirm how many sponsor prizes one project may select.

**Curvegrid: Best RWA Tokenization Project + Best AI Agent Project ($1k each)**
- [ ] GitHub repo with contracts, tests, documentation, solid README
- [ ] README: one-sentence summary · how MultiBaas is used · team intro with social handles · setup & test instructions · MultiBaas feedback
- [ ] Agent understands blockchain activity (reads market state) and takes on-chain action (payouts, revocations)

**Intercepta: Safe Agent-to-Agent Payments with x402 ($1,250 / $750)**
- [ ] Working agent payment flow (testnet OK; x402 preferred → §7.5 P2)
- [ ] ≥1 **live** Intercepta API call runs **before a payment is signed**, and its result decides the outcome
- [ ] Screens **real mainnet addresses**
- [ ] Demo shows one payment approved and one blocked/held, with visible reasoning
- [ ] README points to the files that call the API + 3–5 lines of API feedback

**ENS: Best Use of ENSv2 ($3k / $2k / $1k)**
- [ ] Built on ENSv2 beta (Sepolia)
- [ ] ENSv2 is central: subname hierarchy per borrower + per-record delegated permissions + status records read back by the dashboard/agent
- [ ] Functional, not hard-coded values
- [ ] Live demo link + open-source GitHub
- [ ] Bonus: agent integration (agent updates ENS status on hold/suspend)

**ETHGlobal general**
- [ ] Meaningful commit history across the weekend (no single final-day dump)
- [ ] Demo video (≤ the event's limit; confirm), project description, screenshots
- [ ] Live URL for dashboard (e.g. Vercel + gateway on Render/Fly/Railway)

## 10. Workstreams, owners, timeline

Times are **JST**. Now ≈ Fri 18:00. ~39h to deadline, ~33h to freeze.

| Workstream | Owner | P0 scope |
| --- | --- | --- |
| WS1 Legal & policy | Lam (content) + Eng B (code) | MLA doc, facts, fixture AST, 3-outcome evaluator |
| WS2 Contracts & chain | Eng A | Hook, market, mUSDC, tests, Sepolia deploy + verify, MultiBaas setup |
| WS3 Integrations | Eng B | Intercepta, ENSv2, MultiBaas calls + webhooks |
| WS4 Treasury agent | Eng B (Eng A helps Sat pm) | Payout loop, hold logic, explanations |
| WS5 Dashboard | Eng A (Sat pm) + Lam | 5 screens from §7.6 |
| WS6 Pitch & submission | Lam | Script, video, README, sponsor forms, feedback text |

⚠️ Lam: assign names to Eng A / Eng B. If one engineer is stronger on frontend, swap WS5 to them and move WS4 to Eng A.

| When (JST) | Milestone | Exit check |
| --- | --- | --- |
| **Fri 22:00** | Spikes done: ENSv2 subname + text record from script; Intercepta key works on 1 clean + 1 sanctioned address; MultiBaas deployment created | Each spike has a script committed in `scripts/spikes/` |
| **Sat 02:00** | Contracts + tests pass locally; MLA doc + fixture AST committed; fact set + 3-outcome evaluator merged | `npm test` green |
| **Sat 12:00** | Contracts on Sepolia (verified) and linked in MultiBaas; onboarding path (steps 3–4, 6–7) works via API/curl | Lender A approved end-to-end on Sepolia |
| **Sat 18:00** | Agent payout approve + hold working (steps 8–9); dashboard skeleton reads live API | Full golden path via API |
| **Sat 24:00** | Dashboard P0 complete; deployed to public URL; P1s only if green | Lam runs golden path from UI 2× |
| **Sun 03:00** | **Code freeze.** Only bug fixes after this | Tag `v0.1-freeze` |
| **Sun 03:00–07:00** | Record demo video, finish README, sponsor feedback sections, screenshots | Video uploaded |
| **Sun 08:00** | **Submit** (1h buffer) | ETHGlobal submission confirmed |

Rules of engagement: small PRs to `main`, commit often (history matters), any P0 slipping > 2h → tell Lam, cut scope using §11.

## 11. Scope cut order (if behind)

Cut from the top first:
1. x402 (P2) · tamper-evident audit (P2)
2. LLM explanation for the agent (P1). Use templated text built from the trace
3. Live LLM extraction in the demo (P1). Show the fixture only; mention extraction exists in the repo
4. Withdrawals, revoke/rescreen endpoints (P1)
5. MultiBaas webhooks. Poll events via MultiBaas REST instead
6. **Never cut:** live Intercepta call before payout, one approved + one blocked, ENSv2 subname + records, Sepolia deploy, source-quoted rules

## 12. Risks & mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| ENSv2 Sepolia unstable/reset or missing features | Med | Fri-night spike; fallback ENS v1 Sepolia; record a backup video of the working flow early |
| Intercepta sanctioned-address demo: payout target changes status mid-demo | Certain (by design) | Payout recipient for Lender B maps to a different screening address at payout time via `screeningAddress` override; disclose this in the demo ("simulating a status change") |
| Intercepta rate limits / downtime during judging | Med | Fail-closed path is itself a valid demo; cache last result for display only, never for decisions |
| MultiBaas setup takes longer than expected | Med | Eng A starts it Fri night; ethers fallback exists in repo; README still documents the attempt |
| LLM extraction produces bad rules live | Med | Fixture is the default path; extraction only shown as a diff |
| Legal/IP: MLA template license, use of firm names | Low–Med | Check license; illustrative term sheet; "target customers" wording; disclaimers |
| Scope too big for 3 people / 33h | High | Cut order §11; golden path first, polish last |

## 13. Decisions log (vs Gemini draft)

| Topic | Gemini draft | Decision | Why |
| --- | --- | --- | --- |
| On-chain target | Wildcat `MarketController` whitelist hook | Minimal **Wildcat-style** market + access hook | Wildcat docs list V2 as mainnet-only; the Sepolia deployment is an incomplete 2024 build |
| Intercepta usage | Onboarding screen | Onboarding **and** a treasury agent screening each payout before signing | Track requires an agent payment flow with approve + block |
| AI agent | Autonomous treasury agent (open question) | Yes, narrow: payout agent; the decision is deterministic, the LLM explains | Serves Intercepta + Curvegrid AI + ENS bonus with one feature |
| Automation | Open question | **Hybrid**: auto-approve clean, queue unknowns, hard-deny forbids | Legal teams keep control of exceptions; shows both paths |
| Legal ingestion | Open question | Reviewed fixture by default; live OpenAI extraction as a side-by-side | Demo reliability; extraction already implemented |
| Third sponsor | ENSv2 | ENSv2 (kept) | Team choice; World ID for Agents noted as future work |
| Audit log | "Unalterable" | "Local audit log"; tamper-evident only if P2 done | Accuracy in front of judges |
| Wildcat link in draft | Pointed to an ASX mining company | Use docs.wildcat.finance | Wrong link |

## 14. Open questions

1. ⚠️ Owner names for Eng A / Eng B, and each person's strongest stack. (Lam, Fri 19:00)
2. ⚠️ Do Wintermute / Selini run Wildcat markets today, and what's the current per-lender onboarding time? (Lam, before the pitch)
3. Which parent ENS name do we register on Sepolia? (Eng B during the spike)
4. MultiBaas signing: MultiBaas-managed signer (HSM wallet) or local key + submit? (Eng A, Fri night)
5. Hosting for the gateway (Render / Fly / Railway) and dashboard (Vercel). (Eng A, Sat)
6. Demo video length limit and number of selectable sponsor prizes. (Lam, Sat am)

## 15. References

- Wildcat docs: [Hooks](https://docs.wildcat.finance/technical-overview/security-developer-dives/hooks) · [Market access via policies/hooks](https://docs.wildcat.finance/using-wildcat/day-to-day-usage/market-access-via-policies-hooks) · [Contract deployments](https://docs.wildcat.finance/technical-overview/contract-deployments) · [Template MLA](https://docs.wildcat.finance/legal/master-loan-agreement) · [V2 audit repo](https://github.com/code-423n4/2024-08-wildcat)
- ENS: [ENSv2 overview](https://docs.ens.domains/ensv2/overview/) · [ENSv2 beta announcement](https://ens.domains/blog/post/ensv2-beta-public-testing)
- Curvegrid: [MultiBaas docs](https://docs.curvegrid.com/multibaas/) · [Sample app](https://github.com/curvegrid/multibaas-sample-app/)
- Intercepta: [Compliance Engine](https://intercepta.io/products/compliance-engine) · free hackathon key at intercepta.io/ethglobal
- ETHGlobal Tokyo 2026 [prizes](https://ethglobal.com/events/tokyo2026/prizes)
- Repo README (current MVP architecture, API conventions, recovery model)
