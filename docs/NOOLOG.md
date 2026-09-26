# Noolog

Noolog fuses several models into one deliberation: seats propose, evaluate each other's claims, and converge on one answer with a **confidence score** and **per-claim verdicts** (verified / contested / unverified / wrong). mirr0tech uses it to *generate* the extraction of an agreement, so every rule the compiler emits arrives with who checked it and how sure they were.

## Three engines, one switch

`EXTRACTOR` names the engine that reads an uploaded agreement (`src/noolog/extract.js`, `extractAgreement`):

| `EXTRACTOR` | What runs | Verdicts | Needs |
| --- | --- | --- | --- |
| `noolog` | a live deliberation under the `legal_rwa_pro` policy (RwaCounsel + RwaScrivener + RwaCompliance, up to 3 rounds) | yes | `NOOLOG_API_KEY`, credits on the account |
| `mock` | the in-process orchestrator mock (`src/noolog/mock.js`): same routes, no model; deliberates over the hand-authored draft, so only the demo agreements generate | yes (synthetic) | nothing |
| `openai` | **the bypass**: one model call on any OpenAI-compatible endpoint, no deliberation | none (`verification: null`) | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` |

Unset, `EXTRACTOR` follows the keys present: `noolog` when `NOOLOG_API_KEY` is set, else `openai` when `OPENAI_API_KEY` is set, else `mock`. `GET /v1/status` reports the engine (`model.mode: live | mock | openai`), and for the live engine whether the token lists the model (`model.listed`).

Talk to Astra directly, skipping every deliberation feature:

```sh
EXTRACTOR=openai OPENAI_BASE_URL=https://<astra host>/v1 OPENAI_API_KEY=<astra key> OPENAI_MODEL=<astra model> npm run dev:stack
```

The bypass posts `/chat/completions` with `response_format: { type: "json_object" }`, the schema in the system turn, the document as the user turn (and a draft, when one exists, as an assistant turn to correct), then validates the answer against the document exactly as the deliberation's answer is validated.

## Environment

| Env | Meaning |
| --- | --- |
| `EXTRACTOR` | `noolog` · `mock` · `openai` (above) |
| `NOOLOG_URL` | gateway base, default `https://api.peeramid.xyz` |
| `NOOLOG_API_KEY` | bearer token (`op-…`) for the live orchestrator; never in source control |
| `NOOLOG_MODEL` | `nsed:legal_rwa_pro` (default: the legal RWA policy; its seats come from the policy) or `nsed:deep` (generic; the request names `extractor` + `critic`) |
| `NOOLOG_EFFORT` | the halting dial sent with every deliberation (0–1, default `0.5`): the share of consensus evidence the seats need before they may stop |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | the bypass; the base URL may be any OpenAI-compatible endpoint |

## How the live path works

1. `GET /policies` → the policy whose tag is the model's suffix (`legal_rwa_pro` → `policy_id b245634b…`).
2. `POST /deliberation` with `room_id` (fresh per run: the orchestrator keeps a room slot per id, so a repeat collides; never the reserved `sphera-broker-` prefix), `deliberation_rounds: 2`, `policy_id`, and `messages`: the instructions and the document as the user turn (the orchestrator folds no system turn), the draft as the assistant turn when one exists. The answer is `{ job_id }`, and the job id is the room id.
3. `GET /deliberation/{id}/result` every 2 s. Its `status` is a progress line — `running: round 2 — Starting` — that the agreement record shows as `progress` and `mirr0 show --wait` prints; `completed` carries `result`, the settled answer as a string. The answer is parsed as JSON (a code fence or leading prose is tolerated; prose alone is the error `The model answered prose instead of the policy JSON`).
   The instructions name the actions this deployment's venue components enforce (fund: mint, burn, transfer); whatever the seats still return beyond that — a `withdraw` rule, the agreement's twenty notice periods as terms — is demoted to `unresolved` (`fitToProfile`) and listed under `extraction.demoted`, so a live extraction always compiles.
4. `GET /deliberation/{id}/details` (per-seat proposals, evaluations, claim assessments, round convergence) and `GET /deliberation/{id}/references` (the claim tree with verdicts) → `verificationFrom` builds the report: `claims[]`, `contested[]`, `confidence { overall, byRef, verified, total, counts }`.

When the seats score the answer without decomposing it into claims, the confidence is the mean of their scores mapped to [0, 1] and `confidence.basis` says `evaluations` (else `claims`, or `winner` for the aggregate alone). Live claim keys are the orchestrator's ids, so per-rule confidence exists only where claims anchor to rules.

Budget: an account without credits answers `429 insufficient_quota` / `{"error":"Insufficient budget"}`; the agreement fails with `The model account is out of credits (429)`. A full agreement (≈80 KB request) takes about ten minutes per round, up to three rounds; the client waits up to the policy's job timeout (an hour). A one-line question takes ten seconds to a minute.

### After the seats answer

- **Fitted**: rules for actions no venue enforces and terms no component consumes move to `unresolved` (`extraction.demoted`).
- **Permits derived**: a gate written only as `require` rules would permit nothing; the permit it implies is added per action, quoting the first require (`extraction.derived`).
- **Quotes anchored**: a quote that differs from the source only in quotes, dashes or spacing is replaced by the verbatim span; one with no span moves to `unresolved` (`extraction.unanchored`).

## Client library (`src/noolog/client.js`)

```js
import { NoologClient } from './src/noolog/client.js';
const client = new NoologClient();                       // NOOLOG_URL, NOOLOG_API_KEY; or { url, apiKey, fetchImpl }
await client.models();                                   // ['nsed:legal_rwa_pro', …] from /v1/models
const policy = await client.policyFor('legal_rwa_pro');  // { policy_id, name, tags, max_rounds } from /policies
const { job_id } = await client.startDeliberation({ room_id, deliberation_rounds: 2, policy_id: policy.policy_id, messages });
const state = await client.waitForResult(job_id, { pollMs: 2000, timeoutMs: 900_000, onProgress: (s) => console.log(s.status) });
const [details, references] = await Promise.all([client.details(job_id), client.references(job_id)]);
const { completion, jobId } = await client.chatCompletion({ model: 'nsed:legal_rwa_pro', messages, nsed: { room_id, deliberation_rounds: 2 } }); // OpenAI-compatible route
```

Errors are `NoologError { status, message }` with the orchestrator's status code. `extractWithNoolog({ profile, document, draft, onProgress, live })` wraps the four steps and returns `{ envelope, verification }`; `extractWithOpenAI({ document, draft, env })` is the bypass; `extractAgreement(input)` is the switch.

## Read the docs from an agent

The documentation is a remote MCP server; no install. `.mcp.json` at the repo root already points Claude Code at it (`search_docs` / `fetch_doc`). Any other MCP client:

```json
{ "mcpServers": { "noolog-docs": { "type": "streamable-http", "url": "https://noolog.io/mcp" } } }
```

## Links

- What is Noolog: https://noolog.io/docs/noolog/latest/explanation/what-is-noolog.html · Docs portal: https://noolog.io/docs · Docs MCP: https://noolog.io/mcp
- Gateway REST API, OpenAPI document: https://api.peeramid.xyz/swagger-ui/ · https://api.peeramid.xyz/api-docs/openapi.json
- Quorum SDK (the Rust types every schema here follows): https://git.peeramid.xyz/peeramid-labs/quorum-rs
