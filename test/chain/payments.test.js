import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Wallet } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { deployStack } from '../../src/deploy.js';
import { VenueService } from '../../src/venues.js';
import { createApp } from '../../src/app.js';
import { mockProof } from '../../src/worldid.js';
import { sign, SIGNATURE_HEADER } from '../../src/payments.js';
import { auditEvents } from '../../src/audit-events.js';

const SECRET = 'whsec_chain_test';
const event = (id, wallet, cents) => JSON.stringify({ id, type: 'payment_intent.succeeded', data: { object: { id: `pi_${id}`, amount: cents, currency: 'usd', metadata: { wallet } } } });

test('a signed payment settles into shares under the policy, or is held with the sentence that held it', { timeout: 300_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const signer = new Wallet(DEV_KEY, provider);
  const { record } = await deployStack(signer);
  const venues = await new VenueService({ provider, signer, record }).init();
  const apiKey = 'test-stack-operator-key-only-24';
  const server = createApp(null, apiKey, venues, null, null, null, { paymentSecret: SECRET }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const pay = async (body) => {
    const response = await fetch(`${base}/webhooks/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: sign(body, SECRET) }, body });
    return { status: response.status, data: await response.json() };
  };
  const call = async (path, body) => {
    const response = await fetch(`${base}/v1/stack${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return response.json();
  };

  // A stranger wires money: the funds fact is recorded, the mint is held, nothing moves.
  const held = await pay(event('evt_stranger', 'Stranger', 5000));
  assert.equal(held.status, 200, 'the rail is answered, the policy decided');
  assert.equal(held.data.settlement.status, 'held');
  assert.ok(held.data.settlement.refusal.clause.quote, 'the sentence that held the money');
  const stranger = await call('/wallets/Stranger/explain?policy=rwa&action=mint');
  assert.equal(stranger.facts.depositConfirmed, true);
  assert.equal(stranger.allowed, false);
  assert.equal((await call('/wallets/Stranger')).balances.MIRROR, '0.0');

  // An onboarded, document-verified investor: the same event settles, and the facts already attested stay.
  await call('/wallets/Investor/facts', { policy: 'rwa', facts: { kycApproved: true, amlApproved: true, sanctionsClear: true, issuerAuthorized: true, offeringCompliant: true, subscriptionAccepted: true } });
  await call('/wallets/Investor/worldid', { proof: mockProof('Investor') });
  const settled = await pay(event('evt_investor', 'Investor', 12550));
  assert.equal(settled.data.settlement.status, 'ok', JSON.stringify(settled.data));
  assert.match(settled.data.settlement.txHash, /^0x[0-9a-f]{64}$/);
  const investor = await call('/wallets/Investor');
  assert.equal(investor.balances.MIRROR, '125.5');
  assert.equal(investor.rwa.facts.identityVerified, true, 'the funds fact was merged, not swapped in');
  assert.equal(investor.rwa.facts.depositConfirmed, true);

  // The rail retries: the same payment id settles once.
  const replay = await pay(event('evt_investor', 'Investor', 12550));
  assert.equal(replay.data.settlement.replay, true);
  assert.equal((await call('/wallets/Investor')).balances.MIRROR, '125.5');

  const events = auditEvents(venues.audit, 'rwa-secondary', 31337);
  const kinds = events.filter((entry) => entry.kind === 'PaymentSettled');
  assert.equal(kinds.length, 2);
  assert.match(kinds.find((entry) => /held/.test(entry.summary)).summary, /evt_stranger .* held/);
  assert.match(kinds.find((entry) => /settled into/.test(entry.summary)).summary, /125\.50 USD settled into 125\.50 shares/);
});
