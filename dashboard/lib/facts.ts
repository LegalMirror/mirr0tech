import type { ProfileId } from "./types";

export type FactKind =
  "attested" | "observable" | "derived" | "override" | "operator" | "ledger" | "screening" | "worldid";

export const FACT_KIND_LABEL: Record<FactKind, string> = {
  attested: "attested by the borrower's compliance function",
  observable: "read on chain at decision time",
  derived: "derived from a live attestation",
  override: "borrower override (MLA 13(c)(y))",
  operator: "operator attestation",
  ledger: "gateway ledger",
  screening: "mock screening result",
  worldid: "World ID document credential, bound to this wallet",
};

const CREDIT: Record<string, FactKind> = {
  mlaCountersigned: "attested",
  lenderCheckPassed: "attested",
  amlKycProvided: "attested",
  notInsolvent: "attested",
  sanctionsClear: "observable",
  openTermState: "observable",
  screeningCurrent: "derived",
  borrowerOverride: "override",
};

const CUSTODIAL: Record<string, FactKind> = {
  kycApproved: "screening",
  amlApproved: "screening",
  sanctionsClear: "screening",
  identityVerified: "worldid",
  subscriptionAccepted: "operator",
  issuerAuthorized: "operator",
  offeringCompliant: "operator",
  redemptionAuthorized: "operator",
  depositConfirmed: "ledger",
  depositAvailable: "ledger",
  sufficientBalance: "ledger",
};

export function factKind(profile: ProfileId, fact: string): FactKind {
  return (profile === "wildcat-credit" ? CREDIT : CUSTODIAL)[fact] ?? "attested";
}

/** Where the value comes from, for the oracle-status column: observable facts are never attested. */
export const OBSERVABLE_SOURCE: Record<string, string> = {
  sanctionsClear: "Chainalysis sanctions oracle (MockSanctionsOracle on Sepolia)",
  openTermState: "MockWildcatMarket.isOpenTerm()",
};
