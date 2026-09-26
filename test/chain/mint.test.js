import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractFactory, id, parseUnits } from 'ethers';
import { compileBundle } from '../../src/onchain/solc.js';
import { createRwaMinter, mintInput } from '../../src/onchain/mint.js';
import { startAnvil } from './anvil.js';

test('backend RWA issuance checks eligibility, releases to recipient and resumes without duplicate supply', { timeout: 60000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const backend = await provider.getSigner(0);
  const recipient = await (await provider.getSigner(1)).getAddress();
  const mockPath = 'contracts/test/MintPolicyFixture.sol';
  const artifacts = await compileBundle('core', [['contracts/MirrorToken.sol', 'MirrorToken'], [mockPath, 'MintPolicyFixture']], { overrides: {
    [mockPath]: `pragma solidity ^0.8.24; contract MintPolicyFixture {
      bool public allowed = true;
      function setAllowed(bool value) external { allowed = value; }
      function decide(address,uint8) external view returns(bool,uint16) { return (allowed, 7); }
      function mayTransfer(address) external view returns(bool,uint16) { return (allowed, 8); }
      function poolManager() external pure returns(address) { return address(1); }
    }`,
  } });
  const deploy = async (name, ...args) => {
    const a = artifacts[name];
    const c = await new ContractFactory(a.abi, a.bytecode, backend).deploy(...args);
    await c.waitForDeployment(); return c;
  };
  const oracle = await deploy('MintPolicyFixture');
  const policyHash = id('test-policy');
  const token = await deploy('MirrorToken', 'RWA', 'RWA', await backend.getAddress(), await backend.getAddress(), policyHash, parseUnits('1000', 6), true, true);
  await (await token.configureSecondary(await oracle.getAddress(), await oracle.getAddress())).wait();
  const record = { id: 'agr_test', policyHash, deployment: { token: await token.getAddress(), oracle: await oracle.getAddress(), chainId: 31337 } };
  const policy = { actionOrder: ['mint'] };
  const operation = mintInput({ recipient, amount: '12.345678', requestId: 'test-mint-operation-1' });
  const progress = async (fields) => Object.assign(operation, fields);
  const run = createRwaMinter(backend);
  await (await oracle.setAllowed(false)).wait();
  await assert.rejects(run({ record, policy, operation, progress }), { code: 'POLICY_REFUSED' });
  assert.equal(await token.totalSupply(), 0n);
  await (await oracle.setAllowed(true)).wait();
  await assert.rejects(createRwaMinter(await provider.getSigner(1))({ record, policy, operation, progress }), { code: 'NOT_MINTER' });
  // Simulate a backend failure after the mint has confirmed but before release.
  await assert.rejects(run({ record, policy, operation, progress: async (fields) => {
    await progress(fields);
    if (fields.minted) throw new Error('interrupted');
  } }), /interrupted/);
  assert.equal(await token.balanceOf(await backend.getAddress()), BigInt(operation.units));
  assert.equal(await token.balanceOf(recipient), 0n);
  const mintHash = operation.mintTxHash;
  assert.equal((await run({ record, policy, operation, progress })).status, 'confirmed');
  assert.equal(operation.mintTxHash, mintHash);
  assert.ok(operation.releaseTxHash);
  assert.equal(await token.balanceOf(recipient), BigInt(operation.units));
  await run({ record, policy, operation, progress });
  assert.equal(await token.totalSupply(), BigInt(operation.units));
  assert.equal(await token.balanceOf(await backend.getAddress()), 0n);
});

