import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveComponents, COMPONENTS, PROFILES } from '../src/onchain/components.js';
import { readDocument, readDocuments } from '../src/policy/document.js';
import { sampleFixture } from '../src/policy/fixture.js';
import { mlaFixture } from '../src/policy/mla-fixture.js';
import { compilePolicy } from '../src/policy/compile.js';

const rwaDocument = await readDocument('test/human_contracts/ea026411904ex10-9.htm');
const creditDocument = await readDocuments(['test/human_contracts/wildcat-mla.md', 'test/human_contracts/lender-check-policy.md', 'test/human_contracts/buyback-addendum.md']);
const config = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('every rule and term of each fixture resolves to an enforcing component', async () => {
  const cases = [
    [sampleFixture(rwaDocument).ast, await config('examples/demo-config.json')],
    [sampleFixture(rwaDocument, { secondary: true }).ast, await config('examples/rwa-secondary-config.json')],
    [mlaFixture(creditDocument).ast, await config('examples/wildcat-config.json')],
  ];
  for (const [ast, cfg] of cases) {
    const resolution = resolveComponents(ast, cfg);
    for (const rule of ast.rules) assert.ok(resolution.coverage.rules[rule.id]?.length, `${rule.id} has no enforcer`);
    for (const term of ast.terms) assert.ok(resolution.coverage.terms[term.name]?.length, `${term.name} has no consumer`);
    assert.deepEqual(resolution.components.map((c) => c.id), PROFILES[cfg.profile ?? 'custodial-rwa']);
  }
});

test('an unclaimed rule or term is a compile error, not a guess', async () => {
  const ast = structuredClone(mlaFixture(creditDocument).ast);
  const cfg = await config('examples/demo-config.json'); // custodial profile: no wildcat components
  assert.throws(() => resolveComponents(ast, cfg), /enforces action "deposit"/);
  const orphan = structuredClone(mlaFixture(creditDocument).ast);
  orphan.terms.push({ name: 'somethingNobodyConsumes', value: '1', unit: 'x', source: orphan.terms[0].source, rationale: 'orphan' });
  const creditConfig = await config('examples/wildcat-config.json');
  assert.throws(() => resolveComponents(orphan, creditConfig), /consumes term "somethingNobodyConsumes"/);
});

test('the policy hash commits to the component set', async () => {
  const cfg = await config('examples/wildcat-config.json');
  const base = compilePolicy(mlaFixture(creditDocument), cfg, creditDocument, { demo: true });
  assert.ok(base.policy.components.some((c) => c.id === 'swapvm-buyback'));
  const bumped = COMPONENTS.find((c) => c.id === 'swapvm-buyback');
  const original = bumped.version;
  bumped.version = '9.9.9';
  try {
    const rehashed = compilePolicy(mlaFixture(creditDocument), cfg, creditDocument, { demo: true });
    assert.notEqual(rehashed.policy.hash, base.policy.hash, 'a component upgrade is a different policy');
  } finally { bumped.version = original; }
});

test('the attestation window may not outlive the re-screening term', async () => {
  const cfg = { ...(await config('examples/wildcat-config.json')), attestationValiditySeconds: 31 * 86400 };
  assert.throws(() => compilePolicy(mlaFixture(creditDocument), cfg, creditDocument, { demo: true }), /re-screening interval/);
});

test('every component ships a clause template where it enforces a venue', () => {
  for (const component of COMPONENTS.filter((c) => c.kind === 'venue')) assert.ok(component.clauseTemplate, component.id);
});
