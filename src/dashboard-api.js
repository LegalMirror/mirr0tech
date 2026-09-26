// The routes the dashboard's gateway adapter expects (PRD §7.8), served from the deployed stack.
// Policy data is recomputed with the same export code the static site uses, so what the browser
// renders is byte-for-byte what the chain enforces; parties, facts and the audit are live.
import { Router } from 'express';
import { PROFILES, exportProfile } from '../scripts/export-ui.js';
import { AppError, ensure } from './errors.js';
import { auditEvents } from './audit-events.js';

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
