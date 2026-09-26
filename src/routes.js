// Application HTTP routes and middleware. Both server entrypoints import their app factory here.
// Keep webhook raw-body parsing and public/session routes ahead of operator authentication.
import express, { Router, json } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ensure, AppError } from './errors.js';
import { openapiDocument, swaggerHtml } from './openapi.js';
import { SIGNATURE_HEADER, verifySignature, paymentFrom } from './payments.js';
import { compilerVersions } from './onchain/solc.js';
import { extractWorkspace, extractDemo, OPENAI_MODEL, GENERATIONS, noologDefault, noologStatus } from './openai-extract.js';
import { PROFILES, exportProfile } from '../scripts/export-ui.js';
import { auditEvents } from './onchain/audit-events.js';
import { PoolSwaps } from './onchain/pool-swaps.js';

// Hosted/operator application
function bodyFields(body, required, optional = []) {
  ensure(body && !Array.isArray(body) && typeof body === 'object' && required.every((key) => Object.hasOwn(body, key)) && Object.keys(body).every((key) => [...required, ...optional].includes(key)), 400, 'INVALID_BODY', `Expected fields: ${required.join(', ')}`);
}
// `service` is the custodial issuance ledger (optional); `venues` is the deployed two-act stack (optional).
// POST routes that only read the chain (a quote is a static call), so a viewer may use them.
const VIEWER_POSTS = new Set(['/stack/credit/buyback/quote']);
const isSwapRead = (req) => req.method === 'POST' && /^\/agreements\/[^/]+\/swap\/(quote|approval|transaction)$/.test(req.path);

/// `viewerKey`, when set, opens the GET routes and quotes only: a dashboard build can carry it without carrying the operator key.
export function createApp(service, apiKey, venues = null, policyData = null, viewerKey = null, agreements = null, { paymentSecret = process.env.PAYMENT_WEBHOOK_SECRET ?? null, demoWorkspaces = null, worldLogin = null } = {}) {
  if (!apiKey || apiKey.length < 24) throw new Error('Set API_KEY to at least 24 characters');
  if (viewerKey && (viewerKey.length < 24 || viewerKey === apiKey)) throw new Error('Set VIEWER_KEY to at least 24 characters, different from API_KEY');
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  // The dashboard is served from another origin (or another machine on the LAN); the bearer token is the gate.
  app.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, X-World-Session', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' });
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
  if (worldLogin) app.use('/v1/auth/world', worldLoginRoutes(worldLogin));
  if (demoWorkspaces) {
    if (worldLogin) app.use('/v1', (req, res, next) => {
      // Operator and investor authorization remain separate from browser login.
      const auth = req.get('authorization');
      if (req.path.startsWith('/demo/') || /^Bearer\s+demo_/i.test(auth || '')) return worldLogin.requireSession(req, res, next);
      next();
    });
    app.use('/v1', demoWorkspaceRoutes(demoWorkspaces, () => stackStatus(venues)));
  }
  app.use('/v1', (req, _res, next) => {
    const actual = Buffer.from(req.headers.authorization ?? '');
    const presents = (key) => { const expected = Buffer.from(`Bearer ${key}`); return actual.length === expected.length && timingSafeEqual(actual, expected); };
    const readOnly = req.method === 'GET' || VIEWER_POSTS.has(req.path) || isSwapRead(req);
    if (presents(apiKey) || (viewerKey && readOnly && presents(viewerKey))) return next();
    next(new AppError(401, 'UNAUTHORIZED', 'A valid operator bearer token is required'));
  });
  // An upload is a whole agreement; everything else is small.
  if (agreements) app.use('/v1/agreements', express.json({ limit: '4mb' }));
  app.use(express.json({ limit: '32kb' }));
  if (venues) app.use('/v1/stack', venueRoutes(venues));
  if (agreements) app.use('/v1', agreementRoutes(agreements, () => stackStatus(venues)));
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

