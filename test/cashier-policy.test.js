import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readDocuments, documentFrom } from '../src/policy/document.js';
import { compilePolicy, verifyPolicy } from '../src/policy/compile.js';
import { cashierFixture, readCashierTerms, cashierConfigurationHash } from '../src/policy/cashier.js';
import { sampleFixture } from '../src/policy/fixture.js';
import { deployFund } from '../src/deploy.js';

const document = await readDocuments(['test/human_contracts/ea026411904ex10-9.htm', 'test/human_contracts/nav-cashier-addendum.md']);
const config = JSON.parse(await readFile('examples/rwa-cashier-config.json', 'utf8'));
const CASHIER_TERMS = readCashierTerms(document);
const compile = (envelope = cashierFixture(document), cfg = config, doc = document) => compilePolicy(envelope, cfg, doc, { demo: true });

test('cashier economics are opt-in, document-validated, separately cited and hash bound', () => {
  const result = compile();
  assert.equal(verifyPolicy(result.policy), result.policy);
  assert.deepEqual([result.policy.cashier.subscriptionFeeBps, result.policy.cashier.redemptionFeeBps], [25, 25]);
  assert.match(result.solidity, /MirrorCashierToken/);
  assert.equal(result.cashier.configurationHash, cashierConfigurationHash(result.cashier));
  assert.match(result.compiledCashierTerms, /CONFIGURATION_HASH/);
  assert.doesNotMatch(result.compiledCashierTerms, /NAV =|FEE_BPS =|EXECUTION_CLAUSE =/);
  assert.ok(result.contracts.some(([, , name]) => name === 'MirrorCashierHook'));
  for (const term of CASHIER_TERMS) {
    const clause = result.clauseTable.clauses[result.policy.cashier.clauseIds[term.name] - 1];
    assert.equal(clause.quote, term.source.quote);
    assert.ok(document.text.includes(clause.quote));
  }
  const changed = structuredClone(result.policy);
  changed.cashier.redemptionFeeBps = 0;
  assert.throws(() => verifyPolicy(changed), /integrity/);
  assert.throws(() => compilePolicy(cashierFixture(document), config, document), /Unresolved|DEMO/);
});

test('arbitrary config, fake term values, unrelated verbatim quotes and base-only economics fail closed', async () => {
  assert.throws(() => compile(undefined, { ...config, cashier: { enabled: true, subscriptionFeeBps: 0 } }), /economics/);
  assert.throws(() => compile(undefined, { ...config, maxSupply: '1' }), /cap/);
  for (const term of CASHIER_TERMS) {
    for (const kind of ['value', 'quote', 'missing']) {
      const envelope = cashierFixture(document);
      const entry = envelope.ast.terms.find((entry) => entry.name === term.name);
      if (kind === 'value') entry.value = '0';
      if (kind === 'quote') entry.source.quote = envelope.ast.rules[0].source.quote;
      if (kind === 'missing') envelope.ast.terms = envelope.ast.terms.filter((entry) => entry.name !== term.name);
      assert.throws(() => compile(envelope), /Cashier term/);
    }
  }
  const base = await readDocuments(['test/human_contracts/ea026411904ex10-9.htm']);
  assert.throws(() => compile(sampleFixture(base, { secondary: true }), config, base), /addendum/);
});

const alternateText = () => document.text
  .replace('USD 1.00 per share', 'USD 2.50 per share')
  .replace('subscription fee is 25 basis points', 'subscription fee is 40 basis points').replace('input / 1.0025', 'input / 2.51')
  .replace('redemption fee is 25 basis points', 'redemption fee is 90 basis points').replace('input * 0.9975', 'input * 2.4775')
  .replace('1000000 shares, including', '2000000 shares, including');
const alternateConfig = () => ({ ...config, maxSupply: '2000000000000', cashier: { enabled: true, pool: { fee: 500, tickSpacing: 10 } } });

