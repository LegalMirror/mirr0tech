// Uniswap Trading API adapter. The gateway prepares unsigned transactions only.
// Pool selection is pinned to the persisted deployment, never supplied by a browser.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, getAddress, isAddress, keccak256, verifyTypedData } from 'ethers';
import { UNISWAP } from './onchain/uniswap-config.js';
import { AppError, ensure } from './errors.js';

const BASE_URL = 'https://trade-api.gateway.uniswap.org/v1';
const MOCK_USD = JSON.parse(readFileSync(new URL('../deployments/sepolia-mockusd.json', import.meta.url), 'utf8'));
export const PERMIT2 = UNISWAP.permit2;
export const UNIVERSAL_ROUTER = UNISWAP.router;
export const SEPOLIA_POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543';
const ERC20 = new Interface(['function approve(address spender,uint256 amount) returns (bool)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const positive = (value) => typeof value === 'string' && /^[1-9][0-9]{0,76}$/.test(value);
const fail = (message) => new AppError(502, 'UNISWAP_INVALID_RESPONSE', message);

export function swapDeployment(record) {
  const d = record.deployment;
  ensure(record.status === 'deployed' && d, 409, 'NOT_DEPLOYED', 'Deploy this agreement before swapping.');
  ensure(
    same(record.policyHash, d.policyHash),
    409,
    'STALE_DEPLOYMENT',
    'The deployed policy differs from the current agreement. Deploy the current policy first.',
  );
  ensure(d.chainId === 11155111, 409, 'UNSUPPORTED_CHAIN', 'Swaps are available on Sepolia only.');
  const k = d.poolKey;
  ensure(
    k && d.poolManager && d.poolId && d.hook,
    409,
    'NO_UNISWAP_POOL',
    'This deployment does not contain a Uniswap v4 pool.',
  );
  ensure(
    same(d.poolManager, SEPOLIA_POOL_MANAGER),
    409,
    'UNSUPPORTED_POOL_MANAGER',
    'Uniswap API routing requires the canonical Sepolia PoolManager.',
  );
  ensure(
    [k.currency0, k.currency1, k.hooks, d.token, d.poolManager].every(isAddress) &&
      BigInt(k.currency0) > 0n &&
      BigInt(k.currency0) < BigInt(k.currency1) &&
      [k.currency0, k.currency1].some((token) => same(token, d.token)) &&
      same(k.hooks, d.hook),
    409,
    'INVALID_POOL',
    'The deployment has an invalid pool key.',
  );
  const poolId = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
  ensure(same(poolId, d.poolId), 409, 'INVALID_POOL', 'The deployment pool ID does not match its key.');
  const asset = same(k.currency0, d.token) ? k.currency1 : k.currency0;
  ensure(
    same(asset, MOCK_USD.address),
    409,
    'LEGACY_POOL_ASSET',
    `This pool uses ${asset}, not shared mUSDC at ${MOCK_USD.address}. A new pool with the shared token is required.`,
  );
  ensure(
    d.routing === 'uniswap-api' && same(d.router, UNIVERSAL_ROUTER) && same(d.positionManager, UNISWAP.positionManager),
    409,
    'DEPRECATED_ROUTER',
    'This pool uses a retired custom router. Redeploy the agreement for Uniswap API liquidity and swaps.',
  );
  return d;
}

// The public API has no parameter that forces a particular pool. Reject alternative routes.
export function validatePoolQuote(response, deployment, request) {
  const q = response?.quote;
  const routes = q?.route;
  const k = deployment.poolKey;
  ensure(
    response?.routing === 'CLASSIC' &&
      Array.isArray(routes) &&
      routes.length === 1 &&
      Array.isArray(routes[0]) &&
      routes[0].length === 1,
    409,
    'POOL_NOT_ROUTED',
    'Uniswap did not return a direct route through this agreement’s pool. The pool needs liquidity and API support for its hook.',
  );
  const hop = routes[0][0];
  ensure(
    hop &&
      hop.type === 'v4-pool' &&
      same(hop.address, deployment.poolId) &&
      same(hop.hooks, k.hooks) &&
      Number(hop.fee) === Number(k.fee) &&
      Number(hop.tickSpacing) === Number(k.tickSpacing) &&
      same(hop.tokenIn?.address, request.tokenIn) &&
      same(hop.tokenOut?.address, request.tokenOut) &&
      Number(hop.tokenIn?.chainId) === deployment.chainId &&
      Number(hop.tokenOut?.chainId) === deployment.chainId,
    409,
    'POOL_NOT_ROUTED',
    'Uniswap returned a different pool. This swap is restricted to the deployed agreement pool.',
  );
  ensure(
    q.tradeType === 'EXACT_INPUT' &&
      same(q.swapper, request.swapper) &&
      (!q.recipient || same(q.recipient, request.swapper)) &&
      (!q.output?.recipient || same(q.output.recipient, request.swapper)) &&
      same(q.input?.token, request.tokenIn) &&
      same(q.output?.token, request.tokenOut) &&
      q.input?.amount === request.amount &&
      positive(q.output?.amount) &&
      Number(q.slippage) === request.slippageTolerance,
    502,
    'UNISWAP_INVALID_RESPONSE',
    'Uniswap returned a quote with different swap parameters.',
  );
  ensure(
    !q.txFailureReason && !response.txFailureReason,
    409,
    'SWAP_SIMULATION_FAILED',
    'Uniswap could not simulate this swap. Check token balances, wallet eligibility, liquidity, and hook/router compatibility.',
  );
  return q;
}

export function transaction(tx, wallet, target) {
  if (
    !tx ||
    !same(tx.to, target) ||
    (tx.from && !same(tx.from, wallet)) ||
    Number(tx.chainId) !== 11155111 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(tx.data ?? '') ||
    !/^(?:0|0x0+)$/.test(String(tx.value ?? '0'))
  )
    throw fail('Uniswap returned an unexpected transaction.');
  return { from: getAddress(wallet), to: getAddress(target), data: tx.data, value: '0x0', chainId: 11155111 };
}

export class UniswapSwaps {
  constructor({ apiKey = () => process.env.UNISWAP_API_KEY, fetcher = fetch, now = Date.now } = {}) {
    this.apiKey = typeof apiKey === 'function' ? apiKey : () => apiKey;
    this.fetcher = fetcher;
    this.now = now;
    this.quotes = new Map();
  }
  async call(endpoint, body) {
    const key = this.apiKey();
    ensure(key, 503, 'UNISWAP_NOT_CONFIGURED', 'Set UNISWAP_API_KEY on the gateway to enable Uniswap quotes.');
    let response;
    try {
      response = await this.fetcher(`${BASE_URL}/${endpoint}`, {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'x-universal-router-version': '2.1.2',
          'x-permit2-disabled': 'false',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AppError(503, 'UNISWAP_UNAVAILABLE', 'Uniswap did not respond. Try again shortly.');
    }
    if (!response.ok) {
      if (response.status === 404)
        throw new AppError(
          409,
          'POOL_NOT_ROUTED',
          'Uniswap could not find a route. The deployed pool needs liquidity and a hook supported by Uniswap’s router and API.',
        );
      if (response.status === 401 || response.status === 403)
        throw new AppError(503, 'UNISWAP_NOT_CONFIGURED', 'The gateway’s Uniswap API key was rejected.');
      if (response.status === 429)
        throw new AppError(503, 'UNISWAP_RATE_LIMITED', 'Uniswap is rate limiting requests. Try again shortly.');
      throw new AppError(
        502,
        'UNISWAP_REQUEST_FAILED',
        'Uniswap could not prepare this swap. Check liquidity, balance, and hook/router compatibility.',
      );
    }
    try {
      return await response.json();
    } catch {
      throw fail('Uniswap returned an unreadable response.');
    }
  }
  async quote(record, body) {
    const d = swapDeployment(record);
    ensure(
      body &&
        isAddress(body.wallet) &&
        ['buy', 'sell'].includes(body.direction) &&
        positive(body.amount) &&
        BigInt(body.amount) < 1n << 128n &&
        Number.isInteger(body.slippageBps) &&
        body.slippageBps >= 1 &&
        body.slippageBps <= 500,
      400,
      'INVALID_SWAP',
      'Provide a wallet, buy/sell direction, positive base-unit amount, and slippageBps from 1 to 500.',
    );
    const asset = same(d.poolKey.currency0, d.token) ? d.poolKey.currency1 : d.poolKey.currency0;
    const request = {
      type: 'EXACT_INPUT',
      amount: body.amount,
      tokenInChainId: d.chainId,
      tokenOutChainId: d.chainId,
      tokenIn: body.direction === 'buy' ? asset : d.token,
      tokenOut: body.direction === 'buy' ? d.token : asset,
      swapper: getAddress(body.wallet),
      recipient: getAddress(body.wallet),
      slippageTolerance: body.slippageBps / 100,
      permitAmount: 'EXACT',
      protocols: ['V4'],
      hooksOptions: 'V4_HOOKS_ONLY',
      routingPreference: 'BEST_PRICE',
    };
    const response = await this.call('quote', request);
    const quote = validatePoolQuote(response, d, request);
    // No portion/integrator fees are supported; otherwise the displayed output would be misleading.
    ensure(
      !quote.portionAmount || BigInt(quote.portionAmount) === 0n,
      502,
      'UNISWAP_INVALID_RESPONSE',
      'Fee-bearing quotes are not supported.',
    );
    const permitData = validatePermit(response.permitData, request, this.now());
    const id = randomUUID();
    const expiresAt = this.now() + 120000;
    for (const [key, value] of this.quotes) if (value.expiresAt <= this.now()) this.quotes.delete(key);
    if (this.quotes.size >= 1000) this.quotes.delete(this.quotes.keys().next().value);
    const result = {
      id,
      expiresAt,
      chainId: d.chainId,
      poolId: d.poolId,
      wallet: request.swapper,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: body.amount,
      amountOut: quote.output.amount,
      minAmountOut: ((BigInt(quote.output.amount) * BigInt(10000 - body.slippageBps)) / 10000n).toString(),
      slippageBps: body.slippageBps,
      spender: PERMIT2,
      router: UNIVERSAL_ROUTER,
      permitData,
    };
    ensure(BigInt(result.minAmountOut) > 0n, 400, 'AMOUNT_TOO_SMALL', 'Increase the swap amount.');
    this.quotes.set(id, { ...result, agreementId: record.id, policyHash: d.policyHash, quote, request });
    return result;
  }
  current(record, body) {
    const d = swapDeployment(record);
    const stored = this.quotes.get(body?.quoteId);
    ensure(
      stored &&
        stored.agreementId === record.id &&
        same(stored.wallet, body?.wallet) &&
        same(stored.policyHash, d.policyHash) &&
        same(stored.poolId, d.poolId),
      409,
      'INVALID_QUOTE',
      'Request a new quote for this wallet and deployment.',
    );
    ensure(stored.expiresAt > this.now(), 409, 'QUOTE_EXPIRED', 'The quote expired. Request a new quote.');
    return stored;
  }
  async approval(record, body) {
    const q = this.current(record, body);
    const result = await this.call('check_approval', {
      walletAddress: q.wallet,
      token: q.tokenIn,
      amount: q.amountIn,
      chainId: q.chainId,
      tokenOut: q.tokenOut,
      tokenOutChainId: q.chainId,
    });
    this.current(record, body);
    const normalize = (tx, reset) => {
      if (!tx) return null;
      const normalized = transaction(tx, q.wallet, q.tokenIn);
      let parsed;
      try {
        parsed = ERC20.parseTransaction({ data: tx.data });
      } catch {
        throw fail('Invalid token approval.');
      }
      if (parsed?.name !== 'approve' || !same(parsed.args[0], PERMIT2) || (reset && parsed.args[1] !== 0n))
        throw fail('Unexpected approval spender.');
      // Approve the reviewed amount only, even if the API suggested an unlimited allowance.
      normalized.data = ERC20.encodeFunctionData('approve', [PERMIT2, reset ? 0n : BigInt(q.amountIn)]);
      return normalized;
    };
    return { cancel: normalize(result.cancel, true), approval: normalize(result.approval, false) };
  }
  async swap(record, body) {
    const q = this.current(record, body);
    if (q.permitData) {
      let recovered;
      try {
        recovered = verifyTypedData(q.permitData.domain, q.permitData.types, q.permitData.values, body.signature);
      } catch {}
      ensure(
        same(recovered, q.wallet),
        400,
        'INVALID_PERMIT',
        'Sign the Permit2 authorization with the connected wallet.',
      );
      validatePermit(q.permitData, q.request, this.now());
    }
    const result = await this.call('swap', {
      quote: q.quote,
      ...(q.permitData ? { permitData: q.permitData, signature: body.signature } : {}),
      simulateTransaction: true,
      refreshGasPrice: true,
      deadline: Math.floor(q.expiresAt / 1000),
    });
    this.current(record, body);
    return { transaction: transaction(result.swap, q.wallet, UNIVERSAL_ROUTER), expiresAt: q.expiresAt };
  }
}

// Accept only a single-token Permit2 allowance for the reviewed amount and canonical router.
export function validatePermit(data, request, now = Date.now()) {
  if (!data) return null;
  const v = data.values,
    d = v?.details;
  const seconds = Math.floor(now / 1000);
  const types = {
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
  };
  ensure(
    data.domain?.name === 'Permit2' &&
      Number(data.domain.chainId) === 11155111 &&
      same(data.domain.verifyingContract, PERMIT2) &&
      Object.keys(data.domain).every((k) => ['name', 'chainId', 'verifyingContract'].includes(k)) &&
      same(v?.spender, UNIVERSAL_ROUTER) &&
      same(d?.token, request.tokenIn) &&
      String(d?.amount) === request.amount &&
      Number(d?.expiration) > seconds &&
      Number(d.expiration) <= seconds + 31 * 86400 &&
      Number(v?.sigDeadline) > seconds &&
      Number(v.sigDeadline) <= seconds + 1800 &&
      Object.keys(data.types ?? {}).length === 2 &&
      Object.entries(types).every(
        ([name, fields]) =>
          Array.isArray(data.types[name]) &&
          data.types[name].length === fields.length &&
          fields.every(
            (field, i) => data.types[name][i]?.name === field.name && data.types[name][i]?.type === field.type,
          ),
      ),
    502,
    'UNISWAP_INVALID_RESPONSE',
    'Uniswap returned an unexpected Permit2 authorization.',
  );
  return data;
}
