// The agreement lifecycle over HTTP: upload, watch it generate and compile, see the tree, deploy.
import { Router } from 'express';
import { venueRoutes } from './venues-api.js';
import { ensure } from './errors.js';
import { MODEL } from './noolog/extract.js';
import { NoologClient } from './noolog/client.js';
import { compilerVersions } from './solc.js';

const NOOLOG_URL = 'https://api.peeramid.xyz';
let listing = { at: 0, models: null };

/// Whether the live gateway lists the configured model (its OpenAI-compatible /v1/models); cached a minute.
async function modelListed() {
  if (!process.env.NOOLOG_API_KEY) return { listed: true, models: null };
  if (Date.now() - listing.at > 60_000) {
    listing = { at: Date.now(), models: await new NoologClient().models().catch(() => null) };
  }
  return { listed: listing.models ? listing.models.includes(MODEL) : null, models: listing.models };
}

/// The three health lights: the model behind extraction, the compilers, the chain this gateway signs on.
export async function stackStatus(venues) {
  const { listed, models } = await modelListed();
  return {
    model: { provider: 'noolog', mode: process.env.NOOLOG_API_KEY ? 'live' : 'mock', url: process.env.NOOLOG_URL ?? NOOLOG_URL, model: MODEL, listed, ...(models ? { models } : {}) },
    compiler: { solidity: await compilerVersions() },
    chain: venues ? { chainId: venues.record.chainId, deployer: venues.record.deployer, attestor: venues.record.attestor, poolManager: venues.record.rwa.poolManager } : null,
  };
}

const isPart = (part) => part && typeof part === 'object' && typeof part.name === 'string' && typeof part.text === 'string' && part.text.length > 0;

export function agreementRoutes(agreements, status) {
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
    return agreements.create({ name: body.name.trim(), documents, profile: body.profile, config: body.config ?? null });
  }));
  router.get('/agreements/:id', wrap(200, (req) => agreements.get(req.params.id)));
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
