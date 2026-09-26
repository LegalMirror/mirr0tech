# Investor authentication: contract, tests and integration handoff

`src/investor-auth.js` issues **our limited application sessions**, not the World ID recurring-session protocol. It combines an EOA wallet signature with a World ID v4 Passport uniqueness proof. It does not implement World `session_id` / `session_nullifier`, and `WorldIdVerifier` rejects those proof types.

**Evidence boundary:** Sandbox is supported, alongside staging and production configuration. The automated success cases use synthetic proofs and injected provider responses. **A live Passport proof has NOT actually been completed or verified with World in this work.** Neither Sandbox configuration, an SDK-shaped context, a passing fake-provider test nor a localmock session establishes live proof completion. No real secrets, `.env`, RPC, external verifier calls or deployment artifacts are used by the new unit suite.

## Security and authorization boundary

- Wallet authentication uses `ethers.verifyMessage` over the exact server-issued **EIP-191** message. Ordinary 65-byte and compact 64-byte EIP-2098 signatures are accepted. This is EOA signature recovery, not EIP-1271 / ERC-6492 contract-wallet authentication, SIWE parsing or a transaction signature.
- The message binds wallet, fund ID, policy hash, chain, origin, challenge nonce, issued World nonce, credential, environment, mock flag, action, RP/app IDs and issue/expiry times. The client must sign it unchanged.
- A valid signature is checked **before** proof inspection, fund re-resolution and provider verification. The actual World verifier checks Passport schema `9303`, identifier `passport`, configured action/environment and `hashSignal(wallet.toLowerCase())`. Live proof nonce must equal the issued nonce; the module does not substitute a nonce or signal to make a foreign proof pass.
- Only after verified success and registry binding does the module return an opaque `ia_...` bearer token. Its server-side SHA-256 digest indexes an in-memory session. Tokens are not JWTs and do not carry client-editable authority.
- Internal sessions have `role: 'investor'`, immutable verification provenance, one fund/wallet/policy/chain scope and a fresh server-only `id` generated from 32 cryptographically random bytes (64 lowercase hex characters). Concurrent logins in the same second receive different IDs even when all scope and expiry fields match. `publicSession()` remains unchanged and omits this ID, the nullifier, verification result, role, RP/app IDs and token. Do not serialize the internal session directly. The ID is for server-side intent binding, not an additional bearer credential.
- Login does **not** invoke chain writers, attest compliance, authorize trading, confer KYC/AML approval or grant operator/viewer credentials. Any later identity attestation is a separate bounded service operation; approvals/trades still require the browser wallet and current policy checks.
- An investor bearer must never satisfy the existing operator gate, grant generic fact writes, deploy/fund contracts, impersonate another wallet or change its fund through a request body. The unit suite tests investor-only session authority and traps privileged venue calls; the parent must also test HTTP route separation after mounting.

## Exact module interfaces

```js
const auth = new InvestorAuth({
  resolveFund,     // async (fundId) => { id: fundId, venue }
  allowedOrigins, // explicit array of canonical HTTP(S) origins, no path or wildcard
  ttlSeconds,     // integer 1..900; defaults to 900
  allowLocalMock: false, // trusted boolean opt-in; defaults to false
  clock,          // () => epoch milliseconds; defaults to Date.now
});

const challenge = await auth.challenge({ wallet, fundId }, { origin, clientIp });
const issued = await auth.verify({ challengeId, signature, proof }, { origin, clientIp });
const internalSession = await auth.authenticate(rawAccessToken); // ASYNC; must await
const revoked = auth.revoke(rawAccessToken);                    // synchronous boolean
const safeSession = publicSession(internalSession);
```

These are exact request shapes: extra fields are rejected. `origin` and `clientIp` are request metadata assembled by the server, **not body fields**. Extract the raw token from `Authorization: Bearer ...` in HTTP middleware; passing the whole header to `authenticate()` fails. `allowLocalMock` is constructor-only trusted configuration, never a request field. Non-boolean values are configuration errors; strings such as `"false"` or `"true"` are not coerced.

