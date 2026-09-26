import { getAddress, Interface, parseUnits } from "ethers";
import type {
  Confirmation,
  InvestorQuote,
  InvestorSession,
  PreparedIntent,
  PublicFund,
  Scope,
  Snapshot,
  TransactionRequest,
} from "./types";
import { SEPOLIA } from "./types";
import { sessionAlive } from "./session";

export const approvalAbi = new Interface(["function approve(address spender,uint256 amount) returns (bool)"]);
export const swapAbi = new Interface([
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,uint256 minOut,uint256 deadline,uint8 route) returns (uint256)",
]);
const same = (a: string, b: string) => getAddress(a) === getAddress(b);
export const transactionUrl = (hash: string) =>
  /^0x[0-9a-f]{64}$/i.test(hash) ? `https://sepolia.etherscan.io/tx/${hash}` : null;
export function exactUnits(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new Error("Use a positive decimal amount with at most six decimal places; no exponents or commas.");
  const units = parseUnits(value, 6);
  if (units <= 0n || units > (1n << 127n) - 1n)
    throw new Error("Amount must be positive and within the bounded exact-input range.");
  return units;
}
export function assertScope(scope: Scope, session: InvestorSession, fund: PublicFund) {
  if (
    !scope ||
    !same(scope.wallet, session.session.wallet) ||
    scope.fundId !== fund.id ||
    scope.fundId !== session.session.fundId ||
    scope.chainId !== SEPOLIA ||
    scope.policyHash?.toLowerCase() !== session.session.policyHash.toLowerCase() ||
    scope.policyHash?.toLowerCase() !== fund.policyHash.toLowerCase()
  )
    throw new Error("The fund, wallet or policy binding changed. Sign in again before trading.");
}
export function validateSnapshot(value: Snapshot, session: InvestorSession, fund: PublicFund): Snapshot {
  assertScope(value, session, fund);
  if (
    !value.balances?.asset ||
    !value.balances?.token ||
    !value.balances?.native ||
    !value.addresses ||
    !value.policy ||
    !value.capabilities ||
    !Number.isSafeInteger(value.blockNumber)
  )
    throw new Error(
      "The investor snapshot is incomplete or from an older backend. Trading stays disabled until the gateway is updated."
    );
  if (
    ["mint", "burn", "transfer"].some(
      (action) => typeof value.policy[action as keyof Snapshot["policy"]]?.allowed !== "boolean"
    )
  )
    throw new Error("The gateway has not returned all protected action decisions.");
  for (const key of ["asset", "token"] as const) {
    const balance = value.balances[key];
    if (
      typeof balance.balance !== "string" ||
      typeof balance.allowance !== "string" ||
      !/^\d+$/.test(balance.balanceRaw) ||
      !/^\d+$/.test(balance.allowanceRaw) ||
      !Number.isSafeInteger(balance.decimals) ||
      !same(balance.address, value.addresses[key]) ||
      !same(balance.spender, fund.router)
    )
      throw new Error(
        "The reported token or allowance metadata is inconsistent. No wallet prompt will be opened."
      );
  }
  if (
    !same(value.addresses.token, fund.token) ||
    !same(value.addresses.router, fund.router) ||
    !same(value.addresses.poolManager, fund.poolManager) ||
    (fund.asset && !same(value.addresses.asset, fund.asset))
  )
    throw new Error("The snapshot targets do not match the published fund.");
  return value;
}
export function tradingBlocked(fund: PublicFund, snapshot: Snapshot | null): string | null {
  if (fund.chainId !== SEPOLIA)
    return "This investor interface signs only on Sepolia. No transaction is queued for another chain.";
  if (!fund.cashier)
    return (
      fund.disabledReason ||
      "Read-only legacy fund. Ask the issuer to publish a cashier-enabled agreement with the bounded router."
    );
  if (fund.disabledReason) return fund.disabledReason;
  if (!snapshot) return "Sign in and refresh the on-chain snapshot before preparing a transaction.";
  if (
    snapshot.capabilities.readOnly ||
    !snapshot.capabilities.prepareSwap ||
    !snapshot.capabilities.prepareApproval
  )
    return snapshot.disabledReason || "The gateway reports this fund as read-only.";
  if (
    !snapshot.cashier?.poolKey ||
    snapshot.balances.asset.decimals !== 6 ||
    snapshot.balances.token.decimals !== 6
  )
    return "The bounded cashier requires a verified pool key and six-decimal asset/share metadata.";
  return null;
}
export function validateQuote(
  value: InvestorQuote,
  session: InvestorSession,
  fund: PublicFund,
  request: { amount: string; buy: boolean; route: string }
) {
  assertScope(value, session, fund);
  if (
    value.buy !== request.buy ||
    value.route !== request.route ||
    value.amountRaw !== String(exactUnits(request.amount)) ||
    !Array.isArray(value.blockers) ||
    value.indicative !== true ||
    value.simulated !== false ||
    value.executable !== null
  )
    throw new Error("The quote does not match the requested NAV indication. Refresh it before continuing.");
  return value;
}
export function blockingReasons(quote: InvestorQuote, kind: "approval" | "swap") {
  return quote.blockers.filter(
    (item) =>
      (item.scope === "all" || quote.route === "cashier") &&
      !(kind === "approval" && item.code === "INSUFFICIENT_ALLOWANCE")
  );
}
export function validatePrepared(
  intent: PreparedIntent,
  request: TransactionRequest,
  session: InvestorSession,
  fund: PublicFund,
  snapshot: Snapshot,
  now = Date.now()
) {
  if (!sessionAlive(session, now)) throw new Error("Investor session expired. Nothing will be sent.");
  validateSnapshot(snapshot, session, fund);
  assertScope(intent, session, fund);
  const blocked = tradingBlocked(fund, snapshot);
  if (blocked) throw new Error(blocked);
  if (
    !intent.intentId ||
    !Number.isSafeInteger(intent.expiresAt) ||
    intent.expiresAt * 1000 <= now ||
    intent.expiresAt > session.expiresAt
  )
    throw new Error(
      "Prepared intent is missing, expired or exceeds the session. Prepare a new intent explicitly."
    );
  const tx = intent.transaction;
  if (
    !tx ||
    tx.chainId !== SEPOLIA ||
    !same(tx.from, session.session.wallet) ||
    tx.value !== "0x0" ||
    !/^0x[0-9a-f]+$/i.test(tx.data)
  )
    throw new Error("The prepared chain, sender, value or calldata is unsafe.");
  const units = exactUnits(request.amount);
  const input = request.buy ? snapshot.balances.asset : snapshot.balances.token;
  const output = request.buy ? snapshot.balances.token : snapshot.balances.asset;
  if (
    intent.kind !== request.kind ||
    intent.buy !== request.buy ||
    intent.route !== request.route ||
    exactUnits(intent.amount) !== units ||
    !same(intent.inputToken, input.address) ||
    !same(intent.outputToken, output.address)
  )
    throw new Error("The prepared summary changed the reviewed order.");
  if (request.kind === "approval") {
    if (!same(tx.to, input.address) || !intent.spender || !same(intent.spender, fund.router))
      throw new Error("Approval must target the exact input token and the published router.");
    const decoded = approvalAbi.parseTransaction({ data: tx.data });
    if (
      !decoded ||
      decoded.name !== "approve" ||
      !same(decoded.args.spender, fund.router) ||
      decoded.args.amount !== units ||
      approvalAbi.encodeFunctionData("approve", decoded.args).toLowerCase() !== tx.data.toLowerCase()
    )
      throw new Error(
        "Approval calldata does not grant exactly the reviewed input amount. Unlimited approvals are not accepted."
      );
  } else {
    if (
      !same(tx.to, fund.router) ||
      !request.minOut ||
      !Number.isSafeInteger(request.deadline) ||
      request.deadline! * 1000 <= now ||
      request.deadline! > Math.floor(now / 1000) + 180
    )
      throw new Error("Swap target, minimum output or deadline is invalid. Re-prepare explicitly.");
    const decoded = swapAbi.parseTransaction({ data: tx.data });
    if (
      !decoded ||
      decoded.name !== "swap" ||
      swapAbi.encodeFunctionData("swap", decoded.args).toLowerCase() !== tx.data.toLowerCase()
    )
      throw new Error("Only the bounded cashier router swap is supported.");
    const { key, params, minOut, deadline, route } = decoded.args;
    const expected = snapshot.cashier!.poolKey;
    if (
      !same(key.currency0, expected.currency0) ||
      !same(key.currency1, expected.currency1) ||
      !same(key.hooks, expected.hooks) ||
      !same(key.hooks, snapshot.addresses.hook) ||
      Number(key.fee) !== Number(expected.fee) ||
      Number(key.tickSpacing) !== Number(expected.tickSpacing)
    )
      throw new Error("Prepared pool/hook does not match this fund's verified pool key.");
    const pair = [input.address, output.address].map((value) => value.toLowerCase()).sort();
    if (
      key.currency0.toLowerCase() !== pair[0] ||
      key.currency1.toLowerCase() !== pair[1] ||
      params.zeroForOne !== same(key.currency0, input.address) ||
      params.amountSpecified !== -units ||
      params.sqrtPriceLimitX96 !==
        (params.zeroForOne ? 4295128740n : 1461446703485210103287273052203988822378723970341n) ||
      minOut !== exactUnits(request.minOut) ||
      Number(deadline) !== request.deadline ||
      Number(route) !== ["auto", "amm", "cashier"].indexOf(request.route) ||
      intent.minOut === undefined ||
      exactUnits(intent.minOut) !== minOut ||
      intent.deadline !== request.deadline ||
      intent.expiresAt > request.deadline!
    )
      throw new Error("Swap calldata changed the direction, exact input, minimum output, route or deadline.");
  }
  // Whitelist the fields sent to EIP-1193; do not pass arbitrary server transaction properties.
  return { from: tx.from, to: tx.to, data: tx.data, value: tx.value };
}
export function validateConfirmation(value: Confirmation, intentId: string, hash: string) {
  if (
    !value ||
    value.intentId !== intentId ||
    value.txHash?.toLowerCase() !== hash.toLowerCase() ||
    value.source !== "rpc" ||
    !["pending", "confirmed", "reverted"].includes(value.status)
  )
    throw new Error(
      "The gateway confirmation does not match the submitted transaction. Inspect the wallet receipt; do not resend."
    );
  if (
    value.status !== "pending" &&
    (!value.receipt ||
      value.receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      !Number.isSafeInteger(value.receipt.blockNumber) ||
      value.receipt.status !== (value.status === "confirmed" ? 1 : 0))
  )
    throw new Error("A matching on-chain receipt has not been returned. No completion is claimed.");
  return value;
}

/** Confirm reads are bounded; this never prepares or sends another wallet transaction. */
export async function pollConfirmation(
  read: () => Promise<Confirmation>,
  receive: (result: Confirmation) => void,
  signal: AbortSignal,
  attempts = 6,
  delayMs = 2000
) {
  for (let index = 0; index < attempts; index++) {
    if (signal.aborted) return;
    const result = await read();
    if (signal.aborted) return;
    receive(result);
    if (result.status !== "pending") return;
    if (index + 1 < attempts)
      await new Promise<void>((resolve) => {
        const stop = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", stop);
          resolve();
        }, delayMs);
        signal.addEventListener("abort", stop, { once: true });
      });
  }
}
