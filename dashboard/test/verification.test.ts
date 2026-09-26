import { describe, expect, it } from "vitest";
import { claimsFor, confidenceLabel, verificationSentence } from "@/lib/verification";
import type { Verification } from "@/lib/types";

const verification: Verification = {
  provider: "noolog",
  jobId: "j",
  mock: true,
  agents: ["extractor", "critic"],
  rounds: 2,
  winner: { round: 2, agent: "extractor", score: 0.93 },
  convergence: 1,
  claims: [
    {
      key: "rule:a:quote",
      ref: "rule:a",
      claim: "…",
      verdicts: [{ agent: "critic", verdict: "verified", reason: null }],
      disputed: false,
      score: 1,
    },
    {
      key: "unresolved:x:open",
      ref: "unresolved:x",
      claim: "…",
      verdicts: [{ agent: "critic", verdict: "unverified", reason: null }],
      disputed: false,
      score: 0.5,
    },
  ],
  contested: [],
  confidence: {
    overall: 0.93,
    byRef: { "rule:a": 1, "unresolved:x": 0.5 },
    verified: 1,
    total: 2,
    counts: { verified: 1, contested: 0, unverified: 1, wrong: 0, unknown: 0 },
  },
};

describe("verification", () => {
  it("labels confidence and finds a rule's claims", () => {
    expect(confidenceLabel(0.95)).toBe("high");
    expect(confidenceLabel(0.75)).toBe("medium");
    expect(confidenceLabel(0.2)).toBe("low");
    expect(claimsFor(verification, "rule:a")).toHaveLength(1);
    expect(claimsFor(undefined, "rule:a")).toEqual([]);
    expect(verificationSentence(verification)).toBe("1 of 2 claims verified · confidence 0.93 (high)");
  });
});