The bootstrap in `scripts/dev-stack.js` passes `allowLocalMock: process.env.INVESTOR_ALLOW_MOCK === 'true'`. The module does not read that variable itself. Missing/disabled opt-in denies mock investor login even if `WorldIdVerifier` automatically selected mock mode or was explicitly constructed with `mock: true`.

Default origins are `https://legalmirror.github.io`, plus `http://localhost:3100` and `http://127.0.0.1:3100` outside `NODE_ENV=production`. Prefer explicit deployment configuration. Maximum configured origins: 32. Origin checks are not proof of wallet ownership: non-browser callers can set this header.

The resolver is a trusted integration interface. It must allow only deliberately published funds and return a matching `id`; do not resolve arbitrary uploaded agreements. Required venue shape:

```text
venue.record.chainId                         positive safe integer
venue.record.rwa.policyHash                  32-byte hex deployment hash
venue.policies.rwa.policy.hash               if supplied, must match deployment hash
venue.worldId.verifier.context()             async public signed World request context
venue.worldId.verifier.verify(proof, wallet) async verification result
venue.worldId.verifier.mock                  boolean
venue.worldId.verifier.credential            "document"
venue.worldId.verifier.action                bounded nonempty action
venue.worldId.verifier.environment           sandbox | staging | production for live mode
venue.worldId.verifier.rpId / appId           configured live identifiers
venue.worldId.registry.bind(nullifier, wallet) async atomic, durable binding for live mode
venue.worldId.registry.path                  nonempty durable-storage indicator for live mode
```

`InvestorService.resolveFund()` is the existing published-fund resolver to adapt. Bind it to its service instance when passing it as a callback. The module checks the registry interface/path, not actual storage durability; the integrator must supply a real durable `HumanRegistry` or equivalent transactional implementation. Keep mock, Sandbox/staging and production bindings separate, with deliberate RP/action/policy scoping. A canonical nullifier cannot be rebound to another wallet; the same wallet can sign in again with a fresh verified proof. See [WORLD_ID.md](WORLD_ID.md) for registry persistence and recovery constraints.

Response contracts:

| Operation | Result |
| --- | --- |
| `challenge()` | `{ challengeId, message, expiresAt, wallet, chainId, fundId, world }` |
| `verify()` | `{ accessToken, expiresAt, session }`; `session` is the public projection |
| `authenticate()` | Frozen internal scoped session, including server-only `id`, `expiresAt`, `role`, action/RP/app and frozen `verification` |
| `publicSession()` | `{ wallet, fundId, policyHash, chainId, credential, environment, mock }` |
| `revoke()` | `true` when a stored token was deleted, otherwise `false` |

Response timestamps are Unix **seconds**; the injected clock supplies **milliseconds**. `world` contains only the whitelisted public context and signed `rp_context`, never the RP signing key. The browser must use that context, Passport with the lowercase wallet as signal, and `allow_legacy_proofs: false`; send the complete resulting v4 proof unchanged.

## Parent-owned HTTP mount: `/v1/investor`

The module does not create Express routes itself. `src/investor-api.js` now mounts the routes through `createApp`, before operator authentication; `test/investor-api.test.js` covers HTTP privilege isolation. The existing investor client expects these paths, with service methods supplied by `InvestorService`:

| Method/path under `/v1/investor` | Adapter / authorization |
| --- | --- |
| `GET /config` | `service.config()`; public, safe fields only |
| `GET /funds` | `await service.funds()`; public, published funds only |
| `POST /auth/challenge` | `await auth.challenge(body, metadata)`; no operator key |
| `POST /auth/verify` | `await auth.verify(body, metadata)`; no operator key |
| `GET /me` | `await service.snapshot(session)` after `await auth.authenticate(token)` |
| `GET /activity` | `await service.activity(session)` with authenticated scope |
| `POST /identity` | `await service.attestIdentity(session)`; separate bounded identity operation |
| `POST /quote` | `await service.quote(session, body)` |
| `POST /transactions/prepare` | `await service.prepare(session, body)`; unsigned transaction preparation only |
| `POST /transactions/confirm` | `await service.confirm(session, body)` |

Expose logout/revocation through an investor-only adapter calling `auth.revoke(token)` if desired; its HTTP path is not specified by the current client. Do not turn any service request body into an internal session.

