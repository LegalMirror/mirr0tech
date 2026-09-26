# World ID application login

The login screen has a **Mock / Sandbox / Simulator (v3) / World App (Orb)** toggle. **World App (Orb)** is a legacy Orb request with `environment: production` under the login action, scanned with a real World App; it accepts the v3 or v4 proof the app returns. The simulator (v3) also accepts device-level simulator identities, and needs a staging window open in the Developer Portal (`environment_not_allowed` otherwise). Open it with the Developer Portal MCP (`set_world_id_staging_verification`) and set the token it returns as `WORLD_STAGING_VERIFICATION_TOKEN`; the backend sends it as `x-staging-verification-token` on every staging and sandbox verification, login and wallet check alike. The window lasts 24 hours, and opening another replaces the token. All three modes are always available; there is no mode variable. The screen starts on **Sandbox** when the RP keys are configured, otherwise on **Mock**. A mode whose keys are missing is shown disabled.

- **Mock** creates a placeholder session at once (`POST /v1/auth/world/mock`): no QR code, no World credentials. The account is marked `mock: true`, with no credential and no passport. Anyone can use it, so it is a demo convenience, not a gate.
- **Sandbox** and **Simulator (v3)** each ask the backend for a challenge in that mode (`POST /challenge { mode }`). The challenge records its mode, and the proof that answers it is judged by that mode, not by the screen's current choice.

Sessions from every mode stay valid side by side, and switching the toggle does not sign anyone out. `new WorldLogin({ mode })` pins a single mode, as the tests do.

## v3 simulator login

Set these backend environment variables to use https://simulator.worldcoin.org/:

```dotenv
WORLD_LOGIN_ACTION=login
WORLD_APP_ID=app_...
WORLD_RP_ID=rp_...
WORLD_RP_SIGNING_KEY=...
```

Without `WORLD_LOGIN_ACTION` the action is `login`, so the Simulator toggle works with no extra variable; register an action with that name, or set `WORLD_LOGIN_ACTION` to the one you registered in the Developer Portal. Configure that action to allow repeat verifications so returning users can sign in again. Restart the backend and reload the dashboard. When first deploying this feature, deploy the updated dashboard too; subsequent mode changes only require a backend restart and page reload. Docker Compose forwards both login settings.

This mode uses IDKit v4's legacy Orb preset with `allow_legacy_proofs=true`, requests v3 proofs on **staging**, and links to the simulator. No SDK downgrade or `NEXT_PUBLIC_*` setting is needed. `WORLD_ENVIRONMENT` and `WORLD_ACTION` continue to configure the separate investor verification flow, not login.

The backend verifies the full v3 payload with World's v4 verification endpoint, checks the configured action and fresh challenge signal, and issues the usual 24-hour application token. Returning accounts use the staging app/action-scoped Orb nullifier. That account identifier may repeat; each login must supply a fresh proof for its single-use challenge. v3 accounts and tokens are separate from sandbox and mock accounts. v3 does not use World session IDs and does not attest passport verification.


