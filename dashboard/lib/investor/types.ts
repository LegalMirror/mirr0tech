import type { WorldIdContext } from "../types";

export const SEPOLIA = 11155111;
export const INVESTOR_API = (process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:3000").replace(
  /\/$/,
  ""
);
export type InvestorConfig = {
  chainId: number | null;
  environment: string | null;
  credential: WorldIdContext["credential"] | null;
  mock: boolean;
};
export type PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};
export type PublicFund = {
  id: string;
  name: string;
  chainId: number;
  policyHash: string;
  token: string;
  router: string;
  poolManager: string;
  cashier: boolean;
  asset?: string;
  symbol?: string;
  disabledReason?: string | null;
};
export type InvestorChallenge = {
  challengeId: string;
  message: string;
  expiresAt: number;
  wallet: string;
  chainId: number;
  fundId: string;
  world: WorldIdContext;
};
export type Scope = { wallet: string; fundId: string; policyHash: string; chainId: number };
export type InvestorSession = {
  accessToken: string;
  expiresAt: number;
  session: Scope & { credential: WorldIdContext["credential"]; environment: string; mock: boolean };
};
export type TokenBalance = {
  address: string;
  symbol: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
  allowance: string;
  allowanceRaw: string;
  spender: string;
};
export type PolicyDecision = {
  allowed: boolean;
  clauseId: number | null;
  clause: { clause: string; quote: string } | null;
  reason?: string;
};
export type Cashier = {
  reserve: string;
  reserveRaw: string;
  totalSupply: string;
  totalSupplyRaw: string;
  maxSupply: string;
  maxSupplyRaw: string;
  nav: string;
  navRaw: string;
  subscriptionFeeBps: number;
  redemptionFeeBps: number;
  termsHash: string;
  configurationHash: string;
  poolKey: PoolKey;
  paused: boolean;
  mintEnabled: boolean;
  burnEnabled: boolean;
  limitations: string;
};
export type Snapshot = Scope & {
  name: string;
  blockNumber: number;
  balances: {
    token: TokenBalance;
    asset: TokenBalance;
    native: { symbol: string; decimals: number; balance: string; balanceRaw: string };
  };
  addresses: {
    token: string;
    asset: string;
    router: string;
    hook: string;
    poolManager: string;
    oracle: string;
    attestor: string;
  };
  policy: Record<"mint" | "burn" | "transfer", PolicyDecision>;
  cashier: Cashier | null;
  disabledReason?: string;
  capabilities: {
    readOnly: boolean;
    prepareApproval: boolean;
    prepareSwap: boolean;
    browserWalletRequired: boolean;
    identityAttestation: boolean;
    serverTrading: boolean;
    funding: boolean;
    deployment: boolean;
  };
};
export type ActivityEvent = Scope & {
  contract: string;
  event: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  amount?: string;
  amountIn?: string;
  amountOut?: string;
  route?: string;
  buy?: boolean;
  expiresAt?: number;
};
export type InvestorActivity = Scope & {
  source: "rpc" | "unavailable";
  status: string;
  indexer: { status: string };
  complete: false;
  events: ActivityEvent[];
  notice?: string;
  fromBlock?: number;
  toBlock?: number;
};
export type TradeInput = { buy: boolean; amount: string; route: "auto" | "amm" | "cashier" };
export type Blocker = {
  code: string;
  message: string;
  scope: "all" | "cashier";
  action?: string;
  clause?: { clause: string; quote: string } | null;
};
export type InvestorQuote = Scope &
  TradeInput & {
    kind: "nav-only" | "unavailable";
    indicative: true;
    simulated: false;
    executable: null;
    blockNumber: number;
    amountRaw: string;
    amountOut: string | null;
    amountOutRaw: string | null;
    inputToken: TokenBalance;
    outputToken: TokenBalance;
    policy: Snapshot["policy"];
    blockers: Blocker[];
    termsHash: string | null;
    notice: string;
  };
export type TransactionRequest = TradeInput & {
  kind: "approval" | "swap";
  minOut?: string;
  deadline?: number;
};
export type PreparedIntent = Scope &
  TradeInput & {
    intentId: string;
    expiresAt: number;
    kind: "approval" | "swap";
    transaction: { chainId: number; from: string; to: string; data: string; value: string };
    inputToken: string;
    outputToken: string;
    minOut?: string;
    deadline?: number;
    simulatedAmountOut?: string;
    spender?: string;
    notice: string;
  };
export type Receipt = { transactionHash: string; blockNumber: number; blockHash: string; status: number };
export type Confirmation = {
  status: "pending" | "confirmed" | "reverted";
  txHash: string;
  intentId: string;
  kind: "approval" | "swap";
  source: "rpc";
  receipt?: Receipt;
  reason?: string;
  actualRoute?: string;
  amountIn?: string;
  amountOut?: string;
  finality?: "mined-not-finalized";
};
export type IdentityResult = {
  status: "confirmed" | "pending" | "refused" | "already-attested";
  identityVerified?: boolean;
  submitted?: false;
  txHash?: string;
  expiresAt?: number;
  receipt?: Receipt;
  reason?: string;
  code?: string;
  retryAfter?: number;
  finality?: string;
};
export type PendingTransaction = {
  intentId: string;
  txHash: string;
  kind: "approval" | "swap";
  result: Confirmation | null;
  outputSymbol: string;
  message?: string;
};
