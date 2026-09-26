import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ensure, AppError } from './errors.js';
import { venueRoutes } from './venues-api.js';
import { dashboardRoutes } from './dashboard-api.js';
import { agreementRoutes, stackStatus } from './agreements-api.js';
import { paymentWebhook } from './payments.js';
import { openapiDocument, swaggerHtml } from './openapi.js';
import { signingRoutes } from './signing.js';

function bodyFields(body, required, optional = []) {
  ensure(body && !Array.isArray(body) && typeof body === 'object' && required.every((key) => Object.hasOwn(body, key)) && Object.keys(body).every((key) => [...required, ...optional].includes(key)), 400, 'INVALID_BODY', `Expected fields: ${required.join(', ')}`);
}
// `service` is the custodial issuance ledger (optional); `venues` is the deployed two-act stack (optional).
// POST routes that only read the chain (a quote is a static call), so a viewer may use them.
const VIEWER_POSTS = new Set(['/stack/credit/buyback/quote']);

/// `viewerKey`, when set, opens the GET routes and quotes only: a dashboard build can carry it without carrying the operator key.
export function createApp(service, apiKey, venues = null, policyData = null, viewerKey = null, agreements = null, { paymentSecret = process.env.PAYMENT_WEBHOOK_SECRET ?? null, signing = null } = {}) {
  if (!apiKey || apiKey.length < 24) throw new Error('Set API_KEY to at least 24 characters');
  if (viewerKey && (viewerKey.length < 24 || viewerKey === apiKey)) throw new Error('Set VIEWER_KEY to at least 24 characters, different from API_KEY');
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  // The dashboard is served from another origin (or another machine on the LAN); the bearer token is the gate.
  app.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  // The contract for integrators, webhooks included: the document, and Swagger UI over it.
  app.get('/openapi.json', (req, res) => res.json(openapiDocument({ serverUrl: `${req.protocol}://${req.get('host')}` })));
  app.get('/docs', (_req, res) => res.type('html').send(swaggerHtml));
  app.get('/health', (_req, res) => res.json({
    status: service?.pending() ? 'reconciliation_required' : 'ok', mode: service?.chain.mode ?? 'stack',
    policyHash: service?.policy.hash ?? null, stack: venues ? { chainId: venues.record.chainId, rwa: venues.record.rwa.policyHash, credit: venues.record.credit.policyHash } : null,
  }));
  // The payment rail signs its events instead of carrying the bearer; the raw body is what it signed.
  if (venues) app.use('/webhooks', paymentWebhook(venues, paymentSecret, agreements));
  app.use('/v1', (req, _res, next) => {
    const actual = Buffer.from(req.headers.authorization ?? '');
    const presents = (key) => { const expected = Buffer.from(`Bearer ${key}`); return actual.length === expected.length && timingSafeEqual(actual, expected); };
    const readOnly = req.method === 'GET' || VIEWER_POSTS.has(req.path);
    if (presents(apiKey) || (viewerKey && readOnly && presents(viewerKey))) return next();
    next(new AppError(401, 'UNAUTHORIZED', 'A valid operator bearer token is required'));
  });
  // An upload is a whole agreement; everything else is small.
  if (agreements) app.use('/v1/agreements', express.json({ limit: '4mb' }));
  app.use(express.json({ limit: '32kb' }));
  if (venues) app.use('/v1/stack', venueRoutes(venues));
  if (agreements) app.use('/v1', agreementRoutes(agreements, () => stackStatus(venues)));
  if (signing) app.use('/v1', signingRoutes(signing));
  // The dashboard's routes take the place of the custodial ledger's when only the stack is served.
  if (venues && policyData && !service) app.use('/v1', dashboardRoutes(venues, policyData));
  if (service) {
  app.get('/v1/policy', (_req, res) => res.json(service.policy));
  app.get('/v1/investors', (_req, res) => res.json(Object.values(service.snapshot().investors)));
  app.get('/v1/investors/:id', (req, res) => res.json(service.investor(req.params.id)));
  app.post('/v1/investors', async (req, res) => {
    bodyFields(req.body, ['name']);
    res.status(201).json(await service.createInvestor(req.body.name));
  });
  app.patch('/v1/mock/investors/:id/compliance', async (req, res) => res.json(await service.setCompliance(req.params.id, req.body)));
  app.post('/v1/deposits', async (req, res) => {
    bodyFields(req.body, ['investorId', 'amount']);
    res.status(201).json(await service.createDeposit(req.body.investorId, req.body.amount));
  });
  app.post('/v1/mock/deposits/:id/confirm', async (req, res) => res.json(await service.settleMock('deposits', req.params.id)));
  app.post('/v1/mints', async (req, res) => {
    bodyFields(req.body, ['investorId', 'depositId', 'amount']);
    res.json(await service.operate('mint', req.body, req.headers['idempotency-key']));
  });
  app.post('/v1/redemptions', async (req, res) => {
    bodyFields(req.body, ['investorId', 'amount']);
    res.json(await service.operate('burn', req.body, req.headers['idempotency-key']));
  });
  app.post('/v1/mock/withdrawals/:id/settle', async (req, res) => res.json(await service.settleMock('withdrawals', req.params.id)));
  for (const collection of ['deposits', 'operations', 'withdrawals']) {
    app.get(`/v1/${collection}`, (_req, res) => res.json(Object.values(service.snapshot()[collection])));
    app.get(`/v1/${collection}/:id`, (req, res) => {
      const records = service.snapshot()[collection];
      ensure(Object.hasOwn(records, req.params.id), 404, 'NOT_FOUND', 'Record not found');
      res.json(records[req.params.id]);
    });
  }
  app.get('/v1/audit', (_req, res) => res.json(service.snapshot().audit));
  }
  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found')));
  app.use((error, _req, res, _next) => {
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: {
      code: error.code ?? (status === 400 ? 'INVALID_JSON' : status === 413 ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR'),
      message: status === 500 ? 'Internal server error' : error.message,
      ...(error.details ? { details: error.details } : {}),
    } });
  });
  return app;
}
