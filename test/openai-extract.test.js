import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWithOpenAI, extractWorkspace } from '../src/openai-extract.js';
import { modelLegalAst as ast, legalDocument as document } from './legal-ast-fixture.js';
import { validateLegalAst } from '../src/legal/ast.js';
import { sourcePassages, materializePassages } from '../src/legal/passages.js';

const result = (value = ast) => ({ id: 'resp_test', status: 'completed', model: 'test-model', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

test('OpenAI uses strict structured output, validates quotes and records honest provenance', async () => {
  const extracted = await extractWithOpenAI({ document, profile: 'rwa-secondary', apiKey: 'test-key', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(JSON.parse(body.input[0].content)[0].passages[0].text, document.text);
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.max_output_tokens, 6000);
    assert.equal(body.text.format.schema.properties.nodes.maxItems, 24);
    assert.equal(body.text.format.schema.properties.relations.maxItems, 12);
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(init.headers.authorization, 'Bearer test-key');
    return Response.json(result());
  } });
  assert.deepEqual(extracted.envelope.ast, validateLegalAst(materializePassages(ast, sourcePassages(document)), document));
  assert.equal(extracted.envelope.extraction.provider, 'openai');
  assert.equal(extracted.envelope.extraction.analysisMode, 'light');
  assert.equal(extracted.envelope.extraction.reasoningEffort, 'none');
  assert.equal(extracted.verification, null);
  assert.equal(extracted.envelope.source.sha256, document.sha256);
});
test('OpenAI rejects missing keys, errors, refusals, incomplete output and invented quotes', async () => {
  await assert.rejects(extractWithOpenAI({ document, apiKey: '' }), /OPENAI_API_KEY/);
  for (const [response, message] of [
    [new Response('secret upstream diagnostic', { status: 401 }), /HTTP 401/],
    [Response.json({ status: 'incomplete', output: [] }), /incomplete/],
    [Response.json({ status: 'completed', output: [{ content: [{ type: 'refusal' }] }] }), /declined/],
    [Response.json(result({ ...ast, nodes: [{ ...ast.nodes[0], source: { ...ast.nodes[0].source, spanId: 'invented-passage' } }] })), /Unknown source passage/],
  ]) await assert.rejects(extractWithOpenAI({ document, apiKey: 'test', fetchImpl: async () => response.clone() }), message);
});
test('demo extraction is deterministic and does not need OpenAI', async () => {
  const ast = { schemaVersion: '1.0', title: 'Demo', parties: [], rules: [], terms: [], unresolved: [] };
  const extracted = await extractWorkspace({ generation: 'demo', document, draft: ast, apiKey: '' });
  assert.equal(extracted.envelope.extraction.provider, 'demo');
  assert.deepEqual(extracted.envelope.ast, ast);
  await assert.rejects(extractWorkspace({ generation: 'demo', document, draft: null }), /bundled/);
});

test('OpenAI logs correlated timings and usage without source or credentials', async () => {
  const logs = [];
  let sentId;
  await extractWithOpenAI({ document, apiKey: 'private-api-key', agreementId: 'agr_logging', log: (entry) => logs.push(entry),
    fetchImpl: async (_url, init) => {
      sentId = init.headers['X-Client-Request-Id'];
      return Response.json({ ...result(), usage: { input_tokens: 100, output_tokens: 200, output_tokens_details: { reasoning_tokens: 30 } } },
        { headers: { 'x-request-id': 'req_logging', 'openai-processing-ms': '1234' } });
    } });
  assert.deepEqual(logs.map((entry) => entry.event), ['request.started', 'response.headers', 'response.received', 'validation.started', 'request.completed']);
  assert.ok(sentId);
  assert.ok(logs.every((entry) => entry.clientRequestId === sentId && entry.agreementId === 'agr_logging' && entry.elapsedMs >= 0));
  assert.equal(logs[1].requestId, 'req_logging');
  assert.equal(logs[1].processingMs, '1234');
  assert.equal(logs[2].outputTokens, 200);
  assert.equal(logs[2].reasoningTokens, 30);
  assert.equal(logs.at(-1).responseId, 'resp_test');
  assert.ok(logs.at(-1).validationMs >= 0);
  assert.equal(JSON.stringify(logs).includes('private-api-key'), false);
  assert.equal(JSON.stringify(logs).includes(document.text), false);
});

