import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AbiCoder, ContractFactory, Wallet, id, MaxUint256 } from 'ethers';
import { startAnvil, warp, DEV_KEY } from './anvil.js';
import { evaluatePolicy } from '../../src/policy/evaluate.js';

const policy = JSON.parse(await readFile('generated/policy.json', 'utf8'));
const clauseTable = JSON.parse(await readFile('generated/clause-table.json', 'utf8'));
const load = async (name) => JSON.parse(await readFile(`artifacts/wildcat-credit/${name}.json`, 'utf8'));
const artifacts = Object.fromEntries(await Promise.all(
  ['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MockWildcatMarket', 'MockERC20', 'MirrortechRoleProvider']
    .map(async (name) => [name, await load(name)])));

const FACTS = policy.factOrder;
const ACTIONS = policy.actionOrder;
const bit = (name) => 1n << BigInt(FACTS.indexOf(name));
const pack = (facts) => {
  let known = 0n;
  let value = 0n;
  for (const [name, boolean] of Object.entries(facts)) { known |= bit(name); if (boolean) value |= bit(name); }
  return { known, value };
};
// What the borrower's compliance function attests. Sanctions and term state are observable and are
// read from their sources, never from the attestation; screeningCurrent is derived from expiry.
const ATTESTED = { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true };
const clauseOf = (clauseId) => clauseTable.clauses[Number(clauseId) - 1];
// ethers surfaces custom errors from estimateGas as raw data, so assertions match the selector.
const revertsWith = (signature) => (error) =>
  String(error.info?.error?.data ?? error.data ?? error.message).includes(id(signature).slice(2, 10));

