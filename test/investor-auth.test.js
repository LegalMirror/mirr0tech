import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Signature } from 'ethers';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { AppError } from '../src/errors.js';
import { InvestorAuth, INVESTOR_AUTH_LIMITS as L, publicSession } from '../src/investor-auth.js';
import { HumanRegistry, WorldIdError, WorldIdVerifier, mockProof } from '../src/worldid.js';

// Public, unfunded test keys; all World responses, contexts, clocks and storage are injected.
// No dotenv, RPC, disk registry, actual RP signing key or external verification is used.
const A = new Wallet(`0x${'01'.repeat(32)}`);
const B = new Wallet(`0x${'02'.repeat(32)}`);
const ORIGIN = 'https://investor.example';
const OTHER_ORIGIN = 'https://other.example';
const POLICY = `0x${'ab'.repeat(32)}`;
const OTHER_POLICY = `0x${'cd'.repeat(32)}`;
const NULLIFIER = `0x${'42'.repeat(32)}`;
const START = 1900000000000;
const code = (expected, status) => (error) => {
  assert.ok(error instanceof AppError || error instanceof WorldIdError);
  assert.equal(error.code, expected);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
};
const metadata = (i = 1, origin = ORIGIN) => ({ origin, clientIp: `198.18.${Math.floor(i / 256)}.${i % 256}` });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Only NODE_ENV is changed, restored for every test. All verifier options are explicit so
// developer WORLD_* variables cannot influence the suite. Unexpected global fetch fails.
test.beforeEach((t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  t.mock.method(globalThis, 'fetch', () => assert.fail('External fetch is forbidden in investor auth tests'));
});

function fixture({ ttlSeconds = 900, chainId = 11155111, environment = 'sandbox', mock = false } = {}) {
  const calls = { resolve: [], context: [], verify: [], fetch: [], bind: [] };
  const state = { now: START, nonce: 0, client: 0 };
  const memory = new HumanRegistry();
  const verifier = new WorldIdVerifier({
    rpId: mock === false ? 'rp_synthetic' : null, appId: mock === false ? 'app_synthetic' : null,
    signingKeyHex: null, action: 'onboard-investor', credential: 'document', environment, mock,
    url: 'https://world.invalid/api/v4/verify', timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      const proof = JSON.parse(init.body);
      calls.fetch.push({ url, init, proof });
      if (state.fetchImpl) return state.fetchImpl(proof, init);
      return jsonResponse({ success: true, results: [{ identifier: proof.responses[0].identifier,
        success: true, nullifier: proof.responses[0].nullifier }] });
    },
  });
  verifier.context = async () => {
    const now = Math.floor(state.now / 1000);
    const rpId = verifier.mock ? 'rp_mock' : verifier.rpId;
    const value = {
      app_id: verifier.mock ? 'app_mock' : verifier.appId, rp_id: rpId, action: verifier.action,
      credential: verifier.credential, environment: verifier.mock ? 'mock' : verifier.environment,
      mock: verifier.mock, allow_legacy_proofs: false,
      rp_context: { rp_id: rpId, nonce: `0x${(++state.nonce).toString(16).padStart(64, '0')}`,
        created_at: now, expires_at: now + 300, signature: verifier.mock ? '0xmock' : `0x${'aa'.repeat(65)}` },
    };
    calls.context.push(value);
    return state.contextImpl ? state.contextImpl(value) : value;
  };
  const realVerify = verifier.verify.bind(verifier);
  verifier.verify = async (proof, wallet) => {
    calls.verify.push({ proof, wallet });
    return state.verifyImpl ? state.verifyImpl(proof, wallet, realVerify) : realVerify(proof, wallet);
  };
  // A path sentinel satisfies live configuration validation; this facade never opens it.
  const registry = { path: 'synthetic-only:in-memory-registry', async bind(nullifier, wallet) {
    calls.bind.push({ nullifier, wallet });
    return state.bindImpl ? state.bindImpl(nullifier, wallet) : memory.bind(nullifier, wallet);
  } };
  const forbidden = () => assert.fail('Login must not invoke a chain writer or operator capability');
  const venue = {
    record: { chainId, rwa: { policyHash: POLICY } }, policies: { rwa: { policy: { hash: POLICY } } },
    worldId: { verifier, registry }, provider: { getNetwork: forbidden, send: forbidden },
    attest: forbidden, attestMerged: forbidden, verifyHuman: forbidden, fund: forbidden, deploy: forbidden,
  };
  const funds = new Map(['fund-a', 'fund-b'].map((id) => [id, { id, venue }]));
  const resolveFund = async (id) => {
    calls.resolve.push(id);
    if (state.resolveImpl) return state.resolveImpl(id);
    return funds.get(id);
  };
  const auth = new InvestorAuth({ resolveFund, allowedOrigins: [ORIGIN, OTHER_ORIGIN], ttlSeconds, allowLocalMock: mock === true, clock: () => state.now });
  return { auth, calls, state, verifier, registry, memory, venue, funds, resolveFund,
    nextMetadata: () => metadata(++state.client),
    advance: (seconds) => { state.now += seconds * 1000; },
    changePolicy: () => { venue.record.rwa.policyHash = OTHER_POLICY; venue.policies.rwa.policy.hash = OTHER_POLICY; },
  };
}

function proofFor(challenge, wallet = A.address) {
  if (challenge.world.mock) return mockProof(wallet);
  return {
    protocol_version: '4.0', nonce: challenge.world.rp_context.nonce, action: challenge.world.action,
    environment: challenge.world.environment,
    responses: [{ identifier: 'passport', issuer_schema_id: 9303, nullifier: NULLIFIER,
      signal_hash: hashSignal(wallet.toLowerCase()), expires_at_min: challenge.expiresAt,
      proof: ['0x1', '0x2', '0x3', '0x4', '0x5'] }],
  };
}
async function prepared(h, { wallet = A, fundId = 'fund-a', meta = h.nextMetadata() } = {}) {
  const challenge = await h.auth.challenge({ wallet: wallet.address, fundId }, meta);
  const body = { challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message), proof: proofFor(challenge, wallet.address) };
  return { challenge, body, meta };
}
async function login(h, options) {
  const p = await prepared(h, options);
  return h.auth.verify(p.body, p.meta);
}
function successfulResult(h, overrides = {}) {
  return { success: true, nullifier: NULLIFIER, credential: 'document', action: h.verifier.action,
    environment: h.verifier.mock ? 'mock' : h.verifier.environment, mock: h.verifier.mock, ...overrides };
}

