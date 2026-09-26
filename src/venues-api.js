// REST surface over VenueService. Same conventions as the operator API: bearer auth, typed errors.
import { Router } from 'express';
import { ensure } from './errors.js';

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
  router.get('/events', wrap(async (req) => venues.events(req.query.contract, req.query.event)));
  return router;
}
