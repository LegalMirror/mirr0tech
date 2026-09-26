import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { legalAst, legalDocument } from './legal-ast-fixture.js';
import { validateLegalAst, legalAstGraph } from '../src/legal/ast.js';
import { bundleDocuments, documentFrom } from '../src/policy/document.js';
import { extractWithOpenAI } from '../src/openai-extract.js';
import { Agreements } from '../src/agreements.js';
import { createWorkspaceApp } from '../src/routes.js';

test('legal AST preserves exceptions and locates verbatim quotes without compiler restrictions', () => {
  const ast = validateLegalAst(legalAst, legalDocument);
  assert.equal(ast.relations[0].kind, 'excepts');
  for (const item of [...ast.nodes, ...ast.relations]) assert.equal(ast.documents[0].text.slice(item.source.start, item.source.end), item.source.quote);
  const graph = legalAstGraph(ast);
  assert.equal(graph.edges.find((link) => link.kind === 'excepts').to, 'clause-1');
  assert.ok(graph.edges.some((link) => link.from === 'clause-1' && link.to === 'payment-duty' && link.kind === 'contains'));
});

test('rejects fabricated citations, ambiguous occurrences, cycles, missing references and duplicate IDs', () => {
  for (const mutate of [
    (ast) => { ast.nodes[0].source.quote = 'Invented clause'; },
    (ast) => { ast.nodes[0].source.occurrence = 1; },
    (ast) => { ast.nodes[0].source.documentId = 'absent'; },
    (ast) => { ast.nodes[0].id = ast.nodes[1].id; },
    (ast) => { ast.nodes[0].id = 'document-1'; },
    (ast) => { ast.nodes[0].parentId = 'payment-duty'; },
    (ast) => { ast.nodes[0].parentId = 'absent'; },
    (ast) => { ast.relations[0].to = 'absent'; },
    (ast) => { ast.relations[0].to = ast.relations[0].from; },
    (ast) => { ast.relations.push(structuredClone(ast.relations[0])); },
    (ast) => { ast.issues.push({ nodeId: 'absent', description: 'Ambiguous' }); },
    (ast) => { ast.nodes[0].source.start = 100; },
  ]) { const ast = structuredClone(legalAst); mutate(ast); assert.throws(() => validateLegalAst(ast, legalDocument)); }
});

test('bundle document IDs and repeated quotations resolve to the correct file and occurrence', () => {
  const doc = bundleDocuments([documentFrom('same.txt', 'Pay now. Pay now.'), documentFrom('same.txt', 'Pay now.')]);
  const ast = { ...legalAst, nodes: [{ ...legalAst.nodes[0], source: { documentId: 'document-1', quote: 'Pay now.', occurrence: 1 } }], relations: [] };
  assert.equal(validateLegalAst(ast, doc).nodes[0].source.start, 9);
  ast.nodes[0].source = { documentId: 'document-2', quote: 'Pay now.', occurrence: 0 };
  const validated = validateLegalAst(ast, doc);
  assert.equal(validated.nodes[0].source.start, 0);
  assert.equal(validated.documents.length, 2);
});

test('legal AST is persisted, served and regenerable without compilation or chain configuration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'legal-ast-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'agreements.json');
  const extract = (input) => extractWithOpenAI({ ...input, apiKey: 'test', fetchImpl: async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(legalAst) }] }] }) });
  const agreements = new Agreements({ path, extract });
  const created = await agreements.create({ name: 'Services', documents: [{ name: legalDocument.name, text: legalDocument.text }] });
  await agreements.settled();
  const record = agreements.get(created.id);
  assert.equal(record.status, 'analyzed', record.error);
  assert.equal(record.export, null);
  assert.equal(record.policyHash, null);
  assert.equal(record.ast.schemaVersion, '2.0');
  assert.deepEqual(record.history.map((step) => step.status), ['uploaded', 'extracting', 'verified', 'analyzed']);
  const restarted = await new Agreements({ path, extract }).init();
  assert.deepEqual(restarted.get(created.id).ast, record.ast);
  assert.deepEqual(restarted.ast(created.id), agreements.ast(created.id));
  await assert.rejects(restarted.constrain(created.id, { identity: null }), (error) => error.code === 'UNSUPPORTED_AST');
  const server = createWorkspaceApp(restarted, { apiKey: '' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/v1/agreements/${created.id}/ast`)).status, 401);
  const { accessToken } = await (await fetch(`${base}/v1/workspace/session`, { method: 'POST' })).json();
  const headers = { authorization: `Bearer ${accessToken}` };
  const response = await fetch(`${base}/v1/agreements/${created.id}/ast`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), agreements.ast(created.id));
  assert.deepEqual((await (await fetch(`${base}/v1/agreements/${created.id}`, { headers })).json()).ast, record.ast);
  restarted.regenerate(created.id);
  await restarted.settled();
  assert.equal(restarted.get(created.id).status, 'analyzed');
});
