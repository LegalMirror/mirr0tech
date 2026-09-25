// What the overview shows per act: who stands where, and the transactions that prove it.
import { explain, type Verdict } from "./evaluate";
import { effectiveFacts, statusAction } from "./parties";
import type { AuditEvent, Party, PolicyData } from "./types";

/** The newest events that link to an explorer, at most `limit`. */
export function proofLinks(events: AuditEvent[], limit = 3): AuditEvent[] {
  return [...events]
    .filter((event) => event.explorer)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Each party's standing under the policy's admission action. */
export function standings(policy: PolicyData, parties: Party[]): { party: Party; verdict: Verdict }[] {
  return parties.map((party) => ({
    party,
    verdict: explain(policy, statusAction(policy), effectiveFacts(policy, party)).verdict,
  }));
}
