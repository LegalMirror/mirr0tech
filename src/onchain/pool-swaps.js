import { AbiCoder, Contract, FetchRequest, JsonRpcProvider, getAddress, isAddress, keccak256, toBeHex } from 'ethers';
import { AppError, ensure } from '../errors.js';
import { UniswapSwaps, swapDeployment } from '../uniswap.js';
const coder = AbiCoder.defaultAbiCoder();
const ERC20 = [
  'function symbol() view returns(string)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
];
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
    return super.quote(record, body);
  }
  async receipt(hash) {
    ensure(/^0x[0-9a-fA-F]{64}$/.test(hash), 400, 'INVALID_TRANSACTION', 'Invalid transaction hash.');
    const receipt = await (await this.rpc()).getTransactionReceipt(hash);
    return receipt ? { hash: receipt.hash, status: receipt.status, blockNumber: receipt.blockNumber } : null;
  }
}
