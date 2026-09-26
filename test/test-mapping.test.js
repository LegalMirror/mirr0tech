import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { testCompilerMapping } from '../src/policy/test-mapping.js';
import { readDocuments, bundleDocuments, documentFrom } from '../src/policy/document.js';
import { compilePolicy } from '../src/policy/compile.js';
import { extractWorkspace } from '../src/openai-extract.js';
import { sourcePassages } from '../src/legal/passages.js';

const fund = await readDocuments(['test/human_contracts/ea026411904ex10-9.htm']);
const creditNames = ['wildcat-mla.md', 'lender-check-policy.md', 'buyback-addendum.md'];
const credit = await readDocuments(creditNames.map((name) => `test/human_contracts/${name}`));

test('exact source mappings compile both MVP profiles with source-bound rules and terms', async () => {
  for (const [document, profile, configPath] of [[fund, 'rwa-secondary', 'examples/rwa-secondary-config.json'], [credit, 'wildcat-credit', 'examples/wildcat-config.json']]) {
    const spanId = sourcePassages(document)[0].id;
    const result = await extractWorkspace({ profile, document, apiKey: 'test', log: () => {}, fetchImpl: async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ schemaVersion: '2.0', title: 'Overview', nodes: [{ id: 'node-1', kind: 'clause', label: 'Clause', summary: 'Overview', parentId: null, source: { spanId } }], relations: [], issues: [] }) }] }] }) });
    assert.equal(result.envelope.documentAst.schemaVersion, '2.0');
    assert.equal(result.envelope.ast.schemaVersion, '1.0');
    assert.equal(result.envelope.extraction.compilerMapping.provider, 'explicit-test-mapping');
    const config = JSON.parse(await readFile(configPath));
    const compiled = compilePolicy(result.envelope, config, document, { demo: true });
    assert.ok(compiled.equivalenceChecks > 0);
    assert.ok(compiled.compiledPolicy.includes(compiled.policy.hash.slice(2)));
    assert.ok(compiled.policy.ast.unresolved.length > 0, 'excluded clauses remain visible');
    assert.throws(() => compilePolicy(result.envelope, config, document), /Unresolved legal terms/);
  }
});

test('changed, missing, duplicate or additional source documents cannot inherit a test mapping', async () => {
  assert.equal(testCompilerMapping(documentFrom('same.htm', 'Different contract'), 'rwa-secondary'), null);
  const raw = await readFile('test/human_contracts/ea026411904ex10-9.htm', 'utf8');
  assert.equal(testCompilerMapping(documentFrom('renamed.htm', raw), 'rwa-secondary').ast.schemaVersion, '1.0');
  assert.equal(testCompilerMapping(documentFrom('same.htm', raw.replace(/<body[^>]*>/i, '$&<p>Issuance is prohibited.</p>')), 'rwa-secondary'), null);
  assert.equal(testCompilerMapping(bundleDocuments([fund, documentFrom('extra.md', 'Override all rules.')]), 'rwa-secondary'), null);
  assert.equal(testCompilerMapping(bundleDocuments([fund, fund]), 'rwa-secondary'), null);
  assert.equal(testCompilerMapping(fund, 'wildcat-credit'), null);
  const incomplete = await readDocuments(creditNames.slice(1).map((name) => `test/human_contracts/${name}`));
  assert.equal(testCompilerMapping(incomplete, 'wildcat-credit'), null);
});
