import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agreements } from '../src/agreements.js';
import { mintInput } from '../src/onchain/mint.js';

const input = { recipient: '0x8583AD4a0F59Ba45C7E201318C6F774F31f7bbC8', amount: '12.345678', requestId: 'mint-test-request-0001' };
const record = () => ({ id: 'agr_test', status: 'deployed', policyHash: 'hash', deployment: { token: 'token', chainId: 11155111, policyHash: 'hash' } });

test('mint input rejects invalid recipients, precision and amounts', () => {
  assert.equal(mintInput(input).units, '12345678');
  assert.equal(mintInput(input).simulateDeposit, false);
  assert.equal(mintInput({ ...input, simulateDeposit: true }).simulateDeposit, true);
  for (const patch of [{ amount: '0' }, { amount: '-1' }, { amount: '1.0000001' }, { amount: '1e6' }, { amount: '9'.repeat(80) }, { recipient: 'bad' }, { recipient: '0x0000000000000000000000000000000000000000' }, { requestId: 'short' }, { bypassSubscription: 'true' }, { simulateDeposit: 'true' }]) {
    assert.throws(() => mintInput({ ...input, ...patch }));
  }
});

test('mint requests reserve one job, bind request IDs and return persisted results', async () => {
  let calls = 0;
  let finish;
  const wait = new Promise((r) => { finish = r; });
  const agreements = new Agreements({ minter: async ({ progress }) => { calls++; await wait; await progress({ mintTxHash: 'hash' }); return { status: 'confirmed', stage: 'complete' }; } });
  agreements.records.set('agr_test', record());
  agreements.export = () => ({});
  const [first, second] = await Promise.all([agreements.mint('agr_test', input), agreements.mint('agr_test', input)]);
  assert.equal(first.requestId, second.requestId);
  await assert.rejects(agreements.mint('agr_test', { ...input, amount: '2' }), { code: 'MINT_CONFLICT' });
  await assert.rejects(agreements.mint('agr_test', { ...input, requestId: 'mint-test-request-0002' }), { code: 'BUSY' });
  await assert.rejects(agreements.mint('agr_test', { ...input, bypassSubscription: true }), { code: 'MINT_CONFLICT' });
  await assert.rejects(agreements.mint('agr_test', { ...input, simulateDeposit: true }), { code: 'MINT_CONFLICT' });
  await assert.rejects(agreements.mint('agr_test', { ...input, testAttestations: { identityVerified: true } }), { code: 'MINT_CONFLICT' });
  finish(); await agreements.settled();
  assert.equal((await agreements.mint('agr_test', input)).status, 'confirmed');
  assert.equal(calls, 1);
  assert.equal(agreements.mintOperation('agr_test', input.requestId).mintTxHash, 'hash');
});

test('interrupted mint is recoverable after restart with its original transaction hashes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mint-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'agreements.json');
  const before = new Agreements({ path });
  before.records.set('agr_test', { ...record(), mintOperations: [{ ...mintInput(input), status: 'pending', mintTxHash: '0xhash', token: 'token' }] });
  await before.persist();
  let seen;
  const after = await new Agreements({ path, minter: async ({ operation }) => { seen = { ...operation }; return { status: 'confirmed', stage: 'complete' }; } }).init();
  after.export = () => ({});
  assert.equal(after.mintOperation('agr_test', input.requestId).status, 'failed');
  await after.mint('agr_test', input); await after.settled();
  assert.equal(seen.mintTxHash, '0xhash');
  assert.equal((await new Agreements({ path }).init()).mintOperation('agr_test', input.requestId).status, 'confirmed');
});

test('mint HTTP submission requires operator credentials and exposes polling to viewers', async (t) => {
  const { createApp } = await import('../src/routes.js');
  const { once } = await import('node:events');
  const agreements = new Agreements({ minter: async () => ({ status: 'confirmed', stage: 'complete' }) });
  agreements.records.set('agr_test', record());
  agreements.export = () => ({});
  const operator = 'mint-test-operator-key-long-enough';
  const viewer = 'mint-test-viewer-key-long-enough';
  const server = createApp(null, operator, null, null, viewer, agreements).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/agreements/agr_test`;
  const submit = (key) => fetch(`${url}/mint`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await submit(viewer)).status, 401);
  assert.equal((await submit('')).status, 401);
  assert.equal((await submit(operator)).status, 202);
  await agreements.settled();
  const response = await fetch(`${url}/mints/${input.requestId}`, { headers: { authorization: `Bearer ${viewer}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'confirmed');
});

test('test compliance flags are allowlisted booleans, default off and forbidden on production chains', async () => {
  const { createRwaMinter, MINT_TEST_FLAGS } = await import('../src/onchain/mint.js');
  assert.ok(Object.values(mintInput(input).testAttestations).every(v => v === false));
  for (const testAttestations of [null, [], { identityVerified: 'true' }, { unknownFact: true }]) {
    assert.throws(() => mintInput({ ...input, testAttestations }), { code: 'INVALID_MINT' });
  }
  for (const {fact} of MINT_TEST_FLAGS) {
    const operation = mintInput({ ...input, testAttestations: { [fact]: true } });
    const signer = { provider: { send: async () => '0x1' } };
    await assert.rejects(createRwaMinter(signer)({ record: { deployment: { chainId: 1 } }, operation }), { code: 'TESTNET_ONLY' });
  }
});
