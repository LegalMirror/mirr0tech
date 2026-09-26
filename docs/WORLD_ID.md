# World ID in mirr0tech

## The trust moment: before money or permissions move

The issuer's agreement determines which facts must hold before **share issuance, policy-hooked pool admission, and cashier buy/sell operations**. World ID supplies one narrowly scoped credential check at onboarding; it does not replace the agreement's other conditions. The application calls this fact `identityVerified` for compatibility with the compiled policies. Read that name as **“the configured World ID credential was verified for this wallet and action”**, not “legal identity and all compliance checks completed.”

Exhibit A's KYC/KYB, AML and sanctions obligations remain separate. `kycApproved`, `amlApproved`, `sanctionsClear`, issuer authorization, subscription acceptance, offering restrictions, funding and cashier/NAV limits require their own evidence and attestations. A successful World ID proof alone must not make a wallet eligible to mint, trade or redeem. The deployed policy must actually require the credential fact at each intended gate; the verifier itself does not execute or authorize a financial operation.

### Minimum proportional credential, chosen by the issuer

Choose the least intrusive supported credential that satisfies the specific trust requirement. This is an issuer/policy decision, not a frontend downgrade and not a claim that every KYC process requires an NFC passport.

| Server setting | IDKit v4 preset / identifier | Schema | Supported assurance, not an identity disclosure |
| --- | --- | --- | --- |
| `document` (existing default) | `passport()` / `passport` | `9303` | An enrolled unique government document (NFC credential); document-level duplicate resistance, not universal one-person-one-wallet. |
| `proof_of_human` | `proofOfHuman()` / `proof_of_human` | `1` | Orb-backed proof of a unique human. It does not disclose their legal identity. |
| `selfie` | `selfieCheck()` / `selfie` | `11` | Medium-assurance liveness/abuse resistance, with a verified integer Sybil risk score. It is **not** a strict one-person-one-account guarantee. |

The proof establishes the selected credential's supported claims. This integration does **not** request name, passport number, nationality, age, or other legal identity attributes. A document credential is not disclosure of those attributes and does not, by itself, satisfy full KYC/KYB/AML or sanctions screening. Selfie risk scores are forwarded for World to authenticate; this integration does not invent a score threshold or use the score as a uniqueness verdict. Identity Check preview, compound constraints, recurring session authentication and wallet-signature authentication are outside this gate.

## Backend verification contract

`src/worldid.js` provides `WorldIdVerifier`, `HumanRegistry`, and the deliberately forgeable `mockProof` test helper.

1. `context()` generates the public `rp_context` with the installed SDK's **server-only** `signRequest` helper. Live context requires `WORLD_RP_ID`, `WORLD_APP_ID` and a valid `WORLD_RP_SIGNING_KEY`. Missing or invalid signing configuration fails; it never returns `0xmock` as a live signature. The key is not returned to the browser or included in the verification request.
2. IDKit must request one configured v4 uniqueness credential with the actual wallet address as `signal`, the configured action/environment, and `allow_legacy_proofs: false`. The backend requires a wallet address, mandatory `signal_hash` equal to the SDK's `hashSignal(wallet.toLowerCase())`, the exact numeric schema and identifier, a bounded hexadecimal nullifier, expiry, nonce and five `uint256` proof elements. It never fills in missing proof fields or rewrites a foreign signal to the target wallet.
3. For Selfie Check, the integer `sybil_score` and complete version 2 `integrity_bundle` are required. The bundle is not locally treated as authenticated; World must verify it along with the proof.
4. The complete checked IDKit payload is forwarded unchanged to `POST https://developer.world.org/api/v4/verify/{rp_id}`. The endpoint is server-configured, HTTPS-only, with redirects disabled. A bounded timeout covers both the HTTP request and JSON body reading (default **10 seconds**, configurable with `WORLD_VERIFY_TIMEOUT_MS`, range 1–120000 ms).
5. A 2xx response is **not** sufficient. The provider must return `success: true` and exactly one matching `results` item with `success: true`, the requested identifier, and the same valid nullifier. Empty/non-JSON bodies, missing fields, false results, foreign nullifiers, partial/multiple results and inconsistent metadata are rejected. The official success schema makes top-level action/environment/nullifier echoes optional; if present they must match. The locally checked action, environment, schema and wallet signal are part of the submitted proof that World verifies. The documented result does not echo a signal/schema, so neither is fabricated from provider data.
6. Only after verification succeeds may the caller durably bind the canonical nullifier to the wallet, then attest the credential fact. Failed verification or persistence must not grant a fact. Results include `credential`, `environment`, and an explicit `mock` flag; preserve this provenance in API responses and audit entries.

