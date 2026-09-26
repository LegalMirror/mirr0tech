import type { Verification } from "./types";

/** A confidence as a reader says it. */
export function confidenceLabel(score: number): "high" | "medium" | "low" {
  return score >= 0.9 ? "high" : score >= 0.7 ? "medium" : "low";
}

/** The claims the deliberation assessed about one rule, term or open item. */
export function claimsFor(verification: Verification | undefined, ref: string) {
  return verification?.claims.filter((claim) => claim.ref === ref) ?? [];
}

/** One sentence for the intro: who verified what, and how sure. */
export function verificationSentence(verification: Verification): string {
  const { confidence, agents, rounds } = verification;
  return `${confidence.verified} of ${confidence.total} claims verified by Noolog agents ${agents.join(" and ")} over ${rounds} rounds · confidence ${confidence.overall.toFixed(2)} (${confidenceLabel(confidence.overall)})`;
}
