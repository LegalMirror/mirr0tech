# Anonymous demo workspaces

`src/demo-workspaces.js` exports `DemoWorkspaces` and `demoWorkspaceRoutes`. Visitors get a short-lived, randomly generated bearer capability without entering operator/viewer keys. This is **not anonymous operator access**: a capability owns only agreements created through that session.

This module does not enable itself or modify application wiring, the dashboard, investor authentication, deployment scripts, or environment files. The parent application must mount it explicitly.

## Integration contract

```js
import { dirname, join } from 'node:path';
import { DemoWorkspaces, demoWorkspaceRoutes } from './demo-workspaces.js';
import { stackStatus } from './agreements-api.js';

// The parent has already initialized its ONE shared Agreements instance and
// checked that the connected RPC/signer chain equals venues.record.chainId.
if (process.env.PUBLIC_DEMO === 'true') {
  if (!agreements.path) throw new Error('Persist Agreements before enabling a public demo');
  const workspaces = await new DemoWorkspaces({
    agreements,
    chainId: venues.record.chainId,
    path: join(dirname(agreements.path), 'demo-workspaces.json'),
    deploysPerInterval: 5,
  }).init();
  app.use('/v1', demoWorkspaceRoutes(workspaces, () => stackStatus(venues)));
}
// Mount parent investor authentication/routes, then operator authentication
// and existing agreement/operator routes. Keep their authorization checks.
```

Ordering and deployment requirements:

1. Mount the router at **`/v1` before operator auth, general body parsers and any catch-all investor auth**. The router installs its own size-limited JSON parsers and consumes every matched demo request, including forbidden/unknown routes. Existing CORS/OPTIONS middleware may precede it.
2. Pass the **same `Agreements` instance** used by the operator routes. Its deployment queue now serializes all agreement deployer calls, not just demo calls. Pending records remain `deploying`; `jobs` and `settled()` include queued deployments. A failed job does not poison the queue. This is not a coordinator for other signer-using services or multiple processes.
3. Pass the actual, verified numeric RPC chain ID. Only **31337 and 11155111** are accepted; all other values throw `CONFIG` at construction. The router does not independently select, reconnect, or verify the RPC. The parent must not switch the deployer to another chain after construction.
4. Persist both agreement records and the separate workspace state. A workspace `path` is **required on Sepolia**. Omission is allowed only for local chain 31337 (ephemeral local tests). Do not reuse the agreement JSON path.
5. Run **one process / one `DemoWorkspaces` instance / one shared `Agreements` instance** for a public demo. Atomic JSON writes do not provide a distributed lock; do not run replicas or multiple independent budgets against one signer. Scale-out requires a shared transactional quota/ownership store and signer coordination.
6. Keep operator keys backend-only, but keep the operator API for maintenance. Reserve the `demo_` bearer namespace for this router. Investor tokens are not accepted, transformed, or upgraded here: non-demo Authorization headers pass unchanged to the parent's auth stack, even on `/demo/session`.
7. Existing payment webhooks outside `/v1` still require their existing webhook signature. Mounting this router must not make them public or treat demo tokens as webhook authorization.

### Environment ownership

| Setting | Contract |
| --- | --- |
| `PUBLIC_DEMO` | Parent-owned enable switch. The example enables only literal `true`; the module does not read it. Omitted/false means do not mount the router. A dev-stack launcher may explicitly default it on for supported test chains; public/testnet enablement is the parent's decision. |
| `NOOLOG_API_KEY` | Read at each public create/regenerate. Any nonempty value makes those operations return `503 UNAVAILABLE`; there is no paid public extraction path. Operator extraction remains unchanged. |
| `INVESTOR_AGREEMENT_IDS` | Parent-owned explicit publication allowlist. Never add demo IDs automatically, or derive investor funds from every `agreements.list()` record. Upload/deploy does **not** publish source documents or create an investor account. |
| Operator/viewer keys, RPC/signer/provider secrets | Unchanged, backend-only. Never included in demo config/session/status or dashboard public environment. |

