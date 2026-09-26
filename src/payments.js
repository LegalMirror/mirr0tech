// Money in, tokens out, the way a payment rail reports it. A provider (Stripe, or a bank's wire
// notification in the same shape) posts a signed event; the gateway verifies the signature,
// attests that the funds arrived (`depositConfirmed`) for the wallet the payment names, and mints
// under the policy. A refused mint is not an error for the rail: the money is held and the audit
// names the sentence that held it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { AppError, ensure } from './errors.js';

export const SIGNATURE_HEADER = 'stripe-signature';
const SETTLING = new Set(['payment_intent.succeeded', 'charge.succeeded', 'wire.received']);

/// Stripe's scheme: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
export function sign(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export function verifySignature(rawBody, header, secret, { tolerance = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  const fields = Object.fromEntries(String(header ?? '').split(',').map((part) => part.split('=')));
  ensure(/^\d+$/.test(fields.t ?? '') && /^[0-9a-f]{64}$/.test(fields.v1 ?? ''), 400, 'INVALID_SIGNATURE', 'Missing or malformed signature');
  ensure(Math.abs(now - Number(fields.t)) <= tolerance, 400, 'INVALID_SIGNATURE', 'Signature timestamp outside tolerance');
  const expected = Buffer.from(sign(rawBody, secret, fields.t).split('v1=')[1], 'hex');
  ensure(timingSafeEqual(expected, Buffer.from(fields.v1, 'hex')), 400, 'INVALID_SIGNATURE', 'Signature does not match');
}

/// What the gateway needs from an event: which payment, how much, for whom. Minor units in, decimal
/// string out; the policy prices one token per USD. Anything but a settled USD payment is ignored.
export function paymentFrom(event) {
  if (!SETTLING.has(event?.type)) return { ignored: event?.type ?? 'unknown' };
  const object = event.data?.object ?? {};
  const wallet = object.metadata?.wallet;
  ensure(Number.isInteger(object.amount) && object.amount > 0, 400, 'INVALID_PAYMENT', 'amount must be a positive integer of minor units');
  ensure(String(object.currency ?? '').toLowerCase() === 'usd', 400, 'INVALID_PAYMENT', 'Only USD payments settle into this fund');
  ensure(typeof wallet === 'string' && wallet, 400, 'INVALID_PAYMENT', 'metadata.wallet names the investor wallet');
  return { id: event.id, wallet, amount: (object.amount / 100).toFixed(2), currency: 'usd', reference: object.id ?? null };
}

/// POST /webhooks/payments: no bearer, the signature is the credential. Always 2xx once verified,
/// so the rail does not retry a policy decision.
export function paymentWebhook(venues, secret) {
  const router = express.Router();
  router.post('/payments', express.raw({ type: '*/*', limit: '64kb' }), (req, res, next) => (async () => {
    ensure(secret, 503, 'NO_WEBHOOK_SECRET', 'Set PAYMENT_WEBHOOK_SECRET to accept payment events');
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    verifySignature(raw, req.headers[SIGNATURE_HEADER], secret);
    let event;
    try { event = JSON.parse(raw); } catch { throw new AppError(400, 'INVALID_JSON', 'Body is not JSON'); }
    const payment = paymentFrom(event);
    if (payment.ignored) return res.json({ received: true, ignored: payment.ignored });
    res.json({ received: true, payment, settlement: await venues.settlePayment(payment) });
  })().catch(next));
  return router;
}
