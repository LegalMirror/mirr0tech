import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Contract, Wallet } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { deployStack, deployFund } from '../../src/deploy.js';
import { Agreements } from '../../src/agreements.js';
import { MIRROR_HOOK_FLAGS, ALL_HOOK_MASK } from '../../src/policy/hookAddress.js';

delete process.env.NOOLOG_API_KEY;

test('an uploaded agreement deploys its own token, oracle, hook and policy-managed pool on the running stack', { timeout: 300_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const signer = new Wallet(DEV_KEY, provider);
  const { record } = await deployStack(signer);
  const agreements = new Agreements({ deployer: ({ sources }) => deployFund(signer, { record, sources }) });
  const html = await readFile('test/human_contracts/ea026411904ex10-9.htm', 'utf8');
  const { id } = await agreements.create({ name: 'BUIDL', documents: [{ name: 'ea026411904ex10-9.htm', text: html }] });
  await agreements.settled();
  assert.equal(agreements.get(id).status, 'compiled', agreements.get(id).error ?? '');
  agreements.deploy(id);
  await agreements.settled();
  const { status, error, deployment, policyHash } = agreements.get(id);
  assert.equal(status, 'deployed', error ?? '');

  // The token carries this agreement's hash, not the stack's; the hook sits at a flag-bearing address on the shared PoolManager.
  assert.equal(deployment.policyHash, policyHash);
  assert.notEqual(deployment.token, record.rwa.token);
  const token = new Contract(deployment.token, ['function policyHash() view returns (bytes32)', 'function hook() view returns (address)'], provider);
  assert.equal(await token.policyHash(), policyHash);
  assert.equal((BigInt(deployment.hook) & ALL_HOOK_MASK), MIRROR_HOOK_FLAGS);
  assert.equal(deployment.poolManager, record.rwa.poolManager);
  for (const address of [deployment.token, deployment.oracle, deployment.hook]) assert.notEqual(await provider.getCode(address), '0x');
  assert.deepEqual(Object.keys(deployment.txs), ['oracle', 'token', 'hook', 'configure', 'pool']);
  for (const hash of Object.values(deployment.txs)) assert.equal((await provider.getTransactionReceipt(hash)).status, 1);
  const poolManager = new Contract(record.rwa.poolManager, ['function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24)'], signer);
  await assert.rejects(poolManager.initialize.staticCall([deployment.poolKey.currency0, deployment.poolKey.currency1, 3000, 60, deployment.hook], 79228162514264337593543950336n), 'the pool exists');
});
