// Demo parties and events, labelled as mock wherever they are shown. They follow the golden path of
// PRD §4: an admitted lender, one waiting on a countersignature, one the oracle flags, and a stranger.
import type { AuditEvent, Party, ProfileId } from "../types";

const SCREENED = Date.parse("2026-09-26T01:00:00Z") / 1000;

const LENDERS: Party[] = [
  {
    id: "lender-a",
    name: "Lender A — Northwind Capital",
    address: "0x4a11ce000000000000000000000000000000a0a1",
    role: "lender",
    facts: { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true },
    screenedAt: SCREENED,
    sanctions: "clear",
  },
  {
    id: "lender-b",
    name: "Lender B — Harbor Treasury",
    address: "0xb0b0000000000000000000000000000000000b0b",
    role: "lender",
    facts: { mlaCountersigned: null, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true },
    screenedAt: SCREENED + 600,
    sanctions: "clear",
  },
  {
    id: "lender-c",
    name: "Lender C — Kestrel OTC",
    address: "0xc0ffee00000000000000000000000000000c0c0c",
    role: "lender",
    facts: { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true },
    screenedAt: SCREENED + 1200,
    sanctions: "flagged",
  },
  {
    id: "stranger",
    name: "Stranger — unscreened wallet",
    address: "0x5700000000000000000000000000000000000057",
    role: "stranger",
    facts: {},
    screenedAt: null,
    sanctions: "clear",
  },
  {
    id: "borrower",
    name: "Demo MM Ltd — borrower treasury",
    address: "0x00000000000000000000000000000000000b0770",
    role: "borrower",
    facts: { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true },
    screenedAt: SCREENED - 3600,
    sanctions: "clear",
  },
];

const INVESTORS: Party[] = [
  {
    id: "investor-1",
    name: "Investor 1 — Aoi Fund LP",
    address: "0xa0100000000000000000000000000000000000a1",
    role: "investor",
    facts: {
      kycApproved: true,
      amlApproved: true,
      sanctionsClear: true,
      subscriptionAccepted: true,
      issuerAuthorized: true,
      offeringCompliant: true,
      depositConfirmed: true,
      redemptionAuthorized: true,
    },
    screenedAt: SCREENED,
    sanctions: "clear",
  },
  {
    id: "investor-2",
    name: "Investor 2 — Sakura Family Office",
    address: "0x5a4a000000000000000000000000000000000a02",
    role: "investor",
    facts: {
      kycApproved: true,
      amlApproved: null,
      sanctionsClear: true,
      subscriptionAccepted: true,
      issuerAuthorized: true,
      offeringCompliant: true,
      depositConfirmed: true,
    },
    screenedAt: SCREENED + 900,
    sanctions: "clear",
  },
  {
    id: "stranger",
    name: "Stranger — not onboarded",
    address: "0x5700000000000000000000000000000000000057",
    role: "stranger",
    facts: { kycApproved: false, amlApproved: false, sanctionsClear: true },
    screenedAt: null,
    sanctions: "clear",
  },
];

export function mockParties(profile: ProfileId): Party[] {
  return structuredClone(profile === "wildcat-credit" ? LENDERS : INVESTORS);
}

const tx = (n: number) => `0x${n.toString(16).padStart(4, "0")}${"ab".repeat(30)}`;
const admitted = {
  mlaCountersigned: true,
  lenderCheckPassed: true,
  amlKycProvided: true,
  notInsolvent: true,
  screeningCurrent: true,
  sanctionsClear: true,
  openTermState: true,
};