test('alternate explicit DEMO NAV, distinct fees and cap are derived from quotes; pool settings are hash bound', () => {
  const doc = documentFrom('alternate-demo.md', alternateText());
  const cfg = alternateConfig();
  const result = compile(cashierFixture(doc), cfg, doc);
  assert.equal(result.cashier.navMicroUsd, '2500000');
  assert.equal(result.cashier.subscriptionFeeBps, 40);
  assert.equal(result.cashier.redemptionFeeBps, 90);
  assert.equal(result.cashier.maxSupply, '2000000000000');
  assert.deepEqual(result.cashier.pool, { fee: 500, tickSpacing: 10 });
  assert.notEqual(result.cashier.configurationHash, compile().cashier.configurationHash);
  const poolOnly = compile(cashierFixture(doc), { ...cfg, cashier: { enabled: true, pool: { fee: 100, tickSpacing: 1 } } }, doc);
  assert.equal(poolOnly.cashier.termsHash, result.cashier.termsHash);
  assert.notEqual(poolOnly.cashier.configurationHash, result.cashier.configurationHash);
  assert.notEqual(poolOnly.policy.hash, result.policy.hash);
  for (const term of result.policy.ast.terms) assert.ok(doc.text.includes(term.source.quote));
  assert.throws(() => compile(cashierFixture(doc), { ...cfg, priceModel: 'one-token-per-usd' }, doc), /fixed-nav/);
});

test('unsupported ranges, rounding claims, duplicate evidence and dynamic pool settings are refused', () => {
  for (const text of [
    document.text.replace('USD 1.00 per share', 'USD 0 per share'),
    document.text.replace('USD 1.00 per share', 'USD 0.0000001 per share'),
    document.text.replace('USD 1.00 per share', 'USD 340282366920938463463374607431768.211456 per share'),
    document.text.replace('subscription fee is 25 basis points', 'subscription fee is 10000 basis points'),
    document.text.replace('redemption fee is 25 basis points', 'redemption fee is 10000 basis points'),
    document.text.replace('input / 1.0025', 'input / 1.0024'),
    document.text.replace('input * 0.9975', 'input * 0.9976'),
    document.text.replace('1000000 shares, including', '0 shares, including'),
    `${document.text} DEMO NAV is USD 2.00 per share; shares and mockUSD each use six decimals.`,
    `${document.text} ${CASHIER_TERMS[1].source.quote}`,
  ]) assert.throws(() => cashierFixture(documentFrom('invalid-demo.md', text)));
  for (const pool of [undefined, { fee: 0x800000, tickSpacing: 60 }, { fee: 1000000, tickSpacing: 60 }, { fee: -1, tickSpacing: 60 },
    { fee: 0.5, tickSpacing: 60 }, { fee: 500, tickSpacing: 0 }, { fee: 500, tickSpacing: 32768 }, { fee: 500, tickSpacing: 1, extra: true }]) {
    assert.throws(() => compile(undefined, { ...config, cashier: { enabled: true, pool } }), /pool|static/);
  }
  const zeroFeeDoc = documentFrom('zero-fees.md', document.text.replaceAll('fee is 25 basis points', 'fee is 0 basis points').replace('input / 1.0025', 'input / 1').replace('input * 0.9975', 'input * 1'));
  const zero = compile(cashierFixture(zeroFeeDoc), { ...config, cashier: { enabled: true, pool: { fee: 0, tickSpacing: 1 } } }, zeroFeeDoc);
  assert.equal(zero.cashier.subscriptionFeeBps, 0);
  assert.equal(zero.cashier.redemptionFeeBps, 0);
});

test('deployment rejects missing or tampered metadata before using a signer', async () => {
  const result = compile();
  const sources = { compiledPolicy: result.compiledPolicy, token: result.solidity, cashierTerms: result.compiledCashierTerms, cashier: structuredClone(result.cashier) };
  await assert.rejects(deployFund(null, { record: {}, sources: { ...sources, cashier: undefined } }), /compiler-authorized/);
  sources.cashier.subscriptionFeeBps = 0;
  await assert.rejects(deployFund(null, { record: {}, sources }), /commitment mismatch/);
  sources.cashier.configurationHash = cashierConfigurationHash(sources.cashier);
  await assert.rejects(deployFund(null, { record: {}, sources }), /compiler-authorized/);
});

test('no-cashier secondary compiles unchanged without cashier terms or contracts', async () => {
  const base = await readDocuments(['test/human_contracts/ea026411904ex10-9.htm']);
  const cfg = JSON.parse(await readFile('examples/rwa-secondary-config.json', 'utf8'));
  const result = compile(sampleFixture(base, { secondary: true }), cfg, base);
  assert.equal(result.policy.cashier, undefined);
  assert.equal(result.compiledCashierTerms, null);
  assert.match(result.solidity, /is MirrorToken/);
  assert.ok(!result.contracts.some(([, , name]) => name === 'MirrorCashierHook'));
});
