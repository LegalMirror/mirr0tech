import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContractFactory, Contract, Wallet, ZeroAddress, id } from 'ethers';
import { startAnvil, warp, DEV_KEY } from './anvil.js';
import { evaluatePolicy } from '../../src/policy/evaluate.js';

const policy = JSON.parse(await readFile('generated/policy.json', 'utf8'));
const clauseTable = JSON.parse(await readFile('generated/clause-table.json', 'utf8'));
const attestorArtifact = JSON.parse(await readFile('artifacts/PolicyAttestor.json', 'utf8'));
const providerArtifact = JSON.parse(await readFile('artifacts/MirrortechRoleProvider.json', 'utf8'));

const FACTS = policy.factOrder;
const ACTIONS = policy.actionOrder;
const bit = (name) => 1n << BigInt(FACTS.indexOf(name));
const pack = (facts) => {
  let known = 0n;
  let value = 0n;
  for (const [name, boolean] of Object.entries(facts)) { known |= bit(name); if (boolean) value |= bit(name); }
  return { known, value };
};
const ADMITTED = {
  mlaExecuted: true, kycApproved: true, amlApproved: true, jurisdictionPermitted: true,
  accreditedInvestor: true, screeningCurrent: true, sanctionsClear: true, lenderCapacityAvailable: true,
};