test('OpenAI logs timeout stage for both request and response-body failures', async () => {
  for (const stage of ['request', 'response_body']) {
    const logs = [];
    const fail = () => { throw new DOMException('private upstream detail', 'TimeoutError'); };
    await assert.rejects(extractWithOpenAI({ document, apiKey: 'test', timeoutMs: 1234, log: (entry) => logs.push(entry),
      fetchImpl: async () => stage === 'request' ? fail() : { ok: true, status: 200, headers: new Headers(), json: fail },
    }), /OpenAI AST generation timed out/);
    assert.equal(logs[0].timeoutMs, 1234);
    assert.equal(logs.at(-1).stage, stage);
    assert.equal(logs.at(-1).timedOut, true);
    assert.equal(logs.at(-1).event, 'request.failed');
    assert.equal(JSON.stringify(logs).includes('private upstream detail'), false);
    assert.equal(logs.some((entry) => entry.event === 'validation.started'), false);
  }
});

test('OpenAI logs HTTP and validation failures and rejects invalid timeout configuration', async () => {
  for (const [response, stage] of [
    [new Response('private error', { status: 429, headers: { 'x-request-id': 'req_failed' } }), 'http_error'],
    [Response.json(result({ ...ast, nodes: [{ ...ast.nodes[0], source: { ...ast.nodes[0].source, spanId: 'invented-passage' } }] })), 'source_validation'],
  ]) {
    const logs = [];
    await assert.rejects(extractWithOpenAI({ document, apiKey: 'test', log: (entry) => logs.push(entry), fetchImpl: async () => response.clone() }));
    assert.equal(logs.at(-1).stage, stage);
    assert.equal(logs.at(-1).event, 'request.failed');
    assert.equal(logs.at(-1).timedOut, false);
    assert.equal(JSON.stringify(logs).includes('private error'), false);
  }
  for (const timeoutMs of [0, -1, NaN, 1.5, 3_600_001]) {
    await assert.rejects(extractWithOpenAI({ document, apiKey: 'test', timeoutMs, fetchImpl: () => assert.fail('must not call OpenAI') }), /OPENAI_TIMEOUT_MS/);
  }
});

test('OpenAI emits waiting heartbeats and stops them after success or failure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const fail of [false, true]) {
    const logs = [];
    let finish;
    const pending = extractWithOpenAI({ document, apiKey: 'test', log: (entry) => logs.push(entry),
      fetchImpl: () => new Promise((resolve, reject) => { finish = () => fail ? reject(new TypeError('network failed')) : resolve(Response.json(result())); }) });
    t.mock.timers.tick(15_000);
    assert.equal(logs.at(-1).event, 'request.waiting');
    finish();
    if (fail) await assert.rejects(pending, /Could not reach OpenAI/);
    else await pending;
    const count = logs.length;
    t.mock.timers.tick(30_000);
    assert.equal(logs.length, count);
  }
});

test('OpenAI retries invalid references once using only the approved source input', async () => {
  let calls = 0;
  let firstBody;
  const logs = [];
  const invalid = { ...ast, relations: [{ ...ast.relations[0], to: 'node-24' }] };
  const extracted = await extractWithOpenAI({ document, apiKey: 'test', log: (entry) => logs.push(entry), fetchImpl: async (_url, init) => {
    calls++;
    if (calls === 1) firstBody = init.body;
    else assert.equal(init.body, firstBody, 'retry sends no failed candidate or validation error');
    return Response.json(result(calls === 1 ? invalid : ast));
  } });
  assert.equal(calls, 2);
  assert.equal(extracted.envelope.extraction.validationRetries, 1);
  assert.ok(logs.some((entry) => entry.event === 'validation.retrying'));
  assert.ok(logs.some((entry) => entry.event === 'request.retried'));
  calls = 0;
  await assert.rejects(extractWithOpenAI({ document, apiKey: 'test', log: () => {}, fetchImpl: async () => {
    calls++; return Response.json(result(invalid));
  } }), /Dangling clause relationship/);
  assert.equal(calls, 2, 'invalid output never loops indefinitely');
});