Mount the dedicated investor router separately from the operator bearer gate without weakening that gate for other `/v1` routes. Required integration checks:

1. Public discovery/challenge/verify must not need an operator secret; protect only the explicit investor service routes with the investor token middleware. Unknown paths must not fall through into an investor-authorized operator router.
2. Derive `clientIp` from the socket or a carefully configured trusted proxy. Never trust arbitrary `X-Forwarded-For`, client-provided IPs or wildcard proxy trust. Both IPv4 and IPv6 are accepted; equivalent IPv6 spellings share a budget.
3. Apply bounded JSON parsing, explicit investor CORS/preflight rules and `Cache-Control: no-store`. The auth module validates login origins but does not implement HTTP CORS, parse bodies or set response headers. Keep investor bearer responses out of shared caches.
4. Await `authenticate()` on every protected request, use its internal session, and let the service recheck deployed/on-chain scope. Bind trading intents to `session.id` in addition to their wallet/fund/policy/chain scope; scope plus expiry alone cannot distinguish same-second logins. The client must not choose or override this ID. Return only safe projections. In particular, never attach an unresolved Promise as the session.
5. Keep browser tokens in memory, clear them on logout/account/chain changes and revoke server-side when available. A session token is a bearer capability: after login it is not cryptographically bound to each HTTP request's origin or IP.
6. Never log raw tokens, wallet signatures, proofs, nullifiers or RP secrets. Return sanitized error messages; do not spread verifier objects into responses.
7. Add ingress rate limits and operation deadlines. Module rate/in-flight limits cover `challenge()` / `verify()`, not `authenticate()` or all service operations. Resolver/context/registry interfaces must settle within an operational deadline; an HTTP timeout alone does not cancel their work.
8. Reject investor tokens on every existing operator route in parent-owned integration tests. The standalone module suite does not establish Express isolation, real-chain behavior or browser end-to-end success.

## Lifetime, replay and capacity behavior

Challenges live at most 300 seconds, shortened to the World context expiry. A ready challenge is consumed synchronously before any verification await, including rejected signature/proof attempts. Simultaneous replay therefore cannot produce two sessions. Challenges are independent even for the same wallet/fund/origin: a new unsigned request cannot cancel another client's ready, creating or verifying login. Each challenge occupies its own bounded slot. At capacity, new requests fail rather than evicting an existing challenge; consuming or expiring a challenge reclaims its slot.

The module snapshots bounded JSON proof data before its first verification await. Caller mutation cannot swap the nonce, wallet signal or nullifier in flight. It rechecks challenge validity and fund scope after async work, including provider verification and registry binding. Expiry or a scope change prevents session issuance. If binding has already persisted when expiry or a scope change is noticed, it is intentionally retained, not undone. A failure consumes only that request's challenge, not another login's challenge.

Token expiry is fixed, not sliding. `authenticate()` re-resolves the fund and checks scope, token expiry and revocation **again after awaiting**. Scope changes, unpublished/unavailable funds and invalid configuration invalidate and delete the token. A temporary resolver failure also invalidates it: the user must log in again. Revocation removes the app token, not a World binding or an on-chain fact. Restarting the process loses all app sessions and challenges.

| Limit | Value / behavior |
| --- | --- |
| Challenge lifetime | 300 seconds maximum |
| Session lifetime | 1–900 seconds; default 900 |
| Active challenges | 256 |
| Sessions, including reserved issuance slots | 256 |
| Concurrent challenge/verify operations | 32 shared slots |
| Rate window | 60 seconds per process |
| Challenge requests | 10/IP/window; 600 globally/window |
| Verify requests | 20/IP/window; 1200 globally/window |
| Combined route/IP rate keys | 1024; hashed keys, bounded map |
| Proof JSON size | 16,384 UTF-8 bytes |
| Proof structure | 256 visited nodes, depth 8, 32 array items/object keys, key length 64, string length 2048 |

