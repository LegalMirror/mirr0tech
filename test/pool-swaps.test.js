import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, keccak256, toBeHex } from 'ethers';
import { readFileSync } from 'node:fs';
import { PoolSwaps } from '../src/onchain/pool-swaps.js';
import { UNISWAP } from '../src/onchain/uniswap-config.js';
const asset = JSON.parse(readFileSync('deployments/sepolia-mockusd.json')).address;
const token = `0x${'1'.repeat(40)}`,
  wallet = `0x${'2'.repeat(40)}`,
  hook = `0x${'3'.repeat(40)}`;
const poolKey = { currency0: token, currency1: asset, fee: 3000, tickSpacing: 60, hooks: hook };
const poolId = keccak256(
  AbiCoder.defaultAbiCoder().encode(['tuple(address,address,uint24,int24,address)'], [Object.values(poolKey)]),
);
const record = {
  status: 'deployed',
  policyHash: 'policy',
  deployment: { ...UNISWAP, token, asset, hook, poolKey, poolId, policyHash: 'policy', routing: 'uniswap-api' },
};
const abi = new Interface([
  'function symbol() view returns(string)',
  'function decimals() view returns(uint8)',
  'function balanceOf(address) view returns(uint256)',
  'function extsload(bytes32) view returns(bytes32)',
]);
test('backend RPC supplies balances even when optional symbol metadata reverts', async () => {
  let missing = false;
  const provider = {
    send: async () => toBeHex(11155111),
    getCode: async () => (missing ? '0x' : '0x1234'),
    call: async (tx) => {
      const method = abi.parseTransaction(tx).name;
      if (method === 'symbol') throw Error('missing revert data');
      return abi.encodeFunctionResult(method, [
        method === 'decimals' ? 6 : method === 'balanceOf' ? 1000000000000n : toBeHex(123, 32),
      ]);
    },
  };
  const swaps = new PoolSwaps({ provider });
  const state = await swaps.state(record, wallet);
  assert.equal(state.asset.balance, '1000000000000');
  assert.equal(state.asset.symbol, 'mUSDC');
  assert.equal(state.rwa.symbol, 'RWA');
  assert.equal(state.liquidity, '123');
  missing = true;
  await assert.rejects(swaps.state(record, wallet), { code: 'TOKEN_NOT_DEPLOYED' });
});

test('when the Trading API has no route, the gateway prices on chain and builds one Universal Router call: Permit2 permit, then the swap through this pool', async () => {
  const { Wallet } = await import('ethers');
  const signer = Wallet.createRandom();
  const investor = signer.address;
  const direct = { ...record, id: 'agr_direct' };
  const calls = new Interface([
    'function symbol() view returns(string)',
    'function decimals() view returns(uint8)',
    'function balanceOf(address) view returns(uint256)',
    'function allowance(address,address) view returns(uint256)',
    'function allowance(address,address,address) view returns(uint160,uint48,uint48)',
    'function extsload(bytes32) view returns(bytes32)',
    'function explain(address) view returns(bool,uint16)',
    'function quoteExactInputSingle(tuple(tuple(address,address,uint24,int24,address),bool,uint128,bytes)) returns(uint256,uint256)',
  ]);
  let erc20Allowance = 0n;
  const quoted = [];
  const provider = {
    send: async () => toBeHex(11155111),
    getCode: async () => '0x1234',
    call: async (tx) => {
      const parsed = calls.parseTransaction(tx);
      const reply = (values) => calls.encodeFunctionResult(parsed.fragment, values);
      if (parsed.name === 'allowance') return parsed.args.length === 3 ? reply([0n, 0n, 5n]) : reply([erc20Allowance]);
      if (parsed.name === 'quoteExactInputSingle') { quoted.push(parsed.args[0]); return reply([996n, 90000n]); }
      if (parsed.name === 'explain') return reply([true, 0]);
      if (parsed.name === 'extsload') return reply([toBeHex(10n ** 12n, 32)]);
      return reply([parsed.name === 'decimals' ? 6 : parsed.name === 'balanceOf' ? 10n ** 12n : 'X']);
    },
  };
  const swaps = new PoolSwaps({ provider, apiKey: 'k', fetcher: async () => new Response('{}', { status: 404 }) });
  const quote = await swaps.quote(direct, { wallet: investor, direction: 'sell', amount: '1000', slippageBps: 100 });
  assert.equal(quote.route, 'direct');
  assert.equal(quote.amountOut, '996');
  assert.equal(quote.minAmountOut, '986');
  assert.equal(quote.router, UNISWAP.router);
  assert.equal(quoted[0][1], true, 'selling the fund token (currency0) is zeroForOne');
  assert.equal(quote.permitData.values.spender, UNISWAP.router);
  assert.equal(quote.permitData.values.details.nonce, '5', 'the nonce Permit2 holds for this wallet, token and router');
  assert.equal(quote.permitData.values.details.amount, '1000');

  const body = { quoteId: quote.id, wallet: investor };
  const { approval, cancel } = await swaps.approval(direct, body);
  assert.equal(cancel, null);
  assert.equal(approval.to.toLowerCase(), token);
  assert.deepEqual(new Interface(['function approve(address,uint256)']).decodeFunctionData('approve', approval.data).map(String), [UNISWAP.permit2, '1000']);
  erc20Allowance = 10n ** 30n;
  assert.equal((await swaps.approval(direct, body)).approval, null, 'enough allowance: nothing to approve');

  await assert.rejects(swaps.swap(direct, { ...body, signature: `0x${'1'.repeat(130)}` }), { code: 'INVALID_PERMIT' });
  const signature = await signer.signTypedData(quote.permitData.domain, quote.permitData.types, quote.permitData.values);
  const { transaction } = await swaps.swap(direct, { ...body, signature });
  assert.equal(transaction.to, UNISWAP.router);
  const coder = AbiCoder.defaultAbiCoder();
  const [commands, inputs] = new Interface(['function execute(bytes,bytes[],uint256)']).decodeFunctionData('execute', transaction.data);
  assert.equal(commands, '0x0a10', 'PERMIT2_PERMIT then V4_SWAP');
  const [permit, signed] = coder.decode(['tuple(tuple(address,uint160,uint48,uint48),address,uint256)', 'bytes'], inputs[0]);
  assert.equal(permit[1], UNISWAP.router);
  assert.equal(signed, signature);
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[1]);
  const [swap] = coder.decode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)'], params[0]);
  assert.deepEqual([swap[1], swap[2], swap[3]], [true, 1000n, 986n], 'the reviewed minimum output is enforced on chain');
});
