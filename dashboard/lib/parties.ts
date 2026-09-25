// Assemble a party's facts the way PolicyOracle.facts does on chain: attested facts only while the
// attestation is live, `screeningCurrent` derived from it, observable facts read, never attested.
import { factsForAction, type Facts } from "./evaluate";
import type { Party, PolicyData } from "./types";

const OBSERVABLE = new Set(["sanctionsClear", "openTermState", "screeningCurrent"]);

export function effectiveFacts(policy: PolicyData, party: Party): Facts {
  if (policy.profile !== "wildcat-credit") return { ...party.facts };
  const facts: Facts = {};
  if (party.screenedAt !== null) {
    for (const [name, value] of Object.entries(party.facts)) if (!OBSERVABLE.has(name)) facts[name] = value;
    facts.screeningCurrent = true;
  }
  facts.sanctionsClear = party.sanctions === "clear" ? true : party.sanctions === "flagged" ? false : null;
  facts.openTermState = true;
  return facts;
}

/** The action whose decision is a party's status: admission for a lender, issuance for an investor. */
export const statusAction = (policy: PolicyData) =>
  policy.profile === "wildcat-credit" ? "deposit" : "mint";

/** When the attestation behind a credential lapses, in unix seconds. */
export function credentialExpiry(policy: PolicyData, party: Party): number | null {
  const window = Number(policy.config.attestationValiditySeconds ?? 0);
  return party.screenedAt !== null && window > 0 ? party.screenedAt + window : null;
}

/** The facts some rule of this policy reads, in bit order; the rest of the fact set is noise here. */
export function relevantFacts(policy: PolicyData): string[] {
  const used = new Set(policy.actionOrder.flatMap((action) => factsForAction(policy, action)));
  return policy.factOrder.filter((name) => used.has(name));
}
