import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AbiCoder, ContractFactory, Contract, Interface, Wallet, concat, id, MaxUint256 } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { mineHookAddress, deploymentCalldata, DETERMINISTIC_DEPLOYER } from '../../src/policy/hookAddress.js';

// Act 1: the fund's transfer-agent agreement compiles into the token's issuance rules and into the
// Uniswap v4 hook that is the token's only door into a pool.
const policy = JSON.parse(await readFile('generated/policy.json', 'utf8'));
const clauseTable = JSON.parse(await readFile('generated/clause-table.json', 'utf8'));
const load = async (name) => JSON.parse(await readFile(`artifacts/rwa-secondary/${name}.json`, 'utf8'));
const artifacts = Object.fromEntries(await Promise.all(
  ['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MockERC20', 'CompiledMirrorToken', 'MirrorPolicyHook', 'MirrorLiquidityRouter', 'PoolManager']
    .map(async (name) => [name, await load(name)])));

const FACTS = policy.factOrder;
const bit = (name) => 1n << BigInt(FACTS.indexOf(name));
const ONBOARDED = { kycApproved: true, amlApproved: true };
const pack = (facts) => {
  let known = 0n; let value = 0n;
  for (const [name, boolean] of Object.entries(facts)) { known |= bit(name); if (boolean) value |= bit(name); }
  return { known, value };
};
const clauseOf = (clauseId) => clauseTable.clauses[Number(clauseId) - 1];
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const TICK_SPACING = 60;
const hookInterface = new Interface(artifacts.MirrorPolicyHook.abi);
const tokenInterface = new Interface(artifacts.CompiledMirrorToken.abi);
const wrapper = new Interface(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);
const decode = (error) => {
  const data = error.info?.error?.data ?? error.data;
  if (!data) return null;
  for (const iface of [hookInterface, tokenInterface]) {
    try { const outer = wrapper.parseError(data); if (outer) return iface.parseError(outer.args.reason) ?? null; } catch {}
    try { const parsed = iface.parseError(data); if (parsed) return parsed; } catch {}
  }
  return null;
};

