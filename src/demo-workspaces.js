// An anonymous capability grants only its own agreement lifecycle, never an operator venue.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Router, json } from 'express';
import { draftFor } from './agreements.js';
import { AppError, ensure } from './errors.js';
import { extractWithNoolog } from './noolog/extract.js';
import { bundleDocuments, documentFrom } from './policy/document.js';
import { compilePolicy } from './policy/compile.js';
import { PROFILES } from '../scripts/export-ui.js';

const DEFAULT_LIMITS = Object.freeze({
  sessionTtlSeconds: 3 * 3600, intervalSeconds: 3600,
  maxSessions: 200, sessionsPerIp: 10, sessionsPerInterval: 100,
  requestsPerIp: 1800, requestsPerInterval: 6000, maxPendingRequests: 128,
  uploadsPerWorkspace: 3, uploadsPerInterval: 20,
  jobsPerWorkspace: 12, jobsPerInterval: 40,
  deploysPerWorkspace: 2, deploysPerInterval: 5,
  maxRequestBytes: 4 * 1024 * 1024, maxParts: 4,
});
const PUBLIC_PROFILES = ['rwa-secondary', 'custodial-rwa'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const invalid = (condition, message) => ensure(condition, 400, 'INVALID_BODY', message);
const quota = (condition) => ensure(condition, 429, 'DEMO_LIMIT', 'Public demo quota exhausted; try again after the interval or use the operator API');
const unavailable = (condition, message) => ensure(condition, 503, 'UNAVAILABLE', message);
const fields = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const safeRecord = (record) => record.error ? { ...record, error: 'Agreement job failed; contact the demo operator before retrying.' } : record;

export class DemoWorkspaces {
  // clock returns epoch milliseconds, like Date.now. One instance/process owns each durable file.
  constructor({ agreements, chainId, path = null, clock = Date.now, ...limits } = {}) {
    ensure([31337, 11155111].includes(chainId), 500, 'CONFIG', 'Public demo requires chain 31337 or 11155111');
    ensure(agreements && typeof agreements.create === 'function', 500, 'CONFIG', 'DemoWorkspaces requires Agreements');
    ensure(chainId !== 11155111 || path, 500, 'CONFIG', 'Public Sepolia demo requires a durable workspace path');
    ensure(!path || !agreements.path || resolve(path) !== resolve(agreements.path), 500, 'CONFIG', 'Workspace state and agreements need different paths');
    ensure(fields(limits, Object.keys(DEFAULT_LIMITS)), 500, 'CONFIG', 'Unknown demo limit option');
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    ensure(Object.values(this.limits).every((value) => integer(value) && value > 0), 500, 'CONFIG', 'Demo limits must be positive safe integers');
    ensure(this.limits.sessionTtlSeconds <= 6 * 3600 && this.limits.maxRequestBytes <= DEFAULT_LIMITS.maxRequestBytes && this.limits.maxParts <= 8, 500, 'CONFIG', 'Demo TTL/body/part limits exceed safety ceilings');
    Object.assign(this, { agreements, chainId, path, clock });
    this.queue = Promise.resolve();
    this.pending = 0;
    this.state = { version: 1, chainId, intervalSeconds: this.limits.intervalSeconds, lastNow: 0, sessions: {}, requests: [], issued: [], uploads: [], jobs: [], deploys: [] };
  }

  init() {
    this.ready ??= (async () => {
      if (this.path) {
        try {
          const state = JSON.parse(await readFile(this.path, 'utf8'));
          this.validateState(state);
          this.state = state;
        } catch (error) {
          if (error.code !== 'ENOENT') throw new AppError(503, 'UNAVAILABLE', 'Demo state cannot be loaded; restore it rather than resetting the deployment budget');
        }
      }
      const specs = PROFILES.filter((spec) => PUBLIC_PROFILES.includes(spec.profile));
      this.configs = Object.fromEntries(await Promise.all(specs.map(async (spec) => [spec.profile, { ...JSON.parse(await readFile(new URL(`../${spec.config}`, import.meta.url), 'utf8')), profile: spec.profile }])));
      this.documentHashes = await Promise.all(['ea026411904ex10-9.htm', 'nav-cashier-addendum.md'].map(async (name) => documentFrom(name, await readFile(new URL(`../test/human_contracts/${name}`, import.meta.url))).textSha256));
      return this;
    })();
    return this.ready;
  }

  validateState(state) {
    const valid = (condition) => { if (!condition) throw new Error('Invalid demo state'); };
    valid(object(state) && state.version === 1 && state.chainId === this.chainId && state.intervalSeconds === this.limits.intervalSeconds && integer(state.lastNow) && object(state.sessions));
    const ids = new Set();
    for (const [hash, session] of Object.entries(state.sessions)) {
      valid(/^[a-f0-9]{64}$/.test(hash) && object(session) && integer(session.expiresAt) && Array.isArray(session.ids));
      valid(['uploads', 'jobs', 'deploys'].every((key) => integer(session[key])) && session.ids.length <= session.uploads);
      for (const id of session.ids) { valid(typeof id === 'string' && /^agr_[a-f0-9]{12}$/.test(id) && !ids.has(id)); ids.add(id); }
    }
    for (const key of ['requests', 'issued', 'uploads', 'jobs', 'deploys']) {
      valid(Array.isArray(state[key]) && state[key].every((event) => object(event) && integer(event.at) && (['requests', 'issued'].includes(key) ? /^[a-f0-9]{64}$/.test(event.ip) : true)));
    }
  }

  now() {
    const seconds = Math.floor(this.clock() / 1000);
    ensure(integer(seconds), 500, 'CONFIG', 'Invalid demo clock');
    // A wall-clock rollback must not resurrect expired tokens or release gas reservations.
    this.state.lastNow = Math.max(seconds, this.state.lastNow);
    return this.state.lastNow;
  }

  prune() {
    const now = this.now();
    for (const [hash, session] of Object.entries(this.state.sessions)) if (session.expiresAt <= now) delete this.state.sessions[hash];
    for (const key of ['requests', 'issued', 'uploads', 'jobs', 'deploys']) this.state[key] = this.state[key].filter(({ at }) => at > now - this.limits.intervalSeconds);
  }

  run(handler) {
    if (this.pending >= this.limits.maxPendingRequests) return Promise.reject(new AppError(429, 'DEMO_LIMIT', 'Public demo request queue is full'));
    this.pending++;
    const job = this.queue.then(async () => {
      await this.init();
      unavailable(!this.broken, 'Demo state persistence failed; operator intervention required');
      this.prune();
      return handler();
    }).finally(() => { this.pending--; });
    this.queue = job.catch(() => {});
    return job;
  }

  async persist() {
    if (!this.path) return;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.tmp`;
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(this.state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      this.broken = true;
      throw new AppError(503, 'UNAVAILABLE', 'Demo state persistence failed; no further public work is allowed');
    }
  }

  config() { return { enabled: true, chainId: this.chainId, limits: this.limits }; }

  // IPs are hashed, tokens are never stored, and traffic arrays are bounded by global quotas.
  admit(ip) {
    return this.run(async () => {
      const hash = digest(ip);
      quota(this.state.requests.length < this.limits.requestsPerInterval && this.state.requests.filter((event) => event.ip === hash).length < this.limits.requestsPerIp);
      this.state.requests.push({ at: this.now(), ip: hash });
      await this.persist();
    });
  }

  session(ip) {
    return this.run(async () => {
      const hash = digest(ip);
      quota(Object.keys(this.state.sessions).length < this.limits.maxSessions && this.state.issued.length < this.limits.sessionsPerInterval && this.state.issued.filter((event) => event.ip === hash).length < this.limits.sessionsPerIp);
      const accessToken = `demo_${randomBytes(32).toString('hex')}`;
      const expiresAt = this.now() + this.limits.sessionTtlSeconds;
      this.state.sessions[digest(accessToken)] = { expiresAt, ids: [], uploads: 0, jobs: 0, deploys: 0 };
      this.state.issued.push({ at: this.now(), ip: hash });
      await this.persist();
      return { accessToken, expiresAt, role: 'demo', chainId: this.chainId };
    });
  }

  authenticate(token) {
    const session = typeof token === 'string' && /^demo_[a-f0-9]{64}$/.test(token) ? this.state.sessions[digest(token)] : null;
    ensure(session && session.expiresAt > this.now(), 401, 'UNAUTHORIZED', 'A valid demo session is required');
    return session;
  }

  owned(token, id) {
    const session = this.authenticate(token);
    ensure(session.ids.includes(id), 404, 'NOT_FOUND', 'Agreement not found');
    return session;
  }

  logout(token) {
    return this.run(async () => {
      this.authenticate(token);
      delete this.state.sessions[digest(token)];
      await this.persist();
      return { revoked: true };
    });
  }

  read(token, method, id) {
    return this.run(() => {
      const session = id === undefined ? this.authenticate(token) : this.owned(token, id);
      if (method === 'list') return session.ids.map((owned) => safeRecord(this.agreements.get(owned))).map(({ export: _export, ...summary }) => summary);
      ensure(['get', 'ast', 'constraints'].includes(method), 403, 'FORBIDDEN', 'Demo operation not allowed');
      const value = this.agreements[method](id);
      return method === 'get' ? safeRecord(value) : value;
    });
  }

  mockOnly() {
    unavailable(!process.env.NOOLOG_API_KEY && this.agreements.extract === extractWithNoolog, 'Public demo generation is unavailable with live or custom Noolog extraction; use the operator API. Public uploads only support the bundled mock documents.');
  }

  validateConfig(profile, input) {
    invalid(input === undefined || input === null || fields(input, ['name', 'symbol', 'decimals', 'maxSupply', 'custody', 'currency', 'priceModel', 'assumptions', 'profile', 'secondaryVenue', 'cashier', 'worldId']), 'Unsupported public compile config field');
    const config = { ...structuredClone(this.configs[profile]), ...input };
    invalid(config.profile === profile, 'Config profile must match the public agreement profile');
    invalid(config.decimals === 6 && config.custody === 'backend' && config.currency === 'USD', 'Public config requires six-decimal custodial USD');
    invalid(['one-token-per-usd', ...(profile === 'rwa-secondary' && config.cashier?.enabled ? ['fixed-nav'] : [])].includes(config.priceModel), 'Unsupported public price model');
    invalid(profile === 'rwa-secondary' ? config.secondaryVenue === 'uniswap-v4' : config.secondaryVenue === undefined, 'Unsupported public secondary venue');
    invalid([config.name, config.symbol].every((value) => typeof value === 'string' && /^[A-Za-z0-9 ._-]{1,64}$/.test(value)), 'Invalid token name or symbol');
    invalid((typeof config.maxSupply === 'string' && /^[1-9][0-9]{0,12}$/.test(config.maxSupply)) || (Number.isSafeInteger(config.maxSupply) && config.maxSupply > 0), 'maxSupply must be a positive integer');
    invalid(BigInt(config.maxSupply) <= 1_000_000_000_000n, 'Public maxSupply cannot exceed 1000000000000 base units');
    config.maxSupply = String(config.maxSupply);
    invalid(Array.isArray(config.assumptions) && config.assumptions.length > 0 && config.assumptions.length <= 20 && config.assumptions.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|file|data|javascript):|\/\/)/i.test(value)), 'Assumptions must be bounded text without URLs');
    if (config.worldId !== undefined) {
      invalid(fields(config.worldId, ['credential', 'action']) && ['document', 'proof_of_human', 'selfie'].includes(config.worldId.credential) && (config.worldId.action === undefined || config.worldId.action === this.agreements.worldIdAction), 'Public World ID config cannot override the server action');
    }
    if (config.cashier !== undefined) {
      const pool = config.cashier?.pool;
      invalid(profile === 'rwa-secondary' && fields(config.cashier, ['enabled', 'pool']) && config.cashier.enabled === true && fields(pool, ['fee', 'tickSpacing']) && Number.isInteger(pool.fee) && pool.fee >= 0 && pool.fee < 1_000_000 && Number.isInteger(pool.tickSpacing) && pool.tickSpacing >= 1 && pool.tickSpacing <= 32767, 'Invalid public cashier pool config');
    }
    return config;
  }

  prepare(body) {
    invalid(fields(body, ['name', 'documents', 'text', 'filename', 'profile', 'config']), 'Unsupported upload field');
    ensure(Buffer.byteLength(JSON.stringify(body)) <= this.limits.maxRequestBytes, 413, 'BODY_TOO_LARGE', 'Demo upload is too large');
    invalid(typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 120, 'name must be 1–120 characters');
    const profile = body.profile ?? 'rwa-secondary';
    invalid(PUBLIC_PROFILES.includes(profile), 'Public profiles are rwa-secondary and custodial-rwa');
    const documents = body.documents ?? (typeof body.text === 'string' ? [{ name: body.filename ?? `${body.name}.txt`, text: body.text }] : null);
    invalid(Array.isArray(documents) && documents.length > 0 && documents.length <= this.limits.maxParts && documents.every((part) => fields(part, ['name', 'text']) && typeof part.name === 'string' && part.name.length > 0 && part.name.length <= 200 && typeof part.text === 'string' && part.text.length > 0), 'Expected bounded documents [{ name, text }] or text and filename');
    return { name: body.name.trim(), documents, profile, config: this.validateConfig(profile, body.config) };
  }

  supported(input) {
    let parts;
    try { parts = input.documents.map((part) => documentFrom(part.name, part.text)); }
    catch (error) { throw new AppError(400, 'INVALID_DOCUMENT', error.message); }
    const expected = input.config.cashier ? this.documentHashes : this.documentHashes.slice(0, 1);
    unavailable(parts.length === expected.length && parts.every((part, index) => part.textSha256 === expected[index]), 'Public demo supports only the bundled BUIDL document, optionally followed by the bundled NAV cashier addendum with cashier config. New documents require the operator API; no public live model calls are made.');
    const document = bundleDocuments(parts);
    const draft = draftFor(PROFILES.find((spec) => spec.profile === input.profile), document, input.config);
    unavailable(draft, 'No deterministic mock reading is available for these documents');
    try { compilePolicy({ ast: draft, source: document }, input.config, document, { demo: true }); }
    catch { throw new AppError(400, 'INVALID_BODY', 'Config does not compile with the bundled demo documents'); }
  }

  async reserve(session, kinds) {
    for (const kind of kinds) quota(session[kind] < this.limits[`${kind}PerWorkspace`] && this.state[kind].length < this.limits[`${kind}PerInterval`]);
    for (const kind of kinds) { session[kind]++; this.state[kind].push({ at: this.now() }); }
    // Never refund: a timeout, error or crash cannot prove that no work/transaction happened.
    await this.persist();
  }

  create(token, body) {
    return this.run(async () => {
      const session = this.authenticate(token);
      this.mockOnly();
      const input = this.prepare(body);
      await this.reserve(session, ['uploads', 'jobs']);
      this.supported(input);
      this.mockOnly();
      const created = await this.agreements.create(input);
      session.ids.push(created.id);
      await this.persist();
      return safeRecord(created);
    });
  }

  mutate(token, id, method, body) {
    return this.run(async () => {
      const session = this.owned(token, id);
      ensure(['constrain', 'regenerate', 'deploy'].includes(method), 403, 'FORBIDDEN', 'Demo operation not allowed');
      if (method === 'regenerate') this.mockOnly();
      if (method === 'constrain') {
        invalid(fields(body, ['identity']) && Object.hasOwn(body, 'identity'), 'Expected identity constraint');
        const identity = body.identity;
        invalid(identity === null || (fields(identity, ['credential', 'actions', 'quote', 'clause'])
          && (identity.credential === undefined || ['document', 'proof_of_human', 'selfie'].includes(identity.credential))
          && (identity.actions === undefined || (Array.isArray(identity.actions) && identity.actions.length > 0 && identity.actions.length <= 3 && identity.actions.every((action) => ['mint', 'burn', 'transfer'].includes(action))))
          && ['quote', 'clause'].every((key) => identity[key] === undefined || (typeof identity[key] === 'string' && identity[key].length <= 4000))), 'Invalid or oversized identity constraint');
      }
      await this.reserve(session, method === 'deploy' ? ['jobs', 'deploys'] : ['jobs']);
      if (method === 'regenerate') {
        const record = this.agreements.record(id);
        this.supported(record);
        this.mockOnly();
      }
      return safeRecord(await this.agreements[method](id, body));
    });
  }
}

function publicStatus(value, workspaces) {
  const solidity = {};
  for (const key of ['core', 'uniswap-v4', 'swapvm']) {
    const version = value?.compiler?.solidity?.[key];
    if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:[+.-][A-Za-z0-9.+-]+)?$/.test(version) && version.length <= 100) solidity[key] = version;
  }
  return { model: { provider: 'noolog', mode: process.env.NOOLOG_API_KEY || workspaces.agreements.extract !== extractWithNoolog ? 'unavailable' : 'mock' }, compiler: { solidity }, chain: { chainId: workspaces.chainId } };
}

// Mount at /v1 BEFORE operator auth/body parsers. Non-demo credentials always leave this router.
export function demoWorkspaceRoutes(workspaces, status = async () => ({})) {
  const router = Router();
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
  // No fallthrough, even for unknown agreement suffixes/methods or newly added operator routes.
  router.use((_req, _res, next) => next(new AppError(403, 'FORBIDDEN', 'This endpoint is not available to demo sessions')));
  router.use((error, _req, res, _next) => {
    const code = error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(code).json({ error: { code: error.code ?? (code === 413 ? 'BODY_TOO_LARGE' : code === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR'), message: error instanceof AppError && code !== 500 ? error.message : 'Public demo request failed' } });
  });
  return router;
}
