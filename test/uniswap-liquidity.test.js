import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { UniswapLiquidity, validatePosition } from '../src/uniswap-liquidity.js';
import { UNISWAP } from '../src/onchain/uniswap-config.js';
const coder = AbiCoder.defaultAbiCoder(),
  wallet = `0x${'1'.repeat(40)}`,
  token0 = `0x${'2'.repeat(40)}`,
  token1 = `0x${'3'.repeat(40)}`,
  hook = `0x${'4'.repeat(40)}`;
const keyType = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const poolKey = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: hook };
const d = { poolKey, poolId: keccak256(coder.encode([keyType], [poolKey])) };
const budgets = { [token0]: 1000000n, [token1]: 1000000n };
const pm = new Interface(['function modifyLiquidities(bytes,uint256)']);
const data = (changes = {}) => {
  const c = { key: poolKey, owner: wallet, max0: 1000000n, actions: '0x020d', deadline: 1200, ...changes };
  const mint = coder.encode(
    [keyType, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [c.key, -887220, 887220, 999000n, c.max0, 1000000n, c.owner, '0x'],
  );
  return pm.encodeFunctionData('modifyLiquidities', [
    coder.encode(['bytes', 'bytes[]'], [c.actions, [mint, coder.encode(['address', 'address'], [token0, token1])]]),
    c.deadline,
  ]);
};
test('LP calldata rejects another pool, recipient, excess budget, unexpected actions and expired deadlines', () => {
  assert.equal(validatePosition(data(), d, wallet, budgets, -887220, 887220, 1000000).liquidity, '999000');
  for (const change of [
    { key: { ...poolKey, hooks: wallet } },
    { owner: hook },
    { max0: 1000001n },
    { actions: '0x030d' },
    { deadline: 999 },
  ])
    assert.throws(() => validatePosition(data(change), d, wallet, budgets, -887220, 887220, 1000000));
});
test('LP approvals cap both ERC20 and Permit2 amounts and reject arbitrary spenders', async () => {
  const erc20 = new Interface(['function approve(address,uint256)']),
    permit = new Interface(['function approve(address,address,uint160,uint48)']);
  let spender = UNISWAP.positionManager;
  const api = new UniswapLiquidity({
    apiKey: 'test',
    now: () => 1000000,
    fetcher: async (_url, init) => {
      assert.equal(JSON.parse(init.body).generatePermitAsTransaction, true);
      const tx = (to, data) => ({
        transaction: { to, data, from: wallet, chainId: 11155111, value: '0x00' },
        cancelApproval: false,
      });
      return {
        ok: true,
        json: async () => ({
          transactions: [
            tx(token0, erc20.encodeFunctionData('approve', [UNISWAP.permit2, 2n ** 256n - 1n])),
            tx(UNISWAP.permit2, permit.encodeFunctionData('approve', [token0, spender, 2n ** 160n - 1n, 100000])),
          ],
        }),
      };
    },
  });
  const approvals = await api.approvals(wallet, budgets);
  assert.equal(erc20.parseTransaction(approvals[0]).args[1], 1000000n);
  assert.equal(permit.parseTransaction(approvals[1]).args[2], 1000000n);
  spender = hook;
  await assert.rejects(api.approvals(wallet, budgets), { code: 'UNISWAP_INVALID_RESPONSE' });
});
