// Converts a policy condition into disjunctive normal form so the same decision can run on chain
// from two machine words. Kleene three-valued logic satisfies De Morgan and distributivity, so the
// conversion preserves unknown exactly as evaluate.js propagates it.
import { FACTS, ACTIONS } from './schema.js';

const MAX_TERMS = 64;

// Push negations down to the leaves. not(all) becomes any(not), not(any) becomes all(not).
export function toNnf(node, negated = false) {
  if (node.type === 'fact') return { fact: node.name, negated };
  if (node.type === 'not') return toNnf(node.child, !negated);
  const type = negated ? (node.type === 'all' ? 'any' : 'all') : node.type;
  return { type, children: node.children.map((child) => toNnf(child, negated)) };
}

// A term is one conjunction of literals: facts that must be true, and facts that must be false.
// A fact appearing on both sides is kept, not simplified away: `p AND NOT p` is false when p is
// known and unknown when it is not, which is exactly what the mask evaluation produces.
function product(left, right) {
  const terms = [];
  for (const a of left) for (const b of right) terms.push({ pos: a.pos | b.pos, neg: a.neg | b.neg });
  return terms;
}

export function toDnf(nnf) {
  if (nnf.fact !== undefined) {
    const bit = 1n << BigInt(FACTS.indexOf(nnf.fact));
    return [nnf.negated ? { pos: 0n, neg: bit } : { pos: bit, neg: 0n }];
  }
  const children = nnf.children.map(toDnf);
  let terms = nnf.type === 'any'
    ? children.flat()
    : children.reduce((acc, child) => product(acc, child), [{ pos: 0n, neg: 0n }]);
  const seen = new Set();
  terms = terms.filter((term) => {
    const key = `${term.pos}:${term.neg}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (terms.length > MAX_TERMS) throw new Error(`Condition expands to ${terms.length} terms, over the ${MAX_TERMS} limit`);
  return terms;
}

export const compileCondition = (condition) => toDnf(toNnf(condition));

// Kleene evaluation of one term against a known/value pair. Mirrors PolicyEval.sol exactly.
export function evaluateTerm(term, known, value) {
  const knownPos = known & term.pos;
  const knownNeg = known & term.neg;
  if ((value & knownPos) !== knownPos) return false;
  if ((value & knownNeg) !== 0n) return false;
  return (knownPos === term.pos && knownNeg === term.neg) ? true : null;
}

export function evaluateTerms(terms, known, value) {
  let unknown = false;
  for (const term of terms) {
    const result = evaluateTerm(term, known, value);
    if (result === true) return true;
    if (result === null) unknown = true;
  }
  return unknown ? null : false;
}

// The same decision rule as evaluate.js: one permit must hold, every requirement must hold, and no
// prohibition may hold. Unknown never satisfies anything, so missing evidence denies.
// A refusal names the failing requirement or prohibition, or — when no permission held — the first
// permission, so every denial points at a sentence. Mirrors PolicyEval.sol.
export function decide(program, known, value) {
  let permitted = false;
  let firstPermit = 0;
  for (const rule of program) {
    const result = evaluateTerms(rule.terms, known, value);
    if (rule.effect === 'permit') { if (!firstPermit) firstPermit = rule.clauseId; if (result === true) permitted = true; continue; }
    if (rule.effect === 'require' && result !== true) return { allowed: false, clauseId: rule.clauseId };
    if (rule.effect === 'forbid' && result !== false) return { allowed: false, clauseId: rule.clauseId };
  }
  return permitted ? { allowed: true, clauseId: 0 } : { allowed: false, clauseId: firstPermit };
}

// Clause ids are one-based indices into a table of the rule's id, clause and verbatim quote. The
// table's hash is committed on chain so a decoded revert cannot be pointed at a different quote.
export function buildProgram(ast) {
  const clauses = ast.rules.map((rule, index) => ({
    clauseId: index + 1, ruleId: rule.id, action: rule.action, effect: rule.effect,
    clause: rule.source.clause, quote: rule.source.quote,
  }));
  const byAction = ACTIONS.map((action) => ast.rules
    .map((rule, index) => ({ rule, clauseId: index + 1 }))
    .filter(({ rule }) => rule.action === action)
    .map(({ rule, clauseId }) => ({ clauseId, effect: rule.effect, terms: compileCondition(rule.condition) })));
  return { actions: ACTIONS, facts: FACTS, clauses, byAction };
}
