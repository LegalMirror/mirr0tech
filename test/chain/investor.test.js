import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Contract, ContractFactory, HDNodeWallet, Interface, Transaction, Wallet, id, parseUnits } from 'ethers';
import { startAnvil, DEV_KEY, warp } from './anvil.js';
import { readDocuments } from '../../src/policy/document.js';
import { cashierFixture, cashierConstructorConfig } from '../../src/policy/cashier.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { compileBundle } from '../../src/solc.js';
import { mineHookAddress, deploymentCalldata, DETERMINISTIC_DEPLOYER, CASHIER_HOOK_FLAGS } from '../../src/policy/hookAddress.js';
import { InvestorService } from '../../src/investor-service.js';

const M = 1_000_000n;
const ERC20 = new Interface(['function approve(address spender,uint256 amount) returns (bool)']);
const code = (expected) => (error) => { assert.equal(error.code, expected, error.message); return true; };

// Local fixtures only. No dotenv, deployment scripts, disk artifacts, RPC environment variables,
// external proof requests or MultiBaas clients. Anvil is started on loopback and always stopped.
test('investor service against a real in-memory-compiled v4 cashier on Anvil', { timeout: 300_000 }, async (t) => {
  const document = await readDocuments(['test/human_contracts/ea026411904ex10-9.htm', 'test/human_contracts/nav-cashier-addendum.md']);
  const config = JSON.parse(await readFile('examples/rwa-cashier-config.json', 'utf8'));
  const compiled = compilePolicy(cashierFixture(document), config, document, { demo: true });
  const { policy, clauseTable } = compiled;
  const parameters = cashierConstructorConfig(compiled.cashier);
  const overrides = { 'generated/CompiledPolicy.sol': compiled.compiledPolicy,
    'generated/CompiledMirrorToken.sol': compiled.solidity, 'generated/CompiledCashierTerms.sol': compiled.compiledCashierTerms };
  const artifacts = {};
  for (const bundle of ['core', 'uniswap-v4']) {
    const targets = compiled.contracts.filter(([group, , name]) => group === bundle && name).map(([, path, name]) => [path, name]);
    Object.assign(artifacts, await compileBundle(bundle, targets, { overrides }));
  }
  const { provider } = await startAnvil(t);
  const admin = new Wallet(DEV_KEY, provider);
  // Public, disposable Anvil mnemonic. Signing below happens in this investor wallet, not the service.
  const investor = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/1").connect(provider);
  const stranger = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, "m/44'/60'/0'/0/2").connect(provider);
  const who = investor.address;
  const deploy = async (name, ...args) => {
    const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, admin).deploy(...args);
    await contract.waitForDeployment(); return contract;
  };
  const attestor = await deploy('PolicyAttestor', admin.address);
  await (await attestor.grantRole(id('ATTESTOR_ROLE'), admin.address)).wait();
  const sanctions = await deploy('MockSanctionsOracle', admin.address);
  const oracle = await deploy('PolicyOracle', attestor.target, sanctions.target);
  const token = await deploy('CompiledMirrorToken', admin.address, admin.address);
  const asset = await deploy('MockUSD');
  const manager = await deploy('PoolManager', admin.address);
  const router = await deploy('MirrorCashierRouter', manager.target, parameters);
  const initCode = (await new ContractFactory(artifacts.MirrorCashierHook.abi, artifacts.MirrorCashierHook.bytecode, admin)
    .getDeployTransaction(manager.target, oracle.target, router.target, token.target, asset.target, parameters)).data;
  const mined = mineHookAddress(initCode, CASHIER_HOOK_FLAGS);
  await (await admin.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(mined.salt, initCode) })).wait();
  const hook = new Contract(mined.address, artifacts.MirrorCashierHook.abi, provider);
  await (await token.configureSecondary(oracle.target, hook.target)).wait();
  const tokenFirst = BigInt(token.target) < BigInt(asset.target);
  const poolKey = { currency0: tokenFirst ? token.target : asset.target, currency1: tokenFirst ? asset.target : token.target,
    ...parameters.pool, hooks: hook.target };
  await (await manager.initialize(poolKey, 2n ** 96n)).wait();

  const bit = (name) => {
    const index = policy.factOrder.indexOf(name); assert.ok(index >= 0, `Missing fixture fact ${name}`); return 1n << BigInt(index);
  };
  const eligible = ['kycApproved', 'amlApproved', 'identityVerified', 'issuerAuthorized', 'offeringCompliant',
    'subscriptionAccepted', 'depositConfirmed', 'redemptionAuthorized'].reduce((bits, name) => bits | bit(name), 0n);
  const now = (await provider.getBlock('latest')).timestamp;
  // These are explicit OPERATOR fixture actions, never investor-service side effects.
  await (await attestor.attest(who, policy.hash, eligible, eligible, now, now + 3600)).wait();
  await (await asset.mint(who, 1000n * M)).wait();
  await (await asset.mint(admin.address, 500n * M)).wait();
  await (await asset.transfer(hook.target, 500n * M)).wait();
  const forbidden = [];
  const deny = (name) => () => { forbidden.push(name); throw new Error(`Investor service must not call ${name}`); };
  const venue = {
    provider, signer: { sendTransaction: deny('server.sendTransaction'), signTransaction: deny('server.signTransaction') },
    record: { chainId: 31337, attestor: attestor.target, usdc: asset.target, rwa: { token: token.target, oracle: oracle.target,
      hook: hook.target, router: router.target, poolManager: manager.target, policyHash: policy.hash, poolKey,
      cashier: { enabled: true, asset: asset.target } } },
    c: { token: token.connect(provider), rwaOracle: oracle.connect(provider), hook, v4Router: router.connect(provider),
      attestor: attestor.connect(provider), usdc: asset.connect(provider), cashierAsset: asset.connect(provider) },
    policy: () => ({ policy, clauseTable }),
    worldId: { verifier: { credential: 'document', environment: 'mock', mock: true, action: 'onboard-investor', verify: deny('World proof request') } },
  };
  for (const name of ['signerFor', 'fund', 'deploy', 'attest', 'attestMerged', 'verifyHuman', 'cashierSwap', 'cashierPrefund', 'mint', 'release']) venue[name] = deny(name);
  // The HTTP/auth owner verifies wallet ownership + World proof before constructing this session.
  // This chain test injects a MOCK session; it does not claim to have verified a World Sandbox proof.
  const session = { id: 'local-authenticated-investor-fixture', wallet: who, fundId: 'stack', chainId: 31337, policyHash: policy.hash,
    credential: 'document', environment: 'mock', mock: true, expiresAt: now + 900,
    verification: { success: true, credential: 'document', environment: 'mock', mock: true, action: 'onboard-investor', nullifier: id('local fixture only') } };
  const makeService = () => new InvestorService({ venues: venue, clock: () => now * 1000 });
  const broadcast = async (intent, wallet = investor, overrides = {}) => {
    const request = await wallet.populateTransaction({ ...intent.transaction, ...overrides });
    const signed = await wallet.signTransaction(request);
    const decoded = Transaction.from(signed);
    assert.equal(decoded.from, wallet.address); assert.equal(Number(decoded.chainId), 31337);
    return provider.broadcastTransaction(signed);
  };
  const execute = async (service, intent) => {
    const tx = await broadcast(intent); await tx.wait();
    const result = await service.confirm(session, { intentId: intent.intentId, txHash: tx.hash });
    assert.equal(result.source, 'rpc'); assert.equal(result.status, 'confirmed'); assert.equal(result.finality, 'mined-not-finalized');
    return { tx, result };
  };
  const approve = async (service, buy, amount) => {
    const intent = await service.prepare(session, { kind: 'approval', buy, amount, route: 'cashier' });
    const args = ERC20.decodeFunctionData('approve', intent.transaction.data);
    assert.equal(args.spender, router.target); assert.equal(args.amount, parseUnits(amount, 6));
    assert.equal(intent.transaction.from, who); assert.equal(intent.transaction.to, buy ? asset.target : token.target);
    await execute(service, intent);
    assert.equal(await (buy ? asset : token).allowance(who, router.target), parseUnits(amount, 6));
  };
  let snapshot = await provider.send('evm_snapshot', []);
  const scenario = async (name, run) => t.test(name, async () => {
    await provider.send('evm_revert', [snapshot]); snapshot = await provider.send('evm_snapshot', []);
    await run(makeService()); assert.deepEqual(forbidden, []);
  });

  await scenario('prepare -> investor signs exact approval -> buy/mint -> sell/burn -> RPC confirmations', async (service) => {
    const initial = await service.snapshot(session);
    assert.equal(initial.capabilities.serverTrading, false); assert.equal(initial.capabilities.funding, false);
    assert.equal(initial.cashier.reserveRaw, String(500n * M));
    assert.equal(initial.balances.asset.allowanceRaw, '0');
    const order = { kind: 'swap', buy: true, amount: '100.25', minOut: '100', route: 'cashier' };
    const quote = await service.quote(session, order);
    assert.equal(quote.kind, 'nav-only'); assert.equal(quote.simulated, false); assert.equal(quote.amountOutRaw, String(100n * M));
    await assert.rejects(service.prepare(session, order), code('INSUFFICIENT_ALLOWANCE'));
    await approve(service, true, '100.25');
    const supply = await token.totalSupply(); const reserve = await asset.balanceOf(hook.target);
    const intent = await service.prepare(session, order);
    assert.equal(intent.simulatedAmountOut, '100.0'); assert.equal(await token.totalSupply(), supply, 'eth_call must not mint');
    assert.equal(await asset.balanceOf(hook.target), reserve, 'eth_call must not fund reserves');
    await assert.rejects(service.confirm({ ...session, id: 'foreign-login' }, { intentId: intent.intentId, txHash: id('foreign') }), code('INTENT_NOT_FOUND'));
    const buy = await execute(service, intent);
    assert.equal(buy.result.actualRoute, 'cashier'); assert.equal(buy.result.amountOut, '100.0');
    assert.equal(await token.balanceOf(who), 100n * M); assert.equal(await token.totalSupply(), supply + 100n * M);
    assert.equal(await asset.balanceOf(hook.target), reserve + 100_250_000n); assert.equal(await asset.allowance(who, router.target), 0n);
    await assert.rejects(service.confirm(session, { intentId: intent.intentId, txHash: id('replacement') }), code('INTENT_HASH_CHANGED'));
    await approve(service, false, '100');
    const sellIntent = await service.prepare(session, { kind: 'swap', buy: false, amount: '100', minOut: '99.75', route: 'cashier' });
    const sell = await execute(service, sellIntent);
    assert.equal(sell.result.amountOut, '99.75'); assert.equal(sell.result.actualRoute, 'cashier');
    assert.equal(await token.balanceOf(who), 0n); assert.equal(await token.totalSupply(), supply);
    assert.equal(await asset.balanceOf(who), 999_500_000n); assert.equal(await asset.balanceOf(hook.target), 500_500_000n);
    assert.equal(await token.allowance(who, router.target), 0n);
    const history = await service.activity(session);
    assert.equal(history.source, 'rpc'); assert.equal(history.complete, false);
    assert.equal(history.events.filter((event) => event.event === 'Executed').length, 2);
    assert.equal(history.events.filter((event) => event.event === 'CashierExecuted').length, 2);
    assert.ok(history.events.every((event) => event.wallet === who && event.policyHash === policy.hash));
  });

  await scenario('minimum output and expired calldata are enforced on-chain, not just by a quote', async (service) => {
    await approve(service, true, '100.25');
    const order = { kind: 'swap', buy: true, amount: '100.25', minOut: '100.000001', route: 'cashier' };
    await assert.rejects(service.prepare(session, order), code('SIMULATION_REFUSED'));
    const latest = (await provider.getBlock('latest')).timestamp;
    await assert.rejects(service.prepare(session, { ...order, minOut: '100', deadline: latest }), code('INVALID_DEADLINE'));
    const intent = await service.prepare(session, { ...order, minOut: '100', deadline: latest + 5 });
    const before = [await token.totalSupply(), await asset.balanceOf(who), await asset.balanceOf(hook.target)];
    await warp(provider, 6);
    const tx = await broadcast(intent, investor, { gasLimit: 2_000_000 });
    const mined = await tx.wait().catch((error) => error.receipt);
    assert.equal(mined.status, 0);
    await assert.rejects(service.confirm(session, { intentId: intent.intentId, txHash: tx.hash }), code('INTENT_EXPIRED'));
    assert.deepEqual([await token.totalSupply(), await asset.balanceOf(who), await asset.balanceOf(hook.target)], before);
  });

  await scenario('a mined policy revocation after prepare returns reverted and cannot change balances', async (service) => {
    await approve(service, true, '10.025');
    const intent = await service.prepare(session, { kind: 'swap', buy: true, amount: '10.025', minOut: '10', route: 'cashier' });
    const latest = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(who, policy.hash, eligible, eligible & ~bit('identityVerified'), latest, latest + 3600)).wait();
    const before = [await token.totalSupply(), await asset.balanceOf(who), await asset.balanceOf(hook.target)];
    const tx = await broadcast(intent, investor, { gasLimit: 2_000_000 });
    const mined = await tx.wait().catch((error) => error.receipt); assert.equal(mined.status, 0);
    const result = await service.confirm(session, { intentId: intent.intentId, txHash: tx.hash });
    assert.equal(result.status, 'reverted'); assert.equal(result.receipt.status, 0);
    assert.deepEqual([await token.totalSupply(), await asset.balanceOf(who), await asset.balanceOf(hook.target)], before);
  });

  await scenario('foreign wallet transaction cannot confirm an otherwise byte-identical approval', async (service) => {
    const intent = await service.prepare(session, { kind: 'approval', buy: true, amount: '10', route: 'cashier' });
    const tx = await broadcast(intent, stranger, { from: stranger.address }); await tx.wait();
    await assert.rejects(service.confirm(session, { intentId: intent.intentId, txHash: tx.hash }), code('TRANSACTION_MISMATCH'));
    assert.equal(await asset.allowance(who, router.target), 0n);
  });

  await scenario('real RPC pending receipt then confirmation, without a service signer', async (service) => {
    const intent = await service.prepare(session, { kind: 'approval', buy: true, amount: '10', route: 'cashier' });
    await provider.send('evm_setAutomine', [false]);
    try {
      const tx = await broadcast(intent);
      assert.equal((await service.confirm(session, { intentId: intent.intentId, txHash: tx.hash })).status, 'pending');
      await provider.send('evm_mine', []);
      assert.equal((await service.confirm(session, { intentId: intent.intentId, txHash: tx.hash })).status, 'confirmed');
    } finally { await provider.send('evm_setAutomine', [true]); }
  });

  await scenario('a previously confirmed transaction is not cached as success after an Anvil rollback', async (service) => {
    const intent = await service.prepare(session, { kind: 'approval', buy: true, amount: '10', route: 'cashier' });
    const before = await provider.send('evm_snapshot', []);
    const { tx } = await execute(service, intent);
    await provider.send('evm_revert', [before]); await provider.send('evm_mine', []);
    assert.equal((await service.confirm(session, { intentId: intent.intentId, txHash: tx.hash })).status, 'pending');
    assert.equal(await asset.allowance(who, router.target), 0n);
  });

  await scenario('real identity write grants only identity; independent KYC/AML and issuer facts remain unknown', async (service) => {
    const latest = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(who, policy.hash, 0n, 0n, latest, latest + 600)).wait();
    const identityService = new InvestorService({ venues: { ...venue, signer: admin }, clock: () => now * 1000 });
    const result = await identityService.attestIdentity(session);
    assert.equal(result.status, 'confirmed'); assert.equal(result.identityVerified, true);
    const [known, value] = await attestor.factsOf(who, policy.hash);
    assert.equal(known, bit('identityVerified')); assert.equal(value, bit('identityVerified'));
    assert.equal(await attestor.expiresAt(who, policy.hash), BigInt(latest + 600));
    const quote = await service.quote(session, { buy: true, amount: '10', route: 'cashier' });
    assert.ok(quote.blockers.some((blocker) => blocker.code === 'POLICY_REFUSED'));
    await assert.rejects(service.prepare(session, { kind: 'approval', buy: true, amount: '10', route: 'cashier' }), code('POLICY_REFUSED'));
    assert.equal(await token.balanceOf(who), 0n); assert.equal(await asset.allowance(who, router.target), 0n);
  });
});
