# Legal document AST v2

Uploads are read by `gpt-5.4-mini` with `reasoning.effort: "none"` through the Responses API using strict Structured Outputs and `store: false`. The server reads `OPENAI_API_KEY` from `.env` (`OPENAPI_KEY` is also accepted). `OPENAI_MODEL` overrides the default. The key is never returned to the browser.

New uploads use a selective light analysis: at most 24 key nodes, 12 explicit relationships and 8 issues across the bundle, with a 6,000-token output budget. The model reads the whole bundle but does not enumerate every clause. Light output is flat (`parentId: null`); issues are bundle-level (`nodeId: null`). Extraction provenance records `analysisMode: "light"`; source-quote and structural checks remain mandatory. Saved fuller ASTs remain compatible.

The JSON has `schemaVersion: "2.0"`, `title`, `documents`, `nodes`, `relations`, and `issues`:

- `documents`: generated IDs (`document-1`, etc.), names, SHA-256 hashes of original bytes and normalized text, and normalized text. File identity uses IDs, so duplicate filenames remain distinguishable.
- `nodes`: stable model-generated IDs, `kind`, readable `label`, `summary`, nullable `parentId`, and `source`. Kinds cover sections, clauses, definitions, obligations, permissions, prohibitions, conditions, exceptions, parties, remedies, dates and amounts.
- `source`: `documentId`, verbatim `quote`, zero-based `occurrence`, and server-computed `start`/`end` offsets. The model chooses a numbered passage ID; the server copies the exact passage and calculates its occurrence, so the model never retypes quotations. Offsets use JavaScript UTF-16 code units in that document's normalized text, with an exclusive end.
- `relations`: IDs, `from`/`to` node IDs, a typed relationship (`references`, `defines`, `applies_to`, `requires`, `excepts`, `overrides`, `amends`, `party_to`), and a supporting source quotation. For example, an exception clause points to the clause it qualifies.
- `issues`: unresolved references or ambiguities, with a nullable `nodeId` and description.

`parentId` describes the tree; relations add cross-links. Each top-level node belongs to its source document. The graph endpoint adds an agreement root and document nodes with `contains` edges. All references must resolve. Structural cycles, duplicate IDs/links, self-relations, invented quotes and unknown source documents are rejected. The model cannot supply trusted offsets.

The general lifecycle is `uploaded → extracting → verified → analyzed`. Invalid model output gets at most one fresh retry using the same source-only input; failed candidates and validation messages are not sent back to OpenAI. Schema and citation checks do not establish semantic completeness or legal correctness. Quotes can be valid while a model interpretation still needs review; open questions remain visible. Generation failures retain uploaded files for retry. An interrupted job becomes `failed` on restart. Completed ASTs persist in the agreement store and are available without compiling or deploying anything.

The graph and source cards share selection. The inspector shows relationship direction, type and source evidence. Human Language displays the normalized document with the selected quote highlighted. The graph's **Download AST JSON** button saves the complete version 2 JSON, including nodes outside the current focused view. Existing compiler fixtures and saved version 1 policies remain readable for the separate deployment workflow. Noolog is no longer an extraction provider.

Run `pnpm extract path/to/legal-document.md generated/legal-ast.json` for a CLI export (an envelope containing `ast`, source hashes and extraction provenance). Test fixtures never make paid model calls.

## Executable MVP test mappings

The exact normalized HTML fund agreement has an explicit `rwa-secondary`/`custodial-rwa` compiler mapping. The credit mapping requires the complete `wildcat-mla.md` + `lender-check-policy.md` + `buyback-addendum.md` bundle with profile `wildcat-credit`. The lender policy and buyback addendum each produce valid document ASTs alone, but neither is treated as a complete standalone credit agreement. Do not bundle the unrelated fund agreement with the credit documents.

`src/policy/test-mapping.js` matches the complete normalized source hash set, independent of filenames. Changed, additional, duplicated, or missing documents cannot inherit a mapping. The mapping reuses the repository's explicit hand-authored executable subset; it is not inferred from the light overview. Provenance identifies `explicit-test-mapping`, and the original model AST is preserved as `documentAst` on the envelope and agreement detail. Mapped uploads proceed to `compiled`; unresolved provisions remain visible and only demo/testnet compilation is permitted. Arbitrary uploaded documents remain analysis-only.

Run `node scripts/test-human-contracts.js --live` (Node 22+) to exercise all four individual files and the complete credit bundle with the configured OpenAI API key, then compile the fund and credit contracts with solc. This incurs API usage. Results, Solidity and ABI/bytecode artifacts go under `generated/human-contracts/`.

After funding the configured signer with Sepolia test ETH, run `node scripts/test-human-contracts.js --deploy-sepolia`. It verifies chain 11155111, the exact prepared source/configuration hashes and shared infrastructure before deploying. The fund gets its own oracle, token and hook; the credit bundle gets its own oracle, role provider, six-decimal mock asset, mock market and policy-bound buyback router. The report in `deployments/sepolia-human-contracts.json` records successful transactions and on-chain checks. No local EVM is started. The credit market and compliance inputs are MVP simulations, not a production Wildcat integration. The buyback order is prepared from the source terms; deployment alone does not fund or execute it.
