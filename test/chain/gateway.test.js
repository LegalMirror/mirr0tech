import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Wallet } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { deployStack } from '../../src/deploy.js';
import { VenueService } from '../../src/venues.js';
import { createApp } from '../../src/app.js';

test('the stack API drives both acts over REST', { timeout: 300_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const signer = new Wallet(DEV_KEY, provider);
  const { record } = await deployStack(signer);
  const venues = await new VenueService({ provider, signer, record }).init();
  const apiKey = 'test-stack-operator-key-only-24';
  const server = createApp(null, apiKey, venues).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/stack`;
  const call = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(url + path, { method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };

  const overview = await call('/');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.policies.rwa.policyHash, record.rwa.policyHash);
  assert.ok(overview.data.wallets['Lender A']);

  // Act 1
  assert.equal((await call('/rwa/mint', { amount: '1000000' })).status, 200);
  const refused = await call('/rwa/release', { wallet: 'Stranger', amount: '10' });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error.code, 'POLICY_REFUSED');
  assert.ok(refused.data.error.details.refusal.clause.quote);
  assert.equal((await call('/wallets/Investor/facts', { policy: 'rwa', facts: { kycApproved: true, amlApproved: true } })).status, 200);
  assert.equal((await call('/rwa/release', { wallet: 'Investor', amount: '500000' })).status, 200);
  for (const wallet of ['Investor', 'Stranger']) assert.equal((await call(`/wallets/${encodeURIComponent(wallet)}/fund`, { amount: '1000000' })).status, 200);
  assert.equal((await call('/rwa/pools', { wallet: 'Stranger', hooked: true })).status, 200);
  assert.equal((await call('/rwa/pools', { wallet: 'Stranger', hooked: false })).status, 200);
  const noDoor = await call('/rwa/liquidity', { wallet: 'Investor', hooked: false });
  assert.equal(noDoor.status, 403);
  assert.equal(noDoor.data.error.details.refusal.name, 'NoPolicyDoor');
  assert.equal((await call('/rwa/liquidity', { wallet: 'Investor', hooked: true })).status, 200);
  const stranger = await call('/rwa/liquidity', { wallet: 'Stranger', hooked: true });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.data.error.details.refusal.clause.clause, 'Exhibit A — Investor Onboarding');

  // Act 2
  const admitted = { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true };
  for (const wallet of ['Lender A', 'Operator']) {
    assert.equal((await call(`/wallets/${encodeURIComponent(wallet)}/facts`, { policy: 'credit', facts: admitted })).status, 200);
    assert.equal((await call(`/wallets/${encodeURIComponent(wallet)}/fund`, { amount: '3000000' })).status, 200);
  }
  assert.equal((await call('/credit/deposit', { wallet: 'Lender A', amount: '1000000' })).status, 200);
  const explain = await call('/wallets/Lender%20B/explain?policy=credit&action=deposit');
  assert.equal(explain.data.allowed, false);
  assert.ok(explain.data.clause);
  const shipped = await call('/credit/buyback', {});
  assert.equal(shipped.status, 200);
  assert.equal(shipped.data.instructions.length, 5);
  assert.equal(shipped.data.instructions[1].name, 'Mirrortech._policyGuard');
  const quote = await call('/credit/buyback/quote', { wallet: 'Lender A', amount: '100000' });
  assert.equal(quote.status, 200);
  assert.equal(quote.data.amountOut, '96000.0');
  assert.equal((await call('/credit/buyback/fill', { wallet: 'Lender A', amount: '100000' })).status, 200);
  const strangerQuote = await call('/credit/buyback/quote', { wallet: 'Stranger', amount: '10' });
  assert.equal(strangerQuote.status, 403);
  assert.equal(strangerQuote.data.error.details.refusal.name, 'CounterpartyRefused');
  assert.equal((await call('/wallets/Lender%20A/sanction', { sanctioned: true })).status, 200);
  assert.equal((await call('/credit/buyback/quote', { wallet: 'Lender A', amount: '10' })).status, 403);
  const payment = await call('/wallets/Lender%20A/explain?policy=credit&action=withdraw');
  assert.equal(payment.data.allowed, false);
  assert.equal((await call('/wallets/Lender%20A/override', {})).status, 200);
  assert.equal((await call('/wallets/Lender%20A/explain?policy=credit&action=withdraw')).data.allowed, true);
  assert.equal((await call('/credit/buyback/dock', {})).status, 200);
  const audit = await call('/audit');
  assert.ok(audit.data.length > 15);
  assert.ok(audit.data.some((entry) => entry.status === 'refused' && entry.refusal?.clause));
});