Reference: [IDKit legacy proofs and staging simulator](https://docs.world.org/world-id/idkit/integrate).

## Sandbox configuration

The dashboard displays a landing page until the backend verifies a World ID 4.0 session proof. All routes share `WorldSessionProvider`; components can read the account with `useWorldAccount()`. Login is required by both the local workspace API and the hosted demo API. Operator credentials and wallet/investor authorization retain their separate scopes.

## Run

Use Node **22.13 or newer** (built-in `node:sqlite`) and set these backend-only values in `.env` or the hosting environment:

```dotenv
WORLD_APP_ID=app_...
WORLD_RP_ID=rp_...
WORLD_RP_SIGNING_KEY=...
WORLD_ENVIRONMENT=sandbox
WORLD_SESSION_DB=.data/world-sessions.sqlite
```

Register the app and RP in the World Developer Portal and use its RP signing key. In sandbox mode, login hardcodes `sandbox` on both sides and has no production, legacy, or mock fallback. `WORLD_ENVIRONMENT` configures the existing investor verifier; it cannot switch login out of sandbox. Keep these credentials out of `NEXT_PUBLIC_*` values.

Run `pnpm start` and `pnpm --dir dashboard dev`, open http://localhost:3100, then choose **Sign in with World ID**. Complete the request with your sandbox identity. The landing page links to https://sandbox.auth.world.org/. World’s current sandbox docs also describe access to their sandbox mobile app. This flow requests the sandbox Proof of Human credential (schema 1).

The complete proof is forwarded unchanged to `https://developer.world.org/api/v4/verify/{rp_id}`. This shared endpoint verifies sandbox proofs; using it does not switch to production identities. An application session is issued only after successful verification of the requested credential and matching World session ID.

## Persistence and boundaries

- SQLite stores accounts, hashed application tokens, expiring login challenges, and consumed proof nullifiers. Mount its directory on a durable writable volume, including the SQLite WAL files. The default path is `WORLD_SESSION_DB`, or `DATA_DIR/world-sessions.sqlite`, or `.data/world-sessions.sqlite`.
- Application sessions expire after 24 hours. The bearer lives in browser `sessionStorage`, scoped to the API URL, to support the existing separate-origin static frontend without third-party cookies. Reloads and backend restarts preserve login; closing the tab requires a new proof. Treat frontend script integrity as part of this bearer-token boundary.
- A non-authenticating World session ID hint is retained in localStorage. Returning login requests bind a fresh challenge to the saved session and restore the same account only after verification. Choosing **Use a different World ID**, clearing browser storage, or switching browsers creates a separate World session/account; cross-device account recovery is not implemented.
- Challenges expire after five minutes, are single-use, bind a random signal, and are limited to 100 per five-minute window per database. Proof replay records persist across restarts. Logout revokes the application token on the backend; expiry and rejected API requests return the browser to the landing page.
- Login does **not** attest a passport, legal name, KYC, or wallet ownership. Account context explicitly reports `passportVerified: false`. The existing wallet-bound document verifier remains the separate verification step to connect to deployment later.
- Local agreement storage remains one local workspace. Hosted demo workspaces retain their existing independent quotas, short lifetime, and agreement isolation; login does not grant operator privileges or make demo documents permanent account storage.

## Endpoints

`GET /v1/auth/world/config`, `POST /challenge`, `POST /verify`, `GET /session`, and `POST /logout` (all suffixes under `/v1/auth/world`). Send the application token in `X-World-Session` for session/logout and workspace requests. Workspace requests additionally retain their existing workspace/demo bearer. Responses use `Cache-Control: no-store`.

## Validation

`node --test test/world-login.test.js test/workspace.test.js` covers persistence, expiry, replay/race prevention, nonce/signal/environment/credential checks, upstream failures, logout, CORS, and HTTP access gates using a stubbed World verifier. Dashboard tests cover token origin scoping and invalidation. These checks do not establish success with an actual sandbox identity; complete the browser flow to validate your RP configuration end to end.

References: [World ID overview](https://docs.world.org/world-id/overview), [session proofs](https://docs.world.org/world-id/idkit/session-proofs), [sandbox setup](https://docs.world.org/world-id/sandbox/sandbox-access), [verification API](https://docs.world.org/api-reference/developer-portal/verify).

## Diagnosing login errors

Open browser DevTools → Console, enable **Info** messages and **Preserve log**, and filter for `[World ID]`. Retry login. Logs show:

- API endpoint, duration, HTTP status, and backend request ID.
- Handoff mode, returning/new session, challenge expiry, browser connectivity, and secure-context status.
- World bridge and WASM fetch destinations, status codes, durations, or network error names while the widget is open.
- A filtered IDKit report with SDK version, transport, request ID, and whether request/response material exists.

The `pnpm start` terminal logs auth requests with matching `X-World-Request-ID` values, plus verification status, provider error codes, network cause codes, and response consistency checks. If the browser reports a handoff failure before any `/verify` request, backend proof verification has not been reached. Inspect the corresponding failed request in DevTools → Network for browser-level CORS, TLS, or blocking details; the generic `connection_failed` code alone does not establish the cause.

Request/response payloads, raw error bodies, signing keys, signatures, session tokens, and bridge query/fragment keys are excluded from these logs. SDK-wide raw debug mode is not enabled. Restart the backend after updating logging code, refresh the frontend, and reproduce once; share the `[World ID]` entries from both consoles.
