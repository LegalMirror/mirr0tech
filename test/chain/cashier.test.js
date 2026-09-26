import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AbiCoder, Contract, ContractFactory, Interface, MaxUint256, ZeroAddress, Wallet, id, keccak256 } from 'ethers';
import { startAnvil, DEV_KEY, warp } from './anvil.js';
import { readDocuments, documentFrom } from '../../src/policy/document.js';
import { cashierFixture, cashierConstructorConfig, cashierConfigurationHash } from '../../src/policy/cashier.js';
import { compilePolicy } from '../../src/policy/compile.js';
import { compileBundle } from '../../src/solc.js';
import { mineHookAddress, deploymentCalldata, DETERMINISTIC_DEPLOYER, CASHIER_HOOK_FLAGS, ALL_HOOK_MASK } from '../../src/policy/hookAddress.js';
import { deployFund, cashierInitialSqrtPrice } from '../../src/deploy.js';

// Compiles entirely in memory: does not change generated/, deployments/ or tracked artifacts.
const document = await readDocuments(['test/human_contracts/ea026411904ex10-9.htm', 'test/human_contracts/nav-cashier-addendum.md']);
const config = JSON.parse(await readFile('examples/rwa-cashier-config.json', 'utf8'));
const compiled = compilePolicy(cashierFixture(document), config, document, { demo: true });
const { policy, clauseTable } = compiled;
const parameters = cashierConstructorConfig(compiled.cashier);
const overrides = { 'generated/CompiledPolicy.sol': compiled.compiledPolicy, 'generated/CompiledMirrorToken.sol': compiled.solidity, 'generated/CompiledCashierTerms.sol': compiled.compiledCashierTerms };
const coder = AbiCoder.defaultAbiCoder();
const Q96 = 2n ** 96n;
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;
const M = 1_000_000n;
const ONBOARDED = { kycApproved: true, amlApproved: true, identityVerified: true };
const ELIGIBLE = { ...ONBOARDED, issuerAuthorized: true, offeringCompliant: true, subscriptionAccepted: true, depositConfirmed: true, redemptionAuthorized: true };
const wrapper = new Interface(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);

function decode(error, artifacts) {
  let data = error.info?.error?.data ?? error.data;
  for (let i = 0; i < 3; i++) {
    try { const outer = wrapper.parseError(data); if (!outer) break; data = outer.args.reason; } catch { break; }
  }
  for (const artifact of Object.values(artifacts)) {
    try { const result = new Interface(artifact.abi).parseError(data); if (result) return result; } catch {}
  }
  return null;
}

