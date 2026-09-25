import type { ClauseEntry, PolicyData } from "./types";

export type DecodedRefusal = { kind: "clause" | "no-permit"; clauses: ClauseEntry[] };

/**
 * What a refusal's clauseId means. A failing requirement or prohibition names itself; clauseId 0
 * means no permit held, and the sentences a wallet failed to satisfy are the action's permits.
 */
export function decodeRefusal(policy: PolicyData, action: string, clauseId: number): DecodedRefusal {
  if (clauseId > 0)
    return { kind: "clause", clauses: policy.clauseTable.filter((entry) => entry.clauseId === clauseId) };
  return {
    kind: "no-permit",
    clauses: policy.clauseTable.filter((entry) => entry.action === action && entry.effect === "permit"),
  };
}
