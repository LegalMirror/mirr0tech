import { Wallet, parseUnits } from "ethers";
import type {
  InvestorChallenge,
  InvestorConfig,
  InvestorSession,
  Snapshot,
  PublicFund,
  PreparedIntent,
  TransactionRequest,
  Confirmation,
  InvestorQuote,
} from "@/lib/investor/types";
import { SEPOLIA } from "@/lib/investor/types";
import { approvalAbi, swapAbi } from "@/lib/investor/transactions";

export const signer = new Wallet(`0x${"11".repeat(32)}`); // Test-only, unfunded key.
export const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;
export const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;
export const config: InvestorConfig = {
  chainId: SEPOLIA,
  environment: "sandbox",
  credential: "document",
  mock: false,
};
export const fund: PublicFund = {
  id: "agr_test",
  name: "Published test fund",
  chainId: SEPOLIA,
  policyHash: hash(1),
  token: address(200),
  asset: address(100),
  router: address(300),
  poolManager: address(500),
  cashier: true,
  symbol: "mNAV",
};
export function challenge(now = Date.now()): InvestorChallenge {
  const expiresAt = Math.floor(now / 1000) + 180;
  const world = {
    app_id: "app_test",
    rp_id: "rp_test",
    action: "humanity",
    credential: "document" as const,
    environment: "sandbox",
    mock: false,
    rp_context: {
      rp_id: "rp_test",
      nonce: hash(4),
      created_at: Math.floor(now / 1000),
      expires_at: expiresAt,
      signature: `0x${"ab".repeat(65)}`,
    },
  };
  const scope = {
    version: 1,
    wallet: signer.address.toLowerCase(),
    fundId: fund.id,
    policyHash: fund.policyHash,
    chainId: SEPOLIA,
    credential: "document",
    environment: "sandbox",
    mock: false,
    action: world.action,
    rpId: world.rp_id,
    appId: world.app_id,
    origin: "https://dashboard.example",
    nonce: "test-challenge",
    worldNonce: world.rp_context.nonce,
    issuedAt: Math.floor(now / 1000),
    expiresAt,
  };
  return {
    challengeId: scope.nonce,
    message: `mirr0tech investor login (EIP-191)\n\nSign only to log in as an investor.\n\n${JSON.stringify(scope, null, 2)}`,
    expiresAt,
    wallet: signer.address.toLowerCase(),
    chainId: SEPOLIA,
    fundId: fund.id,
    world,
  };
}
export function session(now = Date.now()): InvestorSession {
  return {
    accessToken: "ia_test_opaque_token",
    expiresAt: Math.floor(now / 1000) + 3600,
    session: {
      wallet: signer.address,
      fundId: fund.id,
      policyHash: fund.policyHash,
      chainId: SEPOLIA,
      credential: "document",
      environment: "sandbox",
      mock: false,
    },
  };
}
export function snapshot(): Snapshot {
  const asset = (token: string, symbol: string) => ({
    address: token,
    symbol,
    decimals: 6,
    balance: "1000.0",
    balanceRaw: "1000000000",
    allowance: "0.0",
    allowanceRaw: "0",
    spender: fund.router,
  });
  return {
    ...session().session,
    name: fund.name,
    blockNumber: 7000,
    balances: {
      asset: asset(fund.asset!, "mockUSD"),
      token: asset(fund.token, "mNAV"),
      native: { symbol: "ETH", decimals: 18, balance: "0.1", balanceRaw: "100000000000000000" },
    },
    addresses: {
      token: fund.token,
      asset: fund.asset!,
      router: fund.router,
      hook: address(400),
      poolManager: fund.poolManager,
      oracle: address(600),
      attestor: address(700),
    },
    policy: {
      mint: { allowed: true, clauseId: 0, clause: null },
      burn: { allowed: true, clauseId: 0, clause: null },
      transfer: { allowed: true, clauseId: 0, clause: null },
    },
    cashier: {
      reserve: "5000",
      reserveRaw: "5000000000",
      totalSupply: "1000",
      totalSupplyRaw: "1000000000",
      maxSupply: "1000000",
      maxSupplyRaw: "1000000000000",
      nav: "1.0",
      navRaw: "1000000",
      subscriptionFeeBps: 25,
      redemptionFeeBps: 25,
      termsHash: hash(2),
      configurationHash: hash(3),
      poolKey: {
        currency0: fund.asset!,
        currency1: fund.token,
        fee: 3000,
        tickSpacing: 60,
        hooks: address(400),
      },
      paused: false,
      mintEnabled: true,
      burnEnabled: true,
      limitations: "Fixed DEMO NAV; prefunded reserve only.",
    },
    capabilities: {
      readOnly: false,
      prepareApproval: true,
      prepareSwap: true,
      browserWalletRequired: true,
      identityAttestation: true,
      serverTrading: false,
      funding: false,
      deployment: false,
    },
  };
}
export function intent(request: TransactionRequest, now = Date.now()): PreparedIntent {
  const state = snapshot();
  const units = parseUnits(request.amount, 6);
  const input = request.buy ? fund.asset! : fund.token;
  const output = request.buy ? fund.token : fund.asset!;
  const expiresAt = Math.min(Math.floor(now / 1000) + 180, request.deadline ?? Infinity);
  const data =
    request.kind === "approval"
      ? approvalAbi.encodeFunctionData("approve", [fund.router, units])
      : swapAbi.encodeFunctionData("swap", [
          state.cashier!.poolKey,
          {
            zeroForOne: request.buy,
            amountSpecified: -units,
            sqrtPriceLimitX96: request.buy ? 4295128740n : 1461446703485210103287273052203988822378723970341n,
          },
          parseUnits(request.minOut!, 6),
          request.deadline,
          ["auto", "amm", "cashier"].indexOf(request.route),
        ]);
  return {
    ...session().session,
    ...request,
    intentId: "test-intent",
    expiresAt,
    transaction: {
      chainId: SEPOLIA,
      from: signer.address,
      to: request.kind === "approval" ? input : fund.router,
      data,
      value: "0x0",
    },
    inputToken: input,
    outputToken: output,
    ...(request.kind === "approval" ? { spender: fund.router } : { simulatedAmountOut: "9.975" }),
    notice: "Simulation is not a mining guarantee.",
  };
}
export const approval: TransactionRequest = { kind: "approval", buy: true, amount: "10", route: "auto" };
export function swap(now = Date.now()): TransactionRequest {
  return { ...approval, kind: "swap", minOut: "9.9", deadline: Math.floor(now / 1000) + 120 };
}
export function confirmation(status: Confirmation["status"] = "confirmed"): Confirmation {
  return {
    intentId: "test-intent",
    txHash: hash(9),
    kind: "swap",
    source: "rpc",
    status,
    ...(status === "pending"
      ? {}
      : {
          receipt: {
            transactionHash: hash(9),
            blockNumber: 7010,
            blockHash: hash(10),
            status: status === "confirmed" ? 1 : 0,
          },
          finality: "mined-not-finalized" as const,
        }),
  };
}
export function quote(): InvestorQuote {
  const state = snapshot();
  return {
    ...session().session,
    kind: "nav-only",
    indicative: true,
    simulated: false,
    executable: null,
    buy: true,
    amount: "10.0",
    amountRaw: "10000000",
    route: "auto",
    blockNumber: 7000,
    amountOut: "9.975",
    amountOutRaw: "9975000",
    inputToken: state.balances.asset,
    outputToken: state.balances.token,
    policy: state.policy,
    blockers: [{ code: "INSUFFICIENT_ALLOWANCE", message: "Exact approval required", scope: "all" }],
    termsHash: hash(2),
    notice: "NAV arithmetic only.",
  };
}