test('opt-in test deposit attestation preserves identity and expiry while default mint still requires bank confirmation', { timeout: 60000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const backend = await provider.getSigner(0);
  const backendAddress = await backend.getAddress();
  const recipient = await (await provider.getSigner(1)).getAddress();
  const path = 'contracts/test/SubscriptionFixture.sol';
  const artifacts = await compileBundle('core', [['contracts/MirrorToken.sol', 'MirrorToken'], ['contracts/PolicyAttestor.sol', 'PolicyAttestor'], [path, 'SubscriptionFixture']], { overrides: {
    [path]: `pragma solidity ^0.8.24; import {PolicyAttestor} from "contracts/PolicyAttestor.sol";
      contract SubscriptionFixture { PolicyAttestor public attestor; bytes32 public hash;
        constructor(PolicyAttestor a, bytes32 h) { attestor = a; hash = h; }
        function decide(address who,uint8) external view returns(bool,uint16) {
          (uint256 known,uint256 value,) = attestor.factsOf(who,hash);
          if ((known & value & 1) == 0) return (false,2);
          if ((known & value & 2) == 0) return (false,3);
          if ((known & value & 8) == 0) return (false,9);
          return (true,0);
        }
        function poolManager() external pure returns(address) { return address(1); }
        function mayTransfer(address) external pure returns(bool,uint16) { return (true,0); }
      }`,
  } });
  const deploy = async (name, ...args) => { const a = artifacts[name]; const c = await new ContractFactory(a.abi, a.bytecode, backend).deploy(...args); await c.waitForDeployment(); return c; };
  const hash = id('subscription-test');
  const attestor = await deploy('PolicyAttestor', backendAddress);
  const oracle = await deploy('SubscriptionFixture', await attestor.getAddress(), hash);
  const token = await deploy('MirrorToken', 'RWA', 'RWA', backendAddress, backendAddress, hash, parseUnits('1000', 6), true, true);
  await (await token.configureSecondary(await oracle.getAddress(), await oracle.getAddress())).wait();
  const record = { id: 'agr_bypass', policyHash: hash, deployment: { chainId: 31337, token: await token.getAddress(), oracle: await oracle.getAddress() } };
  const policy = { actionOrder: ['mint'], factOrder: ['subscriptionAccepted', 'depositConfirmed', 'identityVerified', 'kycApproved'] };
  const operation = mintInput({ recipient, amount: '10', requestId: 'subscription-test-request', bypassSubscription: true });
  const progress = async fields => Object.assign(operation, fields);
  const run = createRwaMinter(backend);
  await assert.rejects(run({ record, policy, operation, progress }), { code: 'NOT_ATTESTOR' });
  await (await attestor.grantRole(id('ATTESTOR_ROLE'), backendAddress)).wait();
  const now = (await provider.getBlock('latest')).timestamp;
  const expiry = now + 3600;
  // Default mint records subscription only; bank receipt is still required.
  await (await attestor.attest(recipient, hash, 4n, 4n, now, expiry)).wait();
  await assert.rejects(run({ record, policy, operation, progress }), /clause 3/);
  assert.equal(operation.depositTxHash, undefined);
  assert.equal(await token.totalSupply(), 0n);
  const [defaultKnown, defaultValue] = await attestor.factsOf(recipient, hash);
  assert.equal(defaultKnown, 5n); assert.equal(defaultValue, 5n);
  const simulated = mintInput({ recipient, amount: '10', requestId: 'test-deposit-request-0001', bypassSubscription: true, simulateDeposit: true });
  Object.assign(operation, simulated);
  await assert.rejects(run({ record, policy, operation, progress }), /clause 9/);
  assert.equal(await token.totalSupply(), 0n);
  assert.ok(operation.subscriptionTxHash);
  assert.ok(operation.depositTxHash);
  const [known, value] = await attestor.factsOf(recipient, hash);
  assert.equal(known, 7n); assert.equal(value, 7n);
  const [backendKnown] = await attestor.factsOf(backendAddress, hash);
  assert.equal(backendKnown, 0n, "attestations belong to the recipient, not the signer");
  assert.equal(await attestor.expiresAt(recipient, hash), BigInt(expiry));
  await (await attestor.attest(recipient, hash, 15n, 15n, now, expiry)).wait();
  const depositHash = operation.depositTxHash;
  assert.equal((await run({ record, policy, operation, progress })).status, 'confirmed');
  assert.equal(operation.depositTxHash, depositHash, 'retry reuses a live deposit attestation');
  assert.equal(await token.balanceOf(recipient), parseUnits('10', 6));
});