test('the fund agreement compiles into the token and into the only door a pool can use', { timeout: 300_000 }, async (t) => {
  assert.equal(policy.profile, 'rwa-secondary', 'run npm run build:secondary first');
  const { provider } = await startAnvil(t);
  const admin = new Wallet(DEV_KEY, provider);
  const investor = await provider.getSigner(1);
  const stranger = await provider.getSigner(2);
  const deploy = async (name, ...args) => {
    const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, admin).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const addr = (contract) => contract.getAddress();

  const attestor = await deploy('PolicyAttestor', admin.address);
  await (await attestor.grantRole(id('ATTESTOR_ROLE'), admin.address)).wait();
  const sanctions = await deploy('MockSanctionsOracle', admin.address);
  const oracle = await deploy('PolicyOracle', await addr(attestor), await addr(sanctions));
  const token = await deploy('CompiledMirrorToken', admin.address, admin.address);
  const usdc = await deploy('MockERC20', 'Mock USD Coin', 'mUSDC');
  const manager = await deploy('PoolManager', admin.address);
  const router = await deploy('MirrorLiquidityRouter', await addr(manager));

  const initCode = concat([artifacts.MirrorPolicyHook.bytecode, AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address'], [await addr(manager), await addr(oracle), await addr(router), await addr(token)])]);
  const mined = mineHookAddress(initCode);
  await (await admin.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(mined.salt, initCode) })).wait();
  const hook = new Contract(mined.address, artifacts.MirrorPolicyHook.abi, admin);

  const attest = async (subject, facts) => {
    const { known, value } = pack(facts);
    const now = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(subject, policy.hash, known, value, now, now + 30 * 86400)).wait();
  };
  const sorted = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);
  const [currency0, currency1] = sorted(await addr(token), await addr(usdc));
  const hookedKey = { currency0, currency1, fee: 3000, tickSpacing: TICK_SPACING, hooks: mined.address };
  const hooklessKey = { ...hookedKey, hooks: '0x0000000000000000000000000000000000000000' };
  const liquidity = { tickLower: -TICK_SPACING, tickUpper: TICK_SPACING, liquidityDelta: 10n ** 12n, salt: id('position') };

  await t.test('the token and the hook are bound to the same compiled agreement', async () => {
    assert.equal(await token.policyHash(), policy.hash);
    assert.equal(await hook.policyHash(), policy.hash);
    assert.equal(await hook.clauseTableHash(), clauseTable.clauseTableHash);
  });

  await t.test('shares are minted to custody and cannot move until a venue is configured', async () => {
    await (await token.mint(id('mint-1'), 1_000_000n * 10n ** 6n)).wait();
    await assert.rejects(token.transfer(await investor.getAddress(), 1n), (error) => decode(error)?.name === 'TransfersDisabled');
  });

  await t.test('after configuration, shares are released only to an onboarded investor', async () => {
    await (await token.configureSecondary(await addr(oracle), mined.address)).wait();
    await assert.rejects(token.release(id('release-0'), await stranger.getAddress(), 1n), (error) => {
      const parsed = decode(error);
      return parsed?.name === 'TransferRefused' && clauseOf(parsed.args.clauseId).ruleId === 'transfer-onboarded-holder';
    });
    await attest(await investor.getAddress(), ONBOARDED);
    await (await token.release(id('release-1'), await investor.getAddress(), 500_000n * 10n ** 6n)).wait();
    assert.equal(await token.balanceOf(await investor.getAddress()), 500_000n * 10n ** 6n);
  });

  for (const party of [investor, stranger]) {
    await (await usdc.mint(await party.getAddress(), 10n ** 24n)).wait();
    await (await usdc.connect(party).approve(await addr(router), MaxUint256)).wait();
    await (await token.connect(party).approve(await addr(router), MaxUint256)).wait();
  }

  await t.test('anyone may create a pool with the hook; nobody asked the issuer', async () => {
    await (await manager.connect(stranger).initialize(hookedKey, SQRT_PRICE_1_1)).wait();
  });

  await t.test('a pool without the hook initializes but cannot take the token: no policy, no door', async () => {
    await (await manager.connect(stranger).initialize(hooklessKey, SQRT_PRICE_1_1)).wait();
    await assert.rejects(router.connect(investor).modifyLiquidity(hooklessKey, liquidity), (error) => {
      const parsed = decode(error);
      return parsed?.name === 'NoPolicyDoor' || /NoPolicyDoor|revert/.test(error.message);
    });
  });

  await t.test('in the hooked pool the onboarded investor adds liquidity and swaps', async () => {
    const receipt = await (await router.connect(investor).modifyLiquidity(hookedKey, liquidity)).wait();
    assert.equal(receipt.status, 1);
    const swap = await (await router.connect(investor).swap(hookedKey, { zeroForOne: true, amountSpecified: -1000n, sqrtPriceLimitX96: SQRT_PRICE_1_1 - 1000n })).wait();
    assert.equal(swap.status, 1);
  });

  await t.test('a stranger is refused at the hooked pool, quoting the onboarding clause', async () => {
    const [allowed, clauseId] = await hook.explain(await stranger.getAddress());
    assert.equal(allowed, false);
    assert.equal(clauseOf(clauseId).clause, 'Exhibit A — Investor Onboarding');
    await assert.rejects(router.connect(stranger).modifyLiquidity(hookedKey, liquidity), (error) => decode(error)?.name === 'LegalClauseViolation');
  });

  await t.test('a sanctions designation closes the venue and the token to that investor, in both directions', async () => {
    const other = Wallet.createRandom().address;
    await attest(other, ONBOARDED);
    await (await token.connect(investor).transfer(other, 1n)).wait();
    await (await sanctions.setSanctioned(await investor.getAddress(), true)).wait();
    await assert.rejects(router.connect(investor).modifyLiquidity(hookedKey, liquidity), (error) => decode(error)?.name === 'LegalClauseViolation');
    await assert.rejects(token.release(id('release-2'), await investor.getAddress(), 1n), (error) => decode(error)?.name === 'TransferRefused');
    await assert.rejects(token.connect(investor).transfer(other, 1n), (error) => decode(error)?.name === 'TransferRefused', 'a refused holder cannot sell either');
  });
});
