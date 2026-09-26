import test from 'node:test';
import assert from 'node:assert/strict';
import { VenueService } from '../src/venues.js';

function fixture() {
  const wallet = '0x0000000000000000000000000000000000000001';
  const now = 2000000000;
  const calls = [];
  const service = new VenueService({
    provider: { getBlock: async () => ({ timestamp: now }) },
    record: { rwa: {} },
    policies: { rwa: { policy: { hash: 'policy', factOrder: ['identityVerified', 'kycApproved'] } } },
    worldId: {
      verifier: { mock: true, verify: async () => ({ success: true, nullifier: `0x${'1'.repeat(64)}`, credential: 'document', action: 'onboard-investor', environment: 'mock', mock: true }) },
      registry: { bind: async () => wallet },
    },
  });
  service.wallets = { Investor: wallet };
  service.c = { attestor: {
    factsOf: async () => [3n, 3n],
    expiresAt: async () => BigInt(now + 3600),
    attest: async (...args) => { calls.push(args); return {}; },
  } };
  service.run = async (_type, details, execute) => { await execute(); return { ...details, status: 'ok' }; };
  return { service, calls, now };
}

test('generic facts cannot manufacture a World ID grant, including merged facts', async () => {
  const { service, calls } = fixture();
  for (const method of ['attest', 'attestMerged']) {
    await assert.rejects(service[method]('rwa', 'Investor', { identityVerified: true }), (e) => e.code === 'WORLD_PROOF_REQUIRED');
  }
  assert.equal(calls.length, 0);
  await service.attest('rwa', 'Investor', { identityVerified: false });
  assert.equal(calls[0][3], 0n, 'explicit revocation is still available');
});

test('preserving identity or merging facts never extends their existing expiry', async () => {
  const { service, calls, now } = fixture();
  await service.attest('rwa', 'Investor', { kycApproved: true });
  await service.attestMerged('rwa', 'Investor', { kycApproved: true });
  const proof = await service.verifyHuman('Investor', {});
  assert.equal(proof.mock, true);
  assert.equal(proof.credential, 'document');
  assert.equal(proof.environment, 'mock');
  assert.equal(proof.expiresAt, now + 3600);
  assert.ok(calls.every((args) => args[5] === now + 3600));
});

test('invalid validity is rejected before issuing an identity attestation', async () => {
  const { service, calls } = fixture();
  for (const days of [0, -1, 91, 1.5, '30', Infinity]) {
    await assert.rejects(service.verifyHuman('Investor', {}, days), (e) => e.code === 'INVALID_VALIDITY');
  }
  assert.equal(calls.length, 0);
});

test('legacy payment settlement cannot silently price a cashier share at one dollar', async () => {
  const { service, calls } = fixture();
  service.record.rwa.cashier = { enabled: true };
  await assert.rejects(service.settlePayment({ id: 'payment', wallet: 'Investor', amount: '100' }), (e) => e.code === 'CASHIER_PAYMENT_UNSUPPORTED');
  assert.equal(calls.length, 0);
});
