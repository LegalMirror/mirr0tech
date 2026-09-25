import test from 'node:test';
import assert from 'node:assert/strict';
import { syncDeployment, deploymentContracts } from '../src/multibaas.js';

const record = {
  chainId: 11155111, attestor: '0x' + '11'.repeat(20), sanctions: '0x' + '22'.repeat(20), usdc: '0x' + '33'.repeat(20),
  rwa: { oracle: '0x' + '44'.repeat(20), token: '0x' + '55'.repeat(20), hook: '0x' + '66'.repeat(20), router: '0x' + '77'.repeat(20), poolManager: '0x' + '88'.repeat(20) },
  credit: { oracle: '0x' + '99'.repeat(20), roleProvider: '0x' + 'aa'.repeat(20), market: '0x' + 'bb'.repeat(20), aqua: '0x' + 'cc'.repeat(20), router: '0x' + 'dd'.repeat(20) },
};

test('every deployed contract is registered, aliased and linked with its ABI and policy version', async () => {
  const calls = { contracts: [], addresses: [], links: [] };
  const client = {
    contracts: {
      createContract: async (label, body) => { calls.contracts.push([label, body]); return { data: { status: 201 } }; },
      linkAddressContract: async (alias, body) => { calls.links.push([alias, body]); return { data: { status: 201 } }; },
    },
    addresses: { setAddress: async (body) => { calls.addresses.push(body); return { data: { status: 201 } }; } },
  };
  const results = await syncDeployment(record, { client });
  const expected = await deploymentContracts(record);
  assert.equal(results.length, expected.length);
  assert.ok(results.every((r) => r.created && r.aliased && r.linked));
  const attestor = calls.contracts.find(([label]) => label === 'mirr0tech_policy_attestor');
  assert.ok(attestor && JSON.parse(attestor[1].rawAbi).some((item) => item.name === 'Attested'));
  const hook = calls.contracts.find(([label]) => label === 'mirr0tech_mirror_policy_hook');
  assert.match(hook[1].version, /^policy-[0-9a-f]{8}$/);
  assert.deepEqual(calls.addresses.find((a) => a.alias === 'swapvm_router'), { alias: 'swapvm_router', address: record.credit.router });
  assert.equal(calls.links.find(([alias]) => alias === 'role_provider')[1].label, 'mirr0tech_mirrortech_role_provider');
});

test('an already registered contract is tolerated, anything else is surfaced', async () => {
  const conflict = { response: { status: 409, data: { message: 'contract already exists' } } };
  const client = {
    contracts: { createContract: async () => { throw conflict; }, linkAddressContract: async () => ({ data: {} }) },
    addresses: { setAddress: async () => ({ data: {} }) },
  };
  const results = await syncDeployment(record, { client });
  assert.ok(results.every((r) => !r.created && r.linked));
  const broken = { ...client, addresses: { setAddress: async () => { throw { response: { status: 401, data: { message: 'invalid api key' } } }; } } };
  await assert.rejects(syncDeployment(record, { client: broken }), /MultiBaas: invalid api key/);
});
