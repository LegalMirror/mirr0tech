// The vault takes over the operator: roles and gas handed over, attestations and a deploy signed
// from it. Anvil's unlocked account stands in for the HSM: MultiBaas's submit endpoint is faked to
// hand the populated transaction to the node under that account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Contract, Wallet, ZeroHash, id, toBeHex } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { deployStack, deployFund } from '../../src/deploy.js';
import { VenueService } from '../../src/venues.js';
import { Agreements } from '../../src/agreements.js';
import { SigningSettings } from '../../src/signing.js';
import { auditEvents } from '../../src/audit-events.js';

delete process.env.NOOLOG_API_KEY;

test('signing moves into the vault: handover, then every operator transaction comes from it', { timeout: 300_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const fileSigner = new Wallet(DEV_KEY, provider);
  const { record } = await deployStack(fileSigner);
  const venues = await new VenueService({ provider, signer: fileSigner, record }).init();
  const vault = await (await provider.getSigner(9)).getAddress();
  const submitted = [];
  const multibaas = { hsm: {
    listHsm: async () => ({ data: { result: [] } }),
    listHsmWallets: async () => ({ data: { result: [{ publicAddress: vault, keyName: 'operator', vaultName: 'anvil' }] } }),
    signAndSubmitTransaction: async ({ tx }) => {
      submitted.push(tx);
      const hash = await provider.send('eth_sendTransaction', [{ from: tx.from, to: tx.to ?? undefined, value: toBeHex(BigInt(tx.value)), data: tx.data, gas: toBeHex(tx.gas), nonce: toBeHex(tx.nonce), maxFeePerGas: toBeHex(BigInt(tx.gasFeeCap)), maxPriorityFeePerGas: toBeHex(BigInt(tx.gasTipCap)) }]);
      return { data: { result: { submitted: true, tx: { ...tx, hash } } } };
    },
  } };
  const agreements = new Agreements({ deployer: ({ sources }) => deployFund(venues.signer, { record, sources }) });
  const html = await readFile('test/human_contracts/ea026411904ex10-9.htm', 'utf8');
  const { id: agreementId } = await agreements.create({ name: 'BUIDL', documents: [{ name: 'ea026411904ex10-9.htm', text: html }] });
  await agreements.settled();
  const settings = new SigningSettings({ venues, fileSigner, multibaas, agreements });

  const switched = await settings.configure({ provider: 'multibaas', gas: '1' });
  assert.equal(switched.address, vault);
  assert.ok(Object.keys(switched.steps.handover).length >= 5, 'roles granted and gas sent');
  const attestor = new Contract(record.attestor, ['function hasRole(bytes32,address) view returns (bool)'], provider);
  const token = new Contract(record.rwa.token, ['function hasRole(bytes32,address) view returns (bool)'], provider);
  assert.equal(await attestor.hasRole(id('ATTESTOR_ROLE'), vault), true);
  assert.equal(await token.hasRole(id('MINTER_ROLE'), vault), true);
  assert.equal(await token.hasRole(ZeroHash, vault), true);
  assert.equal(venues.wallets.Operator, vault);

  // An attestation and a mint now leave the vault, not the file key.
  const attested = await venues.attest('rwa', 'Investor', { kycApproved: true });
  assert.equal((await provider.getTransaction(attested.txHash)).from, vault);
  assert.equal((await venues.mint('10')).status, 'ok');
  assert.ok(submitted.length >= 2 && submitted.every((tx) => tx.from === vault && tx.type === 2));

  // A deploy signed from the vault: the new token's admin and minter is the vault.
  agreements.deploy(agreementId);
  await agreements.settled();
  const { status, deployment, error } = agreements.get(agreementId);
  assert.equal(status, 'deployed', error ?? '');
  const deployedToken = new Contract(deployment.token, ['function hasRole(bytes32,address) view returns (bool)'], provider);
  assert.equal(await deployedToken.hasRole(ZeroHash, vault), true);
  assert.equal((await provider.getTransaction(deployment.txs.token)).from, vault);

  assert.ok(auditEvents(venues.audit, 'rwa-secondary', 31337).some((event) => /operator roles handed to/.test(event.summary)));
  const back = await settings.configure({ provider: 'key' });
  assert.equal(back.address, fileSigner.address);
  assert.equal((await provider.getTransaction((await venues.attest('rwa', 'Investor', { kycApproved: true })).txHash)).from, fileSigner.address);
  // Handing over again grants nothing new.
  assert.deepEqual(await venues.handover(vault), {});
});