for (const environment of ['sandbox', 'staging', 'production']) {
  test(`${environment}: signed EOA + injected World Passport success issues only a scoped investor session`, async () => {
    const h = fixture({ environment, ttlSeconds: 60 });
    const { challenge, body, meta } = await prepared(h);
    const issued = JSON.parse(challenge.message.slice(challenge.message.indexOf('{')));
    assert.deepEqual(issued, {
      version: 1, wallet: A.address.toLowerCase(), fundId: 'fund-a', policyHash: POLICY, chainId: 11155111,
      credential: 'document', environment, mock: false, action: 'onboard-investor', rpId: 'rp_synthetic', appId: 'app_synthetic',
      origin: ORIGIN, nonce: challenge.challengeId, worldNonce: challenge.world.rp_context.nonce,
      issuedAt: START / 1000, expiresAt: START / 1000 + L.challengeSeconds,
    });
    assert.match(challenge.message, /EIP-191/);
    assert.match(challenge.message, /does not authorize a transaction or establish KYC\/AML approval/);
    assert.match(challenge.challengeId, /^[a-f0-9]{64}$/);
    const result = await h.auth.verify(body, meta);
    assert.match(result.accessToken, /^ia_[a-zA-Z0-9_-]{43}$/);
    assert.equal(result.expiresAt, START / 1000 + 60);
    assert.deepEqual(result.session, { wallet: A.address.toLowerCase(), fundId: 'fund-a', policyHash: POLICY,
      chainId: 11155111, credential: 'document', environment, mock: false });
    assert.deepEqual(h.calls.fetch[0].proof, body.proof);
    assert.equal(h.calls.verify[0].wallet, A.address.toLowerCase());
    assert.deepEqual(h.calls.bind, [{ nullifier: NULLIFIER, wallet: A.address.toLowerCase() }]);
    const pending = h.auth.authenticate(result.accessToken);
    assert.ok(pending instanceof Promise, 'HTTP middleware must await authenticate');
    const session = await pending;
    assert.equal(session.role, 'investor');
    assert.match(session.id, /^[a-f0-9]{64}$/);
    assert.equal(session.expiresAt, result.expiresAt);
    assert.deepEqual(session.verification, successfulResult(h));
    assert.ok(Object.isFrozen(session) && Object.isFrozen(session.verification));
    assert.deepEqual(publicSession(session), result.session);
    for (const field of ['id', 'verification', 'nullifier', 'role', 'accessToken', 'signingKeyHex', 'apiKey']) {
      assert.equal(Object.hasOwn(result.session, field), false);
    }
    assert.equal(h.calls.fetch.length, 1);
    await assert.rejects(h.auth.verify(body, meta), code('CHALLENGE_INVALID', 401));
    assert.equal(h.calls.fetch.length, 1);
  });
}

test('64-byte compact EIP-2098 signatures use the same EIP-191 message', async () => {
  const h = fixture();
  const p = await prepared(h);
  p.body.signature = Signature.from(p.body.signature).compactSerialized;
  assert.equal((await h.auth.verify(p.body, p.meta)).session.wallet, A.address.toLowerCase());
});

test('constructor rejects unsafe TTL, resolver, clock, mock opt-in and origin configurations', () => {
  const base = { resolveFund: async () => null, allowedOrigins: [ORIGIN] };
  for (const options of [
    { resolveFund: null }, { clock: 1 }, ...[0, -1, 901, 1.5, NaN, '60'].map((ttlSeconds) => ({ ttlSeconds })),
    ...[null, 0, 1, 'true', 'false', {}, []].map((allowLocalMock) => ({ allowLocalMock })),
    ...['*', `${ORIGIN}/`, `${ORIGIN}/path`, 'null', 'file:///tmp', 'https://u:p@investor.example', 'https://investor.example\n'].map((origin) => ({ allowedOrigins: [origin] })),
    { allowedOrigins: ORIGIN }, { allowedOrigins: Array(33).fill(ORIGIN) },
  ]) assert.throws(() => new InvestorAuth({ ...base, ...options }), code('CONFIG', 500));
  assert.throws(() => new InvestorAuth(), code('CONFIG', 500));
});

test('invalid clocks fail closed before fund resolution', async () => {
  for (const now of [-1, NaN, Infinity, 1.5, '1900000000000']) {
    const h = fixture(); h.state.now = now;
    await assert.rejects(h.auth.challenge({ wallet: A.address, fundId: 'fund-a' }, metadata()), code('CONFIG', 500));
    assert.equal(h.calls.resolve.length, 0);
  }
});

test('strict request fields, wallet/fund syntax, origin and server-resolved IP validation', async (t) => {
  const cases = [
    ['extra privilege', { wallet: A.address, fundId: 'fund-a', role: 'operator' }, metadata(), 'INVALID_BODY', 400],
    ['client mock opt-in', { wallet: A.address, fundId: 'fund-a', allowLocalMock: true }, metadata(), 'INVALID_BODY', 400],
    ['missing fund', { wallet: A.address }, metadata(), 'INVALID_BODY', 400],
    ['array body', [], metadata(), 'INVALID_BODY', 400],
    ['zero wallet', { wallet: `0x${'0'.repeat(40)}`, fundId: 'fund-a' }, metadata(), 'INVALID_WALLET', 400],
    ['named wallet', { wallet: 'Investor', fundId: 'fund-a' }, metadata(), 'INVALID_WALLET', 400],
    ['bad checksum', { wallet: A.address.replace('A', 'a'), fundId: 'fund-a' }, metadata(), 'INVALID_WALLET', 400],
    ['path as fund', { wallet: A.address, fundId: '../fund-a' }, metadata(), 'INVALID_FUND', 400],
    ['long fund', { wallet: A.address, fundId: 'a'.repeat(129) }, metadata(), 'INVALID_FUND', 400],
    ...[null, {}, { origin: ORIGIN }, { ...metadata(), forwardedFor: '198.18.0.2' }].map((meta, i) => [`metadata ${i}`, { wallet: A.address, fundId: 'fund-a' }, meta, 'INVALID_BODY', 400]),
    ...['null', 'https://evil.example', `${ORIGIN}/`, undefined].map((origin) => [`origin ${origin}`, { wallet: A.address, fundId: 'fund-a' }, { ...metadata(), origin }, 'ORIGIN_NOT_ALLOWED', 403]),
    ...['unknown', '198.18.0.1, 198.18.0.2', 'localhost', '', 123].map((clientIp) => [`IP ${clientIp}`, { wallet: A.address, fundId: 'fund-a' }, { ...metadata(), clientIp }, 'INVALID_CLIENT_IP', 400]),
  ];
  for (const [name, body, meta, error, status] of cases) await t.test(name, async () => {
    const h = fixture();
    await assert.rejects(h.auth.challenge(body, meta), code(error, status));
    assert.equal(h.calls.resolve.length, 0);
  });
});

