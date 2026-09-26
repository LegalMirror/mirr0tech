import test from 'node:test';
import assert from 'node:assert/strict';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { CREDENTIALS, WorldIdError, WorldIdVerifier, mockProof } from '../src/worldid.js';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const NULLIFIER = `0x${'ab'.repeat(32)}`;
const identifiers = { document: 'passport', proof_of_human: 'proof_of_human', selfie: 'selfie' };
const config = { rpId: 'rp_test', appId: null, signingKeyHex: null, action: 'onboard-investor', environment: 'staging', credential: 'document', mock: false };
const code = (expected) => (error) => error instanceof WorldIdError && error.code === expected;

// Structural fixtures based on installed IDKit 4.3.0 ResponseItemV4 and World's v4 OpenAPI.
// These are NOT cryptographic proofs. Every upstream response in this file is injected.
function payload(credential = 'document') {
  return {
    protocol_version: '4.0', nonce: `0x${'12'.repeat(32)}`, action: config.action, environment: config.environment,
    responses: [{ identifier: identifiers[credential], issuer_schema_id: CREDENTIALS[credential], nullifier: NULLIFIER,
      signal_hash: hashSignal(A), expires_at_min: 1900000000, proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
      ...(credential === 'selfie' ? { sybil_score: 10 } : {}) }],
    ...(credential === 'selfie' ? { integrity_bundle: { version: 2, signature_format: 'apple_app_attest', timestamp: 1800000000, signature: 'a1b2c3d4', jwt: 'test.integrity.jwt' } } : {}),
  };
}
function success(proof = payload()) {
  return { success: true, results: [{ identifier: proof.responses[0].identifier, success: true, nullifier: proof.responses[0].nullifier }] };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function verifier(fetchImpl, options = {}) { return new WorldIdVerifier({ ...config, ...options, fetchImpl }); }

for (const credential of Object.keys(CREDENTIALS)) {
  test(`fake upstream success: ${credential} is verified as exactly the submitted wallet-bound v4 credential`, async () => {
    const proof = payload(credential);
    proof.action_description = 'Investor onboarding';
    const original = structuredClone(proof);
    const calls = [];
    const subject = verifier(async (url, init) => { calls.push({ url, init }); return response(success(proof)); }, { credential });
    const result = await subject.verify(proof, A.toUpperCase().replace('0X', '0x'));
    assert.deepEqual(result, { success: true, nullifier: NULLIFIER, action: config.action, credential, environment: config.environment, mock: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://developer.world.org/api/v4/verify/rp_test');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].init.signal instanceof AbortSignal, true);
    assert.deepEqual(JSON.parse(calls[0].init.body), original, 'forward complete IDKit result including integrity material unchanged');
    assert.deepEqual(proof, original, 'never overwrite the client signal or environment to make it pass');
  });
}

test('optional provider metadata is checked, and numerically equivalent nullifiers are canonicalized', async () => {
  const proof = payload();
  proof.responses[0].nullifier = '0xAB';
  const canonical = `0x${'ab'.padStart(64, '0')}`;
  const body = { ...success(proof), environment: 'staging', action: config.action, nullifier: canonical };
  Object.assign(body.results[0], { nullifier: canonical, issuer_schema_id: 9303, signal_hash: hashSignal(A) });
  const result = await verifier(async () => response(body)).verify(proof, A);
  assert.equal(result.nullifier, canonical);
});

test('missing or malformed proof fields fail before contacting World', async (t) => {
  const cases = [
    ['empty object', () => ({})], ['null payload', () => null], ['array payload', () => []],
    ['legacy v3', (p) => { p.protocol_version = '3.0'; }],
    ['missing nonce', (p) => { delete p.nonce; }], ['blank nonce', (p) => { p.nonce = ' '; }],
    ['missing action', (p) => { delete p.action; }], ['wrong action', (p) => { p.action = 'other'; }],
    ['session payload', (p) => { p.session_id = 'session_test'; }],
    ['missing responses', (p) => { delete p.responses; }], ['empty responses', (p) => { p.responses = []; }],
    ['multiple responses', (p) => { p.responses.push(structuredClone(p.responses[0])); }],
    ['null response', (p) => { p.responses[0] = null; }],
    ['missing signal', (p) => { delete p.responses[0].signal_hash; }],
    ['foreign signal', (p) => { p.responses[0].signal_hash = hashSignal(B); }],
    ['empty signal', (p) => { p.responses[0].signal_hash = '0x0'; }],
    ['missing schema', (p) => { delete p.responses[0].issuer_schema_id; }],
    ['string schema', (p) => { p.responses[0].issuer_schema_id = '9303'; }],
    ['missing nullifier', (p) => { delete p.responses[0].nullifier; }],
    ['null nullifier', (p) => { p.responses[0].nullifier = null; }],
    ['object nullifier', (p) => { p.responses[0].nullifier = {}; }],
    ['nonhex nullifier', (p) => { p.responses[0].nullifier = '0xnothex'; }],
    ['unprefixed nullifier', (p) => { p.responses[0].nullifier = '123'; }],
    ['empty hex nullifier', (p) => { p.responses[0].nullifier = '0x'; }],
    ['oversize nullifier', (p) => { p.responses[0].nullifier = `0x${'1'.repeat(65)}`; }],
    ['session response', (p) => { p.responses[0].session_nullifier = ['0x1', '0x2']; }],
    ['missing expiry', (p) => { delete p.responses[0].expires_at_min; }],
    ['negative expiry', (p) => { p.responses[0].expires_at_min = -1; }],
    ['fractional expiry', (p) => { p.responses[0].expires_at_min = 1.5; }],
    ['missing proof', (p) => { delete p.responses[0].proof; }],
    ['legacy encoded proof', (p) => { p.responses[0].proof = `0x${'ab'.repeat(256)}`; }],
    ['short proof', (p) => { p.responses[0].proof.pop(); }],
    ['long proof', (p) => { p.responses[0].proof.push('0x6'); }],
    ['invalid proof element', (p) => { p.responses[0].proof[0] = 'oops'; }],
    ['sparse proof', (p) => { p.responses[0].proof = new Array(5); }],
    ['missing environment', (p) => { delete p.environment; }],
    ['wrong environment', (p) => { p.environment = 'production'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    let proof = payload();
    const changed = mutate(proof);
    if (changed !== undefined) proof = changed;
    let called = false;
    const subject = verifier(async () => { called = true; return response(success()); });
    await assert.rejects(subject.verify(proof, A), code('INVALID_PROOF'));
    assert.equal(called, false);
  });
});

test('wrong or missing credential identifiers and explicit mock proofs never reach the live provider', async () => {
  for (const identifier of [undefined, 'mock', 'orb', 'document', 'selfie', 'proof_of_human']) {
    const proof = payload();
    proof.responses[0].identifier = identifier;
    await assert.rejects(verifier(() => assert.fail('must not fetch')).verify(proof, A), code('WRONG_CREDENTIAL'));
  }
  await assert.rejects(verifier(() => assert.fail('must not fetch')).verify(payload('proof_of_human'), A), code('WRONG_CREDENTIAL'));
  await assert.rejects(verifier(() => assert.fail('must not fetch')).verify(mockProof(A), A), code('WRONG_CREDENTIAL'));
});

test('a live proof requires an actual target wallet, never an omitted wallet or a display name', async () => {
  for (const wallet of [undefined, null, '', 'Investor', '0x123', {}, 123]) {
    await assert.rejects(verifier(() => assert.fail('must not fetch')).verify(payload(), wallet), code('INVALID_PROOF'));
  }
});

test('a real-shaped v3 response is deliberately unsupported, not inferred to have a v4 schema', async () => {
  const legacy = { protocol_version: '3.0', action: config.action, nonce: 'legacy-nonce', environment: 'staging', responses: [
    { identifier: 'orb', merkle_root: '0x1234', nullifier: NULLIFIER, proof: `0x${'ab'.repeat(256)}`, signal_hash: hashSignal(A) },
  ] };
  await assert.rejects(verifier(() => assert.fail('must not fetch')).verify(legacy, A), /legacy and session proofs are not supported/);
});

test('Selfie Check requires the risk score and signed version 2 integrity bundle', async (t) => {
  const cases = [
    ['missing score', (p) => { delete p.responses[0].sybil_score; }],
    ['negative score', (p) => { p.responses[0].sybil_score = -1; }],
    ['fractional score', (p) => { p.responses[0].sybil_score = 1.5; }],
    ['missing bundle', (p) => { delete p.integrity_bundle; }],
    ['old bundle', (p) => { p.integrity_bundle.version = 1; }],
    ['wrong format', (p) => { p.integrity_bundle.signature_format = 'other'; }],
    ['missing timestamp', (p) => { delete p.integrity_bundle.timestamp; }],
    ['missing signature', (p) => { delete p.integrity_bundle.signature; }],
    ['bad signature encoding', (p) => { p.integrity_bundle.signature = 'not-hex'; }],
    ['missing jwt', (p) => { delete p.integrity_bundle.jwt; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const proof = payload('selfie'); mutate(proof);
    await assert.rejects(verifier(() => assert.fail('must not fetch'), { credential: 'selfie' }).verify(proof, A), code('INVALID_PROOF'));
  });
});

test('HTTP 200 alone, partial successes and malformed or inconsistent results never grant verification', async (t) => {
  const cases = [
    ['empty object', () => ({})], ['null body', () => null], ['array body', () => []], ['string body', () => 'ok'],
    ['missing success', (b) => { delete b.success; }], ['truthy success', (b) => { b.success = 'true'; }],
    ['missing results', (b) => { delete b.results; }], ['empty results', (b) => { b.results = []; }],
    ['null result', (b) => { b.results = [null]; }],
    ['extra result', (b) => { b.results.push({ identifier: 'orb', success: true, nullifier: NULLIFIER }); }],
    ['missing identifier', (b) => { delete b.results[0].identifier; }],
    ['wrong credential result', (b) => { b.results[0].identifier = 'proof_of_human'; }],
    ['missing result success', (b) => { delete b.results[0].success; }],
    ['truthy result success', (b) => { b.results[0].success = 1; }],
    ['missing result nullifier', (b) => { delete b.results[0].nullifier; }],
    ['malformed result nullifier', (b) => { b.results[0].nullifier = {}; }],
    ['overlong result nullifier', (b) => { b.results[0].nullifier = `0x${'a'.repeat(65)}`; }],
    ['foreign result nullifier', (b) => { b.results[0].nullifier = '0xff'; }],
    ['foreign top nullifier', (b) => { b.nullifier = '0xff'; }],
    ['malformed top nullifier', (b) => { b.nullifier = null; }],
    ['wrong action', (b) => { b.action = 'other'; }], ['null action', (b) => { b.action = null; }],
    ['wrong environment', (b) => { b.environment = 'production'; }],
    ['null environment', (b) => { b.environment = null; }],
    ['session result', (b) => { b.session_id = 'session_test'; }],
    ['session nullifier', (b) => { b.results[0].session_nullifier = ['0x1', '0x2']; }],
    ['wrong echoed schema', (b) => { b.results[0].issuer_schema_id = 1; }],
    ['wrong echoed signal', (b) => { b.results[0].signal_hash = hashSignal(B); }],
    ['contradictory error code', (b) => { b.code = 'verification_failed'; }],
    ['contradictory result error', (b) => { b.results[0].code = 'verification_failed'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    let body = success();
    const changed = mutate(body);
    if (changed !== undefined) body = changed;
    await assert.rejects(verifier(async () => response(body)).verify(payload(), A), code('WORLD_INVALID_RESPONSE'));
  });
});

test('explicit false responses, non-2xx and provider migration errors fail closed', async () => {
  for (const status of [200, 400, 404]) {
    await assert.rejects(verifier(async () => response({ success: false, code: 'all_verifications_failed', detail: 'invalid proof' }, status)).verify(payload(), A), code('INVALID_PROOF'));
  }
  const failedItem = success(); failedItem.results[0].success = false;
  await assert.rejects(verifier(async () => response(failedItem)).verify(payload(), A), code('INVALID_PROOF'));
  await assert.rejects(verifier(async () => response(success(), 400)).verify(payload(), A), code('INVALID_PROOF'));
  await assert.rejects(verifier(async () => response({ success: false, code: 'app_not_migrated', detail: 'Migrate this RP' }, 400)).verify(payload(), A), code('APP_NOT_MIGRATED'));
  for (const status of [429, 500, 503]) {
    await assert.rejects(verifier(async () => response({ success: false }, status)).verify(payload(), A), code('WORLD_UNAVAILABLE'));
  }
});

test('empty 204, invalid JSON, missing response and network exceptions are not verification', async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 204 }),
    async () => new Response('not JSON', { status: 200 }),
    async () => new Response('', { status: 200 }),
    async () => undefined, async () => ({ ok: true }),
  ]) await assert.rejects(verifier(fetchImpl).verify(payload(), A), code('WORLD_INVALID_RESPONSE'));
  await assert.rejects(verifier(async () => { throw new Error('private upstream configuration'); }).verify(payload(), A), (error) => error.code === 'WORLD_UNAVAILABLE' && !error.message.includes('private'));
});

test('timeout aborts hung fetch and body parsing, even if an injected fetch ignores cancellation', async () => {
  for (const hangBody of [false, true]) {
    let signal;
    const subject = verifier(async (_url, init) => {
      signal = init.signal;
      if (hangBody) return { ok: true, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    }, { timeoutMs: 20 });
    await assert.rejects(subject.verify(payload(), A), code('WORLD_TIMEOUT'));
    assert.equal(signal.aborted, true);
  }
});

test('transport configuration cannot send proofs over plaintext or embed credentials in the URL', () => {
  for (const url of ['http://developer.world.org/api/v4/verify', 'not-a-url', 'https://user:secret@developer.world.org/api/v4/verify', 'https://developer.world.org/api/v4/verify?secret=x', 'https://developer.world.org/api/v4/verify#x']) {
    assert.throws(() => verifier(() => {}, { url }), code('CONFIG'));
  }
});
