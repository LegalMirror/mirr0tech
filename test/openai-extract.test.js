import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWithOpenAI, extractWorkspace } from '../src/openai-extract.js';
import { legalAst as ast, legalDocument as document } from './legal-ast-fixture.js';
import { validateLegalAst } from '../src/legal/ast.js';

const result = (value = ast) => ({ id: 'resp_test', status: 'completed', model: 'test-model', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

test('OpenAI uses strict structured output, validates quotes and records honest provenance', async () => {
  const extracted = await extractWithOpenAI({ document, profile: 'rwa-secondary', apiKey: 'test-key', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(JSON.parse(body.input[0].content)[0].text, document.text);
    assert.equal(body.model, 'gpt-6-astra');
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.equal(init.headers.authorization, 'Bearer test-key');
    return Response.json(result());
  } });
  assert.deepEqual(extracted.envelope.ast, validateLegalAst(ast, document));
  assert.equal(extracted.envelope.extraction.provider, 'openai');
  assert.equal(extracted.verification, null);
  assert.equal(extracted.envelope.source.sha256, document.sha256);
});
test('OpenAI rejects missing keys, errors, refusals, incomplete output and invented quotes', async () => {
  await assert.rejects(extractWithOpenAI({ document, apiKey: '' }), /OPENAI_API_KEY/);
  for (const [response, message] of [
    [new Response('secret upstream diagnostic', { status: 401 }), /HTTP 401/],
    [Response.json({ status: 'incomplete', output: [] }), /incomplete/],
    [Response.json({ status: 'completed', output: [{ content: [{ type: 'refusal' }] }] }), /declined/],
    [Response.json(result({ ...ast, nodes: [{ ...ast.nodes[0], source: { ...ast.nodes[0].source, quote: 'Invented quote' } }] })), /Source quote not found/],
  ]) await assert.rejects(extractWithOpenAI({ document, apiKey: 'test', fetchImpl: async () => response }), message);
});
test('demo extraction is deterministic and does not need OpenAI', async () => {
  const ast = { schemaVersion: '1.0', title: 'Demo', parties: [], rules: [], terms: [], unresolved: [] };
  const extracted = await extractWorkspace({ generation: 'demo', document, draft: ast, apiKey: '' });
  assert.equal(extracted.envelope.extraction.provider, 'demo');
  assert.deepEqual(extracted.envelope.ast, ast);
  await assert.rejects(extractWorkspace({ generation: 'demo', document, draft: null }), /bundled/);
});
