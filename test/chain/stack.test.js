import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { deployStack } from '../../src/onchain/deploy.js';

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

test('on a public chain the demo wallets are derived from the operator key and funded with gas', { timeout: 300_000 }, async (t) => {
  const { VenueService } = await import('../../src/onchain/venues.js');
  const { provider } = await startAnvil(t);
  const signer = new Wallet(DEV_KEY, provider);
  const { record } = await deployStack(signer);
  const auditPath = `${await mkdtemp(join(tmpdir(), 'mirr0tech-'))}/audit.json`;
  const venues = await new VenueService({ provider, signer, record: { ...record, chainId: 11155111 }, auditPath }).init();
  const lender = venues.wallets['Lender A'];
  assert.match(lender, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(await provider.getBalance(lender), 0n);
  await venues.fund('Lender A', '1000');
  assert.equal(await provider.getBalance(lender) > 0n, true);
  await venues.attest('credit', 'Lender A', { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true });
  assert.equal((await venues.deposit('Lender A', '1000')).status, 'ok');
  assert.equal((await venues.wallet('Lender A')).balances.mDEMO, '1000.0');
  await assert.rejects(venues.signerFor('0x000000000000000000000000000000000000dEaD'), /NOT_LOCAL|derived demo wallet/);
  venues.audit.push({ type: 'probe', amount: 1n });
  await venues.persist();
  const reloaded = await new VenueService({ provider, signer, record: { ...record, chainId: 11155111 }, auditPath }).init();
  assert.deepEqual(reloaded.audit.map((entry) => entry.type), ['attest', 'credit.deposit', 'probe'], 'the audit survives a restart');
  assert.equal(reloaded.audit.at(-1).amount, '1', 'bigint results persist as strings');
  assert.equal(await (await reloaded.signerFor(lender.toLowerCase())).getAddress(), lender, 'derived wallets resolve case-insensitively');
});