**Why v3 is deliberately rejected:** installed IDKit 4.3.0 can return a legacy `protocol_version: "3.0"` response with an encoded proof string and `merkle_root`, but without `issuer_schema_id` or v4 expiry. It cannot simply pass the v4 credential check by omitting the schema. This gate requests only v4 and rejects legacy, session and multi-response proofs. Supporting legacy later requires an explicit credential mapping, migration policy, and tracking both old/new nullifiers to prevent duplicate claims—not merely enabling the widget fallback.

A wallet-bound signal prevents applying the proof to a different wallet. It is **not** proof that the HTTP caller controls the wallet's private key; wallet/session authentication and operator authorization remain separate integration requirements. Provider verification remains the cryptographic authority; local shape checks alone do not verify a zero-knowledge proof. Replayed or already-used proofs rejected by World are not converted into success from a cached binding.

## Configuration and local simulation

Server-only variables:

- `WORLD_RP_ID`: registered `rp_...` relying party.
- `WORLD_APP_ID`: the matching `app_...` application.
- `WORLD_RP_SIGNING_KEY`: RP signing key; keep in server secrets, never a `NEXT_PUBLIC_*` variable, frontend bundle, request log or source file.
- `WORLD_ACTION`: action registered/configured for this onboarding policy; default `onboard-investor`.
- `WORLD_ENVIRONMENT` (or `WORLD_ENV`): `staging` (current default), `sandbox`, or `production`; match IDKit and the registered RP's intended environment.
- `WORLD_CREDENTIAL`: one of the issuer-selected settings above.
- `WORLD_VERIFY_TIMEOUT_MS`: bounded upstream deadline.
- `WORLD_VERIFY_URL`: optional trusted operator endpoint override; do not let an HTTP client choose it. Tests inject `fetchImpl` instead of contacting World.

For compatibility with the local stack, **no RP/app/signing configuration in a non-production environment** selects mock mode; callers may explicitly use `mock: true` for local simulation or `mock: false` to require live configuration. Partial or blank configuration fails instead of quietly becoming mock. `NODE_ENV=production` or `WORLD_ENVIRONMENT=production` prohibits mock mode, including explicit `mock: true`.

Mock context and verifier results say `mock: true` and `environment: "mock"`. Only fixtures explicitly marked with `identifier: "mock"` are accepted there; live mode rejects that identifier. The helper intentionally supports named wallets such as `Investor`, and replaying one fixture for a second wallet so the **local registry refusal** can be demonstrated. That exception does not exist in live verification. A mock signature, synthetic nullifier, or injected-provider success is never evidence of live World verification.

Staging and sandbox are also not production assurance. Keep their registries and attested facts separate from production. Do not point a mock demo at production contracts or reuse its fact store for a live demonstration.

## Persistent nullifier registry

Supply `new HumanRegistry(path)` to retain bindings. `new HumanRegistry(null)` is intentionally in-memory for tests/local use; persistence is not automatic merely because a verifier is live.

- Only a missing initial file can initialize an empty registry. Malformed JSON, invalid records, inconsistent numeric aliases, read errors and write errors fail closed; corruption is not silently replaced with `{}`.
- Nullifiers are canonicalized to lowercase, zero-padded 32-byte hex; changing case or leading zeroes cannot evade a binding. Wallet comparisons are case-insensitive. The same nullifier may be bound again to the same wallet, but a different wallet receives `HUMAN_ALREADY_BOUND` (409).
- Operations sharing a resolved path serialize within the process. Each writer acquires an exclusive `.lock` file and rereads the snapshot before changing it. A conflicting/stale lock fails with `REGISTRY_BUSY`; it is never automatically stolen.
- Snapshots use a random exclusive temporary file (permissions `0600`), file sync, atomic rename and directory sync. The in-memory map is published only after persistence succeeds. An active instance also rejects disappearance or replacement of its observed bindings.
- The registry enforces **one verified nullifier → one wallet within the chosen verification scope**, not legal identity, global personhood, or an assertion that one human can never obtain multiple document credentials. The caller must keep mock/live environments and intended RP/action/policy scopes separate.

Use a durable local filesystem with atomic rename and exclusive-create semantics. Multi-host deployments should use a transactional database with a unique scoped-nullifier constraint instead of assuming this file protocol is a distributed lock. Preserve and back up registry files. After a process crash, inspect a stale lock and confirm no writer is running before an operator removes it. Do not recover by deleting the registry. A fresh process cannot distinguish a genuinely new registry from a deleted file, or detect every structurally valid rollback; deployment provisioning, backups and database integrity controls must cover those cases.

