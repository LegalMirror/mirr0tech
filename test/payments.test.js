import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { paymentFrom, sign, verifySignature, SIGNATURE_HEADER } from '../src/payments.js';

const SECRET = 'whsec_test_secret';
const event = (overrides = {}) => ({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 12550, currency: 'usd', metadata: { wallet: 'Investor' }, ...overrides } } });

test('the signature scheme is Stripe\'s: timestamped HMAC over the raw body, within tolerance', () => {
  const body = JSON.stringify(event());
  const header = sign(body, SECRET, 1_700_000_000);
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.doesNotThrow(() => verifySignature(body, header, SECRET, { now: 1_700_000_100 }));
  assert.throws(() => verifySignature(body, header, 'other', { now: 1_700_000_100 }), (e) => e.code === 'INVALID_SIGNATURE' && /match/.test(e.message));
  assert.throws(() => verifySignature(body, header, SECRET, { now: 1_700_000_400 }), /tolerance/);
  assert.throws(() => verifySignature(`${body} `, header, SECRET, { now: 1_700_000_100 }), /match/);
  assert.throws(() => verifySignature(body, 'nonsense', SECRET), /malformed/);
  assert.throws(() => verifySignature(body, undefined, SECRET), /malformed/);
});

test('a settled USD payment becomes a decimal amount for a wallet; anything else is ignored or refused', () => {
  assert.deepEqual(paymentFrom(event()), { id: 'evt_1', wallet: 'Investor', amount: '125.50', currency: 'usd', reference: 'pi_1' });
  assert.deepEqual(paymentFrom({ type: 'customer.created' }), { ignored: 'customer.created' });
  assert.deepEqual(paymentFrom(null), { ignored: 'unknown' });
  assert.throws(() => paymentFrom(event({ amount: 0 })), /positive integer/);
  assert.throws(() => paymentFrom(event({ amount: 10.5 })), /positive integer/);
  assert.throws(() => paymentFrom(event({ currency: 'eur' })), /USD/);
  assert.throws(() => paymentFrom(event({ metadata: {} })), /metadata\.wallet/);
});

test('POST /webhooks/payments: the signature is the credential, the rail always gets a 2xx once verified', async (t) => {
  const settled = [];
  const venues = { record: { chainId: 31337, rwa: {}, credit: {} }, settlePayment: async (payment) => { settled.push(payment); return { status: 'ok', paymentId: payment.id }; } };
  const key = 'a-test-operator-key-at-least-24-characters';
  const listen = async (options) => {
    const server = createApp(null, key, venues, null, null, null, options).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}/webhooks/payments`;
  };
  const post = (url, body, header) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(header ? { [SIGNATURE_HEADER]: header } : {}) }, body }).then(async (r) => ({ status: r.status, data: await r.json() }));

  const unset = await listen({ paymentSecret: null });
  assert.equal((await post(unset, '{}', sign('{}', SECRET))).data.error.code, 'NO_WEBHOOK_SECRET');

  const url = await listen({ paymentSecret: SECRET });
  const body = JSON.stringify(event());
  assert.equal((await post(url, body)).data.error.code, 'INVALID_SIGNATURE', 'no bearer is accepted in place of the signature');
  assert.equal((await post(url, body, sign(body, 'wrong'))).status, 400);
  assert.equal((await post(url, 'not json', sign('not json', SECRET))).data.error.code, 'INVALID_JSON');
  const ignored = await post(url, JSON.stringify({ type: 'charge.refunded' }), sign(JSON.stringify({ type: 'charge.refunded' }), SECRET));
  assert.deepEqual(ignored.data, { received: true, ignored: 'charge.refunded' });
  const ok = await post(url, body, sign(body, SECRET));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settlement.paymentId, 'evt_1');
  assert.equal(settled[0].amount, '125.50');
});