test('invalid or foreign signatures are rejected and consumed before resolver, verifier, registry or proof access', async (t) => {
  for (const kind of ['missing', 'malformed', 'unrecoverable', 'wrong wallet', 'altered fund', 'altered hash', 'altered origin', 'altered chain']) await t.test(kind, async () => {
    const h = fixture(); const p = await prepared(h);
    const before = h.calls.resolve.length;
    if (kind === 'missing') delete p.body.signature;
    if (kind === 'malformed') p.body.signature = '0x1234';
    if (kind === 'unrecoverable') p.body.signature = `0x${'00'.repeat(65)}`;
    if (kind === 'wrong wallet') p.body.signature = await B.signMessage(p.challenge.message);
    const replacements = { 'altered fund': ['fund-a', 'fund-b'], 'altered hash': [POLICY, OTHER_POLICY],
      'altered origin': [ORIGIN, OTHER_ORIGIN], 'altered chain': ['11155111', '31337'] };
    if (replacements[kind]) p.body.signature = await A.signMessage(p.challenge.message.replace(...replacements[kind]));
    Object.defineProperty(p.body, 'proof', { enumerable: true, get() { assert.fail('Signature must be checked before inspecting proof'); } });
    await assert.rejects(h.auth.verify(p.body, p.meta), code(kind === 'missing' ? 'INVALID_BODY' : 'INVALID_SIGNATURE', ['malformed', 'missing'].includes(kind) ? 400 : 401));
    assert.equal(h.calls.resolve.length, before);
    assert.equal(h.calls.verify.length, 0);
    assert.equal(h.calls.bind.length, 0);
    await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
  });
});

test('verify cannot override wallet, fund, policy hash, role or signed message', async () => {
  for (const extra of [{ wallet: B.address }, { fundId: 'fund-b' }, { policyHash: OTHER_POLICY }, { role: 'operator' }, { message: 'anything' }]) {
    const h = fixture(); const p = await prepared(h);
    await assert.rejects(h.auth.verify({ ...p.body, ...extra }, p.meta), code('INVALID_BODY', 400));
    assert.equal(h.calls.verify.length, 0);
  }
});

test('a signature from another fund challenge cannot be spliced into verification', async () => {
  const h = fixture(); const a = await prepared(h); const b = await prepared(h, { fundId: 'fund-b' });
  await assert.rejects(h.auth.verify({ ...b.body, signature: a.body.signature }, b.meta), code('INVALID_SIGNATURE', 401));
  assert.equal(h.calls.verify.length, 0);
  assert.equal((await h.auth.verify(a.body, a.meta)).session.fundId, 'fund-a');
});

test('even another allowed origin cannot use a challenge issued to the first origin', async () => {
  const h = fixture(); const p = await prepared(h);
  await assert.rejects(h.auth.verify(p.body, metadata(2, OTHER_ORIGIN)), code('ORIGIN_NOT_ALLOWED', 403));
  assert.equal(h.calls.verify.length, 0);
  await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
});

test('live proofs must contain the exact issued World nonce, not merely a valid nonce', async (t) => {
  for (const nonce of [undefined, null, '0x1', `0x${'ff'.repeat(32)}`]) await t.test(String(nonce), async () => {
    const h = fixture(); const p = await prepared(h);
    if (nonce === undefined) delete p.body.proof.nonce; else p.body.proof.nonce = nonce;
    await assert.rejects(h.auth.verify(p.body, p.meta), code('INVALID_PROOF', 400));
    assert.equal(h.calls.verify.length, 0);
    assert.equal(h.calls.fetch.length, 0);
    assert.equal(h.calls.bind.length, 0);
  });
  const h = fixture(); const p = await prepared(h); const other = await prepared(h, { fundId: 'fund-b' });
  p.body.proof.nonce = other.body.proof.nonce;
  await assert.rejects(h.auth.verify(p.body, p.meta), code('INVALID_PROOF', 400));
});

test('real WorldIdVerifier rejects foreign wallet signals, credentials, environments and recurring/legacy proofs before fake provider', async (t) => {
  const cases = [
    ['wallet', (p) => { p.responses[0].signal_hash = hashSignal(B.address.toLowerCase()); }, 'INVALID_PROOF'],
    ['schema', (p) => { p.responses[0].issuer_schema_id = 1; }, 'WRONG_CREDENTIAL'],
    ['mock identifier', (p) => { p.responses[0].identifier = 'mock'; }, 'WRONG_CREDENTIAL'],
    ['environment', (p) => { p.environment = 'staging'; }, 'INVALID_PROOF'],
    ['action', (p) => { p.action = 'different-action'; }, 'INVALID_PROOF'],
    ['recurring session', (p) => { p.session_id = 'synthetic-session'; }, 'INVALID_PROOF'],
    ['session nullifier', (p) => { p.responses[0].session_nullifier = ['0x1']; }, 'INVALID_PROOF'],
    ['legacy', (p) => { p.protocol_version = '3.0'; }, 'INVALID_PROOF'],
    ['multiple credentials', (p) => { p.responses.push(structuredClone(p.responses[0])); }, 'INVALID_PROOF'],
  ];
  for (const [name, mutate, error] of cases) await t.test(name, async () => {
    const h = fixture(); const p = await prepared(h); mutate(p.body.proof);
    await assert.rejects(h.auth.verify(p.body, p.meta), code(error, 400));
    assert.equal(h.calls.verify.length, 1);
    assert.equal(h.calls.fetch.length, 0);
    assert.equal(h.calls.bind.length, 0);
  });
});

test('proof structural and byte limits reject hostile JSON before the verifier', async (t) => {
  const cases = [
    ['null', () => null], ['array', () => []], ['non-JSON object', () => new Date(0)],
    ['long string', (p) => ({ ...p, extra: 'x'.repeat(2049) })],
    ['long array', (p) => ({ ...p, extra: Array(33).fill(0) })],
    ['many keys', (p) => ({ ...p, ...Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 0])) })],
    ['long key', (p) => ({ ...p, ['k'.repeat(65)]: 0 })],
    ['deep tree', (p) => ({ ...p, extra: Array.from({ length: 9 }).reduce((v) => ({ next: v }), 0) })],
    ['many nodes', (p) => ({ ...p, extra: Array.from({ length: 16 }, () => Array(16).fill(0)) })],
    ['total bytes', (p) => ({ ...p, extra: Array(9).fill('x'.repeat(2000)) })],
    ['UTF-8 bytes', (p) => ({ ...p, extra: Array(4).fill('界'.repeat(1500)) })],
    ['cycle', (p) => { p.extra = p; return p; }],
    ...[undefined, NaN, Infinity, 1n, () => {}, Symbol('synthetic')].map((extra, i) => [`non-JSON value ${i}`, (p) => ({ ...p, extra })]),
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const h = fixture(); const p = await prepared(h); p.body.proof = mutate(p.body.proof);
    await assert.rejects(h.auth.verify(p.body, p.meta), code('INVALID_PROOF', 400));
    assert.equal(h.calls.verify.length, 0);
    assert.equal(h.calls.bind.length, 0);
  });
});

