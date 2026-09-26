import { Router, json } from 'express';
import { AppError } from './errors.js';
import { publicSession } from './investor-auth.js';

// Investor capabilities are consumed only here; they never pass through the operator API.
export function investorRoutes({ auth, service }) {
  const router = Router();
  const rates = new Map();
  const wrap = (handler) => async (req, res) => res.json(await handler(req));
  const token = (req) => {
    const value = req.headers.authorization;
    if (typeof value !== 'string' || !/^Bearer ia_[a-zA-Z0-9_-]{43}$/.test(value)) throw new AppError(401, 'INVESTOR_UNAUTHORIZED', 'Sign in with your wallet and World ID');
    return value.slice(7);
  };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const now = Date.now();
    for (const [key, entry] of rates) if (entry.expiresAt <= now) rates.delete(key);
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!rates.has(ip) && rates.size >= 1024) return next(new AppError(429, 'INVESTOR_BUSY', 'Investor API is busy; retry later'));
    const entry = rates.get(ip) ?? { count: 0, expiresAt: now + 60000 };
    rates.set(ip, entry);
    if (++entry.count > 240) return next(new AppError(429, 'INVESTOR_RATE_LIMIT', 'Too many investor requests; retry later'));
    next();
  });
  router.use(json({ limit: '32kb', inflate: false }));
  router.get('/config', wrap(() => service.config()));
  router.get('/funds', wrap(() => service.funds()));
  const metadata = (req) => ({ origin: req.get('origin'), clientIp: req.socket.remoteAddress ?? req.ip });
  router.post('/auth/challenge', wrap((req) => auth.challenge(req.body, metadata(req))));
  router.post('/auth/verify', wrap((req) => auth.verify(req.body, metadata(req))));
  router.use(async (req, _res, next) => {
    req.investorToken = token(req);
    req.investorSession = await auth.authenticate(req.investorToken);
    next();
  });
  router.post('/auth/logout', wrap((req) => ({ revoked: auth.revoke(req.investorToken) })));
  router.get('/auth/session', wrap((req) => ({ session: publicSession(req.investorSession), expiresAt: req.investorSession.expiresAt })));
  router.get('/me', wrap((req) => service.snapshot(req.investorSession)));
  router.get('/activity', wrap((req) => service.activity(req.investorSession)));
  router.post('/identity', wrap((req) => service.attestIdentity(req.investorSession)));
  router.post('/quote', wrap((req) => service.quote(req.investorSession, req.body)));
  router.post('/transactions/prepare', wrap((req) => service.prepare(req.investorSession, req.body)));
  router.post('/transactions/confirm', wrap((req) => service.confirm(req.investorSession, req.body)));
  router.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Investor endpoint not found')));
  router.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).json({ error: {
      code: error instanceof AppError ? error.code : status === 413 ? 'BODY_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : 'INVESTOR_UNAVAILABLE',
      message: error instanceof AppError && status !== 500 ? error.message : 'Investor request could not be completed',
      ...(error instanceof AppError && status !== 500 && error.details ? { details: error.details } : {}),
    } });
  });
  return router;
}