If the on-chain attestation fails after binding, the binding is intentionally retained. Operator recovery must not free that nullifier for another wallet. One-time World verification and chain submission are not a distributed transaction; automatic proof replay/retry is not a demonstrated recovery mechanism here.

## Judge-facing paths and evidence

| Path | Expected decision and honest presentation |
| --- | --- |
| Verified credential | Only after the backend receives a matching successful World result, persists the binding and successfully attests may the UI show the credential fact as verified. Issuance/pool/cashier still require all other policy facts. Display environment and credential. |
| Wrong credential | `WRONG_CREDENTIAL`; explain the issuer-selected requirement, with no automatic weaker fallback. |
| Foreign wallet, missing signal/schema, malformed or legacy proof | `INVALID_PROOF`; no binding or credential fact. A reused live proof aimed at another wallet is normally rejected here before the registry. |
| Already-bound nullifier | `HUMAN_ALREADY_BOUND`; no second wallet binding. The explicit mock helper can demonstrate this path locally without claiming a live cross-wallet replay succeeded. |
| Cancelled/denied by the user | Do not submit verification or synthesize success. Leave an unverified wallet unverified; explain the still-missing policy requirement and allow a deliberate retry. Cancelling does not revoke an earlier valid fact. |
| Provider outage, timeout, incomplete/false response, registry error | No new fact; show refusal/retry or operator-repair guidance, never a green success state. |

**Evidence boundary:** automated tests exercise the live verifier branch with a **fake provider**, SDK signing/hash behavior, all three credential shapes, malformed/false/empty upstream responses, missing fields, foreign signals, timeouts, and persistent-registry failures/concurrency. They do not obtain a proof from World App or call World's verification service. **Real upstream live success has not yet been demonstrated in this audit without registered app/RP credentials and a user-completed proof.** A completed local/mock chain flow must be labeled as such. No measured time-to-first-live-success is available; no debrief duration is asserted.

To close the live-evidence gap: configure a real app/RP/action and server signing key; use the matching credential in World App; retain redacted evidence of the backend's successful matching provider result and subsequent chain receipt; then exercise cancelled, wrong-wallet, wrong-credential and outage paths. Never include the signing key or raw integrity JWT in demo evidence.

Run the focused regression suite:

```sh
node --test test/worldid*.test.js
```

## Integration handoff (outside this backend file's ownership)

Verify these with the venues/frontend owners before claiming the whole application is fail-closed:

- `src/onchain/venues.js`: bind **before** attesting, keep unrelated facts, and preserve verifier `mock`, `environment`, `credential` and action provenance in successful responses/audits. Generic `attest`/`attestMerged` paths must not grant `identityVerified: true` without the verified-credential path; any privileged recovery route needs explicit authorization and auditing. Explicit false/revocation can remain supported.
- Require durable registry storage for live venues rather than the constructor's in-memory fallback. `scripts/dev-stack.js` currently supplies a chain-based registry shared with agreement venues; decide the intended RP/action/policy scope and separate mock/staging/production storage before a live deployment.
- Bound attestation lifetimes on the server; do not let client-controlled `days` turn a one-time credential result into an arbitrary-lived fact or refresh unrelated expired compliance facts. The credential gate does not decide those facts' validity periods.
- `verifyHuman` must use the correct deployed policy/attestor and ensure the intended issuance, pool and cashier policies require the credential fact. Do not claim cashier enforcement merely because the World ID backend is present.
- The dashboard should use `passport`, `proofOfHuman`, or `selfieCheck` for the selected credential, `allow_legacy_proofs: false`, the context environment, and the actual wallet address as signal. Keep the whole IDKit result, including Selfie integrity material. Its mock helper must use the selected schema. Render cancellation/denial honestly, and only mark success after backend verification and chain attestation—not merely IDKit's completion callback.

Related routes: `GET /v1/stack/worldid/context`, `POST /v1/stack/wallets/:wallet/worldid`; related integration: `src/onchain/venues.js` `verifyHuman`, `dashboard/app/_components/HumanCheck.tsx`. No signing secret belongs in those client components.

## Feedback for World: testing is the hard part

Integrating IDKit took an afternoon. **Getting one test proof to verify** took the rest of the day, and the path to it runs through an undocumented Portal tool behind a team-wide admin key. In order, as it happened on 2026-09-26:

