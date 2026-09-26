import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { anchorQuotes } from '../src/policy/anchor.js';
import { validateAst } from '../src/policy/schema.js';
import { bundleDocuments, documentFrom } from '../src/policy/document.js';

const rule = (id, quote) => ({ id, action: 'mint', effect: 'permit', condition: { type: 'fact', name: 'kycApproved' }, source: { clause: '2', quote }, rationale: 'r' });
const ast = (rules, terms = []) => ({ schemaVersion: '1.0', title: 't', parties: [], rules, terms, unresolved: [] });

test('a quote with curly quotes, dashes or other spacing is replaced by the verbatim span it matches', () => {
  const source = 'Payment to the Issuer�s Custodian — within  two\ndays ("Effective Date").';
  const { ast: anchored, unanchored } = anchorQuotes(ast([rule('a', 'the Issuer’s Custodian - within two days')], [
    { name: 'effectiveDate', value: '2024-03-14', unit: 'date', source: { clause: '1', quote: 'days (“Effective Date”)' }, rationale: 'r' },
  ]), source);
  assert.equal(anchored.rules[0].source.quote, 'the Issuer�s Custodian — within  two\ndays');
  assert.equal(anchored.terms[0].source.quote, 'days ("Effective Date")');
  assert.deepEqual(unanchored, []);
  validateAst(anchored, source);
});

test('a quote the source does not contain moves to unresolved instead of failing the job', () => {
  const { ast: anchored, unanchored } = anchorQuotes(ast([rule('kept', 'Custodian'), rule('invented', 'words nobody wrote')]), 'the Custodian holds');
  assert.deepEqual(anchored.rules.map((r) => r.id), ['kept']);
  assert.deepEqual(unanchored, [{ kind: 'rule', id: 'invented', clause: '2' }]);
  assert.match(anchored.unresolved[0].description, /quote .* not found in the source/);
  validateAst(anchored, 'the Custodian holds');
});

test('the BUIDL agreement, decoded as it is, anchors the quotes a model writes with real punctuation', async () => {
  const names = ['ea026411904ex10-9.htm', 'nav-cashier-addendum.md'];
  const document = bundleDocuments(await Promise.all(names.map(async (name) => documentFrom(name, await readFile(new URL(`./human_contracts/${name}`, import.meta.url))))));
  const quote = 'confirmation of receipt or crediting of funds for such order to the Issuer’s Custodian.';
  const { ast: anchored, unanchored } = anchorQuotes(ast([rule('mint', quote)]), document.text);
  assert.deepEqual(unanchored, []);
  assert.ok(document.text.includes(anchored.rules[0].source.quote));
});
