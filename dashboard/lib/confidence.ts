import type { Verification } from "./types";

/** What the overall confidence rests on, in plain words. */
export function confidenceBasis(report: Verification): string {
  const { basis, total } = report.confidence;
  if (basis === "evaluations" || (!basis && !total && report.evaluations?.length))
    return `from ${report.evaluations?.length ?? 0} models' scores of the final answer; they did not split it into separate claims`;
  if (basis === "winner") return "from the winning answer's aggregate score";
  return `from ${total} claim${total === 1 ? "" : "s"} the models checked`;
}

/** One line for a claim's verdicts, including the case where none was recorded. */
export const verdictsOf = (claim: Verification["claims"][number]) =>
  claim.verdicts.length ? null : "No verdict recorded for this claim.";