1. **We followed the docs.** The integration guide says: "To test during development, use the simulator and set `environment` to `staging`." We did, with an action registered in the Portal.
2. **World refused the proof:** `environment_not_allowed · Staging verification is not open for this app. Open a staging window with the set_world_id_staging_verification tool…`. The Developer Portal web UI has no such control, and the tool is missing from the documented Developer Portal MCP tool table, which lists eleven tools and not this one.
3. **The tool exists only in the Developer Portal MCP**, which authenticates with a **team API key that can change every app in the team**. To test with a *simulator*, a developer has to mint a team-wide admin key and hand it to an AI assistant, or speak MCP JSON-RPC by hand. We pasted it into an LLM chat, and it is now a secret we have to rotate.
4. **The window returns a second secret.** `set_world_id_staging_verification` answers with a token, "shown once", valid for 24 hours, that must be sent as an `x-staging-verification-token` header on every `/api/v4/verify` call carrying staging **or sandbox** proofs. The Verify API reference documents `environment: staging | sandbox` and says nothing about this header, so every server that follows it fails.
5. **Actions are per environment.** Our `login` and `onboard-investor` actions existed in production; the simulator needed separate staging copies. The Portal MCP's `create_world_id_action` offers `production` and `staging`, and no `sandbox`.
6. **Sandbox is a second gated product.** It needs a separate sandbox World ID app, from TestFlight or a private Play track after a tester request. It documents only Selfie Check. Our session request reached the sandbox app, which answered through the bridge, and IDKit reported `generic_error`, with no mapped code for what the app refused.
7. **The simulator's identity level is a surprise.** A legacy Orb request returns the identity's *highest* credential, so a simulator identity without Orb returned a device or document level. That is documented, but only in the migration guide.
8. **A passport cannot be tested.** Our trust moment needs the passport credential (9303). Nothing in the docs says whether sandbox or the simulator can issue one. As far as we can tell, the only way to see a passport proof is production World App with a real passport tapped over NFC.
9. **The signal is hashed as bytes, and nothing says so** (see below).

**Asks, in order of impact:**
- Open staging verification for development apps by default, or put the window behind a button in the Portal UI next to the actions.
- Document `x-staging-verification-token` in the Verify API reference and the simulator guide, and show the token in the Portal.
- Offer scoped keys (one app, one capability) before steering developers to hand keys to agents.
- Provide a test passport credential in sandbox or the simulator, or state plainly that none exists.
- Map the sandbox app's refusals to specific IDKit error codes instead of `generic_error`.

At the time of writing, no staging or sandbox proof has verified end to end for us; the unit and HTTP tests run against a fake World verifier.

## Official sources and integration notes

Audit sources were the installed `@worldcoin/idkit-core@4.3.0` types, presets, hashing and signing exports (`@worldcoin/idkit-server@1.1.1`), plus the official docs MCP at [docs.world.org/mcp](https://docs.world.org/mcp). The [Developer Portal MCP](https://developer.world.org/api/mcp) requires an API key for its tools; its unauthenticated rejection is not live verification evidence. Public documentation and the Developer Portal OpenAPI schema were retrieved through the docs MCP instead.

- [IDKit integration and response shapes](https://docs.world.org/world-id/idkit/integrate)
- [v4 verify request and per-result success schema](https://docs.world.org/api-reference/developer-portal/verify)
- [Credential presets](https://docs.world.org/world-id/idkit/credentials)
- [NFC/document credential 9303](https://docs.world.org/world-id/credentials/9303)
- [Proof of Human credential 1](https://docs.world.org/world-id/credentials/1)
- [Selfie Check credential 11](https://docs.world.org/world-id/credentials/11)
- [v4 on-chain proof encoding (`uint256[5]`)](https://docs.world.org/world-id/idkit/onchain-verification)
- [v4 migration and legacy nullifier tracking](https://docs.world.org/world-id/4-0-migration)

**The signal is hashed as bytes, and nothing says so.** A signal that looks like hex (`0xEE48…`, a wallet) is hashed by IDKit as its 20 bytes, and as its 42 characters by a server that follows the docs; every proof is then refused, indistinguishable from a forgery. We use `hashSignal` from `@worldcoin/idkit-core/hashing` on the server, so both sides apply one rule (`0x` + valid hex → bytes, anything else → UTF-8), and `test/worldid.test.js` locks it for the wallet signal and the login signal. Ask: document the rule beside `signal`, and publish `hashSignal` for other languages.

Actual integration friction: IDKit needs a preset/constraint and explicit legacy policy; RP context must be signed on the server; a v4 endpoint HTTP 200 can include failed proof items. The SDK makes signal optional for general integrations, but it is mandatory for this wallet-bound gate. A useful documentation improvement would be a complete application-level server example validating the selected per-credential result, wallet signal, cancellation/retry semantics and durable nullifier binding—not just forwarding an HTTP status.