Limits, `path`, and `clock` are explicit constructor options, not new implicitly read environment variables. If the parent maps environment variables to them, parse numeric values before construction and fail startup on invalid input. No `.env` changes are required by this module.

## HTTP contract

All paths below include the `/v1` mount prefix. Responses are JSON with `Cache-Control: no-store`. There are no session cookies or operator secrets.

| Route | Result / permission |
| --- | --- |
| `GET /v1/demo/config` | Public `200 { enabled: true, chainId, limits }`. Does not enumerate records or return internal state paths. |
| `POST /v1/demo/session` | Public `201 { accessToken, expiresAt, role: "demo", chainId }`. `expiresAt` is Unix **seconds**, not milliseconds. No request fields are required; no manual keys. |
| `POST /v1/demo/logout` | Demo bearer required; `200 { revoked: true }`. Revokes this session durably. Does not cancel queued work, refund quotas, remove on-chain contracts, or delete agreement records. |
| `GET /v1/status` | Demo bearer required; sanitized health shape described below. |
| `GET /v1/agreements` | Only this session's summaries. Does not call the global agreement listing. |
| `POST /v1/agreements` | Creates an owned agreement using the actual Agreements → mock Noolog → compiler lifecycle; `201`, initially `extracting`. |
| `GET /v1/agreements/:id` | Owned record and actual compiled report/source documents. |
| `GET /v1/agreements/:id/ast` | Owned agreement's actual AST graph. |
| `GET /v1/agreements/:id/constraints` | Owned identity constraint. |
| `PUT /v1/agreements/:id/constraints` | Bounded identity constraint update, `200`. Changes compilation only, **not an identity attestation**. |
| `POST /v1/agreements/:id/regenerate` | Owned agreement's real generation job; `202`. |
| `POST /v1/agreements/:id/deploy` | Owned agreement's actual deploy job, using the shared signer queue; `202`, not a claim of transaction confirmation. |

For all non-public rows send:

```text
Authorization: Bearer demo_<64 random hex characters>
```

There is no refresh/recovery endpoint. Store this token in browser memory rather than a URL, analytics event, persistent public config, or a cookie. Losing or expiring it loses public access to that workspace; a fresh session starts empty. A stolen bearer grants the same limited workspace access until expiry/revocation.

### Status and errors

The router calls `status()` without passing credentials or request data, then projects only:

```json
{
  "model": { "provider": "noolog", "mode": "mock" },
  "compiler": { "solidity": { "core": "0.8.37", "uniswap-v4": "0.8.26", "swapvm": "0.8.30" } },
  "chain": { "chainId": 11155111 }
}
```

Compiler versions above are illustrative: only supplied, bounded version strings for those three keys are retained. Model mode is `unavailable` with a live key or a custom extractor. RPC/model URLs, deployer/attestor/pool addresses, wallet information and arbitrary callback fields are discarded. Runtime agreement job errors are replaced with a generic operator-contact message rather than echoing possible RPC credentials.

Errors have `{ error: { code, message } }`:

- Invalid/expired/revoked `demo_` credentials: `401 UNAUTHORIZED` (or `429` if auth traffic is already exhausted). No records are returned.
- Foreign and nonexistent agreement IDs: identical `404 NOT_FOUND` on lifecycle endpoints, before looking up the record.
- Any unlisted route/method with a valid demo token: `403 FORBIDDEN`; no fallthrough to operator handlers. Examples: `/stack/*`, `/settings/*`, `/agreements/:id/stack/*`, wallets, funding/faucets, facts, payments/webhooks, identity attestation, receipts, signing, mint/redemption and reserve/fund management.
- Invalid upload/config/constraint: `400 INVALID_BODY` or existing compiler `INVALID_DOCUMENT`/constraint errors; excessive JSON size: `413 BODY_TOO_LARGE`.
- Unsupported/new document, live/custom extraction, or unusable persistence: `503 UNAVAILABLE`. No fake successful new-document record is returned.
- Quota or pending-request queue exhausted: `429 DEMO_LIMIT`.
- Existing lifecycle state conflicts remain `409`; deployment availability remains the existing Agreements error (for example `503 NO_CHAIN`).

