import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory, parseUnits } from 'ethers';
import { compileBundle } from '../../src/onchain/solc.js';
import { startAnvil } from './anvil.js';

test('mUSDC has six decimals and anyone can mint repeatedly to any wallet without a cap', { timeout: 60000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const { MockUSD } = await compileBundle('core', [['contracts/test/MockUSD.sol', 'MockUSD']]);
  const deployer = await provider.getSigner(0);
  const stranger = await provider.getSigner(1);
  const recipient = await (await provider.getSigner(2)).getAddress();
  const token = await new ContractFactory(MockUSD.abi, MockUSD.bytecode, deployer).deploy();
  await token.waitForDeployment();
  assert.equal(await token.symbol(), 'mUSDC');
  assert.equal(await token.decimals(), 6n);
  const amount = parseUnits('1000000000000', 6);
  await (await token.connect(stranger).mint(recipient, amount)).wait();
  await (await token.connect(stranger).mint(recipient, amount)).wait();
  assert.equal(await token.balanceOf(recipient), amount * 2n);
  assert.equal(await token.totalSupply(), amount * 2n);
});
