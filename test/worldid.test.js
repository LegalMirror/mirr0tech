import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, getBytes, verifyMessage } from 'ethers';
import { computeRpSignatureMessage } from '@worldcoin/idkit-core/signing';
import { passport, proofOfHuman, selfieCheck } from '@worldcoin/idkit-core';
import { WorldIdError, WorldIdVerifier, mockProof } from '../src/worldid.js';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const local = { rpId: null, appId: null, signingKeyHex: null, environment: 'staging', credential: 'document', action: 'onboard-investor' };
const errorCode = (code) => (error) => error instanceof WorldIdError && error.code === code;

// Isolate configuration tests from operator credentials; never use real secrets in this suite.
test.beforeEach((t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
});

test('unconfigured local mode is visibly simulated, with deterministic explicit fixtures', async () => {
  const verifier = new WorldIdVerifier(local);
  const context = await verifier.context();
  assert.equal(context.mock, true);
  assert.equal(context.environment, 'mock');
  assert.equal(context.action, 'onboard-investor');
  assert.equal(context.allow_legacy_proofs, false);
  assert.match(context.rp_context.nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(context.rp_context.signature, '0xmock');
  const result = await verifier.verify(mockProof(A));
  assert.deepEqual(result, { success: true, nullifier: mockProof(A).responses[0].nullifier, action: context.action, credential: 'document', environment: 'mock', mock: true });
  await assert.rejects(verifier.verify({ protocol_version: '2.0' }), errorCode('INVALID_PROOF'));
  await assert.rejects(verifier.verify(mockProof(A, { action: 'other' })), /expected onboard-investor/);
  const notMock = mockProof(A);
  notMock.responses[0].identifier = 'passport';
  await assert.rejects(verifier.verify(notMock), /explicitly simulated/);
  const wrongEnvironment = { ...mockProof(A), environment: 'production' };
  await assert.rejects(verifier.verify(wrongEnvironment), /explicitly simulated/);
});

test('explicit local fixtures retain named wallets and same-nullifier reuse for the denied demo', async () => {
  const verifier = new WorldIdVerifier({ ...local, mock: true });
  const result = await verifier.verify(mockProof('Investor'), B);
  assert.equal(result.mock, true);
  assert.equal(result.nullifier, mockProof('Investor').responses[0].nullifier);
  assert.equal((await verifier.verify(mockProof(A, { nullifier: '0xAB' }))).nullifier, `0x${'ab'.padStart(64, '0')}`);
});

test('the agreement selects the credential; no silent credential downgrade', async () => {
  const human = new WorldIdVerifier({ ...local, credential: 'proof_of_human' });
  await assert.rejects(human.verify(mockProof(A), A), (error) => error.code === 'WRONG_CREDENTIAL' && /proof of human/.test(error.message));
  for (const credential of ['document', 'proof_of_human', 'selfie']) {
    const verifier = new WorldIdVerifier({ ...local, credential });
    assert.equal((await verifier.verify(mockProof(A, { credential }), A)).credential, credential);
  }
});

test('partial, blank, disabled-mock or production configuration never falls back to mock', () => {
  for (const config of [
    { appId: 'app_test' }, { signingKeyHex: 'bad' }, { rpId: '' }, { appId: '' },
    { mock: false }, { mock: 'false' }, { mock: true, rpId: 'rp_test' },
    { environment: 'production' }, { environment: 'production', mock: true },
    { credential: 'toString' }, { environment: 'unknown' }, { action: '' },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: 120001 }, { timeoutMs: NaN },
  ]) assert.throws(() => new WorldIdVerifier({ ...local, ...config }), errorCode('CONFIG'));
  process.env.NODE_ENV = 'production';
  assert.throws(() => new WorldIdVerifier(local), errorCode('CONFIG'));
  assert.throws(() => new WorldIdVerifier({ ...local, mock: true }), errorCode('CONFIG'));
});

test('live context fails without an app or a usable RP signing key, never returns a mock signature', async () => {
  for (const config of [
    {}, { appId: 'app_test' }, { appId: 'rp_test', signingKeyHex: '01'.repeat(32) },
    { appId: 'app_test', signingKeyHex: 'bad' }, { appId: 'app_test', signingKeyHex: '00'.repeat(32) },
  ]) {
    const verifier = new WorldIdVerifier({ ...local, rpId: 'rp_test', ...config });
    assert.equal(verifier.mock, false);
    await assert.rejects(verifier.context(), errorCode('CONFIG'));
  }
});

test('live context uses the installed SDK signing format and exposes public material only', async () => {
  // Public test key, never an operator key or a funded wallet.
  const key = '0x' + '01'.repeat(32);
  const verifier = new WorldIdVerifier({ ...local, rpId: 'rp_test', appId: 'app_test', signingKeyHex: key });
  const context = await verifier.context();
  assert.equal(context.mock, false);
  assert.equal(context.environment, 'staging');
  assert.equal(context.allow_legacy_proofs, false);
  assert.equal(context.rp_context.expires_at - context.rp_context.created_at, 300);
  assert.match(context.rp_context.signature, /^0x[0-9a-f]{130}$/);
  assert.equal(JSON.stringify(context).includes(key.slice(2)), false);
  assert.deepEqual(Object.keys(context.rp_context).sort(), ['created_at', 'expires_at', 'nonce', 'rp_id', 'signature']);
  const { nonce, created_at, expires_at, signature } = context.rp_context;
  const message = computeRpSignatureMessage(getBytes(nonce), created_at, expires_at, context.action);
  assert.equal(verifyMessage(message, signature), new Wallet(key).address);
  assert.notEqual((await verifier.context()).rp_context.nonce, nonce);
});

test('installed IDKit v4 presets accept the wallet as signal, without legacy remapping', () => {
  assert.deepEqual(passport({ signal: A }), { type: 'Passport', signal: A });
  assert.deepEqual(proofOfHuman({ signal: A }), { type: 'ProofOfHuman', signal: A });
  assert.deepEqual(selfieCheck({ signal: A }), { type: 'SelfieCheck', signal: A });
});