test('proof is deeply snapshotted before the first await; mutation cannot change nonce, wallet signal or nullifier', async () => {
  const h = fixture(); const p = await prepared(h); const original = structuredClone(p.body.proof);
  const entered = deferred(), release = deferred();
  h.state.resolveImpl = async (id) => { entered.resolve(); await release.promise; return h.funds.get(id); };
  const pending = h.auth.verify(p.body, p.meta);
  await entered.promise;
  p.body.proof.nonce = `0x${'ff'.repeat(32)}`;
  p.body.proof.responses[0].nullifier = '0xff';
  p.body.proof.responses[0].signal_hash = hashSignal(B.address.toLowerCase());
  p.body.challengeId = '0'.repeat(64); p.body.signature = '0x00';
  release.resolve();
  const result = await pending;
  assert.equal(result.session.wallet, A.address.toLowerCase());
  assert.deepEqual(h.calls.verify[0].proof, original);
  assert.ok(Object.isFrozen(h.calls.verify[0].proof.responses[0].proof));
  assert.deepEqual(h.calls.bind, [{ nullifier: NULLIFIER, wallet: A.address.toLowerCase() }]);
});

test('simultaneous replay reaches the provider and registry exactly once', async () => {
  const h = fixture(); const p = await prepared(h);
  const entered = deferred(), release = deferred();
  h.state.verifyImpl = async (proof, wallet, realVerify) => { entered.resolve(); await release.promise; return realVerify(proof, wallet); };
  const first = h.auth.verify(p.body, p.meta);
  await entered.promise;
  try { await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401)); }
  finally { release.resolve(); }
  const result = await first;
  assert.ok(result.accessToken);
  assert.equal(h.calls.verify.length, 1);
  assert.equal(h.calls.bind.length, 1);
});

test('same-wallet/fund/origin challenges stay independent while ready or still creating', async () => {
  const h = fixture(); const p = await prepared(h); const otherFund = await prepared(h, { fundId: 'fund-b' });
  const otherOrigin = await prepared(h, { meta: metadata(3, OTHER_ORIGIN) });
  const entered = deferred(), release = deferred();
  h.state.contextImpl = async (value) => { entered.resolve(); await release.promise; return value; };
  const creating = prepared(h);
  await entered.promise;
  h.state.contextImpl = null;
  let fresh;
  try { fresh = await prepared(h); }
  finally { release.resolve(); }
  const requests = [p, otherFund, otherOrigin, await creating, fresh];
  assert.equal(new Set(requests.map((request) => request.challenge.challengeId)).size, requests.length);
  for (const request of requests) {
    assert.ok((await h.auth.verify(request.body, request.meta)).accessToken);
    await assert.rejects(h.auth.verify(request.body, request.meta), code('CHALLENGE_INVALID', 401));
  }
  assert.equal(h.calls.verify.length, requests.length);
  assert.equal(h.calls.bind.length, requests.length);
});

for (const stage of ['provider', 'registry']) {
  test(`a new challenge during ${stage} wait cannot cancel the first login or reopen its replay guard`, async () => {
    const h = fixture(); const p = await prepared(h); const entered = deferred(), release = deferred();
    if (stage === 'provider') h.state.verifyImpl = async (proof, wallet, realVerify) => { entered.resolve(); await release.promise; return realVerify(proof, wallet); };
    else h.state.bindImpl = async (nullifier, wallet) => { entered.resolve(); await release.promise; return h.memory.bind(nullifier, wallet); };
    const pending = h.auth.verify(p.body, p.meta);
    await entered.promise;
    let fresh;
    try {
      fresh = await prepared(h);
      await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
    } finally { release.resolve(); }
    const first = await pending;
    assert.equal(h.calls.bind.length, 1);
    const second = await h.auth.verify(fresh.body, fresh.meta);
    assert.notEqual(second.accessToken, first.accessToken, 'first cleanup must not delete the independent challenge');
    await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
    await assert.rejects(h.auth.verify(fresh.body, fresh.meta), code('CHALLENGE_INVALID', 401));
    assert.equal(h.calls.verify.length, 2);
    assert.equal(h.calls.bind.length, 2);
  });
}

test('challenge expires exactly at its deadline, including during provider verification', async () => {
  for (const inFlight of [false, true]) {
    const h = fixture(); const p = await prepared(h);
    if (inFlight) h.state.verifyImpl = async (proof, wallet, realVerify) => { h.advance(L.challengeSeconds); return realVerify(proof, wallet); };
    else h.advance(L.challengeSeconds);
    await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
    assert.equal(h.calls.verify.length, inFlight ? 1 : 0);
    assert.equal(h.calls.bind.length, 0);
  }
});

test('World context deadline shortens the challenge rather than extending it', async () => {
  for (const lifetime of [30, 600]) {
    const h = fixture();
    h.state.contextImpl = (value) => { value.rp_context.expires_at = START / 1000 + lifetime; return value; };
    const p = await prepared(h);
    assert.equal(p.challenge.expiresAt, START / 1000 + Math.min(lifetime, L.challengeSeconds));
    h.advance(Math.min(lifetime, L.challengeSeconds));
    await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
  }
});

const scopeChanges = [
  ['policy hash', (h) => h.changePolicy()], ['chain', (h) => { h.venue.record.chainId = 1; }],
  ['action', (h) => { h.verifier.action = 'other-action'; }], ['environment', (h) => { h.verifier.environment = 'staging'; }],
  ['RP', (h) => { h.verifier.rpId = 'rp_other'; }], ['app', (h) => { h.verifier.appId = 'app_other'; }],
];
test('every signed scope field is rechecked before verification and on token authentication', async (t) => {
  for (const [name, change] of scopeChanges) await t.test(name, async () => {
    const h = fixture(); const p = await prepared(h); change(h);
    await assert.rejects(h.auth.verify(p.body, p.meta), code('AUTH_SCOPE_CHANGED', 409));
    assert.equal(h.calls.verify.length, 0);
    const active = fixture(); const result = await login(active); change(active);
    await assert.rejects(active.auth.authenticate(result.accessToken), code('INVESTOR_UNAUTHORIZED', 401));
    assert.equal(active.auth.revoke(result.accessToken), false, 'scope-invalid tokens are removed');
  });
});

for (const stage of ['context', 'provider', 'registry']) {
  test(`scope changes while awaiting ${stage} fail closed`, async () => {
    const h = fixture();
    if (stage === 'context') {
      h.state.contextImpl = (value) => { h.changePolicy(); return value; };
      await assert.rejects(prepared(h), code('AUTH_SCOPE_CHANGED', 409));
    } else {
      const p = await prepared(h);
      if (stage === 'provider') h.state.verifyImpl = async (proof, wallet, realVerify) => { const result = await realVerify(proof, wallet); h.changePolicy(); return result; };
      else h.state.bindImpl = async (nullifier, wallet) => { await h.memory.bind(nullifier, wallet); h.changePolicy(); };
      await assert.rejects(h.auth.verify(p.body, p.meta), code('AUTH_SCOPE_CHANGED', 409));
      assert.equal(h.calls.bind.length, stage === 'registry' ? 1 : 0);
      if (stage === 'registry') assert.equal(h.memory.walletOf(NULLIFIER), A.address.toLowerCase(), 'persisted binding is not rolled back');
    }
  });
}

