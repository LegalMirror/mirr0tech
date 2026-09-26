import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../src/policy/evaluate.js';
import { validateAst } from '../src/policy/schema.js';
import { compilePolicy, verifyPolicy } from '../src/policy/compile.js';
import { legalAst } from './legal-ast-fixture.js';
import { legalDocument } from './legal-ast-fixture.js';
import { extractAst } from '../src/policy/extract.js';
import { document, envelope, compiled, config, compliant } from './helpers.js';

test('sample HTML is normalized without scripts, with verifiable clause evidence', () => {
  assert.equal(document.text.includes('bazadebezolkohpepadr'), false);
  assert.ok(document.text.includes('Subscription Documents'));
  assert.equal(validateAst(envelope.ast, document.text), envelope.ast);
  assert.equal(envelope.extraction.provider, 'hand-authored-demo');
});
test('default deny, required conditions, sanctions precedence and unknown facts', () => {
  const facts = { ...compliant, depositConfirmed: true };
  assert.equal(evaluatePolicy(envelope.ast, 'mint', facts).allowed, true);
  assert.equal(evaluatePolicy(envelope.ast, 'transfer', facts).allowed, false);
  assert.equal(evaluatePolicy(envelope.ast, 'mint', { ...facts, subscriptionAccepted: false }).allowed, false);
  assert.equal(evaluatePolicy(envelope.ast, 'mint', { ...facts, sanctionsClear: false }).allowed, false);
  delete facts.sanctionsClear;
  assert.equal(evaluatePolicy(envelope.ast, 'mint', facts).allowed, false);
  assert.equal(evaluatePolicy(envelope.ast, 'mint', {}).allowed, false);
});
test('untrusted AST data cannot introduce facts, code, duplicate IDs or fabricated quotations', () => {
  for (const mutate of [
    (ast) => { ast.code = 'process.exit()'; },
    (ast) => { ast.rules[0].condition = { type: 'fact', name: '__proto__' }; },
    (ast) => { ast.rules[0].source.quote = 'invented text'; },
    (ast) => { ast.rules[1].id = ast.rules[0].id; },
  ]) { const ast = structuredClone(envelope.ast); mutate(ast); assert.throws(() => validateAst(ast, document.text)); }
});
test('compiler is deterministic, rejects missing terms/source mismatch, and binds config', async () => {
  assert.throws(() => compilePolicy(envelope, config, document), /Unresolved/);
  assert.throws(() => compilePolicy(envelope, config, { ...document, sha256: 'wrong' }, { demo: true }), /hash mismatch/);
  assert.equal(compiled.policy.hash, compilePolicy(envelope, config, document, { demo: true }).policy.hash);
  assert.notEqual(compiled.policy.hash, compilePolicy(envelope, { ...config, maxSupply: '100' }, document, { demo: true }).policy.hash);
  const modified = structuredClone(compiled.policy); modified.config.maxSupply = '1';
  assert.throws(() => verifyPolicy(modified), /integrity/);
  const generated = await import(`data:text/javascript;base64,${Buffer.from(compiled.javascript).toString('base64')}`);
  assert.deepEqual(generated.evaluate('mint', { ...compliant, depositConfirmed: true }), evaluatePolicy(envelope.ast, 'mint', { ...compliant, depositConfirmed: true }));
  assert.ok(compiled.solidity.includes(compiled.policy.hash));
});
test('unsupported transfer permission fails compilation explicitly', () => {
  const copy = structuredClone(envelope); copy.ast.rules[0].action = 'transfer';
  assert.throws(() => compilePolicy(copy, config, document, { demo: true }), /No component in profile custodial-rwa enforces action "transfer"/);
});
test('live extractor requests strict structured data and validates returned source citations', async () => {
  let body;
  const result = await extractAst(legalDocument, { apiKey: 'test-only', model: 'test-model', fetchImpl: async (_url, request) => {
    body = JSON.parse(request.body);
    return { ok: true, json: async () => ({ id: 'test', status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(legalAst) }] }] }) };
  } });
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(result.source.sha256, legalDocument.sha256);
  assert.equal(result.extraction.provider, 'openai');
});
test('extractor fails on missing credentials, refusals, truncation and malformed output', async () => {
  await assert.rejects(extractAst(document), /OPENAI_API_KEY/);
  for (const response of [
    { status: 'incomplete' },
    { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'No' }] }] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{}' }] }] },
  ]) await assert.rejects(extractAst(document, { apiKey: 'test', model: 'test', fetchImpl: async () => ({ ok: true, json: async () => response }) }));
});
