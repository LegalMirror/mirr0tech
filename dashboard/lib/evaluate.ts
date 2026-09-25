// A TypeScript port of src/policy/evaluate.js (the tree interpreter) and of the bitmask decision in
// src/policy/dnf.js / PolicyEval.sol. Both run in the browser so the page can show they agree.
import type { Condition, DnfTerm, Effect, PolicyData, Rule, Tri } from "./types";

export type Facts = Record<string, Tri | undefined>;
export type TraceEntry = { id: string; effect: Effect; result: Tri; clauseId: number };
export type Interpretation = { allowed: boolean; reasons: string[]; trace: TraceEntry[] };

export function evaluateCondition(node: Condition, facts: Facts): Tri {
  if (node.type === "fact") {
    const value = facts[node.name];
    return typeof value === "boolean" ? value : null;
  }
  if (node.type === "not") {
    const value = evaluateCondition(node.child, facts);
    return value === null ? null : !value;
  }
  const values = node.children.map((child) => evaluateCondition(child, facts));
  if (node.type === "all") return values.includes(false) ? false : values.includes(null) ? null : true;
  return values.includes(true) ? true : values.includes(null) ? null : false;
}

/** evaluatePolicy from src/policy/evaluate.js: one permit must hold, every require, no forbid. */
export function evaluatePolicy(rules: Rule[], action: string, facts: Facts): Interpretation {
  const trace = rules
    .filter((rule) => rule.action === action)
    .map((rule) => ({
      id: rule.id,
      effect: rule.effect,
      result: evaluateCondition(rule.condition, facts),
      clauseId: rule.clauseId,
    }));
  const failures = trace.filter(
    (rule) =>
      (rule.effect === "require" && rule.result !== true) || (rule.effect === "forbid" && rule.result !== false)
  );
  const permitted = trace.some((rule) => rule.effect === "permit" && rule.result === true);
  return {
    allowed: permitted && failures.length === 0,
    reasons: [...(permitted ? [] : ["NO_MATCHING_PERMISSION"]), ...failures.map((rule) => rule.id)],
    trace,
  };
}

/** Fact values as the two machine words a venue passes to PolicyEval.decide. */
export function pack(facts: Facts, factOrder: string[]): { known: bigint; value: bigint } {
  let known = 0n;
  let value = 0n;
  factOrder.forEach((name, index) => {
    const fact = facts[name];
    if (typeof fact !== "boolean") return;
    const bit = 1n << BigInt(index);
    known |= bit;
    if (fact) value |= bit;
  });
  return { known, value };
}

const maskOf = (bits: number[]) => bits.reduce((mask, bit) => mask | (1n << BigInt(bit)), 0n);

/** Kleene evaluation of one DNF term; mirrors PolicyEval.sol. */
export function evaluateTerm(term: DnfTerm, known: bigint, value: bigint): Tri {
  const pos = maskOf(term.pos);
  const neg = maskOf(term.neg);
  const knownPos = known & pos;
  const knownNeg = known & neg;
  if ((value & knownPos) !== knownPos) return false;
  if ((value & knownNeg) !== 0n) return false;
  return knownPos === pos && knownNeg === neg ? true : null;
}

export function evaluateTerms(terms: DnfTerm[], known: bigint, value: bigint): Tri {
  let unknown = false;
  for (const term of terms) {
    const result = evaluateTerm(term, known, value);
    if (result === true) return true;
    if (result === null) unknown = true;
  }
  return unknown ? null : false;
}

/** PolicyEval.decide over the compiled program: the first failing clause, or 0 when no permit held. */
export function decideOnchain(
  rules: Rule[],
  action: string,
  known: bigint,
  value: bigint
): { allowed: boolean; clauseId: number } {
  let permitted = false;
  for (const rule of rules.filter((entry) => entry.action === action)) {
    const result = evaluateTerms(rule.dnf, known, value);
    if (rule.effect === "permit") {
      if (result === true) permitted = true;
      continue;
    }
    if (rule.effect === "require" && result !== true) return { allowed: false, clauseId: rule.clauseId };
    if (rule.effect === "forbid" && result !== false) return { allowed: false, clauseId: rule.clauseId };
  }
  return permitted ? { allowed: true, clauseId: 0 } : { allowed: false, clauseId: 0 };
}

export function factsOfCondition(node: Condition, found = new Set<string>()): Set<string> {
  if (node.type === "fact") found.add(node.name);
  else if (node.type === "not") factsOfCondition(node.child, found);
  else node.children.forEach((child) => factsOfCondition(child, found));
  return found;
}

/** Every fact the rules of one action mention, in bit order. */
export function factsForAction(policy: PolicyData, action: string): string[] {
  const found = new Set<string>();
  policy.rules.filter((rule) => rule.action === action).forEach((rule) => factsOfCondition(rule.condition, found));
  return policy.factOrder.filter((name) => found.has(name));
}

export type Verdict = "approve" | "review" | "deny";

/**
 * The gateway's reading of a decision (ARCHITECTURE §2.2): a prohibition that holds denies with no
 * override; a refusal that an unknown fact could still change is a review item; anything else refused
 * is a denial.
 */
export function verdictOf(policy: PolicyData, action: string, facts: Facts): Verdict {
  const result = evaluatePolicy(policy.rules, action, facts);
  if (result.allowed) return "approve";
  if (result.trace.some((rule) => rule.effect === "forbid" && rule.result === true)) return "deny";
  const unknown = factsForAction(policy, action).some((name) => typeof facts[name] !== "boolean");
  return unknown ? "review" : "deny";
}

export type Explanation = {
  interpretation: Interpretation;
  onchain: { allowed: boolean; clauseId: number };
  known: bigint;
  value: bigint;
  verdict: Verdict;
  agree: boolean;
};

export function explain(policy: PolicyData, action: string, facts: Facts): Explanation {
  const interpretation = evaluatePolicy(policy.rules, action, facts);
  const { known, value } = pack(facts, policy.factOrder);
  const onchain = decideOnchain(policy.rules, action, known, value);
  return {
    interpretation,
    onchain,
    known,
    value,
    verdict: verdictOf(policy, action, facts),
    agree: interpretation.allowed === onchain.allowed,
  };
}

export const hex = (value: bigint) => `0x${value.toString(16)}`;
