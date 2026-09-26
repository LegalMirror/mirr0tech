# DEMO ONLY — NAV cashier addendum

This is a separately authored simulation addendum. It is not part of the base BUIDL agreement and does not describe BlackRock or Securitize economics. No real assets, fiat settlement, or production NAV feed are represented.

## DEMO NAV
DEMO NAV is USD 1.00 per share; shares and mockUSD each use six decimals.

## DEMO subscription fee
The DEMO subscription fee is 25 basis points added to NAV, so exact-input subscriptions issue floor(mockUSD input / 1.0025) share units.

## DEMO redemption fee
The DEMO redemption fee is 25 basis points deducted from NAV, so exact-input redemptions pay floor(share input * 0.9975) mockUSD units.

## DEMO supply cap
The DEMO maximum outstanding supply is 1000000 shares, including custodial and cashier issuance.

## DEMO execution and reserves
The DEMO cashier may issue or redeem only for a wallet admitted by the transfer policy and the applicable issuance or redemption policy. Only full exact-input orders are supported. A trusted router may try the real AMM execution and revert that attempt if its output is below the cashier quote, then execute the cashier through Uniswap v4 custom accounting. Subscriptions must actually pay mockUSD into the cashier reserve; redemptions burn shares and pay only from prefunded available mockUSD reserves. A caller minimum output and deadline apply to both routes. Zero-output orders are refused. No reserve withdrawal is authorized in this demo.

## Limitations
The two fees define only a NAV band under fixed NAV, available reserves, and eligibility assumptions. They do not establish that all arbitrage is unprofitable or that LPs cannot lose. AMM execution, price manipulation, transaction ordering, gas, off-chain issuer decisions, and changes to real NAV remain risks. Operators may still use the existing custodial mint and burn paths; those shares are not automatically reserve-backed. World ID is an attested gateway fact, not an on-chain proof verifier.

Automatic routing compares full-input AMM execution, including the deployment-configured pool fee and price impact, with the cashier quote; it does not use slot0 as a price oracle. Thus even an AMM at spot NAV can be more expensive than the cashier. Explicit AMM mode opts out of the NAV comparison, but not transfer eligibility, full-input execution, minimum output or deadline checks. The AMM sqrt-price limit applies only to the AMM attempt; the caller minimum output bounds cashier execution. If automatic routing falls back to a cashier that lacks reserves, cap headroom or policy authorization, the whole order is refused rather than accepting a worse AMM fill. The fallback may consume additional gas. Only the configured share/mockUSD pair, static pool fee and tick spacing are supported. Those pool settings are deployment choices bound into the compiled policy, not inferred terms of the base BUIDL document.

The supported DEMO template permits numeric edits to the NAV, the two distinct fees and the cap in the sentences above, with their payout factors updated consistently. NAV and cap have at most six decimal places; fees are nonnegative integer basis points below 10000. The compiler checks the exact sentences and payout arithmetic, rejects conflicting duplicate terms, and commits the resulting typed constructor parameters, source clause ids, evidence hash and pool settings. Arbitrary prose is not interpreted as pricing authority.
