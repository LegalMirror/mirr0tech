import { describe, expect, it } from "vitest";
import {
  decideOnchain,
  evaluateCondition,
  evaluatePolicy,
  evaluateTerms,
  explain,
  factsForAction,
  factsOfCondition,
  pack,
  verdictOf,
  type Facts,
} from "@/lib/evaluate";
import type { PolicyData } from "@/lib/types";
// The interpreter the gateway runs, imported as-is.
import { evaluatePolicy as original } from "../../src/policy/evaluate.js";
import { compiled } from "./fixtures";

const PROFILES = ["custodial-rwa", "wildcat-credit"] as const;

/** Every three-valued assignment of `names`, as the compile-time proof enumerates them. */
function* assignments(names: string[]): Generator<Facts> {
  for (let index = 0; index < 3 ** names.length; index++) {
    const facts: Facts = {};
    let rest = index;
    for (const name of names) {
      const digit = rest % 3;
      rest = Math.floor(rest / 3);
      facts[name] = digit === 2 ? null : digit === 1;
    }
    yield facts;
  }
}

function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe.each(PROFILES)("%s", (profile) => {
  it("evaluates every exported DNF exactly like the condition tree over all 3^k assignments", async () => {
    const policy = await compiled(profile);
    for (const rule of policy.rules) {
      const names = [...factsOfCondition(rule.condition)];
      for (const facts of assignments(names)) {
        const { known, value } = pack(facts, policy.factOrder);
        expect(evaluateTerms(rule.dnf, known, value), `${rule.id} ${JSON.stringify(facts)}`).toBe(
          evaluateCondition(rule.condition, facts)
        );
      }
    }
  });

  it("decides like src/policy/evaluate.js and like the on-chain program on random wallets", async () => {
    const policy: PolicyData = await compiled(profile);
    const next = seeded(42);
    for (let round = 0; round < 400; round++) {
      const facts: Facts = {};
      for (const name of policy.factOrder) {
        const roll = next();
        if (roll < 0.45) facts[name] = true;
        else if (roll < 0.7) facts[name] = false;
      }
      for (const action of policy.actionOrder) {
        const ours = evaluatePolicy(policy.rules, action, facts);
        const theirs = original({ rules: policy.rules }, action, facts);
        expect(ours.allowed).toBe(theirs.allowed);
        expect(ours.reasons).toEqual(theirs.reasons);
        const { known, value } = pack(facts, policy.factOrder);
        expect(decideOnchain(policy.rules, action, known, value).allowed).toBe(ours.allowed);
      }
    }
  });
});

describe("the on-chain decision", () => {
  it("names the first failing clause, and 0 when no permit holds", async () => {
    const policy = await compiled("wildcat-credit");
    const admitted: Facts = {
      mlaCountersigned: true,
      lenderCheckPassed: true,
      amlKycProvided: true,
      notInsolvent: true,
      screeningCurrent: true,
      sanctionsClear: true,
    };
    expect(explain(policy, "deposit", admitted).onchain).toEqual({ allowed: true, clauseId: 0 });
    const countersigned = policy.rules.find((rule) => rule.id === "deposit-countersigned")!;
    expect(explain(policy, "deposit", { ...admitted, mlaCountersigned: null }).onchain).toEqual({
      allowed: false,
      clauseId: countersigned.clauseId,
    });
    expect(explain(policy, "mint", admitted).onchain).toEqual({ allowed: false, clauseId: 0 });
  });
});

describe("verdictOf", () => {
  it("approves, queues an unknown for review and denies a prohibition outright", async () => {
    const policy = await compiled("wildcat-credit");
    const admitted: Facts = {
      mlaCountersigned: true,
      lenderCheckPassed: true,
      amlKycProvided: true,
      notInsolvent: true,
      screeningCurrent: true,
      sanctionsClear: true,
    };
    expect(verdictOf(policy, "deposit", admitted)).toBe("approve");
    expect(verdictOf(policy, "deposit", { ...admitted, mlaCountersigned: null })).toBe("review");
    expect(verdictOf(policy, "deposit", { ...admitted, sanctionsClear: false })).toBe("deny");
    expect(verdictOf(policy, "deposit", { ...admitted, notInsolvent: false })).toBe("deny");
    // A sanctioned wallet with an open question is still denied: the prohibition decides first.
    expect(verdictOf(policy, "deposit", { ...admitted, mlaCountersigned: null, sanctionsClear: false })).toBe(
      "deny"
    );
  });

  it("lists the facts an action mentions in bit order", async () => {
    const policy = await compiled("wildcat-credit");
    const names = factsForAction(policy, "withdraw");
    expect(names).toEqual([
      "sanctionsClear",
      "lenderCheckPassed",
      "screeningCurrent",
      "openTermState",
      "borrowerOverride",
    ]);
    expect(names.map((name) => policy.factOrder.indexOf(name))).toEqual(
      [...names.map((name) => policy.factOrder.indexOf(name))].sort((a, b) => a - b)
    );
  });
});
