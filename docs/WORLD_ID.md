# World ID in mirr0tech

**The trust moment.** Exhibit A of the fund's transfer-agent agreement makes Securitize "perform Know-your-customer (KYC), Know-your-business (KYB), Anti-Money Laundering (AML), and sanctions checks during onboarding of investors". Shares are issued, and a wallet is admitted to the Uniswap pool, only after that. The event is investor onboarding: before the token is issued to a wallet, and before the hook lets that wallet into a pool.

**The credential, and why it is the minimum.** KYC is an identity check. A proof of human says a person exists; a selfie says the person is live and unique; neither says who. A government document does, and a passport read over NFC is the least a KYC step can accept. So the default is the **Document (Passport/NFC) credential**: one credential, verified once, no Orb, no extra proofs. `WORLD_CREDENTIAL` lowers it to `proof_of_human` or `selfie` for a deployment whose agreement asks less.

**What the proof becomes.** The compiler turns the sentence into a fact, `identityVerified`, required to be issued shares and to move them at the pool. The gateway verifies the proof with World (`POST /api/v4/verify/{rp_id}`, the request signed server-side), refuses a proof whose signal is not this wallet, binds the nullifier to the wallet so one person cannot onboard twice, and attests the fact with an expiry. From then on the hook, the mint and the pool read it like every other fact; nothing about World ID lives in the contracts.

**Paths shown.** Success: the Investor verifies, `identityVerified` turns true, issuance and the pool open. Alternatives: the Stranger reuses the Investor's proof and is refused (`HUMAN_ALREADY_BOUND`: one human, one wallet); a malformed or foreign-wallet proof is refused (`INVALID_PROOF`); closing the widget leaves the wallet in review with the sentence that still blocks it. Without a registered app the same paths run on a mock verifier.

**Where.** `src/worldid.js` (verifier, registry, mock), `src/venues.js` `verifyHuman`, `POST /v1/stack/wallets/:wallet/worldid`, `dashboard/app/_components/HumanCheck.tsx` (IDKit widget), `test/worldid.test.js`, `test/chain/gateway.test.js`.

**Docs used.** [IDKit integration](https://docs.world.org/world-id/idkit/integrate) · [credentials](https://docs.world.org/world-id/idkit/credentials) · [Passport/NFC](https://docs.world.org/world-id/credentials/9303) · [Proof of Human](https://docs.world.org/world-id/credentials/1) · [Selfie Check](https://docs.world.org/world-id/credentials/11) · [verification flows](https://docs.world.org/world-id/idkit/verification-flows) · [Developer Portal](https://developer.worldcoin.org).

## Integration debrief

- **Time to first success:** about two hours from the docs to a verified proof attested on chain through the mock path; the real path needs an app in the Developer Portal.
- **Friction:** the widget's types require a `preset` or `constraints`; `allow_legacy_proofs` is mandatory and easy to miss; `rp_context` must be signed on the server and the helper lives in `@worldcoin/idkit-core/signing`, not the React package; the verify endpoint's exact body was spread across several `llms.txt` pages.
- **Missing:** a documented mock or simulator mode for `/v4/verify` so CI can run the loop without an app; a JavaScript example that forwards the IDKit result verbatim to `/v4/verify`.
- **One improvement with the greatest impact:** a server-side helper in `idkit-core`, `verifyResult(rpId, result, { signal })`, that signs, forwards and checks the signal, so an integrator writes only the trust decision.
