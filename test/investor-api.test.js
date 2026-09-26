import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Wallet, id } from 'ethers';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { createApp } from '../src/app.js';
import { InvestorAuth } from '../src/investor-auth.js';
import { HumanRegistry, WorldIdVerifier } from '../src/worldid.js';

const ORIGIN = 'https://legalmirror.github.io';
const OPERATOR = 'test-maintenance-operator-key-24-chars';

test('investor HTTP login requires wallet ownership plus World proof and never grants operator routes', async (t) => {
  const wallet = new Wallet(id('synthetic investor API fixture'));
  const policyHash = id('public fund policy');
  const verifier = new WorldIdVerifier({ rpId: 'rp_test', appId: 'app_test', environment: 'sandbox', credential: 'document', action: 'humanity', mock: false,
    signingKeyHex: '11'.repeat(32), fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ success: true, results: [{ success: true, identifier: 'passport', nullifier: payload.responses[0].nullifier }] }) };
    } });
  const memory = new HumanRegistry();
  const venue = { record: { chainId: 11155111, rwa: { policyHash } }, policies: { rwa: { policy: { hash: policyHash } } },
    worldId: { verifier, registry: { path: 'injected-memory-not-a-file', bind: (...args) => memory.bind(...args) } } };
  const auth = new InvestorAuth({ resolveFund: async (fundId) => ({ id: fundId, venue }), allowedOrigins: [ORIGIN] });
  const calls = [];
  const service = {
    config: () => ({ chainId: 11155111, environment: 'sandbox', credential: 'document', mock: false }),
    funds: () => [{ id: 'stack', policyHash }],
    snapshot: async (session) => { calls.push(session); return { wallet: session.wallet, policyHash, identityVerified: false }; },
    activity: async (session) => ({ wallet: session.wallet, events: [], source: 'unavailable' }),
    quote: async (session, body) => ({ wallet: session.wallet, amount: body.amount, indicative: true }),
    prepare: async (session, body) => ({ wallet: session.wallet, kind: body.kind }),
    confirm: async () => ({ status: 'pending' }),
    attestIdentity: async (session) => ({ status: 'refused', wallet: session.wallet, reason: 'Synthetic test performs no chain writes' }),
  };
  const server = createApp(null, OPERATOR, null, null, null, null, { investor: { auth, service } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { body, token, origin = ORIGIN, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('/v1/investor/config')).status, 200);
  assert.equal((await call('/v1/investor/funds')).status, 200);
  assert.equal((await call('/v1/investor/me')).status, 401);
  assert.equal((await call('/v1/investor/me', { token: OPERATOR })).status, 401);
  assert.equal((await call('/v1/investor/me', { token: `demo_${'0'.repeat(64)}` })).status, 401);
  assert.equal((await call('/v1/investor/auth/challenge', { body: { wallet: wallet.address, fundId: 'stack' }, origin: 'https://untrusted.invalid' })).status, 403);
  const challenge = (await call('/v1/investor/auth/challenge', { body: { wallet: wallet.address, fundId: 'stack' } })).body;
  const proof = { protocol_version: '4.0', nonce: challenge.world.rp_context.nonce, action: 'humanity', environment: 'sandbox', responses: [{ identifier: 'passport', issuer_schema_id: 9303, nullifier: id('synthetic person'), signal_hash: hashSignal(wallet.address.toLowerCase()), expires_at_min: 0, proof: ['0x1', '0x2', '0x3', '0x4', '0x5'] }] };
  const request = { challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message), proof };
  const login = await call('/v1/investor/auth/verify', { body: request });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const token = login.body.accessToken;
  assert.match(token, /^ia_/);
  assert.equal(login.body.session.credential, 'document');
  assert.equal(login.body.session.verification, undefined);
  const me = await call('/v1/investor/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.wallet, wallet.address.toLowerCase());
  assert.equal(me.body.identityVerified, false, 'login is not a fabricated on-chain attestation');
  assert.equal(calls[0].role, 'investor');
  assert.ok(calls[0].id, 'server session has a unique internal identity');
  for (const path of ['/v1/agreements', '/v1/settings/signing', '/v1/stack/wallets']) assert.equal((await call(path, { token })).status, 401);
  assert.equal((await call('/v1/investor/fund', { token, body: { amount: '100' } })).status, 404);
  assert.equal((await call('/v1/investor/auth/verify', { body: request })).status, 401);
  assert.equal((await call('/v1/investor/quote', { token, body: { wallet: 'other', amount: '1' } })).body.wallet, wallet.address.toLowerCase());
  assert.equal((await call('/v1/investor/auth/logout', { token, body: {} })).body.revoked, true);
  assert.equal((await call('/v1/investor/me', { token })).status, 401);
});
