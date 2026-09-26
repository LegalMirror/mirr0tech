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
