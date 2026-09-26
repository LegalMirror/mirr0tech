import { readFileSync } from 'node:fs';
import { AbiCoder, Contract, formatUnits, keccak256, parseUnits, toBeHex } from 'ethers';
import { UniswapLiquidity } from '../uniswap-liquidity.js';
import { swapDeployment } from '../uniswap.js';
import { UNISWAP } from './uniswap-config.js';
import { ensure } from '../errors.js';
const shared = JSON.parse(readFileSync(new URL('../../deployments/sepolia-mockusd.json', import.meta.url)));
const coder = AbiCoder.defaultAbiCoder();
const KEY = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const ERC20 = ['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)'];
const MASK128 = (1n << 128n) - 1n;
export function seedInput(body) {
  ensure(
    body && typeof body.requestId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId),
    400,
    'INVALID_SEED',
    'A unique requestId is required.',
  );
  for (const key of ['rwaAmount', 'usdAmount'])
    ensure(
      typeof body[key] === 'string' &&
        body[key].length <= 80 &&
        /^\d+(\.\d{1,6})?$/.test(body[key]) &&
        parseUnits(body[key], 6) > 0n &&
        parseUnits(body[key], 6) < 1n << 127n,
      400,
      'INVALID_SEED',
      'Enter positive RWA and mUSDC budgets with at most six decimals.',
    );
  return { requestId: body.requestId, rwaAmount: body.rwaAmount, usdAmount: body.usdAmount };
}
export function seedDeployment(record) {
  const d = record.deployment;
  ensure(
    record.status === 'deployed' &&
      d?.policyHash === record.policyHash &&
      d.poolKey &&
      d.poolId &&
      d.router &&
      d.poolManager &&
      d.hook &&
      d.token &&
      d.asset,
    409,
    'NO_POOL',
    'Deploy the current agreement and its Uniswap pool first.',
  );
  ensure(!d.cashier, 409, 'SEED_UNSUPPORTED', 'Cashier pools use their separate liquidity flow.');
  ensure(
    d.chainId !== 11155111 || d.asset?.toLowerCase() === shared.address.toLowerCase(),
    409,
    'LEGACY_POOL_ASSET',
    'Seeding is disabled for deprecated pools paired with the old mUSDC token.',
  );
  const pair = [d.poolKey.currency0, d.poolKey.currency1].map((x) => x.toLowerCase());
  ensure(
    pair.includes(d.token.toLowerCase()) &&
      pair.includes(d.asset?.toLowerCase()) &&
      d.poolKey.hooks.toLowerCase() === d.hook.toLowerCase(),
    409,
    'POOL_MISMATCH',
    'The saved pool does not match this agreement.',
  );
  ensure(
    keccak256(coder.encode([KEY], [d.poolKey])).toLowerCase() === d.poolId.toLowerCase(),
    409,
    'POOL_MISMATCH',
    'The pool key does not match the deployed pool ID.',
  );
  swapDeployment(record);
  return d;
}
export function createPoolSeeder(signer, api = new UniswapLiquidity()) {
  async function context(record) {
    const d = seedDeployment(record);
    ensure(
      Number(BigInt(await signer.provider.send('eth_chainId', []))) === d.chainId,
      409,
      'WRONG_CHAIN',
      'Backend RPC does not match this pool’s chain.',
    );
    const backend = await signer.getAddress();
    const manager = new Contract(d.poolManager, ['function extsload(bytes32) view returns(bytes32)'], signer.provider);
    const slot = keccak256(coder.encode(['bytes32', 'uint256'], [d.poolId, 6]));
    const read = async (offset) => BigInt(await manager.extsload(toBeHex(BigInt(slot) + BigInt(offset), 32)));
    const rwa = new Contract(d.token, ERC20, signer),
      usd = new Contract(d.asset, ERC20, signer);
    const [rwaBalance, usdBalance, rwaDecimals, usdDecimals, slot0, liquidity] = await Promise.all([
      rwa.balanceOf(backend),
      usd.balanceOf(backend),
      rwa.decimals(),
      usd.decimals(),
      read(0),
      read(3),
    ]);
    ensure(
      rwaDecimals === 6n && usdDecimals === 6n,
      409,
      'TOKEN_DECIMALS',
      'This flow requires the six-decimal RWA and shared mUSDC tokens.',
    );
    return {
      d,
      backend,
      manager,
      slot,
      rwa,
      usd,
      rwaBalance,
      usdBalance,
      sqrtPrice: slot0 & ((1n << 160n) - 1n),
      tick: Number(BigInt.asIntN(24, slot0 >> 160n)),
      liquidity: (liquidity & MASK128).toString(),
    };
  }
  return {
    async state(record) {
      const c = await context(record);
      return {
        backend: c.backend,
        token: c.d.token,
        asset: c.d.asset,
        poolId: c.d.poolId,
        liquidity: c.liquidity,
        rwaBalance: formatUnits(c.rwaBalance, 6),
        usdBalance: formatUnits(c.usdBalance, 6),
      };
    },
    async seed({ record, operation, progress }) {
      const c = await context(record);
      const { d, backend } = c;
      await progress({ backend });
      const confirm = async (hash) => {
        const receipt = await signer.provider.waitForTransaction(hash, 1, 120000);
        ensure(receipt, 409, 'SEED_PENDING', 'Transaction still pending. Retry the same request later.');
        return receipt.status === 1;
      };
      // Persist the signed transaction and hash BEFORE broadcast. Retries rebroadcast identical
      // bytes, never mint a second NFT after a crash or a confirmation timeout.
      if (operation.seedTxHash) {
        if (operation.seedRawTransaction && !(await signer.provider.getTransaction(operation.seedTxHash))) {
          await signer.provider.broadcastTransaction(operation.seedRawTransaction);
        }
        if (await confirm(operation.seedTxHash)) return { status: 'confirmed' };
        // A mined revert is safe to retry; a pending/unknown transaction is never replaced.
        await progress({ seedTxHash: null, seedRawTransaction: null });
      }
      if (operation.approvalTxHash) await confirm(operation.approvalTxHash);
      const rwaBudget = parseUnits(operation.rwaAmount, 6),
        usdBudget = parseUnits(operation.usdAmount, 6);
      ensure(
        c.rwaBalance >= rwaBudget && c.usdBalance >= usdBudget,
        409,
        'INSUFFICIENT_BALANCE',
        'The backend needs both RWA and shared mUSDC balances before seeding.',
      );
      const hook = new Contract(
        d.hook,
        [
          'function router() view returns(address)',
          'function positionManager() view returns(address)',
          'function explain(address) view returns(bool,uint16)',
        ],
        signer.provider,
      );
      const [router, positions, decision] = await Promise.all([
        hook.router(),
        hook.positionManager(),
        hook.explain(backend),
      ]);
      ensure(
        router.toLowerCase() === UNISWAP.router.toLowerCase() &&
          positions.toLowerCase() === UNISWAP.positionManager.toLowerCase(),
        409,
        'ROUTER_MISMATCH',
        'Redeploy this agreement with the Uniswap API hook.',
      );
      ensure(
        decision[0],
        403,
        'POLICY_REFUSED',
        `The backend liquidity provider is refused by policy clause ${decision[1]}. Complete its transfer attestations first.`,
      );
      const budgets = Object.fromEntries(
        [d.poolKey.currency0, d.poolKey.currency1].map((address) => [
          address,
          address.toLowerCase() === d.token.toLowerCase() ? rwaBudget : usdBudget,
        ]),
      );
      const transaction = await api.create(d, backend, budgets, c.sqrtPrice);
      for (const approval of await api.approvals(backend, budgets)) {
        const tx = await signer.sendTransaction(approval);
        await progress({
          approvalTxHash: tx.hash,
          approvalTxHashes: [...(operation.approvalTxHashes ?? []), tx.hash],
          stage: 'approval',
        });
        ensure(await confirm(tx.hash), 502, 'APPROVAL_FAILED', 'Approval failed. Retry the same seed request.');
      }
      await signer.provider.call(transaction);
      const populated = await signer.populateTransaction(transaction);
      const raw = await signer.signTransaction(populated);
      const hash = keccak256(raw);
      await progress({ seedTxHash: hash, seedRawTransaction: raw, stage: 'seed' });
      await signer.provider.broadcastTransaction(raw);
      // NonceManager.signTransaction does not increment its cached nonce.
      signer.reset?.();
      ensure(
        await confirm(hash),
        502,
        'SEED_FAILED',
        'Pool seeding failed. Retry the same request after reviewing the transaction.',
      );
      return { status: 'confirmed' };
    },
  };
}