test('all explicit test flags satisfy the real RWA mint and release policy, including mock sanctions', { timeout: 60000 }, async t => {
  const { exportProfile, PROFILES } = await import('../../scripts/export-ui.js');
  const { MINT_TEST_FLAGS } = await import('../../src/onchain/mint.js');
  const { provider } = await startAnvil(t);
  const backend = await provider.getSigner(0), admin = await provider.getSigner(2);
  const backendAddress = await backend.getAddress(), recipient = await (await provider.getSigner(1)).getAddress();
  const policy = await exportProfile(PROFILES.find(p => p.profile === 'rwa-secondary'));
  const hookPath = 'contracts/test/MintHookFixture.sol';
  const artifacts = await compileBundle('core', [['contracts/MirrorToken.sol', 'MirrorToken'], ['contracts/PolicyOracle.sol', 'PolicyOracle'], ['contracts/PolicyAttestor.sol', 'PolicyAttestor'], ['contracts/MockSanctionsOracle.sol', 'MockSanctionsOracle'], [hookPath, 'MintHookFixture']], { overrides: {
    'generated/CompiledPolicy.sol': policy.contractSources['generated/CompiledPolicy.sol'],
    [hookPath]: 'pragma solidity ^0.8.24; contract MintHookFixture { function poolManager() external pure returns(address) { return address(1); } }',
  } });
  const deploy = async (name, ...args) => { const a = artifacts[name]; const c = await new ContractFactory(a.abi, a.bytecode, backend).deploy(...args); await c.waitForDeployment(); return c; };
  const attestor = await deploy('PolicyAttestor', backendAddress);
  await (await attestor.grantRole(id('ATTESTOR_ROLE'), backendAddress)).wait();
  const sanctions = await deploy('MockSanctionsOracle', await admin.getAddress());
  await (await sanctions.connect(admin).setSanctioned(recipient, true)).wait();
  const oracle = await deploy('PolicyOracle', await attestor.getAddress(), await sanctions.getAddress());
  const token = await deploy('MirrorToken', 'RWA', 'RWA', backendAddress, backendAddress, policy.policyHash, parseUnits('1000', 6), true, true);
  const hook = await deploy('MintHookFixture');
  await (await token.configureSecondary(await oracle.getAddress(), await hook.getAddress())).wait();
  const record = { id: 'agr_full_test', policyHash: policy.policyHash, deployment: { chainId: 31337, token: await token.getAddress(), oracle: await oracle.getAddress() } };
  const operation = mintInput({ recipient, amount: '100', requestId: 'all-test-flags-request', bypassSubscription: true, simulateDeposit: true, testAttestations: Object.fromEntries(MINT_TEST_FLAGS.map(({fact}) => [fact,true])) });
  const progress = async fields => Object.assign(operation, fields);
  // No configured mock target means no arbitrary oracle mutation is allowed.
  await assert.rejects(createRwaMinter(backend)({ record, policy, operation, progress }), { code: 'NOT_MOCK_SANCTIONS' });
  assert.equal(await token.totalSupply(), 0n);
  await assert.rejects(createRwaMinter(backend, { mockSanctionsAddress: await sanctions.getAddress() })({ record, policy, operation, progress }), { code: 'NOT_SANCTIONS_ADMIN' });
  const run = createRwaMinter(backend, { mockSanctionsAddress: await sanctions.getAddress(), sanctionsAdmin: admin });
  assert.equal((await run({ record, policy, operation, progress })).status, 'confirmed');
  assert.equal(await sanctions.isSanctioned(recipient), false);
  assert.equal(await token.balanceOf(recipient), parseUnits('100', 6));
  assert.ok(operation.identityVerifiedTxHash);
  assert.ok(operation.sanctionsClearTxHash);
  assert.ok(operation.releaseTxHash);
  const before = await provider.getTransactionCount(backendAddress);
  await run({ record, policy, operation, progress });
  assert.equal(await provider.getTransactionCount(backendAddress), before);
  assert.equal(await token.totalSupply(), parseUnits('100', 6));
});