Missing credentials on non-public routes and all non-demo Authorization headers leave this router and must still be checked by the parent. Unknown non-demo tokens must not be granted access by downstream middleware.

## Uploads and compiler config

The existing request forms are supported:

```js
{ name, documents: [{ name, text }], profile?, config? }
// Or:
{ name, text, filename?, profile?, config? }
```

Only `rwa-secondary` (default) and `custodial-rwa` are allowed. Without `config`, the corresponding bundled example config is used with an explicit matching profile. Partial allowed config overrides merge onto that default.

The public path supports only normalized text matching:

- `test/human_contracts/ea026411904ex10-9.htm` (the bundled BUIDL agreement); or
- that document **followed by** `test/human_contracts/nav-cashier-addendum.md`, with the explicit cashier config from `examples/rwa-cashier-config.json`.

Names may differ, but document normalization, supported text/Markdown/HTML extensions, content hashes, draft quotes, AST validation and compilation still run. Merely embedding known quotes inside a different document is not enough. There are no document URL downloads. Unknown documents return a clear unavailable error directing the user to the operator API. No environment key is removed or global extractor replaced to achieve mock mode. A custom injected `agreements.extract` is also refused for public generation; use the existing default `extractWithNoolog` with no live key.

Allowed config fields: `name`, `symbol`, `decimals`, `maxSupply`, `custody`, `currency`, `priceModel`, `assumptions`, `profile`, `secondaryVenue`, `cashier`, `worldId`. Unknown fields, provider URLs, custom source/import URLs and arbitrary nested config are rejected.

- `maxSupply`: positive decimal integer string or safe integer, at most **1,000,000,000,000 base units** (1,000,000 tokens at six decimals).
- Names/symbols: 1–64 compiler-safe ASCII characters. Six decimals, backend custody and USD are required.
- `assumptions`: 1–20 nonempty strings, up to 1,000 characters each; no URL values. These are declarations, not executable configuration.
- Profile must match the request. Secondary venue is `uniswap-v4` only for the secondary profile.
- Cashier is optional and secondary-profile-only: exactly `{ enabled: true, pool: { fee, tickSpacing } }`. Static fee must be integer `[0, 1000000)`; tick spacing integer `[1, 32767]`. `fixed-nav` is only available with cashier enabled. NAV, economic fees and supply cap must still compile from the separately supplied supported addendum; config cannot override its evidence.
- World ID accepts only `document`, `proof_of_human`, `selfie`; an explicit action must equal the parent Agreements action. This does not grant an attestation capability.
- Constraint bodies are exactly `{ identity: null }` or `{ identity: { credential?, actions?, quote?, clause? } }`. Actions are limited to mint/burn/transfer (at most three entries); quote/clause lengths are at most 4,000 characters. Existing quote and compiler validation still applies.

The JSON parser caps create requests at 4 MiB, constraints at 32 KiB and session bodies at 1 KiB. Compressed JSON is refused. Each document also has the existing compiler's 2,000,000-byte limit; existing AST/rule limits remain active. Public preflight compilation does not replace the actual mock Noolog extraction, verification and report-generation job.

## Limits and durable reservations

Every option below is a positive safe integer; unknown option names fail construction. Defaults are exposed by `/demo/config`.

