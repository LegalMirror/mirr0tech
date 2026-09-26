import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContractFactory, Contract, Interface, Wallet, AbiCoder, concat, id, MaxUint256, ZeroAddress } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { mineHookAddress, deploymentCalldata, DETERMINISTIC_DEPLOYER, MIRROR_HOOK_FLAGS, ALL_HOOK_MASK } from '../../src/policy/hookAddress.js';

const policy = JSON.parse(await readFile('generated/policy.json', 'utf8'));
const clauseTable = JSON.parse(await readFile('generated/clause-table.json', 'utf8'));
const load = async (name) => JSON.parse(await readFile(`artifacts/rwa-secondary/${name}.json`, 'utf8'));
const [attestorArtifact, oracleArtifact, sanctionsArtifact, hookArtifact, routerArtifact, tokenArtifact, managerArtifact] =
  await Promise.all(['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MirrorPolicyHook', 'MirrorLiquidityRouter', 'MockERC20', 'PoolManager'].map(load));

const FACTS = policy.factOrder;
const bit = (name) => 1n << BigInt(FACTS.indexOf(name));
const ADMITTED = { kycApproved: true, amlApproved: true, identityVerified: true };
const pack = (facts) => {
  let known = 0n; let value = 0n;
  for (const [name, boolean] of Object.entries(facts)) { known |= bit(name); if (boolean) value |= bit(name); }
  return { known, value };
};
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const TICK_SPACING = 60;

test('the fund agreement gates a real Uniswap v4 pool: mined address, admission, sanctions, caller check', { timeout: 240_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const admin = new Wallet(DEV_KEY, provider);
  const deploy = async (artifact, ...args) => {
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, admin).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };

  const manager = await deploy(managerArtifact, admin.address);
  const attestor = await deploy(attestorArtifact, admin.address);
  await (await attestor.grantRole(id('ATTESTOR_ROLE'), admin.address)).wait();
  await (await attestor.grantRole(id('WATCHER_ROLE'), admin.address)).wait();
  const sanctions = await deploy(sanctionsArtifact, admin.address);
  const oracle = await deploy(oracleArtifact, await attestor.getAddress(), await sanctions.getAddress());
  const router = await deploy(routerArtifact, await manager.getAddress());

  const constructorArgs = AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address'],
    [await manager.getAddress(), await oracle.getAddress(), await router.getAddress(), ZeroAddress]);
  const initCode = concat([hookArtifact.bytecode, constructorArgs]);

  await t.test('Anvil carries the deterministic deployer the hook address search depends on', async () => {
    assert.notEqual(await provider.getCode(DETERMINISTIC_DEPLOYER), '0x');
  });

  const mined = mineHookAddress(initCode);
  let hook;

  await t.test('a hook address is found whose low bits are exactly the permissions it declares', async () => {
    assert.equal(BigInt(mined.address) & ALL_HOOK_MASK, MIRROR_HOOK_FLAGS);
    await (await admin.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(mined.salt, initCode) })).wait();
    assert.notEqual(await provider.getCode(mined.address), '0x');
    hook = new Contract(mined.address, hookArtifact.abi, admin);
    assert.equal(await hook.policyHash(), policy.hash);
    assert.equal(await hook.clauseTableHash(), clauseTable.clauseTableHash);
  });

  await t.test('deploying the same hook to an address without those bits is refused', async () => {
    await assert.rejects(deploy(hookArtifact, await manager.getAddress(), await oracle.getAddress(), await router.getAddress(), ZeroAddress));
  });

  // One signer, so deployments are sequential: concurrent sends reuse a nonce.
  const tokens = [await deploy(tokenArtifact, 'Market Position', 'POS'), await deploy(tokenArtifact, 'USD Coin', 'USDC')];
  const addresses = [await tokens[0].getAddress(), await tokens[1].getAddress()];
  const [currency0, currency1] = [...addresses].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const key = { currency0, currency1, fee: 3000, tickSpacing: TICK_SPACING, hooks: mined.address };

  await t.test('a pool initializes with the hook attached', async () => {
    await (await manager.initialize(key, SQRT_PRICE_1_1)).wait();
  });

  const lender = admin;
  for (const token of tokens) {
    await (await token.mint(lender.address, 10n ** 24n)).wait();
    await (await token.approve(await router.getAddress(), MaxUint256)).wait();
  }
  const attest = async (subject, facts) => {
    const { known, value } = pack(facts);
    const now = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(subject, policy.hash, known, value, now, now + (policy.config.attestationValiditySeconds ?? 30 * 86400))).wait();
  };
  const addLiquidity = () => router.modifyLiquidity(key, { tickLower: -TICK_SPACING, tickUpper: TICK_SPACING, liquidityDelta: 10n ** 18n, salt: id('position') });
  const hookInterface = new Contract(mined.address, hookArtifact.abi, admin).interface;
  // The pool manager wraps a reverting hook call, so the clause has to be unwrapped before it can
  // be read. A front end rendering the refused quote has to do exactly this.
  const wrapper = new Interface(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);
  const decodeViolation = (error) => {
    const data = error.info?.error?.data ?? error.data;
    if (!data) return null;
    try {
      const outer = wrapper.parseError(data);
      return outer ? hookInterface.parseError(outer.args.reason) : null;
    } catch { return hookInterface.parseError(data); }
  };

  await t.test('an unscreened wallet cannot provide liquidity, and the revert names a clause', async () => {
    const [allowed] = await hook.explain(lender.address);
    assert.equal(allowed, false);
    await assert.rejects(addLiquidity(), (error) => {
      const parsed = decodeViolation(error);
      assert.ok(parsed, `expected a decodable custom error, got ${error.message}`);
      assert.equal(parsed.name, 'LegalClauseViolation');
      assert.equal(parsed.args.policyHash, policy.hash);
      return true;
    });
  });

  await t.test('the admitted lender provides liquidity to the same pool', async () => {
    await attest(lender.address, ADMITTED);
    const [allowed] = await hook.explain(lender.address);
    assert.equal(allowed, true);
    const receipt = await (await addLiquidity()).wait();
    assert.equal(receipt.status, 1);
  });

  await t.test('a swap by the same admitted lender clears the hook', async () => {
    const receipt = await (await router.swap(key, { zeroForOne: true, amountSpecified: -1000n, sqrtPriceLimitX96: SQRT_PRICE_1_1 - 1000n })).wait();
    assert.equal(receipt.status, 1);
  });

  await t.test('a sanctions hit closes the venue to that wallet immediately', async () => {
    await (await sanctions.setSanctioned(lender.address, true)).wait();
    const [allowed, clauseId] = await hook.explain(lender.address);
    assert.equal(allowed, false);
    assert.equal(clauseTable.clauses[Number(clauseId) - 1].ruleId, 'transfer-sanctions-block');
    await assert.rejects(addLiquidity(), (error) => decodeViolation(error)?.name === 'LegalClauseViolation');
    await assert.rejects(
      router.swap(key, { zeroForOne: true, amountSpecified: -1000n, sqrtPriceLimitX96: SQRT_PRICE_1_1 - 1000n }),
      (error) => decodeViolation(error)?.name === 'LegalClauseViolation');
  });

  await t.test('only the pool manager may invoke the hook', async () => {
    await assert.rejects(
      hook.beforeSwap.staticCall(await router.getAddress(), key, { zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: SQRT_PRICE_1_1 }, '0x'),
      (error) => String(error.info?.error?.data ?? error.data ?? '').startsWith(id('NotPoolManager()').slice(0, 10)));
  });
});
