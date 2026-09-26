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
| `NOOLOG_MODEL` | deliberating model for `/v1/chat/completions`, default `nsed:deep` |
