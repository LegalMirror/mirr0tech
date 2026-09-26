import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory, Interface } from 'ethers';
import { MultiBaasSigner, cloudWallet } from '../src/multibaas-signer.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;
// The node as the signer sees it: fees, nonce, gas, and the transaction once MultiBaas has broadcast it.
function fakeProvider(seen) {
  let broadcast = false;
  return {
    provider: {
      getNetwork: async () => ({ chainId: 11155111n }),
      getFeeData: async () => ({ maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, gasPrice: 20n }),
      getTransactionCount: async () => 7,
      estimateGas: async () => 21_000n,
      getTransaction: async (hash) => { seen.push(hash); return broadcast ? { hash, from: WALLET, nonce: 7, wait: async () => ({ status: 1, hash }) } : null; },
      resolveName: async (name) => name,
    },
    broadcast: () => { broadcast = true; },
  };
}

test('the vault signs what the gateway populated; the response is the node\'s view of the transaction', async () => {
  const requests = [];
  const seen = [];
  const { provider, broadcast } = fakeProvider(seen);
  const client = { hsm: { signAndSubmitTransaction: async (request) => { requests.push(request); setTimeout(broadcast, 5); return { data: { result: { submitted: true, tx: { ...request.tx, hash: HASH } } } }; } } };
  const signer = new MultiBaasSigner(client, WALLET.toLowerCase(), provider, { pollMs: 1 });
  assert.equal(await signer.getAddress(), WALLET);
  const response = await signer.sendTransaction({ to: '0x2222222222222222222222222222222222222222', data: '0xdead', value: 5n });
  assert.equal(response.hash, HASH);
  assert.deepEqual(requests[0], { tx: { from: WALLET, to: '0x2222222222222222222222222222222222222222', value: '5', data: '0xdead', gas: 21000, nonce: 7, gasFeeCap: '30', gasTipCap: '2', type: 2 } });
  assert.ok(seen.length >= 2, 'polled until the node saw it');
  assert.throws(() => signer.signTransaction(), /inside the HSM/);
  assert.throws(() => signer.signMessage(), /messages/);
  assert.equal((await signer.connect(provider).getAddress()), WALLET);

  // A contract deployment is a transaction without a recipient.
  const factory = new ContractFactory(new Interface(['constructor(address a)']), '0x6080', signer);
  const contract = await factory.deploy(WALLET);
  assert.equal(requests[1].tx.to, null);
  assert.equal(contract.deploymentTransaction().hash, HASH);
});

test('a refused or unseen submission is an error, not a silent hash', async () => {
  const { provider } = fakeProvider([]);
  const refused = new MultiBaasSigner({ hsm: { signAndSubmitTransaction: async () => ({ data: { message: 'wallet locked', result: { submitted: false, tx: {} } } }) } }, WALLET, provider);
  await assert.rejects(refused.sendTransaction({ to: WALLET }), /did not submit.*wallet locked/);
  const lost = new MultiBaasSigner({ hsm: { signAndSubmitTransaction: async () => ({ data: { result: { submitted: true, tx: { hash: HASH } } } }) } }, WALLET, provider, { pollMs: 1, attempts: 3 });
  await assert.rejects(lost.sendTransaction({ to: WALLET }), /has not seen it/);
});

test('the gateway picks its Cloud Wallet by address, or the only one there is', async () => {
  const one = { hsm: { listHsmWallets: async () => ({ data: { result: [{ publicAddress: WALLET, keyName: 'operator' }] } }) } };
  assert.equal((await cloudWallet(one, undefined)).keyName, 'operator');
  assert.equal((await cloudWallet(one, WALLET.toLowerCase())).keyName, 'operator');
  await assert.rejects(cloudWallet(one, '0x3333333333333333333333333333333333333333'), /no HSM wallet/);
  const none = { hsm: { listHsmWallets: async () => ({ data: { result: [] } }) } };
  await assert.rejects(cloudWallet(none, undefined), /no HSM wallets yet/);
  const two = { hsm: { listHsmWallets: async () => ({ data: { result: [{ publicAddress: WALLET }, { publicAddress: '0x3333333333333333333333333333333333333333' }] } }) } };
  await assert.rejects(cloudWallet(two, undefined), /Set MULTIBAAS_WALLET to one of/);
});
