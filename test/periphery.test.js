import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder } from 'ethers';
import { ACTIONS, mintPositionCall, swapExactInSingleCall } from '../src/onchain/periphery.js';

const coder = AbiCoder.defaultAbiCoder();
const KEY = { currency0: '0x14aC14640B13dCeE6864f786e23821248a408091', currency1: '0xfa6738D1b4Cd4Cd212909B5c5C555F464219f0AB', fee: 3000, tickSpacing: 60, hooks: '0x923c2a1FCbDCb0c7dB7C06A2E654aDe0CE06ca80' };
const POOL_KEY = 'tuple(address,address,uint24,int24,address)';

test('a position is minted through PositionManager.modifyLiquidities: MINT_POSITION then SETTLE_PAIR', () => {
  const call = mintPositionCall({ key: KEY, tickLower: -60, tickUpper: 60, liquidity: 10n ** 12n, amount0Max: 5n, amount1Max: 6n, owner: '0x55da01025ea2F709f746eA32dB8444596B0d78EC', deadline: 99n });
  assert.equal(call.slice(0, 10), '0xdd46508f', 'modifyLiquidities(bytes,uint256)');
  const [unlockData, deadline] = coder.decode(['bytes', 'uint256'], `0x${call.slice(10)}`);
  assert.equal(deadline, 99n);
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], unlockData);
  assert.equal(actions, `0x${ACTIONS.MINT_POSITION}${ACTIONS.SETTLE_PAIR}`);
  const mint = coder.decode([POOL_KEY, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'], params[0]);
  assert.equal(mint[0][4], KEY.hooks);
  assert.deepEqual([mint[1], mint[2], mint[3], mint[4], mint[5]], [-60n, 60n, 10n ** 12n, 5n, 6n]);
  assert.deepEqual(coder.decode(['address', 'address'], params[1]).map(String), [KEY.currency0, KEY.currency1]);
});

test('a swap goes through UniversalRouter.execute: V4_SWAP of SWAP_EXACT_IN_SINGLE, SETTLE_ALL the input, TAKE_ALL the output', () => {
  const call = swapExactInSingleCall({ key: KEY, zeroForOne: true, amountIn: 1_000_000n, amountOutMinimum: 0n, deadline: 7n });
  assert.equal(call.slice(0, 10), '0x3593564c', 'execute(bytes,bytes[],uint256)');
  const [commands, inputs, deadline] = coder.decode(['bytes', 'bytes[]', 'uint256'], `0x${call.slice(10)}`);
  assert.equal(commands, '0x10', 'V4_SWAP');
  assert.equal(deadline, 7n);
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  assert.equal(actions, `0x${ACTIONS.SWAP_EXACT_IN_SINGLE}${ACTIONS.SETTLE_ALL}${ACTIONS.TAKE_ALL}`);
  const [swap] = coder.decode([`tuple(${POOL_KEY},bool,uint128,uint128,uint256,bytes)`], params[0]);
  assert.deepEqual([swap[1], swap[2], swap[3], swap[4]], [true, 1_000_000n, 0n, 0n], 'Universal Router 2.1 reads minHopPriceX36 before hookData');
  assert.deepEqual(coder.decode(['address', 'uint256'], params[1]).map(String), [KEY.currency0, '1000000'], 'pays currency0 in');
  assert.deepEqual(coder.decode(['address', 'uint256'], params[2]).map(String), [KEY.currency1, '0'], 'takes currency1 out');
  const back = swapExactInSingleCall({ key: KEY, zeroForOne: false, amountIn: 5n, amountOutMinimum: 1n, deadline: 7n });
  const [, backInputs] = coder.decode(['bytes', 'bytes[]', 'uint256'], `0x${back.slice(10)}`);
  const [, backParams] = coder.decode(['bytes', 'bytes[]'], backInputs[0]);
  assert.equal(String(coder.decode(['address', 'uint256'], backParams[1])[0]), KEY.currency1, 'oneForZero pays currency1');
});