// Local workspace application
const loopback = (host) => ['localhost', '127.0.0.1', '[::1]', '::1', '::ffff:127.0.0.1'].includes(host);
export function createWorkspaceApp(agreements, { apiKey = process.env.OPENAI_API_KEY || process.env.OPENAPI_KEY, model = process.env.OPENAI_MODEL || OPENAI_MODEL, chainStatus = async () => null, worldLogin = null } = {}) {
  const app = express();
  const token = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // A local workspace can spend the server's OpenAI budget. Only local browser origins may access it.
    let allowedOrigin = false;
    try { const origin = new URL(req.get('origin')); allowedOrigin = ['http:', 'https:'].includes(origin.protocol) && loopback(origin.hostname); } catch {}
    if (!loopback(req.socket.remoteAddress) || !loopback(req.hostname) || (req.get('origin') && !allowedOrigin))
      return res.status(403).json({ error: { code: 'LOCAL_ONLY', message: 'This workspace is available only on this machine.' } });
    res.set('Cache-Control', 'no-store');
    if (allowedOrigin) {
      res.set('Access-Control-Allow-Origin', req.get('origin'));
      res.vary('Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-World-Session');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'workspace' }));
  if (worldLogin) {
    app.use('/v1/auth/world', worldLoginRoutes(worldLogin));
    app.use('/v1', worldLogin.requireSession);
  }
  app.get('/v1/workspace/config', (_req, res) => res.json({ mode: 'local', files: Boolean(apiKey), demo: true }));
  app.post('/v1/workspace/session', (_req, res) => res.json({ role: 'workspace', accessToken: token }));
  app.use('/v1', (req, res, next) => {
    const actual = Buffer.from(req.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Reconnect to the local workspace.' } });
    next();
  });
  app.use(express.json({ limit: '4mb' }));
  app.post('/v1/agreements', (req, res, next) => {
    const body = req.body ?? {};
    if (!GENERATIONS.includes(body.generation) || !Array.isArray(body.documents) || !body.documents.length || body.documents.length > 20)
      return res.status(400).json({ error: { code: 'INVALID_UPLOAD', message: 'Choose a generation (demo, openai or noolog) and 1–20 documents.' } });
    next();
  });
  app.use('/v1', agreementRoutes(agreements, async () => ({
    model: { provider: 'openai', mode: apiKey ? 'live' : 'unavailable', model },
    compiler: { solidity: await compilerVersions() }, chain: await chainStatus(),
  })));
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }));
  app.use((error, _req, res, _next) => {
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error(error.message);
    res.status(status).json({ error: { code: error.code ?? 'WORKSPACE_ERROR', message: status === 500 ? 'Workspace operation failed; check the server log.' : error.message } });
  });
  return app;
}

// World ID login
export function worldLoginRoutes(login) {
  const router = Router();
  router.use((req, res, next) => {
    const started = Date.now();
    const endpoint = ['/config', '/mock', '/challenge', '/verify', '/session', '/logout'].includes(req.path) ? req.path : 'unknown';
    req.worldRequestId = randomUUID();
    res.set({ 'Cache-Control': 'no-store', 'X-World-Request-ID': req.worldRequestId, 'Access-Control-Expose-Headers': 'X-World-Request-ID' });
    res.on('finish', () => console.info('[World ID] API request', {
      requestId: req.worldRequestId, method: req.method,
      endpoint,
      mode: req.body?.mode ?? login.mode, status: res.statusCode, durationMs: Date.now() - started,
      errorCode: res.locals.worldErrorCode,
    }));
    next();
  });
  router.get('/config', (_req, res) => res.json(login.config()));
  router.post('/mock', (_req, res) => res.json(login.mockLogin()));
  router.post('/challenge', json({ limit: '1kb', inflate: false }), (req, res) => res.json(login.challenge(req.body)));
  router.post('/verify', json({ limit: '32kb', inflate: false }), async (req, res) => res.json(await login.login(req.body, { requestId: req.worldRequestId })));
  router.get('/session', (req, res) => res.json(login.authenticate(req.get('X-World-Session'))));
  router.post('/logout', (req, res) => { login.logout(req.get('X-World-Session')); res.json({ revoked: true }); });
  router.use((error, _req, res, next) => {
    res.locals.worldErrorCode = typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'INTERNAL_ERROR';
    next(error);
  });
  return router;
}

// Demo workspaces
function publicStatus(value, workspaces) {
  const solidity = {};
  for (const key of ['core', 'uniswap-v4', 'swapvm']) {
    const version = value?.compiler?.solidity?.[key];
    if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:[+.-][A-Za-z0-9.+-]+)?$/.test(version) && version.length <= 100) solidity[key] = version;
  }
  return { model: noologDefault() ? noologStatus() : { provider: 'demo', mode: [extractWorkspace, extractDemo].includes(workspaces.agreements.extract) ? 'mock' : 'unavailable' }, compiler: { solidity }, chain: { chainId: workspaces.chainId } };
}

