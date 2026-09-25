import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { deployStack } from '../../src/deploy.js';

test('the two-act stack deploys on a local chain with both policies bound', { timeout: 300_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const { record, contracts, policies } = await deployStack(new Wallet(DEV_KEY, provider));
  assert.equal(record.chainId, 31337);
  assert.equal(await contracts.token.policyHash(), policies.rwa.hash);
  assert.equal(await contracts.hook.policyHash(), policies.rwa.hash);
  assert.equal(await contracts.roleProvider.policyHash(), policies.credit.hash);
  assert.equal(await contracts.swapRouter.policyHash(), policies.credit.hash);
  assert.notEqual(policies.rwa.hash, policies.credit.hash);
  assert.equal(await contracts.token.venueHook(), record.rwa.hook);
  assert.equal(await contracts.market.venues(record.credit.router), true);
});
