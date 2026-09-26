import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, funded, compliant } from './helpers.js';
import { amountUnits, MirrorService } from '../src/service.js';
import { Store } from '../src/store.js';
import { MockChain } from '../src/onchain/chain.js';
import { AppError } from '../src/errors.js';

test('amounts use exact integers, rejecting floats, negatives, zero and overflow', () => {
  assert.equal(amountUnits('9007199254740993.000001'), 9007199254740993000001n);
  for (const value of [0.1, '-1', '0', '1e6', '0.0000001', '01', '', '9'.repeat(78), null]) assert.throws(() => amountUnits(value), /Amount/);
});
test('funding and onboarding are required, and denials explain the failed clauses', async (t) => {
  const { service, chain } = await setup(t);
  const investor = await service.createInvestor('Alice');
  const deposit = await service.createDeposit(investor.id, '100');
  const body = { investorId: investor.id, depositId: deposit.id, amount: '100' };
  await assert.rejects(service.operate('mint', body, 'mint'), (error) => error.code === 'POLICY_DENIED' && error.details.reasons.includes('funds-received'));
  await service.setCompliance(investor.id, compliant);
  await assert.rejects(service.operate('mint', body, 'mint'), { code: 'POLICY_DENIED' });
  await service.settleMock('deposits', deposit.id);
  await service.operate('mint', body, 'mint');
  assert.equal(await chain.totalSupply(), 100000000n);
});
test('mint/redeem/withdrawal lifecycle and idempotent retries preserve backing', async (t) => {
  const { service, chain } = await setup(t);
  const { investor, body, deposit } = await funded(service);
  const original = await service.operate('mint', body, 'mint-1');
  assert.deepEqual(await service.operate('mint', body, 'mint-1'), original);
  assert.equal(service.snapshot().deposits[deposit.id].consumedUnits, '100000000');
  await assert.rejects(service.operate('mint', body, 'mint-2'), { code: 'POLICY_DENIED' });
  await assert.rejects(service.operate('mint', { ...body, amount: '1' }, 'mint-1'), { code: 'IDEMPOTENCY_CONFLICT' });
  const burn = await service.operate('burn', { investorId: investor.id, amount: '25' }, 'burn-1');
  assert.equal(service.snapshot().withdrawals[burn.id].status, 'pending');
  assert.equal((await service.settleMock('withdrawals', burn.id)).status, 'settled');
  assert.equal(service.investor(investor.id).balanceUnits, '75000000');
  assert.equal(await chain.totalSupply(), 75000000n);
  await assert.rejects(service.operate('burn', { investorId: investor.id, amount: '76' }, 'too-much'), { code: 'POLICY_DENIED' });
});
test('sanctions, revoked KYC and cross-investor deposits prevent signing', async (t) => {
  const { service, chain } = await setup(t);
  const { investor, body } = await funded(service);
  const other = await service.createInvestor('Other');
  await service.setCompliance(other.id, compliant);
  await assert.rejects(service.operate('mint', { ...body, investorId: other.id }, 'theft'), { code: 'POLICY_DENIED' });
  await service.setCompliance(investor.id, { sanctionsClear: false });
  await assert.rejects(service.operate('mint', body, 'sanctioned'), { code: 'POLICY_DENIED' });
  await service.setCompliance(investor.id, { sanctionsClear: true });
  await service.operate('mint', body, 'mint');
  await service.setCompliance(investor.id, { kycApproved: false });
  await assert.rejects(service.operate('burn', { investorId: investor.id, amount: '1' }, 'kyc-expired'), { code: 'POLICY_DENIED' });
  assert.equal(await chain.totalSupply(), 100000000n);
});
test('concurrent requests cannot spend a deposit or investor balance twice', async (t) => {
  const { service, chain } = await setup(t);
  const { investor, body } = await funded(service);
  const mints = await Promise.allSettled(['a', 'b'].map((key) => service.operate('mint', body, key)));
  assert.equal(mints.filter((result) => result.status === 'fulfilled').length, 1);
  const burns = await Promise.allSettled(['c', 'd'].map((key) => service.operate('burn', { investorId: investor.id, amount: '75' }, key)));
  assert.equal(burns.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(await chain.totalSupply(), 25000000n);
});
test('crash after chain execution recovers after restart with no duplicate mint', async (t) => {
  const { service, chain, store, directory, policy } = await setup(t);
  const { investor, body } = await funded(service);
  const execute = chain.execute.bind(chain);
  chain.execute = async (operation) => { await execute(operation); throw new Error('Lost RPC response'); };
  await assert.rejects(service.operate('mint', body, 'recover-me'), { code: 'CHAIN_CONFIRMATION_PENDING' });
  assert.equal(service.investor(investor.id).balanceUnits, '0');
  assert.equal(await chain.totalSupply(), 100000000n);
  await assert.rejects(service.setCompliance(investor.id, { sanctionsClear: false }), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(service.operate('mint', body, 'another-key'), { code: 'RECONCILIATION_REQUIRED' });
  store.close();
  const reopened = new Store(directory);
  try {
    const recoveredChain = new MockChain(reopened, policy);
    const recovered = await new MirrorService({ store: reopened, chain: recoveredChain, policy }).init();
    assert.equal((await recovered.operate('mint', body, 'recover-me')).status, 'confirmed');
    assert.equal(await recoveredChain.totalSupply(), 100000000n);
    assert.equal(recovered.investor(investor.id).balanceUnits, '100000000');
  } finally { reopened.close(); }
});
test('failed burn never creates a payout and leaves balance available', async (t) => {
  const { service, chain } = await setup(t);
  const { investor, body } = await funded(service);
  await service.operate('mint', body, 'mint');
  chain.execute = async () => { throw new AppError(409, 'CHAIN_REJECTED', 'reverted'); };
  await assert.rejects(service.operate('burn', { investorId: investor.id, amount: '25' }, 'burn'), { code: 'CHAIN_REJECTED' });
  assert.equal(Object.keys(service.snapshot().withdrawals).length, 0);
  assert.equal(service.investor(investor.id).balanceUnits, '100000000');
  assert.equal(service.pending(), undefined);
});
test('single writer lock and supply reconciliation fail closed', async (t) => {
  const { service, store, directory } = await setup(t);
  assert.throws(() => new Store(directory), /locked/);
  const { body } = await funded(service);
  store.update((state) => { state.chain.supply = '1'; });
  await assert.rejects(service.operate('mint', body, 'mint'), { code: 'SUPPLY_MISMATCH' });
});