const CREDIT_EVENTS: AuditEvent[] = [
  {
    id: "e1",
    at: "2026-09-26T01:00:12Z",
    kind: "Attested",
    subject: "Lender A — Northwind Capital",
    action: "deposit",
    summary: "Lender Check Process facts attested for 30 days",
    facts: admitted,
    txHash: tx(1),
    venue: "PolicyAttestor",
  },
  {
    id: "e2",
    at: "2026-09-26T01:00:40Z",
    kind: "CredentialDecision",
    subject: "Lender A — Northwind Capital",
    action: "deposit",
    summary: "getCredential → screening timestamp; deposit accepted",
    facts: admitted,
    txHash: tx(2),
    venue: "MirrortechRoleProvider",
  },
  {
    id: "e3",
    at: "2026-09-26T01:10:05Z",
    kind: "CredentialDecision",
    subject: "Lender B — Harbor Treasury",
    action: "deposit",
    summary: "mlaCountersigned unknown → queued for review",
    facts: { ...admitted, mlaCountersigned: null },
    txHash: null,
    venue: "Gateway",
  },
  {
    id: "e4",
    at: "2026-09-26T01:20:31Z",
    kind: "CredentialDecision",
    subject: "Lender C — Kestrel OTC",
    action: "deposit",
    summary: "sanctions oracle flags the wallet → denied, no override",
    facts: { ...admitted, sanctionsClear: false },
    txHash: tx(4),
    venue: "MirrortechRoleProvider",
  },
  {
    id: "e5",
    at: "2026-09-26T01:30:00Z",
    kind: "Shipped",
    subject: "Demo MM Ltd — borrower treasury",
    action: "transfer",
    summary: "Buyback strategy shipped to Aqua at 0.96; no capital moved",
    facts: admitted,
    txHash: tx(5),
    venue: "Aqua",
  },
  {
    id: "e6",
    at: "2026-09-26T01:34:10Z",
    kind: "Fill",
    subject: "Lender A — Northwind Capital",
    action: "transfer",
    summary: "Filled 10,000 position tokens → 9,600 mUSDC",
    facts: admitted,
    txHash: tx(6),
    venue: "PolicyGuard",
  },
  {
    id: "e7",
    at: "2026-09-26T01:35:45Z",
    kind: "QuoteRefused",
    subject: "Stranger — unscreened wallet",
    action: "transfer",
    summary: "quote() reverted CounterpartyRefused before any transaction",
    facts: { sanctionsClear: true, openTermState: true },
    txHash: null,
    venue: "PolicyGuard",
  },
  {
    id: "e8",
    at: "2026-09-26T01:40:02Z",
    kind: "Revoked",
    subject: "Lender A — Northwind Capital",
    action: "withdraw",
    summary: "Sanctions designation → mayWithdraw blocked; strategy stops filling",
    facts: { ...admitted, sanctionsClear: false },
    txHash: tx(8),
    venue: "MirrortechRoleProvider",
  },
];

const CUSTODIAL_EVENTS: AuditEvent[] = [
  {
    id: "c1",
    at: "2026-09-26T00:10:00Z",
    kind: "Minted",
    subject: "Investor 1 — Aoi Fund LP",
    action: "mint",
    summary: "Onboarded, deposit confirmed → minted 250,000 MIRROR to custody",
    facts: INVESTORS[0].facts,
    txHash: tx(11),
    venue: "MirrorToken",
  },
  {
    id: "c2",
    at: "2026-09-26T00:12:30Z",
    kind: "Refused",
    subject: "Stranger — not onboarded",
    action: "mint",
    summary: "Gateway 403 POLICY_DENIED before signing",
    facts: INVESTORS[2].facts,
    txHash: null,
    venue: "Gateway",
  },
  {
    id: "c3",
    at: "2026-09-26T00:20:00Z",
    kind: "PolicyChecked",
    subject: "Stranger — not onboarded",
    action: "transfer",
    summary: "beforeSwap in the hooked pool → LegalClauseViolation",
    facts: INVESTORS[2].facts,
    txHash: null,
    venue: "MirrorPolicyHook",
  },
];

export function mockAudit(profile: ProfileId): AuditEvent[] {
  return structuredClone(profile === "wildcat-credit" ? CREDIT_EVENTS : CUSTODIAL_EVENTS);
}
