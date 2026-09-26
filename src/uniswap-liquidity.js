import { AbiCoder, Interface, keccak256 } from 'ethers';
import { AppError, ensure } from './errors.js';
import { transaction } from './uniswap.js';
import { UNISWAP } from './onchain/uniswap-config.js';
const coder = AbiCoder.defaultAbiCoder();
const KEY = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const PM = new Interface([
  'function modifyLiquidities(bytes unlockData,uint256 deadline)',
  'function multicall(bytes[] data)',
]);
const ERC20 = new Interface(['function approve(address spender,uint256 amount)']);
const PERMIT = new Interface(['function approve(address token,address spender,uint160 amount,uint48 expiration)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const invalid = (message) => new AppError(502, 'UNISWAP_INVALID_RESPONSE', message);

export class UniswapLiquidity {
  constructor({ fetcher = fetch, apiKey = () => process.env.UNISWAP_API_KEY, now = Date.now } = {}) {
    Object.assign(this, { fetcher, apiKey, now });
  }
  async call(endpoint, body) {
    const key = typeof this.apiKey === 'function' ? this.apiKey() : this.apiKey;
    ensure(key, 503, 'UNISWAP_NOT_CONFIGURED', 'Set UNISWAP_API_KEY on the gateway to seed pools.');
    let r;
    try {
      r = await this.fetcher(`https://liquidity.api.uniswap.org/lp/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify(body),
      });
    } catch {
      throw new AppError(503, 'UNISWAP_UNAVAILABLE', 'Uniswap liquidity API did not respond. Try again.');
    }
    ensure(
      r.ok,
      502,
      'UNISWAP_LIQUIDITY_FAILED',
      'Uniswap could not prepare liquidity. Check the API key, pool availability and backend token balances.',
    );
    return r.json();
  }
  async approvals(wallet, budgets) {
    const response = await this.call('check_approval', {
      walletAddress: wallet,
      chainId: 11155111,
      protocol: 'V4',
      action: 'CREATE',
      generatePermitAsTransaction: true,
      lpTokens: Object.entries(budgets).map(([tokenAddress, amount]) => ({ tokenAddress, amount: amount.toString() })),
    });
    ensure(
      Array.isArray(response.transactions) && !response.v4BatchPermitData,
      502,
      'UNISWAP_INVALID_RESPONSE',
      'Expected onchain liquidity approvals.',
    );
    return response.transactions.map((item) => {
      const tx = item.transaction;
      const entry = Object.entries(budgets).find(([token]) => same(token, tx?.to));
      let parsed;
      try {
        if (entry) {
          const normalized = transaction(tx, wallet, entry[0]);
          parsed = ERC20.parseTransaction(tx);
          if (
            parsed?.name !== 'approve' ||
            !same(parsed.args.spender, UNISWAP.permit2) ||
            (item.cancelApproval && parsed.args.amount !== 0n)
          )
            throw invalid('Unexpected approval.');
          normalized.data = ERC20.encodeFunctionData('approve', [UNISWAP.permit2, item.cancelApproval ? 0n : entry[1]]);
          return normalized;
        }
        const normalized = transaction(tx, wallet, UNISWAP.permit2);
        parsed = PERMIT.parseTransaction(tx);
        const budget = Object.entries(budgets).find(([token]) => same(token, parsed?.args.token));
        if (parsed?.name !== 'approve' || !budget || !same(parsed.args.spender, UNISWAP.positionManager))
          throw invalid('Unexpected Permit2 approval.');
        normalized.data = PERMIT.encodeFunctionData('approve', [
          budget[0],
          UNISWAP.positionManager,
          item.cancelApproval ? 0n : budget[1],
          Math.floor(this.now() / 1000) + 1800,
        ]);
        return normalized;
      } catch {
        throw invalid('Uniswap returned an unexpected liquidity approval.');
      }
    });
  }
  async create(d, wallet, budgets, sqrtPrice) {
    ensure(sqrtPrice > 0n, 409, 'UNINITIALIZED_POOL', 'Initialize the pool before seeding.');
    const k = d.poolKey;
    const amount0 = budgets[k.currency0],
      amount1 = budgets[k.currency1];
    // Leave room for the API's slippage maximum, and size to the smaller budget at spot.
    const independent =
      ((amount0 < (amount1 * (1n << 192n)) / (sqrtPrice * sqrtPrice)
        ? amount0
        : (amount1 * (1n << 192n)) / (sqrtPrice * sqrtPrice)) *
        99n) /
      100n;
    ensure(independent > 0n, 400, 'INVALID_LIQUIDITY', 'Increase the seed budgets.');
    const lower = Math.ceil(-887272 / k.tickSpacing) * k.tickSpacing,
      upper = -lower;
    const response = await this.call('create', {
      walletAddress: wallet,
      chainId: 11155111,
      protocol: 'V4',
      existingPool: { token0Address: k.currency0, token1Address: k.currency1, poolReference: d.poolId },
      independentToken: { tokenAddress: k.currency0, amount: independent.toString() },
      tickBounds: { tickLower: lower, tickUpper: upper },
      slippageTolerance: 0.5,
      simulateTransaction: false,
    });
    const tx = transaction(response.create, wallet, UNISWAP.positionManager);
    validatePosition(tx.data, d, wallet, budgets, lower, upper, this.now());
    return tx;
  }
}

// Only a new, full-range position for this exact pool and backend owner is signable.
// Reject transfers, existing-position edits, extra pools and arbitrary multicall commands.
export function validatePosition(data, d, wallet, budgets, lower, upper, now = Date.now()) {
  try {
    let call = PM.parseTransaction({ data });
    if (call?.name === 'multicall') {
      if (call.args.data.length !== 1) throw invalid('Unexpected liquidity multicall.');
      call = PM.parseTransaction({ data: call.args.data[0] });
    }
    if (
      call?.name !== 'modifyLiquidities' ||
      call.args.deadline <= BigInt(Math.floor(now / 1000)) ||
      call.args.deadline > BigInt(Math.floor(now / 1000) + 3600)
    )
      throw invalid('Invalid liquidity deadline.');
    const [actions, params] = coder.decode(['bytes', 'bytes[]'], call.args.unlockData);
    if (actions !== '0x020d' || params.length !== 2) throw invalid('Unexpected liquidity actions.');
    const [key, tickLower, tickUpper, liquidity, max0, max1, owner, hookData] = coder.decode(
      [KEY, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
      params[0],
    );
    const [currency0, currency1] = coder.decode(['address', 'address'], params[1]);
    if (
      keccak256(coder.encode([KEY], [key])).toLowerCase() !== d.poolId.toLowerCase() ||
      Number(tickLower) !== lower ||
      Number(tickUpper) !== upper ||
      liquidity <= 0n ||
      !same(owner, wallet) ||
      hookData !== '0x' ||
      !same(currency0, key.currency0) ||
      !same(currency1, key.currency1)
    )
      throw invalid('Unexpected liquidity position.');
    if (max0 > budgets[d.poolKey.currency0] || max1 > budgets[d.poolKey.currency1])
      throw new AppError(
        409,
        'SEED_BUDGET_EXCEEDED',
        'Uniswap’s maximum token amounts exceed your seed budgets. Refresh and retry with adjusted budgets.',
      );
    return { liquidity: liquidity.toString() };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid('Could not validate Uniswap liquidity calldata.');
  }
}
