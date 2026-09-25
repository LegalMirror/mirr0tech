// Plain-language names for everything the compiler names in code. Screens speak these; identifiers
// stay in the technical folds.
import type { Effect } from "./types";

export const FACT_LABEL: Record<string, string> = {
  kycApproved: "KYC approved",
  amlApproved: "AML approved",
  sanctionsClear: "Not on a sanctions list",
  subscriptionAccepted: "Subscription accepted",
  issuerAuthorized: "Issuer authorized the transfer",
  offeringCompliant: "Offering is compliant",
  redemptionAuthorized: "Redemption authorized",
  depositConfirmed: "Deposit confirmed",
  depositAvailable: "Deposit available",
  sufficientBalance: "Sufficient balance",
  mlaCountersigned: "Signed the loan agreement",
  lenderCheckPassed: "Passed the lender check",
  amlKycProvided: "Provided AML/KYC information",
  notInsolvent: "Not insolvent",
  screeningCurrent: "Screening is up to date",
  openTermState: "Market is open",
  borrowerOverride: "Borrower override in place",
};
export const factLabel = (name: string) => FACT_LABEL[name] ?? name;

export const ACTION_LABEL: Record<string, string> = {
  mint: "Issue shares",
  burn: "Redeem shares",
  transfer: "Transfer",
  deposit: "Deposit",
  withdraw: "Withdraw",
};
export const actionLabel = (action: string) => ACTION_LABEL[action] ?? action;

export const VERDICT_LABEL = { approve: "Allowed", review: "Needs review", deny: "Blocked" } as const;
export const TRI_LABEL = { true: "yes", false: "no", unknown: "not established" } as const;

export const EFFECT_LABEL: Record<Effect, string> = {
  permit: "Allows",
  require: "Requires",
  forbid: "Prohibits",
};
export const EFFECT_SENTENCE: Record<Effect, string> = {
  permit: "The action is allowed when this holds (and nothing else blocks it).",
  require: "The action is refused unless this is established.",
  forbid: "The action is refused whenever this holds, or is not ruled out.",
};

/** Timeline event kinds as a reader would say them. */
export const KIND_LABEL: Record<string, string> = {
  Attested: "Facts attested",
  Revoked: "Designated / revoked",
  CredentialDecision: "Deposit decision",
  PolicyChecked: "Checked",
  Fill: "Buyback filled",
  QuoteRefused: "Quote refused",
  Shipped: "Buyback posted",
  Minted: "Shares issued",
  Refused: "Refused",
};

/** What each instruction of the buyback program does, without its opcode. */
export const INSTRUCTION_LABEL: Record<string, string> = {
  "Controls._deadline": "Open until the deadline",
  "PolicyGuard._policyGuard": "Both sides must pass the agreement",
  "FixedRateBalances._fixedRateBalances": "Fixed price and cap",
  "DutchAuctionBalanceOut._dutchAuctionBalanceOut": "Price improves over the window",
  "LimitSwap._limitSwap1D": "Swap at that price",
  "Invalidators._invalidateTokenIn1D": "Fill once, up to the cap",
};
export const instructionLabel = (name: string) => INSTRUCTION_LABEL[name] ?? name.split("._").pop() ?? name;

export const REFUSAL_LABEL: Record<string, string> = {
  NoDepositCredential: "No deposit credential",
  CounterpartyRefused: "Counterparty refused",
  LegalClauseViolation: "A clause was violated",
  PolicyDenied: "Refused by the agreement",
  NoPolicyDoor: "Pool carries no policy hook",
  TransferRefused: "Transfer refused",
  WithdrawalRefused: "Withdrawal refused",
  TransfersDisabled: "Transfers disabled",
};

/** Swaps identifiers in a gateway sentence for their plain names. */
export function plainSummary(text: string): string {
  let out = text;
  for (const [name, label] of Object.entries(REFUSAL_LABEL))
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), label);
  for (const [name, label] of Object.entries(FACT_LABEL))
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), label.toLowerCase());
  return out;
}
