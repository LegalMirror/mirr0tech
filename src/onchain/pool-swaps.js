import { AbiCoder, Contract, FetchRequest, Interface, JsonRpcProvider, getAddress, isAddress, keccak256, toBeHex, verifyTypedData } from 'ethers';
import { randomUUID } from 'node:crypto';
import { UNISWAP } from './uniswap-config.js';
import { permitAndSwapCall } from './periphery.js';
const PERMIT2 = UNISWAP.permit2;
import { AppError, ensure } from '../errors.js';
import { UniswapSwaps, swapDeployment, validatePermit } from '../uniswap.js';
const coder = AbiCoder.defaultAbiCoder();
const ERC20 = [
  'function symbol() view returns(string)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
];
const QUOTER = ['function quoteExactInputSingle(tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)'];
const APPROVE = new Interface(['function approve(address spender,uint256 amount) returns (bool)']);
// The Trading API does not index every hooked v4 pool; these mean the gateway can still build the swap itself.
const NO_API_ROUTE = ['POOL_NOT_ROUTED', 'UNISWAP_NOT_CONFIGURED', 'UNISWAP_UNAVAILABLE', 'UNISWAP_RATE_LIMITED'];
const PERMIT_TYPES = {
  PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
};
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
// Read token metadata and balances through the configured Sepolia RPC; wallets only sign.
export class PoolSwaps extends UniswapSwaps {
  constructor({ provider, ...options } = {}) {
    super(options);
    this.provider = provider;
  }
  async rpc() {
    if (!this.provider) {
      ensure(process.env.RPC_URL, 503, 'NO_RPC', 'Configure the backend Sepolia RPC for swaps.');
      const request = new FetchRequest(process.env.RPC_URL);
      request.timeout = 10000;
      this.provider = new JsonRpcProvider(request, 11155111, { staticNetwork: true, cacheTimeout: -1 });
    }
    ensure(
      Number(BigInt(await this.provider.send('eth_chainId', []))) === 11155111,
      409,
      'WRONG_CHAIN',
      'The backend RPC must use Sepolia.',
    );
    return this.provider;
  }
  async state(record, wallet) {
    const d = swapDeployment(record);
    ensure(isAddress(wallet), 400, 'INVALID_WALLET', 'Connect a valid Sepolia wallet.');
    const provider = await this.rpc();
    const read = async (address, fallback) => {
      ensure(
        (await provider.getCode(address)) !== '0x',
        409,
        'TOKEN_NOT_DEPLOYED',
        `No token contract exists at ${address} on Sepolia. Refresh the selected agreement.`,
      );
      const token = new Contract(address, ERC20, provider);
      try {
        const [decimals, balance, symbol] = await Promise.all([
          token.decimals(),
          token.balanceOf(wallet),
          token.symbol().catch(() => fallback),
        ]);
        ensure(Number(decimals) <= 36, 409, 'TOKEN_PRECISION', 'Unsupported token decimals.');
        return { address, decimals: Number(decimals), balance: balance.toString(), symbol };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          502,
          'TOKEN_READ_FAILED',
          `Could not read token balances at ${address} through the backend Sepolia RPC. Try again shortly.`,
        );
      }
    };
    const asset = same(d.poolKey.currency0, d.token) ? d.poolKey.currency1 : d.poolKey.currency0;
    const slot = keccak256(coder.encode(['bytes32', 'uint256'], [d.poolId, 6]));
    const manager = new Contract(d.poolManager, ['function extsload(bytes32) view returns(bytes32)'], provider);
    const [rwa, usd, liquidity] = await Promise.all([
      read(d.token, 'RWA'),
      read(asset, 'mUSDC'),
      manager.extsload(toBeHex(BigInt(slot) + 3n, 32)),
    ]);
    return {
      chainId: d.chainId,
      poolId: d.poolId,
      wallet: getAddress(wallet),
      rwa,
      asset: usd,
      liquidity: (BigInt(liquidity) & ((1n << 128n) - 1n)).toString(),
      route: 'uniswap-api',
    };
  }
  async quote(record, body) {
    const d = swapDeployment(record);
    ensure(isAddress(body?.wallet), 400, 'INVALID_SWAP', 'Connect a valid Sepolia wallet.');
    const state = await this.state(record, body.wallet);
    ensure(
      BigInt(state.liquidity) > 0n,
      409,
      'NO_LIQUIDITY',
      'Seed this pool under Liquidity management before swapping.',
    );
    const hook = new Contract(d.hook, ['function explain(address) view returns(bool,uint16)'], await this.rpc());
    const decision = await hook.explain(body.wallet);
    ensure(
      decision[0],
      403,
      'POLICY_REFUSED',
      `The connected wallet is refused by transfer clause ${decision[1]}. Complete its attestations before swapping.`,
    );
    try {
      return await super.quote(record, body);
    } catch (error) {
      if (!NO_API_ROUTE.includes(error.code)) throw error;
      return this.directQuote(record, body, d);
    }
  }
  /// Prices the swap with the canonical v4 Quoter (the hook admits it) and asks the wallet for a
  /// Permit2 permit to the Universal Router; `swap` then permits and swaps in one router call.
  async directQuote(record, body, d) {
    const provider = await this.rpc();
    const asset = same(d.poolKey.currency0, d.token) ? d.poolKey.currency1 : d.poolKey.currency0;
    const tokenIn = getAddress(body.direction === 'buy' ? asset : d.token);
    const tokenOut = getAddress(body.direction === 'buy' ? d.token : asset);
    const zeroForOne = same(tokenIn, d.poolKey.currency0);
    const key = { currency0: d.poolKey.currency0, currency1: d.poolKey.currency1, fee: d.poolKey.fee, tickSpacing: d.poolKey.tickSpacing, hooks: d.poolKey.hooks };
    let amountOut;
    try {
      [amountOut] = await new Contract(UNISWAP.quoter, QUOTER, provider).quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne, exactAmount: body.amount, hookData: '0x' });
    } catch {
      throw new AppError(409, 'SWAP_SIMULATION_FAILED', 'This pool could not price the swap. Check its liquidity and the amount.');
    }
    const wallet = getAddress(body.wallet);
    const [, , nonce] = await new Contract(PERMIT2, ['function allowance(address,address,address) view returns (uint160,uint48,uint48)'], provider).allowance(wallet, tokenIn, UNISWAP.router);
    const seconds = Math.floor(this.now() / 1000);
    const permitData = {
      domain: { name: 'Permit2', chainId: 11155111, verifyingContract: PERMIT2 },
      types: PERMIT_TYPES,
      values: { details: { token: tokenIn, amount: body.amount, expiration: String(seconds + 30 * 86400), nonce: nonce.toString() }, spender: UNISWAP.router, sigDeadline: String(seconds + 1500) },
    };
    const request = { tokenIn, amount: body.amount };
    validatePermit(permitData, request, this.now());
    const minAmountOut = ((amountOut * BigInt(10000 - body.slippageBps)) / 10000n).toString();
    ensure(BigInt(minAmountOut) > 0n, 400, 'AMOUNT_TOO_SMALL', 'Increase the swap amount.');
    const id = randomUUID();
    const expiresAt = this.now() + 120000;
    const result = { id, expiresAt, chainId: d.chainId, poolId: d.poolId, wallet, tokenIn, tokenOut, amountIn: body.amount, amountOut: amountOut.toString(), minAmountOut, slippageBps: body.slippageBps, spender: PERMIT2, router: UNISWAP.router, permitData, route: 'direct' };
    this.quotes.set(id, { ...result, agreementId: record.id, policyHash: d.policyHash, direct: { key, zeroForOne }, request });
    return result;
  }
  async approval(record, body) {
    const q = this.current(record, body);
    if (!q.direct) return super.approval(record, body);
    const allowance = await new Contract(q.tokenIn, ['function allowance(address,address) view returns (uint256)'], await this.rpc()).allowance(q.wallet, PERMIT2);
    const approval = allowance >= BigInt(q.amountIn) ? null
      : { from: q.wallet, to: q.tokenIn, data: APPROVE.encodeFunctionData('approve', [PERMIT2, BigInt(q.amountIn)]), value: '0x0', chainId: 11155111 };
    return { cancel: null, approval };
  }
  async swap(record, body) {
    const q = this.current(record, body);
    if (!q.direct) return super.swap(record, body);
    let recovered;
    try { recovered = verifyTypedData(q.permitData.domain, q.permitData.types, q.permitData.values, body.signature); } catch {}
    ensure(same(recovered, q.wallet), 400, 'INVALID_PERMIT', 'Sign the Permit2 authorization with the connected wallet.');
    validatePermit(q.permitData, q.request, this.now());
    const data = permitAndSwapCall({
      permit: q.permitData.values, signature: body.signature, deadline: BigInt(Math.floor(q.expiresAt / 1000)),
      key: q.direct.key, zeroForOne: q.direct.zeroForOne, amountIn: BigInt(q.amountIn), amountOutMinimum: BigInt(q.minAmountOut),
    });
    return { transaction: { from: q.wallet, to: UNISWAP.router, data, value: '0x0', chainId: 11155111 }, expiresAt: q.expiresAt };
  }
  async receipt(hash) {
    ensure(/^0x[0-9a-fA-F]{64}$/.test(hash), 400, 'INVALID_TRANSACTION', 'Invalid transaction hash.');
    const receipt = await (await this.rpc()).getTransactionReceipt(hash);
    return receipt ? { hash: receipt.hash, status: receipt.status, blockNumber: receipt.blockNumber } : null;
  }
}
