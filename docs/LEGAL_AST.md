# Legal document AST v2

Uploads are read by `gpt-6-astra` with `reasoning.effort: "low"` through the Responses API using strict Structured Outputs and `store: false`. The server reads `OPENAI_API_KEY` from `.env` (`OPENAPI_KEY` is also accepted). `OPENAI_MODEL` overrides the default. The key is never returned to the browser.

The JSON has `schemaVersion: "2.0"`, `title`, `documents`, `nodes`, `relations`, and `issues`:

- `documents`: generated IDs (`document-1`, etc.), names, SHA-256 hashes of original bytes and normalized text, and normalized text. File identity uses IDs, so duplicate filenames remain distinguishable.
- `nodes`: stable model-generated IDs, `kind`, readable `label`, `summary`, nullable `parentId`, and `source`. Kinds cover sections, clauses, definitions, obligations, permissions, prohibitions, conditions, exceptions, parties, remedies, dates and amounts.
- `source`: `documentId`, verbatim `quote`, zero-based `occurrence`, and server-computed `start`/`end` offsets. Offsets use JavaScript UTF-16 code units in that document's normalized text, with an exclusive end.
- `relations`: IDs, `from`/`to` node IDs, a typed relationship (`references`, `defines`, `applies_to`, `requires`, `excepts`, `overrides`, `amends`, `party_to`), and a supporting source quotation. For example, an exception clause points to the clause it qualifies.
- `issues`: unresolved references or ambiguities, with a nullable `nodeId` and description.

`parentId` describes the tree; relations add cross-links. Each top-level node belongs to its source document. The graph endpoint adds an agreement root and document nodes with `contains` edges. All references must resolve. Structural cycles, duplicate IDs/links, self-relations, invented quotes and unknown source documents are rejected. The model cannot supply trusted offsets.

The lifecycle is `uploaded → extracting → verified → analyzed`. Schema and citation checks do not establish semantic completeness or legal correctness. Quotes can be valid while a model interpretation still needs review; open questions remain visible. Generation failures retain uploaded files for retry. An interrupted job becomes `failed` on restart. Completed ASTs persist in the agreement store and are available without compiling or deploying anything.

The graph and source cards share selection. The inspector shows relationship direction, type and source evidence. Human Language displays the normalized document with the selected quote highlighted. The graph's **Download AST JSON** button saves the complete version 2 JSON, including nodes outside the current focused view. Existing compiler fixtures and saved version 1 policies remain readable for the separate deployment workflow. Noolog is no longer an extraction provider.

Run `pnpm extract path/to/legal-document.md generated/legal-ast.json` for a CLI export (an envelope containing `ast`, source hashes and extraction provenance). Test fixtures never make paid model calls.