test('the compiled agreement decides the same way on a real EVM as it does in JavaScript', { timeout: 180_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const admin = new Wallet(DEV_KEY, provider);

  const attestor = await new ContractFactory(attestorArtifact.abi, attestorArtifact.bytecode, admin).deploy(admin.address);
  await attestor.waitForDeployment();
  await (await attestor.grantRole(id('ATTESTOR_ROLE'), admin.address)).wait();
  await (await attestor.grantRole(id('WATCHER_ROLE'), admin.address)).wait();

  const roleProvider = await new ContractFactory(providerArtifact.abi, providerArtifact.bytecode, admin).deploy(await attestor.getAddress());
  await roleProvider.waitForDeployment();

  const validUntil = () => Math.floor(Date.now() / 1000) + policy.config.attestationValiditySeconds;
  const attest = async (subject, facts, until) => {
    const { known, value } = pack(facts);
    const now = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(subject, policy.hash, known, value, now, until ?? (now + policy.config.attestationValiditySeconds))).wait();
  };

  await t.test('the deployment is bound to the hashed source document', async () => {
    assert.equal(await roleProvider.policyHash(), policy.hash);
    assert.equal(await roleProvider.clauseTableHash(), clauseTable.clauseTableHash);
    assert.equal(await roleProvider.isPullProvider(), true);
  });

  await t.test('Solidity and JavaScript agree on randomized fact sets, for every action', async () => {
    const lender = Wallet.createRandom().address;
    for (let round = 0; round < 24; round++) {
      const facts = {};
      for (const name of FACTS) {
        const roll = Math.floor(Math.random() * 3);
        if (roll !== 2) facts[name] = roll === 1;
      }
      await attest(lender, facts);
      for (const [index, action] of ACTIONS.entries()) {
        const expected = evaluatePolicy(policy.ast, action, facts);
        const [allowed, clauseId] = await roleProvider.explain(lender, index);
        assert.equal(allowed, expected.allowed, `${action} disagrees on ${JSON.stringify(facts)}`);
        if (!allowed && clauseId !== 0n) {
          const clause = clauseTable.clauses[Number(clauseId) - 1];
          assert.ok(expected.reasons.includes(clause.ruleId), `clause ${clauseId} is not among ${expected.reasons}`);
        }
      }
    }
  });

  await t.test('an unscreened wallet gets no credential and a screened one does', async () => {
    const stranger = Wallet.createRandom().address;
    assert.equal(await roleProvider.getCredential(stranger), 0n);

    const lender = Wallet.createRandom().address;
    await attest(lender, ADMITTED);
    assert.notEqual(await roleProvider.getCredential(lender), 0n);
    const [allowed] = await roleProvider.explain(lender, ACTIONS.indexOf('deposit'));
    assert.equal(allowed, true);
  });

  await t.test('a lapsed screening withdraws the credential without anyone acting', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, ADMITTED);
    assert.notEqual(await roleProvider.getCredential(lender), 0n);

    await warp(provider, policy.config.attestationValiditySeconds + 60);
    assert.equal(await roleProvider.getCredential(lender), 0n, 'an expired attestation must stop granting');

    const [allowed, clauseId] = await roleProvider.explain(lender, ACTIONS.indexOf('deposit'));
    assert.equal(allowed, false);
    const clause = clauseTable.clauses[Number(clauseId) - 1];
    assert.ok(clause.quote.length > 0);
  });

  await t.test('a sanctions hit between screenings blocks the lender immediately', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, ADMITTED);
    assert.notEqual(await roleProvider.getCredential(lender), 0n);

    await (await attestor.revokeFacts(lender, policy.hash, bit('sanctionsClear'), 'OFAC SDN match')).wait();
    assert.equal(await roleProvider.getCredential(lender), 0n);

    const [allowed, clauseId] = await roleProvider.explain(lender, ACTIONS.indexOf('deposit'));
    assert.equal(allowed, false);
    assert.equal(clauseTable.clauses[Number(clauseId) - 1].ruleId, 'deposit-sanctions');
  });

  await t.test('eligibility is re-checked at payment time, not at onboarding', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, { ...ADMITTED, withdrawalWindowOpen: true, lockupElapsed: true });
    let [allowed] = await roleProvider.mayWithdraw(lender);
    assert.equal(allowed, true);

    await (await attestor.revokeFacts(lender, policy.hash, bit('sanctionsClear'), 'sanctions hit after onboarding')).wait();
    let clauseId;
    [allowed, clauseId] = await roleProvider.mayWithdraw(lender);
    assert.equal(allowed, false, 'a sanctioned lender must not be paid');
    assert.equal(clauseTable.clauses[Number(clauseId) - 1].ruleId, 'withdraw-sanctions');
  });

  await t.test('the lockup and the withdrawal window are enforced separately', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, { ...ADMITTED, withdrawalWindowOpen: true, lockupElapsed: false });
    const [allowed, clauseId] = await roleProvider.mayWithdraw(lender);
    assert.equal(allowed, false);
    assert.equal(clauseTable.clauses[Number(clauseId) - 1].clause, '5.3');
  });

  await t.test('presenting a signed screening certificate admits a lender in one transaction', async () => {
    const lender = Wallet.createRandom();
    const { known, value } = pack(ADMITTED);
    const now = (await provider.getBlock('latest')).timestamp;
    const until = now + policy.config.attestationValiditySeconds;
    const domain = { name: 'Mirrortech Policy Attestor', version: '1', chainId: 31337, verifyingContract: await attestor.getAddress() };
    const types = { Attestation: [
      { name: 'subject', type: 'address' }, { name: 'policyHash', type: 'bytes32' },
      { name: 'known', type: 'uint256' }, { name: 'value', type: 'uint256' },
      { name: 'issuedAt', type: 'uint32' }, { name: 'expiresAt', type: 'uint32' }, { name: 'nonce', type: 'uint256' }] };
    const signature = await admin.signTypedData(domain, types, {
      subject: lender.address, policyHash: policy.hash, known, value, issuedAt: now, expiresAt: until, nonce: 0,
    });
    const data = new (await import('ethers')).AbiCoder().encode(
      ['uint256', 'uint256', 'uint32', 'uint32', 'uint256', 'bytes'], [known, value, now, until, 0, signature]);

    assert.equal(await roleProvider.getCredential(lender.address), 0n);
    await (await roleProvider.validateCredential(lender.address, data)).wait();
    assert.notEqual(await roleProvider.getCredential(lender.address), 0n);
  });

  await t.test('an attestation signed by nobody in particular is refused', async () => {
    const outsider = Wallet.createRandom().connect(provider);
    const lender = Wallet.createRandom().address;
    const now = (await provider.getBlock('latest')).timestamp;
    const domain = { name: 'Mirrortech Policy Attestor', version: '1', chainId: 31337, verifyingContract: await attestor.getAddress() };
    const types = { Attestation: [
      { name: 'subject', type: 'address' }, { name: 'policyHash', type: 'bytes32' },
      { name: 'known', type: 'uint256' }, { name: 'value', type: 'uint256' },
      { name: 'issuedAt', type: 'uint32' }, { name: 'expiresAt', type: 'uint32' }, { name: 'nonce', type: 'uint256' }] };
    const { known, value } = pack(ADMITTED);
    const signature = await outsider.signTypedData(domain, types, {
      subject: lender, policyHash: policy.hash, known, value, issuedAt: now, expiresAt: now + 600, nonce: 0 });
    // ethers surfaces the raw revert for a static call it cannot attribute, so match the selector.
    const selector = id('UnauthorizedAttestor(address)').slice(0, 10);
    await assert.rejects(
      attestor.attestWithSignature(lender, policy.hash, known, value, now, now + 600, 0, signature),
      (error) => String(error.info?.error?.data ?? error.data ?? error.message).includes(selector.slice(2)));
  });

  await t.test('a different document produces a different policy and finds nothing on file', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, ADMITTED);
    const otherPolicy = id('one word changed in the agreement');
    const [known, value] = await attestor.factsOf(lender, otherPolicy);
    assert.equal(known, 0n);
    assert.equal(value, 0n);
  });
});
