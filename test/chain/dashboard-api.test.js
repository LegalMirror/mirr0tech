import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Wallet } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { deployStack } from '../../src/deploy.js';
import { VenueService } from '../../src/venues.js';
import { loadPolicyData } from '../../src/dashboard-api.js';
import { createApp } from '../../src/app.js';

test('the dashboard adapter routes are served live from the stack', { timeout: 300_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const signer = new Wallet(DEV_KEY, provider);
  const { record } = await deployStack(signer);
  const venues = await new VenueService({ provider, signer, record }).init();
  const apiKey = 'test-stack-operator-key-only-24';
  const server = createApp(null, apiKey, venues, loadPolicyData()).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };

  const profiles = await call('/policy/profiles');
  assert.equal(profiles.status, 200);
  assert.deepEqual(profiles.data.map((p) => p.profile), ['custodial-rwa', 'rwa-secondary', 'wildcat-credit']);
  const credit = await call('/policy?profile=wildcat-credit');
  assert.equal(credit.data.policyHash, record.credit.policyHash, 'what the browser renders is what the chain enforces');
  assert.equal(credit.data.rules.length, 14);
  const rwa = await call('/policy?profile=rwa-secondary');
  assert.equal(rwa.data.policyHash, record.rwa.policyHash);

  let parties = (await call('/lenders?profile=wildcat-credit')).data;
  assert.deepEqual(parties.map((p) => p.id), ['lender-a', 'lender-b', 'lender-c', 'stranger', 'operator']);
  const before = parties.find((p) => p.id === 'lender-a');
  assert.equal(before.screenedAt, null);
  assert.equal(before.facts.sanctionsClear, true, 'observable facts are live');

  const attested = await call('/lenders/lender-a/attestations?profile=wildcat-credit', 'PATCH', { facts: { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true } });
  assert.equal(attested.status, 200);
  assert.ok(attested.data.screenedAt > 0);
  assert.equal(attested.data.facts.screeningCurrent, true);
  assert.equal(attested.data.decision.allowed, true);

  const partial = await call('/lenders/lender-b/attestations?profile=wildcat-credit', 'PATCH', { facts: { lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true } });
  assert.equal(partial.data.facts.mlaCountersigned, null);
  assert.equal(partial.data.decision.allowed, false);
  assert.equal(partial.data.decision.clause.clause, 'Lender Check Policy 2.1');

  const approved = await call('/lenders/lender-a/approve?profile=wildcat-credit', 'POST');
  assert.equal(approved.data.resolution, 'approved');
  const revoked = await call('/lenders/lender-a/revoke?profile=wildcat-credit', 'POST');
  assert.equal(revoked.data.screenedAt, null, 'revoking clears every attested fact');
  assert.equal(revoked.data.resolution, undefined);

  const audit = await call('/audit?profile=wildcat-credit');
  assert.ok(audit.data.some((event) => event.kind === 'Attested' && event.subject === 'Lender A'));
  assert.ok(audit.data.some((event) => event.kind === 'Revoked'));
  assert.ok(audit.data[0].at >= audit.data.at(-1).at, 'newest first');
  const signed = audit.data.find((event) => event.txHash);
  assert.equal(signed.explorer, null, 'no explorer on a local chain');
  venues.record.chainId = 11155111;
  const sepolia = (await call('/audit?profile=wildcat-credit')).data.find((event) => event.id === signed.id);
  assert.equal(sepolia.explorer, `https://sepolia.etherscan.io/tx/${signed.txHash}`);
  venues.record.chainId = 31337;
});
