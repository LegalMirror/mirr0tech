import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanRegistry, WorldIdError, WorldIdVerifier, mockProof } from '../src/worldid.js';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';

test('without an rp id the verifier hands out a mock context and accepts well-formed mock proofs only', async () => {
  const verifier = new WorldIdVerifier({ rpId: null });
  const context = await verifier.context();
  assert.equal(context.mock, true);
  assert.equal(context.action, 'onboard-investor');
  assert.match(context.rp_context.nonce, /^0x[0-9a-f]{64}$/);
  const ok = await verifier.verify(mockProof(A));
  assert.equal(ok.success, true);
  assert.equal(ok.nullifier, mockProof(A).responses[0].nullifier, 'the mock nullifier is deterministic per wallet');
  await assert.rejects(verifier.verify({ protocol_version: '2.0' }), (e) => e instanceof WorldIdError && e.code === 'INVALID_PROOF');
  await assert.rejects(verifier.verify(mockProof(A, { action: 'other' })), /expected onboard-investor/);
});

test('with an rp id the verifier posts to the Developer Portal and maps its answer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ success: true, nullifier: '0xabc', action: 'onboard-investor', environment: 'staging' }) }; };
  const verifier = new WorldIdVerifier({ rpId: 'rp_test', environment: 'staging', fetchImpl });
  const result = await verifier.verify(mockProof(A));
  assert.equal(calls[0].url, 'https://developer.world.org/api/v4/verify/rp_test');
  assert.equal(calls[0].body.environment, 'staging');
  assert.equal(result.nullifier, '0xabc');
  const failing = new WorldIdVerifier({ rpId: 'rp_test', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ success: false, code: 'all_verifications_failed', detail: 'invalid proof' }) }) });
  await assert.rejects(failing.verify(mockProof(A)), (e) => e.code === 'INVALID_PROOF' && /invalid proof/.test(e.message));
});

test('the registry binds one human to one wallet and survives a restart', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'mirr0tech-humans-')), 'humans.json');
  const registry = await new HumanRegistry(path).load();
  const nullifier = mockProof(A).responses[0].nullifier;
  await registry.bind(nullifier, A);
  await registry.bind(nullifier, A.toUpperCase().replace('0X', '0x'));
  await assert.rejects(registry.bind(nullifier, B), (e) => e.code === 'HUMAN_ALREADY_BOUND' && e.status === 409);
  const reloaded = await new HumanRegistry(path).load();
  assert.equal(reloaded.walletOf(nullifier).toLowerCase(), A);
});

test('the agreement names the credential: a proof of another kind is refused in plain words', async () => {
  const { WorldIdVerifier, mockProof } = await import('../src/worldid.js');
  const wallet = '0x1111111111111111111111111111111111111111';
  const human = new WorldIdVerifier({ credential: 'proof_of_human' });
  await assert.rejects(human.verify(mockProof(wallet), wallet), (error) => error.code === 'WRONG_CREDENTIAL' && /proof of human/.test(error.message));
  assert.equal((await human.verify(mockProof(wallet, { credential: 'proof_of_human' }), wallet)).success, true);
  assert.equal((await new WorldIdVerifier().verify(mockProof(wallet), wallet)).success, true);
});
