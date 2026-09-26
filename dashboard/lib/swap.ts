import type { AgreementDetail } from "./agreements";
import { MOCK_USD } from "./mock-usd";

export function sharedPoolMismatch(record: AgreementDetail): string | null {
  const d = record.deployment;
  if (!d?.poolKey) return null;
  const asset =
    d.poolKey.currency0.toLowerCase() === d.token.toLowerCase() ? d.poolKey.currency1 : d.poolKey.currency0;
  return asset.toLowerCase() === MOCK_USD.address.toLowerCase()
    ? null
    : `This pool uses the legacy token at ${asset}. Your shared mUSDC balance is at ${MOCK_USD.address}. The shared-token balance cannot be spent in this legacy pool; its currencies are fixed.`;
}

export type SwapToken = { address: string; symbol: string; decimals: number; balance: string };
export type SwapState = {
  chainId: number;
  poolId: string;
  wallet: string;
  rwa: SwapToken;
  asset: SwapToken;
  liquidity: string;
  route: "uniswap-api";
};
export type SwapQuote = {
  route?: "uniswap-api" | "direct";
  id: string;
  expiresAt: number;
  chainId: number;
  poolId: string;
  wallet: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  slippageBps: number;
  spender: string;
  router: string;
  permitData: {
    domain: import("ethers").TypedDataDomain;
    types: Record<string, import("ethers").TypedDataField[]>;
    values: Record<string, unknown>;
  } | null;
};
export type SwapTransaction = { from: string; to: string; data: string; value: string; chainId: number };
export type SwapApprovals = { cancel: SwapTransaction | null; approval: SwapTransaction | null };
export function swapBlocked(record: AgreementDetail, sample: boolean): string | null {
  if (sample) return "Connect a gateway and deploy your own agreement to swap. Samples are read-only.";
  if (record.status !== "deployed" || !record.deployment)
    return "Deploy this agreement to create its pool before swapping.";
  const d = record.deployment;
  if (d.policyHash !== record.policyHash)
    return "Deploy the current policy before swapping. The deployment belongs to an earlier policy.";
  if (d.chainId !== 11155111) return "Swaps are available on Sepolia only.";
  if (!d.poolId || !d.poolKey || !d.hook || !d.poolManager)
    return "This agreement has no deployed Uniswap v4 pool.";
  if (d.routing !== "uniswap-api")
    return "This pool uses the retired custom router. Redeploy the agreement to use Uniswap API liquidity and swaps.";
  return null;
}