| Constructor option | Default | Scope |
| --- | ---: | --- |
| `sessionTtlSeconds` | 10800 | Session lifetime; hard ceiling 21600 (six hours). |
| `intervalSeconds` | 3600 | Rolling quota window, not an hourly fixed bucket. |
| `maxSessions` | 200 | Maximum live sessions; expired/revoked entries are removed. |
| `sessionsPerIp` | 10 | Successful session issuances per IP/window, including subsequently revoked sessions. |
| `sessionsPerInterval` | 100 | Global session issuances/window. |
| `requestsPerIp` | 1800 | Public config/session and all demo authentication requests/IP/window, including invalid demo credentials. |
| `requestsPerInterval` | 6000 | Same traffic, globally/window. |
| `maxPendingRequests` | 128 | Bounded in-process state-operation queue; overflow is rejected, not queued. |
| `uploadsPerWorkspace` | 3 | Upload reservations over a session's entire lifetime. |
| `uploadsPerInterval` | 20 | Global upload reservations/window. |
| `jobsPerWorkspace` | 12 | Create, regenerate, constraints and deploy reservations/session lifetime. |
| `jobsPerInterval` | 40 | Same work reservations, globally/window. |
| `deploysPerWorkspace` | 2 | Deployment reservations/session lifetime. |
| `deploysPerInterval` | 5 | Global public deployment reservations/window. |
| `maxRequestBytes` | 4194304 | Upload JSON bound; cannot increase beyond 4 MiB. |
| `maxParts` | 4 | Structural upload part bound; cannot increase beyond eight. Supported mock bundles currently contain one or two parts. |

IP limits use `req.ip` when Express proxy trust is off. If the parent enables `trust proxy`, the router deliberately uses the socket peer address instead: **`X-Forwarded-For` cannot buy new quotas**. Behind a proxy, all its visitors therefore share the peer-IP budget. Use a correctly configured edge rate limiter for finer visitor limits; do not loosen this boundary by trusting arbitrary forwarding headers. IP hashing is not a claim of strong IP anonymization.

Workspace quotas do not reset during the session. Global/IP quotas survive both new sessions and restarts. There are no challenge maps or unbounded per-IP maps; event arrays are capped by global limits and pruned as entries age out. Request and issuance budgets include the public config/session endpoints; unsupported documents also consume upload/job reservations after cheap shape/config checks.

Before expensive document normalization/preflight, asynchronous creation, constraint recompilation, regeneration or deployment begins, its reservation is committed to the durable JSON file. Deployment attempts reserve both a job and deployment slot. **No reservations are refunded**, including errors, timeouts, lifecycle conflicts or ambiguous on-chain results. Caps bound admitted public work, not actual ETH cost or individual transactions inside one deploy job; use a low-balance testnet signer and external gas controls as well. A deployment admitted earlier can still execute later from the signer queue.

The state stores SHA-256 token hashes, expiry, owned IDs, workspace counters, hashed-IP traffic events, a clock high-water mark and global reservation timestamps. It contains neither raw access tokens nor uploaded document bytes. Writes use a `0600` temporary file, fsync, atomic rename and directory fsync before admitting work. Filesystem/persistence failures fail closed for the running instance; corrupt, incompatible-chain or changed-interval state fails initialization instead of silently resetting the gas budget.

A crash between agreement creation and ownership persistence can leave an orphan accessible only to the operator. It cannot assign it to another visitor. Missing agreement records are not reassigned. Expiry/logout removes public ownership but does not delete the underlying sensitive documents from the Agreements store. The operator must set storage retention/backups and manual cleanup policy. Keep both files outside static asset directories, on persistent storage with restricted access; never log Authorization headers, issued tokens, request bodies or source documents. This module itself does not log them.

Do not delete/recreate/roll back the workspace file to recover service: doing so discards gas history. Recover the durable state, reconcile ambiguous transactions, and restart one writer. Changing the quota window needs an explicit operator migration rather than resetting state. A system clock rollback does not resurrect sessions or release reservations.

## Validation

Run the focused suite from the repository root:

```sh
node --test test/demo-workspaces.test.js test/agreements.test.js test/agreements-api.test.js
```

It exercises the real bundled mock Noolog/compiler lifecycle, both profiles and cashier config, source/record isolation, foreign-ID indistinguishability, route deny-by-default and operator/investor passthrough, token TTL/logout, IP/global/workspace quotas and forged forwarding headers, concurrent admission, request/document bounds, live-model refusal, durable ownership/auth/gas budgets across restart, persistence failures, and operator/demo shared-signer deployment serialization with failure recovery.

Deployers are controlled test doubles in this suite. Passing it does not claim a live Sepolia transaction, gas-cost bound, live Noolog call, investor proof or application/dashboard mounting has been performed.