test('invalidated fund/credential/mock/storage configuration revokes active sessions', async (t) => {
  for (const [name, change] of [
    ['unpublished', (h) => h.funds.delete('fund-a')], ['wrong resolver identity', (h) => { h.funds.get('fund-a').id = 'fund-b'; }],
    ['credential', (h) => { h.verifier.credential = 'selfie'; }], ['mock', (h) => { h.verifier.mockMode = true; }],
    ['storage', (h) => { h.registry.path = null; }], ['compiled policy', (h) => { h.venue.policies.rwa.policy.hash = OTHER_POLICY; }],
    ['resolver failure', (h) => { h.state.resolveImpl = () => { throw new Error('synthetic private resolver detail'); }; }],
  ]) await t.test(name, async () => {
    const h = fixture(); const result = await login(h); change(h);
    await assert.rejects(h.auth.authenticate(result.accessToken), code('INVESTOR_UNAUTHORIZED', 401));
    assert.equal(h.auth.revoke(result.accessToken), false);
  });
});

test('fund lookup and deployment configuration fail before context generation', async (t) => {
  const cases = [
    ['missing fund', (h) => h.funds.clear(), 'FUND_NOT_FOUND', 404],
    ['foreign fund', (h) => { h.funds.get('fund-a').id = 'fund-b'; }, 'FUND_NOT_FOUND', 404],
    ['resolver 404', (h) => { h.state.resolveImpl = () => { throw new AppError(404, 'PRIVATE', 'synthetic detail'); }; }, 'FUND_NOT_FOUND', 404],
    ['resolver error', (h) => { h.state.resolveImpl = () => { throw new Error('synthetic detail'); }; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
    ['missing registry', (h) => { h.venue.worldId.registry = null; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
    ['no persistent registry', (h) => { h.registry.path = null; }, 'WORLD_REGISTRY_REQUIRED', 503],
    ['policy mismatch', (h) => { h.venue.policies.rwa.policy.hash = OTHER_POLICY; }, 'POLICY_MISMATCH', 503],
    ['malformed policy', (h) => { h.venue.record.rwa.policyHash = '0x1'; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
    ['string chain', (h) => { h.venue.record.chainId = '11155111'; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
    ['no chain', (h) => { h.venue.record.chainId = 0; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
    ['weaker credential', (h) => { h.verifier.credential = 'proof_of_human'; }, 'WRONG_CREDENTIAL', 403],
    ['bad app', (h) => { h.verifier.appId = ''; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
    ['bad RP', (h) => { h.verifier.rpId = 'wrong'; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
    ['bad action', (h) => { h.verifier.action = 'action\n'; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
    ['bad environment', (h) => { h.verifier.environment = 'unknown'; }, 'INVESTOR_AUTH_UNAVAILABLE', 503],
  ];
  for (const [name, change, error, status] of cases) await t.test(name, async () => {
    const h = fixture(); change(h);
    await assert.rejects(prepared(h), code(error, status));
    assert.equal(h.calls.context.length, 0);
  });
});

test('malformed or mismatched World contexts never become signable challenges', async (t) => {
  const mutations = [
    ['app_id', 'app_other'], ['rp_id', 'rp_other'], ['action', 'other'], ['credential', 'selfie'],
    ['environment', 'staging'], ['mock', true], ['allow_legacy_proofs', true],
  ].map(([key, value]) => [key, (c) => { c[key] = value; }]);
  mutations.push(...[
    ['rp_id', 'rp_other'], ['nonce', '0x1'], ['created_at', START / 1000 + 31], ['created_at', -1],
    ['expires_at', START / 1000], ['expires_at', 1.5], ['signature', '0xmock'],
  ].map(([key, value]) => [`rp_context.${key}: ${value}`, (c) => { c.rp_context[key] = value; }]));
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const h = fixture(); h.state.contextImpl = (value) => { mutate(value); return value; };
    await assert.rejects(prepared(h), code('WORLD_CONTEXT_INVALID', 503));
    h.state.contextImpl = null;
    assert.ok((await prepared(h)).challenge.challengeId, 'failed context releases capacity');
  });
});

test('challenge context and session serializers whitelist public fields', async () => {
  const h = fixture();
  h.state.contextImpl = (value) => ({ ...value, signingKeyHex: 'synthetic-private-marker', unexpected: true,
    rp_context: { ...value.rp_context, secret: 'synthetic-private-marker' } });
  const p = await prepared(h);
  assert.equal(JSON.stringify(p.challenge).includes('synthetic-private-marker'), false);
  assert.ok(Object.isFrozen(p.challenge.world) && Object.isFrozen(p.challenge.world.rp_context));
  assert.deepEqual(publicSession({ wallet: 'a', fundId: 'b', policyHash: 'c', chainId: 1,
    credential: 'document', environment: 'sandbox', mock: false, role: 'operator', verification: { nullifier: NULLIFIER }, secret: 'synthetic' }),
  { wallet: 'a', fundId: 'b', policyHash: 'c', chainId: 1, credential: 'document', environment: 'sandbox', mock: false });
});

test('inconsistent injected verifier results cannot bind a human or issue a token', async (t) => {
  const results = [null, [], {}, { success: false }, { success: 'true' }, { nullifier: 'bad' }, { nullifier: '0x' },
    { nullifier: `0x${'f'.repeat(65)}` }, { credential: 'selfie' }, { environment: 'staging' }, { mock: true }, { action: 'other' }];
  for (const [i, result] of results.entries()) await t.test(`result ${i}`, async () => {
    const h = fixture(); const p = await prepared(h);
    h.state.verifyImpl = async () => result === null || Array.isArray(result) || Object.keys(result).length === 0 ? result : successfulResult(h, result);
    await assert.rejects(h.auth.verify(p.body, p.meta), code('WORLD_INVALID_RESPONSE', 502));
    assert.equal(h.calls.bind.length, 0);
  });
});

test('provider rejection, foreign nullifier and outages are never upgraded to success', async (t) => {
  for (const [name, response, error, status] of [
    ['false', jsonResponse({ success: false }), 'INVALID_PROOF', 400],
    ['empty', jsonResponse({}), 'WORLD_INVALID_RESPONSE', 502],
    ['migration', jsonResponse({ success: false, code: 'app_not_migrated', detail: 'synthetic-private-marker' }, 400), 'APP_NOT_MIGRATED', 400],
    ['outage', jsonResponse({}, 503), 'WORLD_UNAVAILABLE', 503],
    ['foreign nullifier', jsonResponse({ success: true, results: [{ identifier: 'passport', success: true, nullifier: '0xff' }] }), 'WORLD_INVALID_RESPONSE', 502],
  ]) await t.test(name, async () => {
    const h = fixture(); const p = await prepared(h); h.state.fetchImpl = async () => response;
    await assert.rejects(h.auth.verify(p.body, p.meta), (e) => { code(error, status)(e); assert.ok(!e.message.includes('synthetic-private-marker')); return true; });
    assert.equal(h.calls.bind.length, 0);
    await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
  });
});

test('World and registry errors are sanitized; failures consume challenges and release slots', async (t) => {
  for (const [stage, error, expected, status] of [
    ['context', new Error('synthetic-private-marker'), 'WORLD_UNAVAILABLE', 503],
    ['verify', new WorldIdError(503, 'WORLD_TIMEOUT', 'synthetic-private-marker'), 'WORLD_TIMEOUT', 503],
    ['verify', new WorldIdError(418, 'toString', 'synthetic-private-marker'), 'WORLD_UNAVAILABLE', 503],
    ['bind', new Error('synthetic-private-marker'), 'REGISTRY_UNAVAILABLE', 503],
    ['bind', new WorldIdError(503, 'REGISTRY_BUSY', 'synthetic-private-marker'), 'REGISTRY_BUSY', 503],
    ['bind', new WorldIdError(409, 'HUMAN_ALREADY_BOUND', 'synthetic-private-marker'), 'HUMAN_ALREADY_BOUND', 409],
  ]) await t.test(`${stage}: ${expected}`, async () => {
    const h = fixture(); const p = stage === 'context' ? null : await prepared(h);
    h.state[`${stage}Impl`] = async () => { throw error; };
    await assert.rejects(p ? h.auth.verify(p.body, p.meta) : prepared(h), (e) => {
      code(expected, status)(e); assert.ok(!e.message.includes('synthetic-private-marker')); return true;
    });
    h.state[`${stage}Impl`] = null;
    if (p) await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
    assert.ok((await login(h)).accessToken);
  });
});

test('canonical registry binding permits the same wallet but rejects a concurrent second wallet', async () => {
  const h = fixture(); const a = await prepared(h); const b = await prepared(h, { wallet: B });
  a.body.proof.responses[0].nullifier = '0xAB';
  b.body.proof.responses[0].nullifier = `0x${'ab'.padStart(64, '0')}`;
  const settled = await Promise.allSettled([h.auth.verify(a.body, a.meta), h.auth.verify(b.body, b.meta)]);
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = settled.find((r) => r.status === 'rejected'); code('HUMAN_ALREADY_BOUND', 409)(failed.reason);
  const winner = settled.find((r) => r.status === 'fulfilled').value;
  assert.equal(h.memory.walletOf('0xAB'), winner.session.wallet);
  assert.ok(h.calls.bind.every((call) => call.nullifier === `0x${'ab'.padStart(64, '0')}`));
  const again = await prepared(h, { wallet: winner.session.wallet === A.address.toLowerCase() ? A : B });
  again.body.proof.responses[0].nullifier = '0xAB';
  assert.ok((await h.auth.verify(again.body, again.meta)).accessToken);
});

test('tokens expire at the deadline, do not slide, and revocation is per-token/idempotent', async () => {
  const h = fixture({ ttlSeconds: 2 }); const first = await login(h); const second = await login(h);
  assert.notEqual(first.accessToken, second.accessToken);
  h.advance(1);
  assert.equal((await h.auth.authenticate(first.accessToken)).expiresAt, first.expiresAt);
  assert.equal(h.auth.revoke(first.accessToken), true);
  assert.equal(h.auth.revoke(first.accessToken), false);
  await assert.rejects(h.auth.authenticate(first.accessToken), code('INVESTOR_UNAUTHORIZED', 401));
  assert.ok(await h.auth.authenticate(second.accessToken));
  h.advance(1);
  await assert.rejects(h.auth.authenticate(second.accessToken), code('INVESTOR_UNAUTHORIZED', 401));
  assert.equal(h.auth.revoke(second.accessToken), false);
});

test('token lookup rejects malformed, unknown, operator and viewer tokens without resolving a fund', async () => {
  const h = fixture(); const active = await login(h); const before = h.calls.resolve.length;
  for (const token of [undefined, null, {}, '', 'synthetic-operator-key', 'synthetic-viewer-key', `Bearer ${active.accessToken}`,
    'ia_short', `ia_${'a'.repeat(42)}`, `ia_${'a'.repeat(44)}`, `ia_${'!'.repeat(43)}`, `ia_${'z'.repeat(43)}`]) {
    await assert.rejects(h.auth.authenticate(token), code('INVESTOR_UNAUTHORIZED', 401));
    assert.equal(h.auth.revoke(token), false);
  }
  assert.equal(h.calls.resolve.length, before);
});

for (const change of ['revoke', 'expire', 'scope']) {
  test(`authenticate rechecks ${change} after asynchronous fund resolution`, async () => {
    const h = fixture({ ttlSeconds: 10 }); const result = await login(h);
    const entered = deferred(), release = deferred();
    h.state.resolveImpl = async (id) => { entered.resolve(); await release.promise; return h.funds.get(id); };
    const rejected = assert.rejects(h.auth.authenticate(result.accessToken), code('INVESTOR_UNAUTHORIZED', 401));
    await entered.promise;
    if (change === 'revoke') h.auth.revoke(result.accessToken);
    if (change === 'expire') h.advance(10);
    if (change === 'scope') h.changePolicy();
    release.resolve(); await rejected;
  });
}

test('per-IP challenge and verify budgets count malformed requests and reset only at the window boundary', async () => {
  const h = fixture();
  for (let i = 0; i < L.challengePerIp; i++) await assert.rejects(h.auth.challenge({}, metadata()), code('INVALID_BODY', 400));
  for (let i = 0; i < L.verifyPerIp; i++) await assert.rejects(h.auth.verify({}, metadata()), code('INVALID_BODY', 400));
  await assert.rejects(h.auth.challenge({}, metadata()), code('AUTH_RATE_LIMITED', 429));
  await assert.rejects(h.auth.verify({}, metadata()), code('AUTH_RATE_LIMITED', 429));
  h.advance(L.rateWindowSeconds - 1);
  await assert.rejects(h.auth.challenge({}, metadata()), code('AUTH_RATE_LIMITED', 429));
  h.advance(1);
  await assert.rejects(h.auth.challenge({}, metadata()), code('INVALID_BODY', 400));
  await assert.rejects(h.auth.verify({}, metadata()), code('INVALID_BODY', 400));
  assert.equal(h.calls.resolve.length, 0);
});

test('equivalent IPv6 spellings cannot multiply the per-IP rate budget', async () => {
  const h = fixture(); const first = { origin: ORIGIN, clientIp: '2001:db8::1' };
  const alias = { origin: ORIGIN, clientIp: '2001:0db8:0000:0000:0000:0000:0000:0001' };
  for (let i = 0; i < L.challengePerIp; i++) await assert.rejects(h.auth.challenge({}, i % 2 ? first : alias), code('INVALID_BODY', 400));
  await assert.rejects(h.auth.challenge({}, first), code('AUTH_RATE_LIMITED', 429));
});

test('global budgets cannot be bypassed by rotating client IPs', async () => {
  for (const [route, limit, perIp] of [['challenge', L.challengeGlobal, L.challengePerIp], ['verify', L.verifyGlobal, L.verifyPerIp]]) {
    const h = fixture();
    for (let i = 0; i < limit; i++) await assert.rejects(h.auth[route]({}, metadata(Math.floor(i / perIp) + 1)), code('INVALID_BODY', 400));
    await assert.rejects(h.auth[route]({}, metadata(999)), code('AUTH_RATE_LIMITED', 429));
    h.advance(L.rateWindowSeconds);
    await assert.rejects(h.auth[route]({}, metadata(999)), code('INVALID_BODY', 400));
  }
});

test('combined route/IP rate-key memory is bounded and expired keys are reclaimed', async () => {
  const h = fixture(); const challenges = L.challengeGlobal - 1;
  for (let i = 0; i < challenges; i++) await assert.rejects(h.auth.challenge({}, metadata(i + 1)), code('INVALID_BODY', 400));
  for (let i = 0; i < L.maxRateKeys - challenges; i++) await assert.rejects(h.auth.verify({}, metadata(i + 1)), code('INVALID_BODY', 400));
  await assert.rejects(h.auth.verify({}, metadata(2000)), code('AUTH_RATE_LIMITED', 429));
  await assert.rejects(h.auth.verify({}, metadata(1)), code('INVALID_BODY', 400), 'an existing key still fits');
  h.advance(L.rateWindowSeconds);
  await assert.rejects(h.auth.verify({}, metadata(2000)), code('INVALID_BODY', 400));
});

test('same-wallet challenge memory is bounded without evicting a victim; consumption and expiry reclaim capacity', async () => {
  const h = fixture(); const victim = await prepared(h);
  for (let i = 1; i < L.maxChallenges; i++) {
    await h.auth.challenge({ wallet: A.address, fundId: 'fund-a' }, h.nextMetadata());
  }
  const before = h.calls.context.length;
  for (const wallet of [A.address, B.address]) {
    await assert.rejects(h.auth.challenge({ wallet, fundId: 'fund-a' }, h.nextMetadata()), code('AUTH_CAPACITY', 503));
  }
  assert.equal(h.calls.context.length, before);
  assert.ok((await h.auth.verify(victim.body, victim.meta)).accessToken);
  assert.ok((await prepared(h)).challenge.challengeId, 'consumption releases only its own slot');
  h.advance(L.challengeSeconds);
  assert.ok((await prepared(h)).challenge.challengeId);
});

test('in-flight challenge work is bounded and released on resolver failure', async () => {
  const h = fixture(); const release = deferred();
  h.state.resolveImpl = async () => { await release.promise; throw new Error('synthetic resolver failure'); };
  const pending = Array.from({ length: L.maxInFlight }, (_, i) => assert.rejects(h.auth.challenge({
    wallet: `0x${(i + 1).toString(16).padStart(40, '0')}`, fundId: 'fund-a',
  }, h.nextMetadata()), code('INVESTOR_AUTH_UNAVAILABLE', 503)));
  try {
    await assert.rejects(h.auth.challenge({ wallet: A.address, fundId: 'fund-a' }, h.nextMetadata()), code('AUTH_BUSY', 503));
    assert.equal(h.calls.resolve.length, L.maxInFlight);
  } finally { release.resolve(); }
  await Promise.all(pending);
  h.state.resolveImpl = null;
  assert.ok((await login(h)).accessToken);
});

test('session reservations prevent parallel successes from exceeding capacity; revoke/expiry free slots', async () => {
  const h = fixture(); const tokens = [];
  for (let i = 0; i < L.maxSessions - 1; i++) tokens.push((await login(h)).accessToken);
  const a = await prepared(h); const b = await prepared(h, { fundId: 'fund-b' });
  const entered = deferred(), release = deferred();
  h.state.verifyImpl = async (proof, wallet, realVerify) => { entered.resolve(); await release.promise; return realVerify(proof, wallet); };
  const pending = h.auth.verify(a.body, a.meta); await entered.promise;
  const before = h.calls.verify.length;
  try { await assert.rejects(h.auth.verify(b.body, b.meta), code('AUTH_CAPACITY', 503)); }
  finally { release.resolve(); }
  tokens.push((await pending).accessToken);
  assert.equal(h.calls.verify.length, before);
  h.state.verifyImpl = null;
  await assert.rejects(login(h), code('AUTH_CAPACITY', 503));
  assert.equal(h.auth.revoke(tokens[0]), true);
  assert.ok((await login(h)).accessToken);
  h.advance(900);
  assert.ok((await login(h)).accessToken);
  await assert.rejects(h.auth.authenticate(tokens[1]), code('INVESTOR_UNAUTHORIZED', 401));
});

test('verification in-flight limit is shared with challenge work and failures release all reservations', async () => {
  const h = fixture(); const requests = [];
  for (let i = 0; i <= L.maxInFlight; i++) {
    const fundId = `fund-${i}`; h.funds.set(fundId, { id: fundId, venue: h.venue });
    requests.push(await prepared(h, { fundId }));
  }
  const entered = deferred(), release = deferred(); let count = 0;
  h.state.verifyImpl = async () => {
    if (++count === L.maxInFlight) entered.resolve();
    await release.promise;
    throw new WorldIdError(503, 'WORLD_TIMEOUT', 'synthetic timeout');
  };
  const pending = requests.slice(0, -1).map((p) => assert.rejects(h.auth.verify(p.body, p.meta), code('WORLD_TIMEOUT', 503)));
  await entered.promise;
  try {
    const last = requests.at(-1);
    await assert.rejects(h.auth.verify(last.body, last.meta), code('AUTH_BUSY', 503));
    await assert.rejects(prepared(h), code('AUTH_BUSY', 503));
  } finally { release.resolve(); }
  await Promise.all(pending);
  h.state.verifyImpl = null;
  for (let i = 0; i < L.maxSessions; i++) assert.ok((await login(h)).accessToken, 'no failed verification may leak a session reservation');
});

test('unknown challenge IDs and untrusted origins cannot trigger provider work', async () => {
  const h = fixture(); const p = await prepared(h);
  for (const challengeId of ['', 'abc', 'g'.repeat(64), '0'.repeat(64)]) {
    await assert.rejects(h.auth.verify({ ...p.body, challengeId }, p.meta), code(challengeId === '0'.repeat(64) ? 'CHALLENGE_INVALID' : 'INVALID_BODY'));
  }
  await assert.rejects(h.auth.verify(p.body, metadata(2, 'https://untrusted.example')), code('ORIGIN_NOT_ALLOWED', 403));
  assert.equal(h.calls.verify.length, 0);
  assert.ok((await h.auth.verify(p.body, p.meta)).accessToken, 'an untrusted Origin is rejected before consuming a valid challenge');
});

test('response edits cannot change the authoritative wallet, fund, hash or investor-only role', async () => {
  const h = fixture(); const result = await login(h);
  Object.assign(result.session, { wallet: B.address, fundId: 'fund-b', policyHash: OTHER_POLICY, role: 'operator', apiKey: 'synthetic-operator-key' });
  const session = await h.auth.authenticate(result.accessToken);
  assert.equal(session.wallet, A.address.toLowerCase());
  assert.equal(session.fundId, 'fund-a');
  assert.equal(session.policyHash, POLICY);
  assert.equal(session.role, 'investor');
  assert.equal(Object.hasOwn(session, 'apiKey'), false);
  assert.throws(() => { session.role = 'operator'; }, TypeError);
  assert.throws(() => { session.verification.mock = true; }, TypeError);
  const anotherProcess = fixture();
  await assert.rejects(anotherProcess.auth.authenticate(result.accessToken), code('INVESTOR_UNAUTHORIZED', 401));
});

test('real verifier timeout aborts a hung injected transport and never binds a session', async () => {
  const h = fixture(); const p = await prepared(h); let signal;
  h.verifier.timeoutMs = 20;
  h.state.fetchImpl = async (_proof, init) => { signal = init.signal; return new Promise(() => {}); };
  await assert.rejects(h.auth.verify(p.body, p.meta), code('WORLD_TIMEOUT', 503));
  assert.equal(signal.aborted, true);
  assert.equal(h.calls.bind.length, 0);
  await assert.rejects(h.auth.verify(p.body, p.meta), code('CHALLENGE_INVALID', 401));
  h.state.fetchImpl = null;
  assert.ok((await login(h)).accessToken);
});

test('SECURITY: an unsigned request or failed login from another IP cannot cancel the victim challenge', async () => {
  const h = fixture(); const victim = await prepared(h, { meta: metadata(1) });
  const attacker = await h.auth.challenge({ wallet: A.address, fundId: 'fund-a' }, metadata(2));
  await assert.rejects(h.auth.verify({ challengeId: attacker.challengeId,
    signature: await B.signMessage(attacker.message), proof: proofFor(attacker) }, metadata(2)), code('INVALID_SIGNATURE', 401));
  assert.equal(h.calls.verify.length, 0);
  const result = await h.auth.verify(victim.body, victim.meta);
  assert.equal(result.session.wallet, A.address.toLowerCase());
  assert.equal(h.calls.verify.length, 1);
  assert.equal(h.calls.bind.length, 1);
  await assert.rejects(h.auth.verify(victim.body, victim.meta), code('CHALLENGE_INVALID', 401));
});

test('explicit local mock succeeds only as a visibly simulated chain-31337 investor session', async () => {
  const h = fixture({ mock: true, chainId: 31337 }); h.registry.path = null;
  const result = await login(h);
  assert.deepEqual(result.session, { wallet: A.address.toLowerCase(), fundId: 'fund-a', policyHash: POLICY,
    chainId: 31337, credential: 'document', environment: 'mock', mock: true });
  assert.equal((await h.auth.authenticate(result.accessToken)).role, 'investor');
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.calls.bind.length, 1);
});

test('mock login is refused outside chain 31337 or after switching NODE_ENV to production', async () => {
  for (const chainId of [1, 11155111, 31338]) {
    const h = fixture({ mock: true, chainId });
    await assert.rejects(prepared(h), code('MOCK_LOGIN_FORBIDDEN', 403));
    assert.equal(h.calls.context.length, 0);
  }
  const h = fixture({ mock: true, chainId: 31337 }); const result = await login(h); const p = await prepared(h);
  process.env.NODE_ENV = 'production';
  await assert.rejects(h.auth.verify(p.body, p.meta), code('MOCK_LOGIN_FORBIDDEN', 403));
  await assert.rejects(h.auth.authenticate(result.accessToken), code('INVESTOR_UNAUTHORIZED', 401));
  await assert.rejects(prepared(h), code('MOCK_LOGIN_FORBIDDEN', 403));
});

test('SECURITY: implicit WorldIdVerifier mock fallback must not authorize investor login', async () => {
  const h = fixture({ mock: null, chainId: 31337 });
  assert.equal(h.verifier.mock, true, 'worldid.js retains implicit no-config local compatibility');
  await assert.rejects(login(h), code('MOCK_LOGIN_FORBIDDEN', 403));
  assert.equal(h.calls.context.length, 0);
  assert.equal(h.calls.verify.length, 0);
  assert.equal(h.calls.bind.length, 0);
});

test('explicit verifier mock mode alone is insufficient when investor opt-in is omitted or false', async () => {
  for (const options of [{}, { allowLocalMock: false }]) {
    const h = fixture({ mock: true, chainId: 31337 });
    h.auth = new InvestorAuth({ resolveFund: h.resolveFund, allowedOrigins: [ORIGIN], clock: () => h.state.now, ...options });
    await assert.rejects(login(h), code('MOCK_LOGIN_FORBIDDEN', 403));
    assert.equal(h.calls.context.length, 0);
  }
});

test('same-second concurrent logins have distinct immutable server-only session IDs, not extra bearer credentials', async () => {
  const h = fixture(); const a = await prepared(h); const b = await prepared(h);
  const issued = await Promise.all([h.auth.verify(a.body, a.meta), h.auth.verify(b.body, b.meta)]);
  const sessions = await Promise.all(issued.map((result) => h.auth.authenticate(result.accessToken)));
  assert.equal(issued[0].expiresAt, issued[1].expiresAt);
  assert.deepEqual(issued[0].session, issued[1].session);
  assert.notEqual(sessions[0].id, sessions[1].id);
  for (const [i, session] of sessions.entries()) {
    assert.match(session.id, /^[a-f0-9]{64}$/);
    assert.notEqual(session.id, a.challenge.challengeId);
    assert.notEqual(session.id, b.challenge.challengeId);
    assert.equal(Object.hasOwn(issued[i].session, 'id'), false);
    assert.equal(JSON.stringify(issued[i]).includes(session.id), false);
    assert.deepEqual(publicSession(session), issued[i].session);
    assert.equal(session.role, 'investor');
    assert.throws(() => { session.id = '0'.repeat(64); }, TypeError);
    await assert.rejects(h.auth.authenticate(session.id), code('INVESTOR_UNAUTHORIZED', 401));
    assert.equal(h.auth.revoke(session.id), false);
    assert.equal((await h.auth.authenticate(issued[i].accessToken)).id, session.id);
  }
});
