# Demo script — one flow, about 4 minutes

Sequence and numbers match PRD §5; `test/chain/flow.test.js` runs the same commands on anvil. Fallback with no gateway: https://legalmirror.github.io/mirr0tech/ (static dashboard, Sepolia links) and the README "Sepolia" section, where every step below is a recorded tx (`agr_1b8a5c438bb1`).

**Setup.** `npm run dev:stack` (anvil + gateway on `PORT`, default 3000), or the Sepolia gateway: `RPC_URL=… DEPLOYER_PRIVATE_KEY=… DEPLOYMENT_PATH=deployments/sepolia.json npm run dev:stack`. `PAYMENT_WEBHOOK_SECRET` set. Terminal left: `npx mirr0 login <url> <key>` done. Browser right: `<url>/docs` (Swagger UI). Lines in *italics* are narration; what follows `→` is what the audience reads on screen.

## Open (15 s)

*A fund's transfer-agent agreement says who may hold the token and what onboarding they clear. On chain that becomes a hand-kept allowlist: it cannot tell "not permitted" from "not yet checked", and nothing says which sentence refused a wallet. mirr0tech compiles the agreement itself.*

## 1 Upload → Verified (45 s)

- `mirr0 upload test/human_contracts/ea026411904ex10-9.htm --name BUIDL` → `agr_…  extracting  BUIDL`.
- `mirr0 show agr_… --wait compiled` → `compiled`, `confidence <n>  rules <n>  history uploaded → extracting → verified → compiled`, the hash. *A deliberation read the document: an extractor proposes, a critic checks every quote against the text. Each rule carries the sentence it came from and a verdict; contested items are shown, not hidden.*
- `mirr0 ast agr_…` → the tree; `✓` verified, `?` contested, `!` unresolved. Point at `fact: identityVerified`.

## 2 Constrain (30 s)

- `mirr0 constrain agr_… --credential document --actions mint,transfer` → `identity: document on mint, transfer — "Know-your-customer (KYC)…"` and `deploy again: the policy hash changed`. *Exhibit A asks for KYC. A proof of human says a person exists; a passport says who. The issuer chooses per agreement, and the choice is inside the hash the token will carry.*

## 3 Deploy (45 s; ~15 s on anvil, a few minutes on Sepolia, so deploy ahead there)

- `mirr0 deploy agr_… --wait` → `deployed`, `oracle 0x…`, `hook 0x…` (mined address), `pool 0x…`. *Solidity compiled now, from this AST. Its own oracle, token, hook and pool on the canonical Uniswap v4 PoolManager. The hook is the token's only door: a pool without it initializes, then reverts at the first deposit.*

## 4 Prove the hook (75 s)

- `mirr0 facts agr_… Investor kycApproved=true amlApproved=true sanctionsClear=true` → `attested … tx 0x…`.
- `mirr0 explain agr_… Investor` → `Investor transfer: refused — transfer-identity-verified — Exhibit A — Investor Onboarding: "…"`. *Facts alone do not admit. The refusal names the sentence.*
- `mirr0 verify agr_… Investor` → `identity verified for Investor (nullifier 0x…)  tx 0x…`. *A World ID document proof, verified server-side, bound to this wallet: one human, one wallet.* `mirr0 explain agr_… Investor` → `allowed`.
- `mirr0 fund agr_… Investor 10000 && mirr0 mint agr_… 10000 && mirr0 release agr_… Investor 5000` → three txs.
- `mirr0 pool agr_… liquidity Investor && mirr0 pool agr_… swap Investor` → `… through the policy-hooked pool: ok  tx 0x…` twice. *Liquidity and a swap, through the hook.*
- `mirr0 pool agr_… swap Stranger` → `POLICY_REFUSED: …` and `↳ transfer-identity-verified — Exhibit A — Investor Onboarding: "…"`. *Same pool, no proof: refused, sentence rendered, no transaction.*
- Optional (mock proofs): `mirr0 verify agr_… Stranger --proof investor.json` (the Investor's saved proof) → `HUMAN_ALREADY_BOUND`; a proof-of-human payload → `WRONG_CREDENTIAL`.

## 5 Payment in (30 s)

- Post a signed `payment_intent.succeeded` event to `POST /webhooks/payments` (`metadata.wallet`, `metadata.agreement: agr_…`; `sign()` in `src/payments.js` makes the `Stripe-Signature` header). Investor, 125.50 USD → `settlement.status: ok`, mint and release txs. Stranger, 50.00 → `held`, `subscription-documents`.
- `mirr0 audit agr_…` → `payment.settle ok Investor` and `payment.settle held Stranger — subscription-documents`. *Money in is a fact like any other. A hold is a decision with a sentence, not an error, and the rail never retries it.*

## Close (20 s)

- `mirr0 audit agr_…` → every decision: `worldid.verify ok`, `rwa.pool.swap refused — transfer-identity-verified`, the payments. Swagger UI on the right: the whole contract, the webhook under **Webhooks**. *Change one word in the agreement: new hash, new deployment. The deployed hook keeps enforcing the document as signed. Law stays law; the code is its build artifact.*

## Fallbacks

- Gateway down: the static site and the README "Sepolia" links tell the same story as recorded txs; the audit is `deployments/sepolia-agreement-audit.json`.
- anvil restarted: rerun from `upload`, about 2 minutes; or `npm run test:chain:stack` for the recorded run.
- Live model slow: unset `NOOLOG_API_KEY`, the mock serves the same routes from the draft reading; `mirr0 status` shows `model mock`.
- No World `rp_id` / app not migrated: mock proofs run every path; `APP_NOT_MIGRATED` is its own code.
