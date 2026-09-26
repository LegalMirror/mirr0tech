import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface } from 'ethers';
import { sharedMockUsd } from '../src/onchain/mock-usd.js';
import { VenueService } from '../src/onchain/venues.js';

const deployment = JSON.parse(await readFile('deployments/sepolia-mockusd.json', 'utf8'));
const abi = new Interface(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
test('future Sepolia deployments select the saved shared faucet and verify its chain and precision', async () => {
  const calls = [];
  const provider = {
    send: async (method) => { assert.equal(method, 'eth_chainId'); return '0xaa36a7'; },
    call: async ({ to, data }) => {
      assert.equal(to.toLowerCase(), deployment.address.toLowerCase());
      const name = abi.parseTransaction({ data }).name;
      calls.push(name);
      return abi.encodeFunctionResult(name, [name === 'decimals' ? 6 : 'mUSDC']);
    },
  };
  assert.equal(await sharedMockUsd(provider, 11155111), deployment.address);
  assert.deepEqual(calls.sort(), ['decimals', 'symbol']);
  await assert.rejects(sharedMockUsd({ ...provider, send: async () => '0x1' }, 11155111), /Sepolia only/);
  await assert.rejects(sharedMockUsd({ ...provider, call: async ({ data }) => {
    const name = abi.parseTransaction({ data }).name;
    return abi.encodeFunctionResult(name, [name === 'decimals' ? 18 : 'mUSDC']);
  } }, 11155111), /metadata does not match/);
});
test('local chain fixtures do not load or use the shared Sepolia asset', async () => {
  assert.equal(await sharedMockUsd(null, 31337), null);
});
test('venues keep the deployed pool pair instead of reconstructing it using an older stack token', () => {
  const key = { currency0: `0x${'1'.repeat(40)}`, currency1: deployment.address, fee: 3000, tickSpacing: 60, hooks: `0x${'2'.repeat(40)}` };
  const record = { usdc: `0x${'3'.repeat(40)}`, rwa: { poolKey: key, hook: key.hooks, asset: deployment.address } };
  assert.deepEqual(VenueService.prototype.poolKey.call({ record }, true), key);
  assert.equal(VenueService.prototype.poolKey.call({ record }, false).hooks, `0x${'0'.repeat(40)}`);
  assert.equal(record.usdc, `0x${'3'.repeat(40)}`, 'historical credit markets keep their existing asset');
});
