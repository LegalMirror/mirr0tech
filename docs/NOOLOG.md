# Noolog

Noolog fuses several models into one deliberation: agents propose, evaluate each other's claims, and converge on one answer with a **confidence score** and **per-claim verdicts** (verified / contested / unverified / wrong). mirr0tech uses it to generate the extraction of an agreement, so every rule the compiler emits arrives with who checked it and how sure they were (`src/noolog/`, `README.md` § How we used Noolog).

## Read the docs from an agent

The documentation is a remote MCP server; no install. `.mcp.json` at the repo root already points Claude Code at it, so `search_docs` / `fetch_doc` are available in this checkout. Any other MCP client:

```json
{ "mcpServers": { "noolog-docs": { "type": "streamable-http", "url": "https://noolog.io/mcp" } } }
```

| Tool | Args | Returns |
| --- | --- | --- |
| `search_docs` | `query`, `limit?` | ranked pages: title, section, url, snippet |
| `fetch_doc` | `url` from a hit | the page as markdown |

## Links

- What is Noolog: https://noolog.io/docs/noolog/latest/explanation/what-is-noolog.html
- Docs portal: https://noolog.io/docs · Docs MCP: https://noolog.io/mcp (`GET` answers 405; the channel is POST)
- Gateway REST API (deliberations, results, details, reference tree, OpenAI-compatible chat): https://api.peeramid.xyz/swagger-ui/
- Quorum SDK (Rust types every schema here follows): https://git.peeramid.xyz/peeramid-labs/quorum-rs
- Web app: https://open.noolog.io

## In this repo

| Env | Meaning |
| --- | --- |
| `NOOLOG_URL` | gateway base, default `https://api.peeramid.xyz` |
| `NOOLOG_API_KEY` | bearer token; unset → the in-process mock (`src/noolog/mock.js`) serves the same routes with no model |
| `NOOLOG_MODEL` | deliberating model for `/v1/chat/completions`, default `nsed:deep` (generic; the request names the seats `extractor` + `critic`). A policy tag such as `nsed:legal_rwa_pro` (RwaCounsel + RwaScrivener + RwaCompliance, max 3 rounds, 1 h job timeout) brings its own seats, so no agents are named |

Live rules the client follows: one fresh `room_id` per run (a repeat collides on the orchestrator's room slot; never the reserved `sphera-broker-` prefix), 2 rounds, a 15-minute wait for the settled result. The account behind the token needs credits: an empty budget answers `429 insufficient_quota`, which the agreement records as `The model account is out of credits`.