test('the compiled agreement decides the same way on a real EVM as it does in JavaScript', { timeout: 240_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const admin = new Wallet(DEV_KEY, provider);
  const borrower = await provider.getSigner(1);
  const deploy = async (name, ...args) => {
    const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, admin).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };

  const attestor = await deploy('PolicyAttestor', admin.address);
  for (const role of ['ATTESTOR_ROLE', 'WATCHER_ROLE']) await (await attestor.grantRole(id(role), admin.address)).wait();
  await (await attestor.grantRole(id('BORROWER_ROLE'), await borrower.getAddress())).wait();
  const sanctions = await deploy('MockSanctionsOracle', admin.address);
  const oracle = await deploy('PolicyOracle', await attestor.getAddress(), await sanctions.getAddress());
  const roleProvider = await deploy('MirrortechRoleProvider', await oracle.getAddress());
  const usdc = await deploy('MockERC20', 'Mock USD Coin', 'mUSDC');
  const market = await deploy('MockWildcatMarket', await usdc.getAddress(), await roleProvider.getAddress(), await borrower.getAddress());
  await (await oracle.bindMarket(await market.getAddress())).wait();

  const attest = async (subject, facts, until) => {
    const { known, value } = pack(facts);
    const now = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(subject, policy.hash, known, value, now, until ?? (now + policy.config.attestationValiditySeconds))).wait();
  };
  const explain = async (subject, action) => {
    const [allowed, clauseId] = await roleProvider.explain(subject, ACTIONS.indexOf(action));
    return { allowed, clauseId };
  };

  await t.test('the deployment is bound to the hashed source documents', async () => {
    assert.equal(await roleProvider.policyHash(), policy.hash);
    assert.equal(await roleProvider.clauseTableHash(), clauseTable.clauseTableHash);
    assert.equal(await oracle.policyHash(), policy.hash);
    assert.equal(await roleProvider.isPullProvider(), true);
  });

  await t.test('Solidity and JavaScript agree on randomized fact sets, for every action', async () => {
    const lender = Wallet.createRandom().address;
    const attestable = FACTS.filter((name) => !['sanctionsClear', 'openTermState', 'screeningCurrent'].includes(name));
    for (let round = 0; round < 24; round++) {
      const facts = {};
      for (const name of attestable) {
        const roll = Math.floor(Math.random() * 3);
        if (roll !== 2) facts[name] = roll === 1;
      }
      const sanctioned = Math.random() < 0.3;
      const openTerm = Math.random() < 0.7;
      await (await sanctions.setSanctioned(lender, sanctioned)).wait();
      await (await market.connect(borrower).setOpenTerm(openTerm)).wait();
      await attest(lender, facts);
      const observed = { ...facts, sanctionsClear: !sanctioned, openTermState: openTerm, screeningCurrent: true };
      for (const action of ACTIONS) {
        const expected = evaluatePolicy(policy.ast, action, observed);
        const { allowed, clauseId } = await explain(lender, action);
        assert.equal(allowed, expected.allowed, `${action} disagrees on ${JSON.stringify(observed)}`);
        if (!allowed && clauseId !== 0n) {
          const clause = clauseOf(clauseId);
          if (clause.effect === 'permit') assert.ok(expected.reasons.includes('NO_MATCHING_PERMISSION'), `${action}: permit named without a missing permission`);
          else assert.ok(expected.reasons.includes(clause.ruleId), `clause ${clauseId} is not among ${expected.reasons}`);
        }
      }
    }
    await (await sanctions.setSanctioned(lender, false)).wait();
    await (await market.connect(borrower).setOpenTerm(true)).wait();
  });

  await t.test('an unscreened wallet gets no credential; a screened one deposits into the market', async () => {
    const stranger = Wallet.createRandom().connect(provider);
    assert.equal(await roleProvider.getCredential(stranger.address), 0n);

    const lender = Wallet.createRandom().connect(provider);
    await (await admin.sendTransaction({ to: lender.address, value: 10n ** 18n })).wait();
    await (await usdc.mint(lender.address, 1_000_000n)).wait();
    await (await usdc.connect(lender).approve(await market.getAddress(), MaxUint256)).wait();
    await assert.rejects(market.connect(lender).deposit(1_000_000n), revertsWith('NoDepositCredential(address)'));

    await attest(lender.address, ATTESTED);
    assert.notEqual(await roleProvider.getCredential(lender.address), 0n);
    await (await market.connect(lender).deposit(1_000_000n)).wait();
    assert.equal(await market.balanceOf(lender.address), 1_000_000n);
  });

  await t.test('a lapsed screening withdraws the credential without anyone acting', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, ATTESTED);
    assert.notEqual(await roleProvider.getCredential(lender), 0n);
    await warp(provider, policy.config.attestationValiditySeconds + 60);
    assert.equal(await roleProvider.getCredential(lender), 0n, 'an expired attestation must stop granting');
    const { allowed, clauseId } = await explain(lender, 'deposit');
    assert.equal(allowed, false);
    assert.ok(clauseOf(clauseId).quote.length > 0);
  });

  await t.test('a sanctions designation blocks the lender immediately, from the oracle not the attestor', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, { ...ATTESTED, sanctionsClear: true });
    assert.notEqual(await roleProvider.getCredential(lender), 0n);
    await (await sanctions.setSanctioned(lender, true)).wait();
    assert.equal(await roleProvider.getCredential(lender), 0n, 'an attested sanctionsClear must not override the oracle');
    const { allowed, clauseId } = await explain(lender, 'deposit');
    assert.equal(allowed, false);
    assert.equal(clauseOf(clauseId).ruleId, 'deposit-sanctions');
  });

  await t.test('eligibility is re-checked at payment time, and only the borrower can override a designation', async () => {
    const lender = Wallet.createRandom().connect(provider);
    await (await admin.sendTransaction({ to: lender.address, value: 10n ** 18n })).wait();
    await (await usdc.mint(lender.address, 500_000n)).wait();
    await (await usdc.connect(lender).approve(await market.getAddress(), MaxUint256)).wait();
    await attest(lender.address, ATTESTED);
    await (await market.connect(lender).deposit(500_000n)).wait();
    assert.deepEqual((await roleProvider.mayWithdraw(lender.address))[0], true);

    await (await sanctions.setSanctioned(lender.address, true)).wait();
    let [allowed, clauseId] = await roleProvider.mayWithdraw(lender.address);
    assert.equal(allowed, false, 'a sanctioned lender must not be paid');
    assert.equal(clauseOf(clauseId).ruleId, 'withdraw-sanctions');
    await assert.rejects(market.connect(lender).withdraw(100n), revertsWith('WithdrawalRefused(address,uint16)'));

    await assert.rejects(attestor.overrideFacts(lender.address, policy.hash, bit('borrowerOverride')), revertsWith('AccessControlUnauthorizedAccount(address,bytes32)'));
    await (await attestor.connect(borrower).overrideFacts(lender.address, policy.hash, bit('borrowerOverride'))).wait();
    [allowed] = await roleProvider.mayWithdraw(lender.address);
    assert.equal(allowed, true, 'the Section 13(c)(y) override releases the payment');
    await (await market.connect(lender).withdraw(100n)).wait();
    await (await sanctions.setSanctioned(lender.address, false)).wait();
  });

  await t.test('a fixed-term market blocks withdrawals until it is open term', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, ATTESTED);
    await (await market.connect(borrower).setOpenTerm(false)).wait();
    const [allowed, clauseId] = await roleProvider.mayWithdraw(lender);
    assert.equal(allowed, false);
    assert.equal(clauseOf(clauseId).ruleId, 'withdraw-open-term', 'the refusal names the permission the lender lacks');
    await (await market.connect(borrower).setOpenTerm(true)).wait();
  });

  await t.test('market tokens only move to a wallet the agreement admits', async () => {
    const lender = Wallet.createRandom().connect(provider);
    await (await admin.sendTransaction({ to: lender.address, value: 10n ** 18n })).wait();
    await (await usdc.mint(lender.address, 10_000n)).wait();
    await (await usdc.connect(lender).approve(await market.getAddress(), MaxUint256)).wait();
    await attest(lender.address, ATTESTED);
    await (await market.connect(lender).deposit(10_000n)).wait();
    const stranger = Wallet.createRandom().address;
    await assert.rejects(market.connect(lender).transfer(stranger, 1n), revertsWith('TransferRefused(address,uint16)'));
    const admitted = Wallet.createRandom().address;
    await attest(admitted, ATTESTED);
    await (await market.connect(lender).transfer(admitted, 1n)).wait();
    assert.equal(await market.balanceOf(admitted), 1n);
  });

  await t.test('presenting a signed screening certificate admits a lender in one transaction', async () => {
    const lender = Wallet.createRandom();
    const { known, value } = pack(ATTESTED);
    const now = (await provider.getBlock('latest')).timestamp;
    const until = now + policy.config.attestationValiditySeconds;
    const domain = { name: 'Mirrortech Policy Attestor', version: '1', chainId: 31337, verifyingContract: await attestor.getAddress() };
    const types = { Attestation: [
      { name: 'subject', type: 'address' }, { name: 'policyHash', type: 'bytes32' },
      { name: 'known', type: 'uint256' }, { name: 'value', type: 'uint256' },
      { name: 'issuedAt', type: 'uint32' }, { name: 'expiresAt', type: 'uint32' }, { name: 'nonce', type: 'uint256' }] };
    const signature = await admin.signTypedData(domain, types, {
      subject: lender.address, policyHash: policy.hash, known, value, issuedAt: now, expiresAt: until, nonce: 0 });
    const data = new AbiCoder().encode(['uint256', 'uint256', 'uint32', 'uint32', 'uint256', 'bytes'], [known, value, now, until, 0, signature]);
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
    const { known, value } = pack(ATTESTED);
    const signature = await outsider.signTypedData(domain, types, {
      subject: lender, policyHash: policy.hash, known, value, issuedAt: now, expiresAt: now + 600, nonce: 0 });
    await assert.rejects(
      attestor.attestWithSignature(lender, policy.hash, known, value, now, now + 600, 0, signature),
      revertsWith('UnauthorizedAttestor(address)'));
  });

  await t.test('a different document produces a different policy and finds nothing on file', async () => {
    const lender = Wallet.createRandom().address;
    await attest(lender, ATTESTED);
    const [known, value] = await attestor.factsOf(lender, id('one word changed in the agreement'));
    assert.equal(known, 0n);
    assert.equal(value, 0n);
  });
});