Malformed bodies still consume rate budget after origin/IP validation. Expired state is pruned lazily on requests/authentication, not by a timer. Reservations prevent concurrent successful verifications from overfilling session storage; failures release them. Bounds are per process, not distributed anti-abuse protection. Multi-worker deployments need deliberate shared session/rate-limit design or sticky routing; a durable human registry alone does not share app tokens.

Common failures include `INVALID_SIGNATURE`, `INVALID_PROOF`, `CHALLENGE_INVALID`, `AUTH_SCOPE_CHANGED`, `INVESTOR_UNAUTHORIZED`, `AUTH_RATE_LIMITED`, `AUTH_BUSY`, `AUTH_CAPACITY`, `WORLD_TIMEOUT`, `WORLD_UNAVAILABLE`, `HUMAN_ALREADY_BOUND` and registry errors. Failed/expired/consumed challenges require a fresh challenge, signature and proof; never silently replay a failed provider submission or convert an existing registry binding into verification success.

## Localmock policy and resolved security findings

Enforced policy: **only explicit `allowLocalMock: true`, only chain 31337, and only while `NODE_ENV !== 'production'`**. All three conditions are checked when resolving scope during challenge creation, verification and token authentication. Such sessions remain labeled `mock: true`, `environment: "mock"`. Their deliberately forgeable fixtures are not Passport verification. Mock proof nonces/signals are intentionally not checked as live cryptographic bindings by `worldid.js`; do not export this exception to Sepolia or any live chain. The World verifier also rejects production mock configuration at construction.

The initial review found two issues, both now addressed in `src/investor-auth.js` without changing `worldid.js`:

1. **Implicit mock fallback:** investor authentication no longer infers opt-in from the verifier's resolved `mock` boolean. A default-false constructor flag denies automatic fallback, and explicit verifier mock mode alone is also insufficient. Nonlocal chains and production remain denied even with opt-in. The formerly failing implicit-mock regression now asserts successful denial.
2. **Unsigned cross-client cancellation:** issuing a new challenge no longer deletes earlier challenges for a public wallet/fund/origin. Tests prove that an unsigned request or a failed attacker signature from another IP cannot cancel a victim's login, including during context creation, provider verification and registry binding. Replay checks remain per-challenge and single-use; independent challenges still share the existing global memory/rate/in-flight bounds.

Additionally, every issued internal session now has a fresh random `session.id`, preventing same-second logins from sharing a session identity. This is not an operator key or token privilege. The unchanged public projection excludes it; presenting the ID to `authenticate()` or `revoke()` does not authorize or revoke a session. Parent-owned trading service integration must use that ID in its intent binding and continue checking the original scope.

Remaining operational boundaries: unauthenticated clients can still consume the bounded global challenge capacity, so ingress anti-abuse limits matter; the module does not provide distributed rate limiting or deadlines for every injected dependency. No source changes here assert completion of HTTP/operator isolation, service intent binding or real World Passport verification.

## Validation

From the repository root:

```sh
node --test test/investor-auth.test.js
node --test test/worldid.test.js test/worldid-live.test.js test/worldid-registry.test.js
```

The new suite exercises the actual async API with an injected venue/resolver, `WorldIdVerifier` with fake transport, public synthetic EOA keys, in-memory `HumanRegistry` behind an injected registry interface, fake contexts and an injected clock. Unexpected global `fetch` is forbidden. Tests cover successful scoped sessions, exact nonce/signature binding, foreign wallet/fund/hash, proof bounds, provider/registry failures, sanitization, replay and independent-challenge races, expiry/revocation, all scope fields, server-only session-ID uniqueness, public projections, no operator capability, memory/rate/concurrency boundaries and mock isolation. Gates rather than sleeps control race tests; only the dedicated injected-transport timeout test uses a short real timer.

Validation after the fixes: **181/181 investor-auth checks passed** and **107/107 existing World ID checks passed**, including a combined run of all **288 checks** with no failures, skips or TODOs. The changed source and test files also have no editor diagnostics. The security regressions assert denial of implicit mock login, isolation of independent challenges and private, unique session IDs. Passing fake-provider tests must not be presented as live World Passport verification. Express mount, environment bootstrap, service intent binding, README changes and route-level authorization tests remain parent-owned; real Passport completion remains an explicit uncompleted integration step.
