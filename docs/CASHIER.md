# Document-bound Uniswap v4 cashier

The cashier is **opt-in, local/testnet prototype code**, not part of the existing Sepolia deployment. No real fund shares or USD are issued.

## Start from the uploaded documents

Run the gateway with `pnpm run dev:stack` after building the existing profiles (see README), then the dashboard with `pnpm --dir dashboard run dev`. Connect with the local operator key. In **Upload Contracts**, select the supplied fund agreement and opt into the NAV cashier addendum. The chooser submits the actual documents and `examples/rwa-cashier-config.json` through `/v1/agreements`.

The base transfer-agent agreement does **not** authorize the demo NAV/fees. `test/human_contracts/nav-cashier-addendum.md` is separately authored demo evidence. Without `NOOLOG_API_KEY`, analysis uses the existing deterministic mock adapter; quote validation, AST, compilation and equivalence checks still run. Inspect source quotes, contested/unresolved items and constructor parameters before deploying.

## Terms versus deployment settings

- The supported explicit sentence grammar supplies fixed NAV, subscription fee, redemption fee and supply cap. Numeric edits are accepted only with consistent payout arithmetic and source evidence.
- `config.cashier.pool` supplies the static v4 fee (millionths) and tick spacing. These are deployment settings, not offering terms.
- Typed parameters (`contracts/CashierConfig.sol`) are passed through deployment into immutable hook/router fields. The generated configuration commitment, evidence and policy hash bind those values. Changed terms/settings require recompilation and redeployment.
- The example uses $1 NAV, a 25 bps subscription fee and a separate 25 bps redemption fee. Its quotes are $1.0025 to subscribe and $0.9975 to redeem, not a single 25 bps-wide band.

## Settlement and route selection

`contracts/MirrorCashierRouter.sol` authenticates the actual payer. **auto** attempts full-input AMM execution and compares the actual output, including LP fee and price impact, against the cashier quote. An inferior attempt is reverted atomically before the cashier route executes; slot0 is not treated as an oracle. **amm** explicitly bypasses this NAV comparison; **cashier** uses only issuance/redemption.

`contracts/MirrorCashierHook.sol` returns v4 custom-accounting deltas. Buys transfer actual six-decimal mockUSD to the reserve and mint shares; sells burn shares and pay only from available reserves. `MirrorCashierToken.sol` preserves the policy hook as the token's pool settlement door. Exact-input/full-fill orders only; caller minimum output, deadline, policy checks and supply/reserve bounds apply. The chosen route and actual output are returned in the audit.

Policy denial uses the same source-linked clause/hash. Transfer policy is always required; cashier mint/burn additionally requires the applicable action policy, including configured World ID requirements. World ID is a server-attested credential condition, not complete KYC/AML or an on-chain World proof verifier.

## Agreement-scoped API

Use the operator bearer token. Prefix each path with `/v1/agreements/<id>/stack` after deployment.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/rwa/cashier` | Terms, reserve, supply, pool key and limitations |
| POST | `/rwa/cashier/quote` | `{ "buy": true, "amount": "100.25" }` |
| POST | `/rwa/cashier/swap` | `{ "wallet": "Investor", "buy": true, "amount": "100.25", "minOut": "100", "deadline": <Unix seconds>, "route": "auto" }` |
| POST | `/rwa/cashier/prefund` | `{ "wallet": "Investor", "amount": "1000" }` |

Amounts are decimal strings. Quote is NAV arithmetic only, not authorization or a promise of reserves. The existing wallet funding route faucets test mockUSD and approves the router. Prefunding transfers that wallet's mockUSD into the reserve; no reserve withdrawal is authorized. These swap/prefund endpoints are not idempotent: inspect the audit/receipt before retrying an uncertain write.

The legacy USD-payment webhook assumes one USD per share and is deliberately disabled for cashier agreements. It must not silently issue fixed-NAV shares at the wrong price. The legacy unbounded swap endpoint also refuses cashier agreements; use the bounded route above.

## Verification and limitations

```sh
pnpm run build:cashier
pnpm run test:chain:cashier
pnpm test
```

Tests use the real v4 PoolManager on Anvil: both mint/burn directions, ordinary AMM fills, failed eligibility and World ID, reserves, cap, full-fill/slippage/deadline limits, fake-router rejection, transient settlement isolation, and alternative NAV/fees/pool settings.

A 25 bps fee below a 30 bps LP fee is **not** a universal no-arbitrage or no-LP-loss proof. Auto routing can prefer the cashier even at spot NAV because the LP fee makes pool execution worse. A stale or manipulated AMM can still offer a favorable trade that costs LPs. NAV correctness, issuer privileges, reserves, eligibility, gas and transaction ordering remain risks. Custodial issuance remains privileged and is not automatically reserve-backed. Fixed DEMO NAV is not a live NAV oracle; this prototype has not been audited.