test('real v4 NAV cashier: bounded AMM trial, actual mint/burn settlement, policy and atomic refusals', { timeout: 300_000 }, async (t) => {
  const artifacts = {};
  for (const bundle of ['core', 'uniswap-v4']) {
    const targets = compiled.contracts.filter(([b, , name]) => b === bundle && name).map(([, path, name]) => [path, name]);
    if (bundle === 'uniswap-v4') targets.push(['contracts/test/CashierProbe.sol', 'CashierProbe'], ['contracts/test/MirrorLiquidityRouter.sol', 'MirrorLiquidityRouter']);
    Object.assign(artifacts, await compileBundle(bundle, targets, { overrides }));
  }
  const { provider } = await startAnvil(t);
  const admin = new Wallet(DEV_KEY, provider);
  const investor = await provider.getSigner(1);
  const stranger = await provider.getSigner(2);
  const who = await investor.getAddress();
  const deploy = async (name, ...args) => {
    const c = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, admin).deploy(...args);
    await c.waitForDeployment(); return c;
  };
  const attestor = await deploy('PolicyAttestor', admin.address);
  await (await attestor.grantRole(id('ATTESTOR_ROLE'), admin.address)).wait();
  const sanctions = await deploy('MockSanctionsOracle', admin.address);
  const oracle = await deploy('PolicyOracle', attestor.target, sanctions.target);
  const token = await deploy('CompiledMirrorToken', admin.address, admin.address);
  const usd = await deploy('MockUSD');
  const manager = await deploy('PoolManager', admin.address);
  const router = await deploy('MirrorCashierRouter', manager.target, parameters);
  const rogue = await deploy('CashierProbe', manager.target);
  const legacyRouter = await deploy('MirrorLiquidityRouter', manager.target);
  const hookInitCode = async (values) => (await new ContractFactory(artifacts.MirrorCashierHook.abi, artifacts.MirrorCashierHook.bytecode, admin).getDeployTransaction(...values)).data;
  const args = [manager.target, oracle.target, router.target, token.target, usd.target, parameters];
  const initCode = await hookInitCode(args);
  const mined = mineHookAddress(initCode, CASHIER_HOOK_FLAGS);
  await (await admin.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(mined.salt, initCode) })).wait();
  const hook = new Contract(mined.address, artifacts.MirrorCashierHook.abi, admin);
  await (await token.configureSecondary(oracle.target, hook.target)).wait();
  const token0 = BigInt(token.target) < BigInt(usd.target);
  const key = { currency0: token0 ? token.target : usd.target, currency1: token0 ? usd.target : token.target, ...parameters.pool, hooks: hook.target };
  const poolId = keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
  const poolSlot = keccak256(coder.encode(['bytes32', 'uint256'], [poolId, 6]));
  const slot0 = () => manager['extsload(bytes32)'](poolSlot);
  const attest = async (subject, facts, lifetime = 86400, hash = policy.hash) => {
    let known = 0n; let value = 0n;
    for (const [name, yes] of Object.entries(facts)) {
      const bit = 1n << BigInt(policy.factOrder.indexOf(name)); known |= bit; if (yes) value |= bit;
    }
    const now = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(subject, hash, known, value, now, now + lifetime)).wait();
  };
  await attest(admin.address, ELIGIBLE);
  await attest(who, ELIGIBLE);
  await (await token.mint(id('LP and investor supply'), 500_000n * M)).wait();
  await (await token.release(id('investor initial shares'), who, 10_000n * M)).wait();
  for (const party of [admin, investor, stranger]) {
    await (await usd.mint(await party.getAddress(), 1_000_000n * M)).wait();
    await (await usd.connect(party).approve(router.target, MaxUint256)).wait();
    await (await token.connect(party).approve(router.target, MaxUint256)).wait();
    await (await token.connect(party).approve(legacyRouter.target, MaxUint256)).wait();
    await (await usd.connect(party).approve(legacyRouter.target, MaxUint256)).wait();
  }
  const liquidity = { tickLower: -12000, tickUpper: 12000, liquidityDelta: 500_000n * M, salt: id('LP') };
  const initialize = async (price = Q96, liquid = true) => {
    await (await manager.initialize(key, price)).wait();
    if (liquid) await (await router.modifyLiquidity(key, liquidity)).wait();
  };
  const params = (buy, amount = 100n * M) => {
    const zeroForOne = buy ? !token0 : token0;
    return { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN : MAX };
  };
  const deadline = async () => (await provider.getBlock('latest')).timestamp + 1000;
  const swap = async (buy, { amount = 100n * M, mode = 0, min = 1n, party = investor, pool = key, limit } = {}) =>
    router.connect(party).swap(pool, { ...params(buy, amount), ...(limit ? { sqrtPriceLimitX96: limit } : {}) }, min, await deadline(), mode);
  const balances = async () => Promise.all([token.totalSupply(), token.balanceOf(who), usd.balanceOf(who), usd.balanceOf(hook.target), token.balanceOf(manager.target), usd.balanceOf(manager.target), slot0()]);
  const expectError = async (action, name, reason) => assert.rejects(action, (error) => {
    const parsed = decode(error, artifacts);
    assert.equal(parsed?.name, name, error.shortMessage ?? error.message);
    if (reason !== undefined) assert.equal(Number(parsed.args.reason), reason);
    if (parsed.args.policyHash) {
      assert.equal(parsed.args.policyHash, policy.hash);
      assert.ok(document.text.includes(clauseTable.clauses[Number(parsed.args.clauseId) - 1].quote));
    }
    return true;
  });
  let snapshot = await provider.send('evm_snapshot', []);
  const scenario = async (name, fn) => t.test(name, async () => {
    await provider.send('evm_revert', [snapshot]); snapshot = await provider.send('evm_snapshot', []);
    await fn();
  });

  await scenario('mined flags, policy/terms commitments and exact six-decimal fee formulas', async () => {
    assert.equal(BigInt(hook.target) & ALL_HOOK_MASK, CASHIER_HOOK_FLAGS);
    assert.equal(await hook.policyHash(), policy.hash);
    assert.equal(await hook.clauseTableHash(), clauseTable.clauseTableHash);
    assert.equal(await hook.termsHash(), policy.cashier.termsHash);
    assert.equal(await hook.configurationHash(), policy.cashier.configurationHash);
    assert.equal(await router.configurationHash(), policy.cashier.configurationHash);
    assert.equal(await hook.navClauseId(), BigInt(parameters.clauseIds.navUsd));
    assert.equal(await hook.subscriptionClauseId(), BigInt(parameters.clauseIds.subscriptionFeeBps));
    assert.equal(await hook.redemptionClauseId(), BigInt(parameters.clauseIds.redemptionFeeBps));
    assert.equal(await hook.supplyCapClauseId(), BigInt(parameters.clauseIds.cashierSupplyCap));
    assert.equal(await hook.executionClauseId(), BigInt(parameters.clauseIds.cashierExecution));
    assert.equal(await usd.decimals(), 6n);
    assert.equal(await hook.quote(true, 100_250_000n), 100_000_000n);
    assert.equal(await hook.quote(false, 100_000_000n), 99_750_000n);
  });
  for (const buy of [true, false]) {
    await scenario(`unfavorable ${buy ? 'buy mints' : 'sell burns'} via real beforeSwap delta, with AMM state rolled back`, async () => {
      // Premium makes buys unfavorable; discount makes sells unfavorable, irrespective of sorting.
      const highRatio = buy === token0;
      await initialize(highRatio ? Q96 * 11n / 10n : Q96 * 10n / 11n);
      await (await usd.mint(hook.target, 1000n * M)).wait();
      const before = await balances();
      const amount = 100n * M;
      const out = await hook.quote(buy, amount);
      const receipt = await (await swap(buy, { amount, min: out })).wait();
      const executed = receipt.logs.map((log) => { try { return router.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Executed');
      assert.equal(executed.args.route, 2n);
      const after = await balances();
      assert.equal(after[0] - before[0], buy ? out : -amount);
      assert.equal(after[1] - before[1], buy ? out : -amount);
      assert.equal(after[2] - before[2], buy ? -amount : out);
      assert.equal(after[3] - before[3], buy ? amount : -out);
      assert.deepEqual(after.slice(4), before.slice(4), 'pool token balances and slot0 are untouched');
      assert.equal(await token.balanceOf(hook.target), 0n);
      assert.equal(await hook.approvedSubject(), ZeroAddress);
    });
    await scenario(`favorable ${buy ? 'buy' : 'sell'} executes the actual AMM, without supply or reserve changes`, async () => {
      await initialize(buy === token0 ? Q96 * 10n / 11n : Q96 * 11n / 10n);
      await attest(who, ONBOARDED); // AMM does not need issuance/redemption authorization.
      const before = await balances();
      const receipt = await (await swap(buy)).wait();
      const executed = receipt.logs.map((log) => { try { return router.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Executed');
      assert.equal(executed.args.route, 1n);
      const after = await balances();
      assert.equal(after[0], before[0]); assert.equal(after[3], before[3]);
      assert.notEqual(after[6], before[6]);
    });
  }
  await scenario('explicit bounded normal-pool swaps work at NAV in both directions', async () => {
    await initialize();
    for (const buy of [true, false]) await (await swap(buy, { mode: 1, min: 90n * M })).wait();
    await (await router.modifyLiquidity(key, { ...liquidity, liquidityDelta: -liquidity.liquidityDelta })).wait();
  });
  await scenario('cashier can mint and redeem with zero AMM liquidity and no singleton starting balances', async () => {
    await initialize(Q96, false);
    await (await swap(true, { amount: 100_250_000n, min: 100_000_000n })).wait();
    await (await swap(false, { amount: 100_000_000n, min: 99_750_000n })).wait();
    assert.equal(await usd.balanceOf(hook.target), 500_000n);
    assert.equal(await token.balanceOf(manager.target), 0n);
    assert.equal(await usd.balanceOf(manager.target), 0n);
  });
  await scenario('unknown, missing/false World ID, KYC, sanctions and expired facts fail with source citations', async () => {
    await initialize();
    await expectError(() => swap(true, { party: stranger }), 'LegalClauseViolation');
    for (const facts of [{ ...ELIGIBLE, identityVerified: false }, { ...ELIGIBLE, kycApproved: false }, ONBOARDED]) {
      await attest(who, facts);
      for (const buy of [true, false]) await expectError(() => swap(buy, { mode: 2 }), 'LegalClauseViolation');
    }
    const missing = { ...ELIGIBLE }; delete missing.identityVerified;
    await attest(who, missing);
    await expectError(() => swap(true), 'LegalClauseViolation');
    await attest(who, ELIGIBLE, 10);
    await warp(provider, 11);
    await expectError(() => swap(false), 'LegalClauseViolation');
    await attest(who, ELIGIBLE);
    await (await sanctions.setSanctioned(who, true)).wait();
    await expectError(() => swap(true), 'LegalClauseViolation');
  });
  await scenario('insufficient reserve and total supply cap fail atomically', async () => {
    await initialize();
    const before = await balances();
    await expectError(() => swap(false), 'CashierRefused', 2);
    assert.deepEqual(await balances(), before);
    await (await token.mint(id('fill cap'), await token.maxSupply() - await token.totalSupply())).wait();
    const capped = await balances();
    await expectError(() => swap(true), 'CashierRefused', 3);
    assert.deepEqual(await balances(), capped);
  });
  await scenario('min output, partial AMM fills, tiny inputs, exact-output, deadline and oversized orders', async () => {
    await initialize();
    const before = await balances();
    for (const buy of [true, false]) {
      await (await usd.mint(hook.target, 1000n * M)).wait();
      const out = await hook.quote(buy, 100n * M);
      for (const mode of [0, 2]) await expectError(() => swap(buy, { min: out + 1n, mode }), 'ExecutionRefused', 4);
      await expectError(() => swap(buy, { amount: 1n }), 'CashierRefused', 1);
      await expectError(() => swap(buy, { amount: 0n }), 'ExecutionRefused', 1);
      await expectError(() => swap(buy, { amount: -1n }), 'ExecutionRefused', 1);
      await expectError(() => swap(buy, { amount: 2n ** 127n }), 'ExecutionRefused', 1);
    }
    await expectError(() => swap(true, { mode: 1, limit: params(true).zeroForOne ? Q96 - 1n : Q96 + 1n }), 'ExecutionRefused', 4);
    await expectError(() => router.connect(investor).swap(key, params(true), 1, 1, 0), 'ExecutionRefused', 5);
    assert.deepEqual((await balances()).slice(0, 3), before.slice(0, 3));
  });
  await scenario('no fake subjects, unauthorized mint/burn, arbitrary token door, or wrong pool currencies', async () => {
    await initialize();
    await expectError(() => rogue.forge(key, params(true), who), 'NotRouter');
    await expectError(() => router.payInput(), 'Unauthorized');
    await expectError(() => token.cashierMint(1), 'NotCashier');
    await expectError(() => token.cashierBurn(1), 'NotCashier');
    await expectError(() => hook.consumeApproval(), 'NotToken');
    await expectError(() => token.connect(investor).transfer(manager.target, 1), 'NoPolicyDoor');
    await expectError(() => hook.beforeSwap(router.target, key, params(true), coder.encode(['address', 'bool'], [who, true])), 'NotPoolManager');
    const hookless = { ...key, hooks: ZeroAddress };
    await (await manager.initialize(hookless, Q96)).wait();
    await expectError(() => legacyRouter.modifyLiquidity(hookless, liquidity), 'NoPolicyDoor');
    const wrongFee = { ...key, fee: 500 };
    await (await manager.initialize(wrongFee, Q96)).wait();
    await expectError(() => swap(true, { pool: wrongFee }), 'InvalidPool');
    const another = await deploy('MockUSD');
    const pair = [token.target, another.target].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    const wrongAsset = { ...key, currency0: pair[0], currency1: pair[1] };
    await (await manager.initialize(wrongAsset, Q96)).wait();
    await expectError(() => swap(true, { pool: wrongAsset, mode: 2 }), 'InvalidPool');
  });
  await scenario('zero-token settlement cannot leave an approval for a later hookless transfer in the same transaction', async () => {
    await initialize();
    await attest(rogue.target, ELIGIBLE);
    await (await token.release(id('probe shares'), rogue.target, 1000n * M)).wait();
    await (await usd.mint(rogue.target, 1000n * M)).wait();
    await expectError(() => rogue.emptyApprovalAttack(router.target, key, { ...liquidity, liquidityDelta: 1000n * M }, token.target), 'NoPolicyDoor');
  });
  await scenario('actual payer allowances and balances are mandatory; a failed leg cannot mint or burn', async () => {
    await initialize(Q96, false);
    const before = await balances();
    await (await usd.connect(investor).approve(router.target, 0)).wait();
    await expectError(() => swap(true, { mode: 2 }), 'ERC20InsufficientAllowance');
    assert.deepEqual(await balances(), before);
    await (await usd.mint(hook.target, 100_000n * M)).wait();
    const funded = await balances();
    await expectError(() => swap(false, { mode: 2, amount: 20_000n * M }), 'ERC20InsufficientBalance');
    assert.deepEqual(await balances(), funded);
    await (await token.pause()).wait();
    await expectError(() => swap(false, { mode: 2 }), 'EnforcedPause');
    assert.deepEqual(await balances(), funded);
  });
  await scenario('constructor rejects non-six-decimal, native, identical currencies and a router for another manager', async () => {
    const oldUsd = await deploy('MockERC20', 'Legacy USD', 'USD18');
    const otherManager = await deploy('PoolManager', admin.address);
    const wrongRouter = await deploy('MirrorCashierRouter', otherManager.target, parameters);
    for (const [asset, trustedRouter] of [[oldUsd.target, router.target], [ZeroAddress, router.target], [token.target, router.target], [usd.target, wrongRouter.target]]) {
      const values = [manager.target, oracle.target, trustedRouter, token.target, asset, parameters];
      const code = await hookInitCode(values);
      const address = mineHookAddress(code, CASHIER_HOOK_FLAGS);
      await assert.rejects(admin.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(address.salt, code) }));
      assert.equal(await provider.getCode(address.address), '0x');
    }
  });
  await scenario('constructor parameter ranges and the compiler commitment cannot be bypassed', async () => {
    for (const patch of [{ navMicroUsd: 0 }, { subscriptionFeeBps: 10000 }, { redemptionFeeBps: 10000 }, { shareDecimals: 18 }, { assetDecimals: 18 },
      { maxSupply: 0 }, { pool: { fee: 0x800000, tickSpacing: 60 } }, { pool: { fee: 1000000, tickSpacing: 60 } },
      { pool: { fee: 500, tickSpacing: 0 } }, { pool: { fee: 500, tickSpacing: 32768 } }, { clauseIds: { ...parameters.clauseIds, cashierExecution: 0 } }]) {
      await expectError(() => deploy('MirrorCashierRouter', manager.target, { ...parameters, ...patch }), 'InvalidCashierConfiguration');
    }
    for (const patch of [{ navMicroUsd: 2000000 }, { subscriptionFeeBps: 0 }, { redemptionFeeBps: 0 }, { maxSupply: '2000000000000' },
      { termsHash: id('unrelated evidence') }, { pool: { fee: 500, tickSpacing: 10 } },
      { clauseIds: { ...parameters.clauseIds, cashierExecution: 1 } }]) {
      await expectError(() => deploy('MirrorCashierRouter', manager.target, { ...parameters, ...patch }), 'UnauthorizedCashierConfiguration');
    }
    // The hook checks the same authorization independently of the router.
    const code = await hookInitCode([manager.target, oracle.target, router.target, token.target, usd.target, { ...parameters, subscriptionFeeBps: 0 }]);
    const address = mineHookAddress(code, CASHIER_HOOK_FLAGS);
    await assert.rejects(admin.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(address.salt, code) }));
    assert.equal(await provider.getCode(address.address), '0x');
  });
  await scenario('alternate document NAV/fees/cap and pool configuration deploy and settle real mint, burn and AMM fills', async () => {
    const doc = documentFrom('alternate-demo.md', document.text
      .replace('USD 1.00 per share', 'USD 2.50 per share')
      .replace('subscription fee is 25 basis points', 'subscription fee is 40 basis points').replace('input / 1.0025', 'input / 2.51')
      .replace('redemption fee is 25 basis points', 'redemption fee is 90 basis points').replace('input * 0.9975', 'input * 2.4775')
      .replace('1000000 shares, including', '2000000 shares, including'));
    const alternate = compilePolicy(cashierFixture(doc), { ...config, maxSupply: '2000000000000',
      cashier: { enabled: true, pool: { fee: 500, tickSpacing: 10 } } }, doc, { demo: true });
    const result = await deployFund(admin, { record: { chainId: 31337, attestor: attestor.target, sanctions: sanctions.target, usdc: usd.target,
      rwa: { poolManager: manager.target, router: legacyRouter.target } }, sources: {
      compiledPolicy: alternate.compiledPolicy, token: alternate.solidity, cashierTerms: alternate.compiledCashierTerms, cashier: alternate.cashier,
    } });
    const otherHook = new Contract(result.hook, result.cashier.hookAbi, admin);
    const otherRouter = new Contract(result.router, result.cashier.routerAbi, admin);
    const otherToken = new Contract(result.token, artifacts.CompiledMirrorToken.abi, admin);
    const otherUsd = new Contract(result.cashier.asset, artifacts.MockUSD.abi, admin);
    const tokenFirst = result.poolKey.currency0 === result.token;
    assert.equal(result.cashier.configurationHash, cashierConfigurationHash(alternate.cashier));
    assert.equal(await otherHook.nav(), 2500000n);
    assert.equal(await otherHook.subscriptionFeeBps(), 40n);
    assert.equal(await otherHook.redemptionFeeBps(), 90n);
    assert.equal(await otherHook.poolFee(), 500n);
    assert.equal(await otherHook.tickSpacing(), 10n);
    assert.equal(await otherRouter.poolFee(), 500n);
    assert.equal(await otherRouter.tickSpacing(), 10n);
    assert.equal(await otherToken.maxSupply(), 2000000000000n);
    assert.equal(await otherHook.configurationHash(), alternate.cashier.configurationHash);
    assert.equal(await otherHook.termsHash(), alternate.cashier.termsHash);
    const otherSlot = keccak256(coder.encode(['bytes32', 'uint256'], [result.poolId, 6]));
    const initial = await manager['extsload(bytes32)'](otherSlot);
    const initialSqrt = cashierInitialSqrtPrice(alternate.cashier.navMicroUsd, tokenFirst);
    assert.equal(BigInt(initial) & (2n ** 160n - 1n), initialSqrt);
    assert.equal(result.cashier.initialSqrtPriceX96, initialSqrt.toString());
    const encodedKey = keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'], [[result.poolKey.currency0, result.poolKey.currency1, 500, 10, result.hook]]));
    assert.equal(result.poolId, encodedKey);
    for (const party of [admin, investor]) {
      const subject = await party.getAddress();
      await attest(subject, ELIGIBLE, 86400, alternate.policy.hash);
      await (await otherUsd.mint(subject, 1000000n * M)).wait();
      await (await otherUsd.connect(party).approve(result.router, MaxUint256)).wait();
      await (await otherToken.connect(party).approve(result.router, MaxUint256)).wait();
    }
    const execute = async (buy, input, min, mode = 0) => {
      const zeroForOne = buy ? !tokenFirst : tokenFirst;
      const receipt = await (await otherRouter.connect(investor).swap(result.poolKey,
        { zeroForOne, amountSpecified: -input, sqrtPriceLimitX96: zeroForOne ? MIN : MAX }, min, await deadline(), mode)).wait();
      return receipt.logs.filter((log) => log.address.toLowerCase() === result.router.toLowerCase())
        .map((log) => { try { return otherRouter.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Executed');
    };
    assert.equal(await otherHook.quote(true, 251000000n), 100000000n);
    assert.equal(await otherHook.quote(false, 100000000n), 247750000n);
    const userUsd = await otherUsd.balanceOf(who);
    const buy = await execute(true, 251000000n, 100000000n);
    assert.equal(buy.args.route, 2n);
    assert.equal(await otherToken.totalSupply(), 100000000n);
    assert.equal(await otherToken.balanceOf(who), 100000000n);
    assert.equal(await otherUsd.balanceOf(result.hook), 251000000n);
    const sell = await execute(false, 100000000n, 247750000n);
    assert.equal(sell.args.route, 2n);
    assert.equal(await otherToken.totalSupply(), 0n);
    assert.equal(await otherUsd.balanceOf(who), userUsd - 3250000n);
    assert.equal(await otherUsd.balanceOf(result.hook), 3250000n);
    assert.equal(await otherUsd.balanceOf(manager.target), 0n);
    assert.equal(await otherToken.balanceOf(manager.target), 0n);
    assert.equal(await manager['extsload(bytes32)'](otherSlot), initial);
    await (await otherToken.mint(id('alternate LP'), 100000n * M)).wait();
    await (await otherToken.release(id('alternate investor'), who, 1000n * M)).wait();
    await (await otherRouter.modifyLiquidity(result.poolKey, { tickLower: -12000, tickUpper: 12000, liquidityDelta: 100000n * M, salt: id('alternate LP') })).wait();
    const supply = await otherToken.totalSupply();
    const reserve = await otherUsd.balanceOf(result.hook);
    for (const buy of [true, false]) {
      const input = buy ? 2500000n : M;
      const output = await otherHook.quote(buy, input);
      assert.equal((await execute(buy, input, output)).args.route, 1n, 'lower configured pool fee admits in-band auto AMM fills');
    }
    assert.equal(await otherToken.totalSupply(), supply);
    assert.equal(await otherUsd.balanceOf(result.hook), reserve);
    for (const patch of [{ fee: 3000 }, { tickSpacing: 60 }]) {
      await expectError(() => otherRouter.modifyLiquidity({ ...result.poolKey, ...patch }, liquidity), 'InvalidPool');
    }
  });
  await scenario('per-agreement runtime deployment is opt-in and returns live dedicated cashier interfaces', async () => {
    const result = await deployFund(admin, { record: { chainId: 31337, attestor: attestor.target, sanctions: sanctions.target, usdc: usd.target,
      rwa: { poolManager: manager.target, router: legacyRouter.target } }, sources: { compiledPolicy: compiled.compiledPolicy, token: compiled.solidity, cashierTerms: compiled.compiledCashierTerms, cashier: compiled.cashier } });
    assert.equal(result.policyHash, policy.hash);
    assert.equal(result.cashier.termsHash, policy.cashier.termsHash);
    assert.notEqual(result.router, legacyRouter.target);
    assert.equal(BigInt(result.hook) & ALL_HOOK_MASK, CASHIER_HOOK_FLAGS);
    const newHook = new Contract(result.hook, result.cashier.hookAbi, admin);
    assert.equal(await newHook.router(), result.router);
    assert.equal(await newHook.asset(), result.cashier.asset);
    assert.equal(await provider.getCode(result.router) === '0x', false);
  });
});
