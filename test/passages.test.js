import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcePassages, passageAstSchema, materializePassages } from '../src/legal/passages.js';
import { validateLegalAst } from '../src/legal/ast.js';
import { documentFrom, readDocument, bundleDocuments } from '../src/policy/document.js';
import { modelLegalAst } from './legal-ast-fixture.js';

test('every passage round-trips to its exact file and occurrence, including repeated text and HTML', async () => {
  for (const document of [documentFrom('repeated.md', 'Repeat. Repeat. Repeat. Repeat.'),
    ...await Promise.all(['ea026411904ex10-9.htm', 'wildcat-mla.md', 'lender-check-policy.md', 'buyback-addendum.md'].map((name) => readDocument(`test/human_contracts/${name}`)))]) {
    const passages = sourcePassages(document, 200);
    assert.equal(new Set(passages.map((p) => p.id)).size, passages.length);
    assert.equal(passages.map((p) => p.text).join('').replace(/\s/g, ''), document.text.replace(/\s/g, ''));
    for (const passage of passages) {
      const candidate = { schemaVersion: '2.0', title: 'Passage', nodes: [{ id: 'node-1', kind: 'clause', label: 'Evidence', summary: 'Evidence', parentId: null, source: { spanId: passage.id } }], relations: [], issues: [] };
      const ast = validateLegalAst(materializePassages(candidate, passages), document);
      const source = ast.nodes[0].source;
      assert.equal(document.text.slice(source.start, source.end), passage.text);
    }
  }
});

test('repeated evidence uses zero-based occurrences computed by the server', () => {
  const document = documentFrom('repeat.md', 'Repeat. Repeat. Repeat. Repeat.');
  assert.deepEqual(sourcePassages(document, 8).map((p) => p.occurrence), [0, 1, 2, 3]);
});

test('passage references preserve document identity and reject invented evidence', () => {
  const document = bundleDocuments([documentFrom('a.md', 'Pay now.'), documentFrom('b.md', 'Pay now.')]);
  const passages = sourcePassages(document);
  assert.deepEqual(passages.map((p) => p.documentId), ['document-1', 'document-2']);
  const candidate = { ...modelLegalAst, nodes: [{ ...modelLegalAst.nodes[0], source: { spanId: passages[1].id } }], relations: [] };
  assert.equal(validateLegalAst(materializePassages(candidate, passages), document).nodes[0].source.documentId, 'document-2');
  candidate.nodes[0].source.spanId = 'invented';
  assert.throws(() => materializePassages(candidate, passages), /Unknown source passage/);
  assert.deepEqual(passageAstSchema(passages).properties.issues.items.properties.nodeId, { type: 'null' });
});
