import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SigningSettings } from '../src/signing.js';
import { MultiBaasSigner } from '../src/multibaas-signer.js';
import { createApp } from '../src/app.js';

const FILE = '0x1111111111111111111111111111111111111111';
const VAULT = '0x2222222222222222222222222222222222222222';
const fileSigner = { getAddress: async () => FILE };
function fakeVenues(extra = {}) {
  const venues = { ...extra, signer: fileSigner, provider: { getBalance: async () => 10n ** 18n }, handovers: [], useSigner: async (signer) => { venues.signer = signer; }, handover: async (address, options) => { venues.handovers.push({ address, options }); return { 'attestor.ATTESTOR_ROLE': '0xa' }; } };
  return venues;
}
function fakeMultibaas(wallets = [{ publicAddress: VAULT, keyName: 'operator', vaultName: 'kv' }]) {
  const calls = [];
  return { calls, hsm: {
    listHsm: async () => ({ data: { result: [{ configuration: { id: 1, label: 'acme' }, wallets }] } }),
    listHsmWallets: async () => ({ data: { result: wallets } }),
    addHsmConfig: async (body) => { calls.push(['config', body]); return { data: { status: 200 } }; },
    createHsmKey: async (body) => { calls.push(['create', body]); return { data: { result: { publicAddress: VAULT, keyName: body.keyName } } }; },
    addHsmKey: async (body) => { calls.push(['add', body]); return { data: { status: 200 } }; },
  } };
}
const azure = { label: 'acme', clientID: 'app', clientSecret: 's3', tenantID: 't', subscriptionID: 'sub', baseGroupName: 'rg' };

test('the issuer moves signing into the vault: account, key, wallet, handover, and the choice persists', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'signing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'signing.json');
  const venues = fakeVenues();
  const multibaas = fakeMultibaas();
  const agreements = { venues: new Map([['agr_1', {}]]), list: () => [{ deployment: { token: '0x3333333333333333333333333333333333333333' } }, { deployment: null }] };
  const settings = await new SigningSettings({ venues, fileSigner, multibaas, agreements, path }).init();
  const before = await settings.describe();
  assert.equal(before.provider, 'key');
  assert.equal(before.address, FILE);
  assert.equal(before.balance, '1.0');
  assert.deepEqual(before.hsm.wallets, [{ address: VAULT, keyName: 'operator', vaultName: 'kv' }]);

  const after = await settings.configure({ provider: 'multibaas', azure, key: { clientID: 'app', keyName: 'operator', vaultName: 'kv', create: true }, gas: '0.05' });
  assert.equal(after.provider, 'multibaas');
  assert.equal(after.address, VAULT);
  assert.ok(venues.signer instanceof MultiBaasSigner);
  assert.deepEqual(multibaas.calls.map(([kind]) => kind), ['config', 'create']);
  assert.deepEqual(multibaas.calls[1][1], { clientID: 'app', keyName: 'operator', vaultName: 'kv', useHardwareModule: true });
  assert.deepEqual(venues.handovers[0], { address: VAULT, options: { gas: '0.05', tokens: ['0x3333333333333333333333333333333333333333'] } });
  assert.deepEqual(after.steps.handover, { 'attestor.ATTESTOR_ROLE': '0xa' });
  assert.equal(agreements.venues.size, 0, 'per-agreement venues rebind on the next call');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { provider: 'multibaas', wallet: { address: VAULT, keyName: 'operator', vaultName: 'kv' } });

  const restarted = fakeVenues();
  const reloaded = await new SigningSettings({ venues: restarted, fileSigner, multibaas, path }).init();
  assert.equal(reloaded.provider, 'multibaas');
  assert.ok(restarted.signer instanceof MultiBaasSigner);
  assert.equal(await restarted.signer.getAddress(), VAULT);

  const back = await reloaded.configure({ provider: 'key' });
  assert.equal(back.provider, 'key');
  assert.equal(restarted.signer, fileSigner);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { provider: 'key', wallet: null });
});

test('what cannot be done is said: no MultiBaas, no wallet, bad bodies, an existing key needs its version', async () => {
  const settings = new SigningSettings({ venues: fakeVenues(), fileSigner });
  await assert.rejects(settings.configure({ provider: 'ledger' }), (error) => error.code === 'INVALID_BODY');
  await assert.rejects(settings.configure({ provider: 'multibaas' }), (error) => error.code === 'NO_MULTIBAAS');
  assert.equal((await settings.describe()).hsm, null);
  const empty = new SigningSettings({ venues: fakeVenues(), fileSigner, multibaas: fakeMultibaas([]) });
  await assert.rejects(empty.configure({ provider: 'multibaas' }), (error) => error.code === 'NO_HSM_WALLET');
  const some = new SigningSettings({ venues: fakeVenues(), fileSigner, multibaas: fakeMultibaas() });
  await assert.rejects(some.configure({ provider: 'multibaas', azure: { label: 'x' } }), /azure needs/);
  await assert.rejects(some.configure({ provider: 'multibaas', key: { clientID: 'app', keyName: 'k', vaultName: 'v' } }), /keyVersion/);
  await assert.rejects(some.configure({ provider: 'multibaas', gas: 'lots' }), /gas is an ETH amount/);
  await assert.rejects(some.configure({ provider: 'multibaas', wallet: '0x9999999999999999999999999999999999999999' }), (error) => error.code === 'NO_HSM_WALLET');
  const refusing = new SigningSettings({ venues: fakeVenues(), fileSigner, multibaas: { hsm: { ...fakeMultibaas().hsm, addHsmConfig: async () => { const error = new Error('bad'); error.response = { status: 400, data: { message: 'tenant not found' } }; throw error; } } } });
  await assert.rejects(refusing.configure({ provider: 'multibaas', azure }), (error) => error.code === 'MULTIBAAS' && /tenant not found/.test(error.message));
  const existing = new SigningSettings({ venues: fakeVenues(), fileSigner, multibaas: { hsm: { ...fakeMultibaas().hsm, addHsmConfig: async () => { const error = new Error('dup'); error.response = { status: 409, data: { message: 'already exists' } }; throw error; } } } });
  assert.equal((await existing.configure({ provider: 'multibaas', azure, key: { clientID: 'app', keyName: 'k', vaultName: 'v', keyVersion: '1' } })).steps.config.skipped, 'already exists');
});

test('PUT /v1/settings/signing needs the operator key; GET shows a viewer who signs', async (t) => {
  const settings = new SigningSettings({ venues: fakeVenues({ record: { chainId: 31337, rwa: {}, credit: {} } }), fileSigner, multibaas: fakeMultibaas() });
  const key = 'a-test-operator-key-at-least-24-characters';
  const viewer = 'a-test-viewer-key-at-least-24-characters!';
  const server = createApp(null, key, settings.venues, null, viewer, null, { signing: settings }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/v1/settings/signing`;
  const call = (token, method = 'GET', body) => fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  assert.equal((await call(viewer)).data.provider, 'key');
  assert.equal((await call(viewer, 'PUT', { provider: 'multibaas' })).status, 401);
  assert.equal((await call(key, 'PUT', [])).data.error.code, 'INVALID_BODY');
  const switched = await call(key, 'PUT', { provider: 'multibaas', gas: '0.01' });
  assert.equal(switched.status, 200, JSON.stringify(switched.data));
  assert.equal(switched.data.address, VAULT);
});