// Mount at /v1 BEFORE operator auth/body parsers. Non-demo credentials always leave this router.
export function demoWorkspaceRoutes(workspaces, status = async () => ({})) {
  const router = Router();
  const swaps = new PoolSwaps();
  const tokenOf = (req) => req.demoAccessToken;
  const wrap = (code, handler) => async (req, res) => res.status(code).json(await handler(req));
  router.use(async (req, res, next) => {
    const authorization = req.headers.authorization;
    const isDemo = typeof authorization === 'string' && /^Bearer\s+demo_/i.test(authorization);
    if (authorization && !isDemo) return next('router');
    const isPublic = (req.method === 'GET' && req.path === '/demo/config') || (req.method === 'POST' && req.path === '/demo/session');
    if (!isDemo && !isPublic) return next('router');
    res.set('Cache-Control', 'no-store');
    // Never use X-Forwarded-For. Even a parent's broad trust-proxy setting cannot create free IPs.
    req.demoIp = req.app.get('trust proxy') ? req.socket.remoteAddress : req.ip;
    await workspaces.admit(req.demoIp ?? 'unknown');
    if (isDemo) {
      req.demoAccessToken = authorization.replace(/^Bearer\s+/i, '');
      workspaces.authenticate(tokenOf(req));
    }
    next();
  });
  router.get('/demo/config', wrap(200, () => workspaces.config()));
  router.post('/demo/session', json({ limit: 1024, inflate: false }), wrap(201, (req) => workspaces.session(req.demoIp)));
  router.post('/demo/logout', wrap(200, (req) => workspaces.logout(tokenOf(req))));
  router.get('/status', wrap(200, async () => publicStatus(await status(), workspaces)));
  router.get('/agreements', wrap(200, (req) => workspaces.read(tokenOf(req), 'list')));
  router.post('/agreements', json({ limit: workspaces.limits.maxRequestBytes, inflate: false }), wrap(201, (req) => workspaces.create(tokenOf(req), req.body)));
  for (const method of ['get', 'ast', 'constraints']) router.get(`/agreements/:id${method === 'get' ? '' : `/${method}`}`, wrap(200, (req) => workspaces.read(tokenOf(req), method, req.params.id)));
  router.put('/agreements/:id/constraints', json({ limit: '32kb', inflate: false }), wrap(200, (req) => workspaces.mutate(tokenOf(req), req.params.id, 'constrain', req.body)));
  for (const method of ['regenerate', 'deploy']) router.post(`/agreements/:id/${method}`, wrap(202, (req) => workspaces.mutate(tokenOf(req), req.params.id, method)));
  router.get('/agreements/:id/swap/state', wrap(200, async req => swaps.state(await workspaces.read(tokenOf(req), 'get', req.params.id), req.query.wallet)));
  router.get('/agreements/:id/swap/receipts/:hash', wrap(200, async req => { await workspaces.read(tokenOf(req), 'get', req.params.id); return swaps.receipt(req.params.hash); }));
  for (const [path, method] of [['quote', 'quote'], ['approval', 'approval'], ['transaction', 'swap']]) {
    router.post(`/agreements/:id/swap/${path}`, json({ limit: '2kb', inflate: false }), wrap(200, async (req) => {
      const record = await workspaces.read(tokenOf(req), 'get', req.params.id);
      const result = await swaps[method](record, req.body);
      swaps.current(await workspaces.read(tokenOf(req), 'get', req.params.id), method === 'quote' ? { quoteId: result.id, wallet: result.wallet } : req.body);
      return result;
    }));
  }
  // No fallthrough, even for unknown agreement suffixes/methods or newly added operator routes.
  router.use((_req, _res, next) => next(new AppError(403, 'FORBIDDEN', 'This endpoint is not available to demo sessions')));
  router.use((error, _req, res, _next) => {
    const code = error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(code).json({ error: { code: error.code ?? (code === 413 ? 'BODY_TOO_LARGE' : code === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR'), message: error instanceof AppError && code !== 500 ? error.message : 'Public demo request failed' } });
  });
  return router;
}

// Payment webhooks
/// POST /webhooks/payments: no bearer, the signature is the credential. Always 2xx once verified,
/// so the rail does not retry a policy decision. `metadata.agreement` settles on that agreement's
/// token; without it the payment settles on the stack's fund token.
export function paymentWebhook(venues, secret, agreements = null) {
  const router = express.Router();
  router.post('/payments', express.raw({ type: '*/*', limit: '64kb' }), (req, res, next) => (async () => {
    ensure(secret, 503, 'NO_WEBHOOK_SECRET', 'Set PAYMENT_WEBHOOK_SECRET to accept payment events');
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    verifySignature(raw, req.headers[SIGNATURE_HEADER], secret);
    let event;
    try { event = JSON.parse(raw); } catch { throw new AppError(400, 'INVALID_JSON', 'Body is not JSON'); }
    const payment = paymentFrom(event);
    if (payment.ignored) return res.json({ received: true, ignored: payment.ignored });
    ensure(!payment.agreement || agreements, 400, 'INVALID_PAYMENT', 'This gateway has no agreements to settle on');
    const venue = payment.agreement ? await agreements.venue(payment.agreement) : venues;
    res.json({ received: true, payment, settlement: await venue.settlePayment(payment) });
  })().catch(next));
  return router;
}

// Agreement lifecycle and status
// The agreement lifecycle over HTTP: upload, watch it generate and compile, see the tree, deploy.


/// The three health lights: the model behind extraction, the compilers, the chain this gateway signs on.
export async function stackStatus(venues) {
  return {
    model: noologDefault() ? noologStatus() : { provider: 'openai', mode: process.env.OPENAI_API_KEY || process.env.OPENAPI_KEY ? 'live' : 'unavailable', model: process.env.OPENAI_MODEL || OPENAI_MODEL },
    compiler: { solidity: await compilerVersions() },
    chain: venues ? { chainId: venues.record.chainId, deployer: venues.record.deployer, attestor: venues.record.attestor, poolManager: venues.record.rwa.poolManager } : null,
  };
}

const isPart = (part) => part && typeof part === 'object' && typeof part.name === 'string' && typeof part.text === 'string' && part.text.length > 0;

export function agreementRoutes(agreements, status, swaps = new PoolSwaps()) {
  const router = Router();
  const wrap = (code, handler) => (req, res, next) => Promise.resolve().then(() => handler(req)).then((value) => res.status(code).json(value)).catch(next);
  router.get('/status', wrap(200, () => status()));
  router.get('/agreements', wrap(200, () => agreements.list()));
  router.post('/agreements', wrap(201, (req) => {
    const body = req.body ?? {};
    // The short form is one file: `filename` says what kind (.md, .txt, .htm), plain text when absent.
    const documents = body.documents ?? (typeof body.text === 'string' ? [{ name: body.filename ?? `${body.name}.txt`, text: body.text }] : null);
    ensure(typeof body.name === 'string' && body.name.trim() && Array.isArray(documents) && documents.length && documents.every(isPart), 400, 'INVALID_BODY', 'Expected fields: name, documents [{ name, text }] (or name, text, filename)');
    ensure(body.config === undefined || (body.config && typeof body.config === 'object'), 400, 'INVALID_BODY', 'config must be an object');
    return agreements.create({ name: body.name.trim(), documents, profile: body.profile, config: body.config ?? null, generation: body.generation });
  }));
  router.get('/agreements/:id', wrap(200, (req) => agreements.get(req.params.id)));
  router.get('/agreements/:id/liquidity', wrap(200, (req) => agreements.liquidityState(req.params.id)));
  router.post('/agreements/:id/liquidity/seeds', wrap(202, (req) => agreements.seed(req.params.id, req.body)));
  router.get('/agreements/:id/liquidity/seeds/:requestId', wrap(200, (req) => agreements.seedOperation(req.params.id, req.params.requestId)));
  router.post('/agreements/:id/mint', wrap(202, (req) => agreements.mint(req.params.id, req.body)));
  router.get('/agreements/:id/mints/:requestId', wrap(200, (req) => agreements.mintOperation(req.params.id, req.params.requestId)));
  router.get('/agreements/:id/swap/state', wrap(200, req => swaps.state(agreements.get(req.params.id), req.query.wallet)));
  router.get('/agreements/:id/swap/receipts/:hash', wrap(200, req => { agreements.get(req.params.id); return swaps.receipt(req.params.hash); }));
  for (const [path, method] of [['quote', 'quote'], ['approval', 'approval'], ['transaction', 'swap']]) {
    router.post(`/agreements/:id/swap/${path}`, wrap(200, async (req) => {
      const result = await swaps[method](agreements.get(req.params.id), req.body);
      swaps.current(agreements.get(req.params.id), method === 'quote' ? { quoteId: result.id, wallet: result.wallet } : req.body);
      return result;
    }));
  }
  router.get('/agreements/:id/ast', wrap(200, (req) => agreements.ast(req.params.id)));
  router.get('/agreements/:id/constraints', wrap(200, (req) => agreements.constraints(req.params.id)));
  router.put('/agreements/:id/constraints', wrap(200, (req) => {
    ensure(req.body && typeof req.body === 'object' && 'identity' in req.body, 400, 'INVALID_BODY', 'Expected fields: identity ({ credential, actions, quote?, clause? } or null)');
    return agreements.constrain(req.params.id, req.body);
  }));
  // The deployed agreement's own venue: the stack routes, over its token, oracle and hook.
  const venueRouters = new Map();
  router.use('/agreements/:id/stack', (req, res, next) => agreements.venue(req.params.id).then((venue) => {
    if (venueRouters.get(req.params.id)?.venue !== venue) venueRouters.set(req.params.id, { venue, routes: venueRoutes(venue) });
    venueRouters.get(req.params.id).routes(req, res, next);
  }).catch(next));
  router.post('/agreements/:id/regenerate', wrap(202, (req) => agreements.regenerate(req.params.id)));
  router.post('/agreements/:id/deploy', wrap(202, (req) => agreements.deploy(req.params.id)));
  return router;
}

// Venue operations
// REST surface over VenueService. Same conventions as the operator API: bearer auth, typed errors.

const field = (body, name, type = 'string') => { ensure(body && typeof body[name] === type, 400, 'INVALID_BODY', `Expected ${name} (${type})`); return body[name]; };
const wrap = (handler) => (req, res, next) => handler(req, res).then((value) => res.json(value)).catch(next);

export function venueRoutes(venues) {
  const router = Router();
  router.get('/', wrap(async () => venues.overview()));
  router.get('/policies', wrap(async () => venues.policies));
  router.get('/wallets', wrap(async () => Promise.all(Object.keys(venues.wallets).map((name) => venues.wallet(name)))));
  router.get('/wallets/:wallet', wrap(async (req) => venues.wallet(req.params.wallet)));
  router.get('/wallets/:wallet/explain', wrap(async (req) => venues.explain(req.query.policy ?? 'credit', req.params.wallet, req.query.action ?? 'deposit')));
  router.post('/wallets/:wallet/fund', wrap(async (req) => venues.fund(req.params.wallet, field(req.body, 'amount'))));
  router.get('/worldid/context', wrap(async () => venues.worldId.verifier.context()));
  router.post('/wallets/:wallet/worldid', wrap(async (req) => venues.verifyHuman(req.params.wallet, field(req.body, 'proof', 'object'), req.body.days)));
  router.post('/wallets/:wallet/facts', wrap(async (req) => venues.attest(field(req.body, 'policy'), req.params.wallet, field(req.body, 'facts', 'object'), req.body.days)));
  router.delete('/wallets/:wallet/facts', wrap(async (req) => venues.revoke(field(req.body, 'policy'), req.params.wallet, field(req.body, 'facts', 'object'))));
  router.post('/wallets/:wallet/sanction', wrap(async (req) => venues.sanction(req.params.wallet, field(req.body, 'sanctioned', 'boolean'))));
  router.post('/wallets/:wallet/override', wrap(async (req) => venues.override(req.params.wallet)));

  router.post('/rwa/mint', wrap(async (req) => venues.mint(field(req.body, 'amount'))));
  router.post('/rwa/release', wrap(async (req) => venues.release(field(req.body, 'wallet'), field(req.body, 'amount'))));
  router.post('/rwa/pools', wrap(async (req) => venues.createPool(field(req.body, 'wallet'), field(req.body, 'hooked', 'boolean'))));
  router.post('/rwa/liquidity', wrap(async (req) => venues.addLiquidity(field(req.body, 'wallet'), field(req.body, 'hooked', 'boolean'))));
  router.post('/rwa/swap', wrap(async (req) => venues.swap(field(req.body, 'wallet'), field(req.body, 'hooked', 'boolean'))));
  router.get('/rwa/cashier', wrap(async () => venues.cashierState()));
  router.post('/rwa/cashier/quote', wrap(async (req) => venues.cashierQuote({ buy: field(req.body, 'buy', 'boolean'), amount: field(req.body, 'amount') })));
  router.post('/rwa/cashier/swap', wrap(async (req) => venues.cashierSwap(field(req.body, 'wallet'), {
    buy: field(req.body, 'buy', 'boolean'), amount: field(req.body, 'amount'), minOut: field(req.body, 'minOut'),
    deadline: field(req.body, 'deadline', 'number'), route: req.body.route ?? 'auto',
  })));
  router.post('/rwa/cashier/prefund', wrap(async (req) => venues.cashierPrefund(field(req.body, 'wallet'), field(req.body, 'amount'))));

  router.post('/credit/deposit', wrap(async (req) => venues.deposit(field(req.body, 'wallet'), field(req.body, 'amount'))));
  router.post('/credit/withdraw', wrap(async (req) => venues.withdraw(field(req.body, 'wallet'), field(req.body, 'amount'))));
  router.get('/credit/buyback', wrap(async () => venues.buyback()));
  router.post('/credit/buyback', wrap(async (req) => venues.shipBuyback({ auction: req.body?.auction === true })));
  router.post('/credit/buyback/quote', wrap(async (req) => venues.quote(field(req.body, 'wallet'), field(req.body, 'amount'))));
  router.post('/credit/buyback/fill', wrap(async (req) => venues.fill(field(req.body, 'wallet'), field(req.body, 'amount'))));
  router.post('/credit/buyback/dock', wrap(async () => venues.dock()));

  router.get('/audit', wrap(async () => venues.audit));
  router.get('/events', wrap(async (req) => venues.events()));
  return router;
}

// Dashboard adapter
// The routes the dashboard's gateway adapter expects (PRD §7.8), served from the deployed stack.
// Policy data is recomputed with the same export code the static site uses, so what the browser
// renders is byte-for-byte what the chain enforces; parties, facts and the audit are live.

const KIND = { 'custodial-rwa': 'rwa', 'rwa-secondary': 'rwa', 'wildcat-credit': 'credit' };
const ROLE = { Investor: 'investor', Stranger: 'stranger', 'Lender A': 'lender', 'Lender B': 'lender', 'Lender C': 'lender', Operator: 'borrower' };
const WALLETS_FOR = { rwa: ['Investor', 'Stranger', 'Operator'], credit: ['Lender A', 'Lender B', 'Lender C', 'Stranger', 'Operator'] };
const LABEL = { Operator: 'Demo MM Ltd — issuer and borrower treasury', Stranger: 'Stranger — unscreened wallet' };
const slug = (name) => name.toLowerCase().replace(/\s+/g, '-');

export async function loadPolicyData() {
  const entries = await Promise.all(PROFILES.map(async (spec) => [spec.profile, await exportProfile(spec)]));
  return new Map(entries);
}

export function dashboardRoutes(venues, policyData) {
  const router = Router();
  const resolutions = new Map();
  const wrap = (handler) => (req, res, next) => handler(req, res).then((value) => res.json(value)).catch(next);
  const profileOf = (req) => {
    const profile = req.query.profile ?? 'wildcat-credit';
    ensure(KIND[profile], 400, 'UNKNOWN_PROFILE', `Unknown profile ${profile}`);
    return profile;
  };
  const walletOf = (profile, id) => {
    const name = WALLETS_FOR[KIND[profile]].find((candidate) => slug(candidate) === id);
    if (!name) throw new AppError(404, 'PARTY_NOT_FOUND', `Unknown party ${id}`);
    return name;
  };
  const party = async (profile, name) => {
    const kind = KIND[profile];
    const address = venues.address(name);
    const { policy } = venues.policy(kind);
    const [known, value, issuedAt] = await venues.c.attestor.factsOf(address, policy.hash);
    const decision = await venues.explain(kind, address, kind === 'rwa' ? 'transfer' : 'deposit');
    const attested = Object.fromEntries(policy.factOrder.map((fact, i) => [fact, (known >> BigInt(i)) & 1n ? Boolean((value >> BigInt(i)) & 1n) : null]));
    return {
      id: slug(name), name: LABEL[name] ?? name, address, role: ROLE[name],
      facts: { ...attested, ...Object.fromEntries(Object.entries(decision.facts).filter(([fact]) => ['sanctionsClear', 'openTermState', 'screeningCurrent'].includes(fact))) },
      // A record whose facts were all revoked is not a screening the venue can rely on.
      screenedAt: known !== 0n && issuedAt ? Number(issuedAt) : null,
      sanctions: decision.sanctioned ? 'flagged' : 'clear',
      decision: { allowed: decision.allowed, clause: decision.clause },
      ...(resolutions.has(`${profile}:${slug(name)}`) ? { resolution: resolutions.get(`${profile}:${slug(name)}`) } : {}),
    };
  };

  router.get('/policy/profiles', wrap(async () => {
    const data = await policyData;
    return PROFILES.map(({ profile, act, label, venue }) => {
      const { paragraphs: _paragraphs, ...coverage } = data.get(profile).coverage;
      return { profile, act, label, venue, title: data.get(profile).title, policyHash: data.get(profile).policyHash, coverage };
    });
  }));
  router.get('/policy', wrap(async (req) => (await policyData).get(profileOf(req))));
  router.get('/lenders', wrap(async (req) => { const profile = profileOf(req); return Promise.all(WALLETS_FOR[KIND[profile]].map((name) => party(profile, name))); }));
  router.get('/worldid/context', wrap(async () => venues.worldId.verifier.context()));
  router.post('/lenders/:id/worldid', wrap(async (req) => {
    const profile = profileOf(req);
    const name = walletOf(profile, req.params.id);
    ensure(req.body && typeof req.body.proof === 'object', 400, 'INVALID_BODY', 'Expected proof');
    await venues.verifyHuman(name, req.body.proof);
    return party(profile, name);
  }));
  router.patch('/lenders/:id/attestations', wrap(async (req) => {
    const profile = profileOf(req);
    const name = walletOf(profile, req.params.id);
    ensure(req.body && typeof req.body.facts === 'object', 400, 'INVALID_BODY', 'Expected facts');
    const kind = KIND[profile];
    const current = (await party(profile, name)).facts;
    const merged = {};
    for (const [fact, tri] of Object.entries({ ...current, ...req.body.facts })) {
      if (['sanctionsClear', 'openTermState', 'screeningCurrent'].includes(fact)) continue;
      // Only a verified World ID proof sets identityVerified; a hand attestation keeps what the proof established.
      if (fact === 'identityVerified') { if (current.identityVerified === true) merged[fact] = true; continue; }
      if (tri === true || tri === false) merged[fact] = tri;
    }
    await venues.attest(kind, name, merged);
    resolutions.delete(`${profile}:${req.params.id}`);
    return party(profile, name);
  }));
  const clearAll = async (profile, name) => {
    const kind = KIND[profile];
    const attested = Object.entries((await party(profile, name)).facts).filter(([fact, tri]) => tri !== null && !['sanctionsClear', 'openTermState', 'screeningCurrent'].includes(fact)).map(([fact]) => fact);
    if (attested.length) await venues.revoke(kind, name, attested);
  };
  router.post('/lenders/:id/approve', wrap(async (req) => { const profile = profileOf(req); const name = walletOf(profile, req.params.id); resolutions.set(`${profile}:${req.params.id}`, 'approved'); return party(profile, name); }));
  router.post('/lenders/:id/reject', wrap(async (req) => { const profile = profileOf(req); const name = walletOf(profile, req.params.id); await clearAll(profile, name); resolutions.set(`${profile}:${req.params.id}`, 'rejected'); return party(profile, name); }));
  router.post('/lenders/:id/revoke', wrap(async (req) => { const profile = profileOf(req); const name = walletOf(profile, req.params.id); await clearAll(profile, name); resolutions.delete(`${profile}:${req.params.id}`); return party(profile, name); }));

  router.get('/audit', wrap(async (req) => auditEvents(venues.audit, profileOf(req), venues.record.chainId)));
  return router;
}
