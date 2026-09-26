import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, keccak256 } from 'ethers';
import { seedInput, seedDeployment } from '../src/onchain/liquidity.js';
import { UNISWAP } from '../src/onchain/uniswap-config.js';
import { Agreements } from '../src/agreements.js';
const shared = JSON.parse(readFileSync('deployments/sepolia-mockusd.json'));
const token = `0x${'1'.repeat(40)}`, hook = `0x${'2'.repeat(40)}`, router = `0x${'3'.repeat(40)}`;
const poolKey = { currency0: token, currency1: shared.address, fee: 3000, tickSpacing: 60, hooks: hook };
const poolId = keccak256(AbiCoder.defaultAbiCoder().encode(['tuple(address,address,uint24,int24,address)'], [[token, shared.address, 3000, 60, hook]]));
const record = () => ({ id: 'agr_seed', status: 'deployed', policyHash: 'hash', deployment: { policyHash: 'hash', token, asset: shared.address, hook, router, poolManager: UNISWAP.poolManager, routing: 'uniswap-api', router: UNISWAP.router, positionManager: UNISWAP.positionManager, poolKey, poolId, chainId: 11155111 } });
const input = { requestId: 'seed-request-00000001', rwaAmount: '100', usdAmount: '200' };
test('seeding rejects deprecated pools, stale policies and mismatched pool IDs', () => {
  assert.equal(seedDeployment(record()).poolId, poolId);
  const legacy = record(); legacy.deployment.asset = router;
  assert.throws(() => seedDeployment(legacy), { code: 'LEGACY_POOL_ASSET' });
  const stale = record(); stale.policyHash = 'different';
  assert.throws(() => seedDeployment(stale), { code: 'NO_POOL' });
  const wrong = record(); wrong.deployment.poolId = `0x${'0'.repeat(64)}`;
  assert.throws(() => seedDeployment(wrong), { code: 'POOL_MISMATCH' });
});
test('seed budgets require positive six-decimal amounts', () => {
  assert.deepEqual(seedInput(input), input);
  for (const amount of ['0', '-1', '1e6', '1.1234567', '9'.repeat(80)]) assert.throws(() => seedInput({ ...input, rwaAmount: amount }));

});
test('seed API jobs serialize with mint jobs, bind budgets and reuse confirmed requests', async () => {
  let count = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const agreements = new Agreements({ seeder: { seed: async () => { count++; await pending; return { status: 'confirmed' }; } }, minter: async () => ({ status: 'confirmed' }) });
  agreements.records.set('agr_seed', record());
  const [a, b] = await Promise.all([agreements.seed('agr_seed', input), agreements.seed('agr_seed', input)]);
  assert.equal(a.requestId, b.requestId);
  await assert.rejects(agreements.seed('agr_seed', { ...input, usdAmount: '500' }), { code: 'SEED_CONFLICT' });
  await assert.rejects(agreements.mint('agr_seed', { recipient: token, amount: '1', requestId: 'mint-while-seeding-1' }), { code: 'BUSY' });
  release(); await agreements.settled();
  assert.equal((await agreements.seed('agr_seed', input)).status, 'confirmed');
  assert.equal(count, 1);
});

test('seed endpoints reject viewers for writes and expose operation status', async t => {
  const { createApp } = await import('../src/routes.js');
  const { once } = await import('node:events');
  const agreements = new Agreements({ seeder: { state: async () => ({ liquidity: '0' }), seed: async () => ({ status: 'confirmed', seedTxHash: '0xseed' }) } });
  agreements.records.set('agr_seed', record());
  const operator = 'pool-test-operator-key-long-enough';
  const viewer = 'pool-test-viewer-key-long-enough';
  const server = createApp(null, operator, null, null, viewer, agreements).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/agreements/agr_seed/liquidity`;
  const post = key => fetch(`${url}/seeds`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await post(viewer)).status, 401);
  assert.equal((await post(operator)).status, 202);
  await agreements.settled();
  const result = await fetch(`${url}/seeds/${input.requestId}`, { headers: { authorization: `Bearer ${viewer}` } });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).seedTxHash, '0xseed');
});
