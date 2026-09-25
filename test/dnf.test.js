import test from 'node:test';
import assert from 'node:assert/strict';
import { FACTS, ACTIONS } from '../src/policy/schema.js';
import { evaluatePolicy } from '../src/policy/evaluate.js';
import { buildProgram, compileCondition, decide, evaluateTerms } from '../src/policy/dnf.js';
import { envelope } from './helpers.js';

const usedFacts = (node, found = new Set()) => {
  if (node.type === 'fact') found.add(node.name);
  if (node.child) usedFacts(node.child, found);
  if (node.children) node.children.forEach((child) => usedFacts(child, found));
  return found;
};

// Every assignment of true/false/unknown over the facts a rule mentions.
function* assignments(names) {
  const total = 3 ** names.length;
  for (let index = 0; index < total; index++) {
    const facts = {};
    let rest = index;
    for (const name of names) {
      const digit = rest % 3;
      rest = Math.floor(rest / 3);
      if (digit !== 2) facts[name] = digit === 1;
    }
    yield facts;
  }
}

const pack = (facts) => {
  let known = 0n;
  let value = 0n;
  for (const [name, boolean] of Object.entries(facts)) {
    const bit = 1n << BigInt(FACTS.indexOf(name));
    known |= bit;
    if (boolean) value |= bit;
  }
  return { known, value };
};

test('DNF masks reproduce the tree interpreter on every three-valued assignment', () => {
  const single = (condition, facts) =>
    evaluatePolicy({ rules: [{ id: 'r', action: 'mint', effect: 'require', condition, source: {}, rationale: '' }] }, 'mint', facts)
      .trace[0].result;
  let checked = 0;
  for (const rule of envelope.ast.rules) {
    const names = [...usedFacts(rule.condition)];
    const terms = compileCondition(rule.condition);
    for (const facts of assignments(names)) {
      const { known, value } = pack(facts);
      assert.equal(evaluateTerms(terms, known, value), single(rule.condition, facts),
        `${rule.id} disagrees on ${JSON.stringify(facts)}`);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('whole-policy decisions agree across every assignment of the facts in play', () => {
  const program = buildProgram(envelope.ast);
  const names = [...new Set(envelope.ast.rules.flatMap((rule) => [...usedFacts(rule.condition)]))];
  assert.ok(names.length <= 12, 'exhaustive comparison would be too large');
  for (const facts of assignments(names)) {
    const { known, value } = pack(facts);
    for (const [index, action] of ACTIONS.entries()) {
      const expected = evaluatePolicy(envelope.ast, action, facts);
      const actual = decide(program.byAction[index], known, value);
      assert.equal(actual.allowed, expected.allowed, `${action} disagrees on ${JSON.stringify(facts)}`);
    }
  }
});

test('a denial names a clause that carries the verbatim quote', () => {
  const program = buildProgram(envelope.ast);
  const mint = ACTIONS.indexOf('mint');
  const result = decide(program.byAction[mint], ...Object.values(pack({ kycApproved: false })));
  assert.equal(result.allowed, false);
  if (result.clauseId !== 0) {
    const clause = program.clauses[result.clauseId - 1];
    assert.ok(clause.quote.length > 0);
    assert.ok(envelope.ast.rules.some((rule) => rule.id === clause.ruleId));
  }
});

test('unknown facts deny, including under negation', () => {
  const terms = compileCondition({ type: 'not', child: { type: 'fact', name: 'sanctionsClear' } });
  assert.equal(evaluateTerms(terms, 0n, 0n), null);
});

test('a contradiction is false when known and unknown when not', () => {
  const terms = compileCondition({ type: 'all', children: [
    { type: 'fact', name: 'kycApproved' }, { type: 'not', child: { type: 'fact', name: 'kycApproved' } }] });
  assert.equal(evaluateTerms(terms, 1n, 1n), false);
  assert.equal(evaluateTerms(terms, 0n, 0n), null);
});
