import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContractFactory, Interface, Wallet, id, keccak256, MaxUint256 } from 'ethers';
import { startAnvil, warp, DEV_KEY } from './anvil.js';
import { loadOpcodes, buildBuybackProgram, buildAquaOrder, encodeOrder, buildTakerData, buybackTermsFrom } from '../../src/policy/programs.js';

const policy = JSON.parse(await readFile('generated/policy.json', 'utf8'));
const clauseTable = JSON.parse(await readFile('generated/clause-table.json', 'utf8'));
const load = async (name) => JSON.parse(await readFile(`artifacts/wildcat-credit/${name}.json`, 'utf8'));
const artifacts = Object.fromEntries(await Promise.all(
  ['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MockWildcatMarket', 'MockERC20', 'MirrortechRoleProvider', 'MirrortechRouter', 'Aqua']
    .map(async (name) => [name, await load(name)])));

const FACTS = policy.factOrder;
const bit = (name) => 1n << BigInt(FACTS.indexOf(name));
const ATTESTED = { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true };
const pack = (facts) => {
  let known = 0n; let value = 0n;
  for (const [name, boolean] of Object.entries(facts)) { known |= bit(name); if (boolean) value |= bit(name); }
  return { known, value };
};
const clauseOf = (clauseId) => clauseTable.clauses[Number(clauseId) - 1];
const guardInterface = new Interface(artifacts.MirrortechRouter.abi);
const refusal = (error) => {
  const data = error.info?.error?.data ?? error.data;
  try { return data ? guardInterface.parseError(data) : null; } catch { return null; }
};
const MICRO = 1_000_000n;

test('the compiled agreement runs as an instruction inside a 1inch SwapVM program on Aqua', { timeout: 300_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const admin = new Wallet(DEV_KEY, provider);
  const borrower = await provider.getSigner(1);
  const lender = await provider.getSigner(2);
  const stranger = await provider.getSigner(3);
  const deploy = async (name, ...args) => {
    const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, admin).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const addr = (contract) => contract.getAddress();

  // Policy layer.
  const attestor = await deploy('PolicyAttestor', admin.address);
  for (const role of ['ATTESTOR_ROLE', 'WATCHER_ROLE']) await (await attestor.grantRole(id(role), admin.address)).wait();
  const sanctions = await deploy('MockSanctionsOracle', admin.address);
  const oracle = await deploy('PolicyOracle', await addr(attestor), await addr(sanctions));
  const roleProvider = await deploy('MirrortechRoleProvider', await addr(oracle));
  const usdc = await deploy('MockERC20', 'Mock USD Coin', 'mUSDC');
  const market = await deploy('MockWildcatMarket', await addr(usdc), await addr(roleProvider), await borrower.getAddress());
  await (await oracle.bindMarket(await addr(market))).wait();

  // Venue: the official Aqua registry (redeployed unmodified) and a modified SwapVM router.
  const weth = await deploy('MockERC20', 'Wrapped Ether', 'WETH');
  const aqua = await deploy('Aqua');
  const router = await deploy('MirrortechRouter', await addr(aqua), await addr(weth), admin.address, await addr(oracle));
  await (await market.connect(borrower).setVenue(await addr(router), true)).wait();

  const attest = async (subject, facts) => {
    const { known, value } = pack(facts);
    const now = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(subject, policy.hash, known, value, now, now + policy.config.attestationValiditySeconds)).wait();
  };

  // Both parties are admitted; the lender holds a position; the borrower holds the asset.
  await attest(await borrower.getAddress(), ATTESTED);
  await attest(await lender.getAddress(), ATTESTED);
  await (await usdc.mint(await lender.getAddress(), 1_000_000n * MICRO)).wait();
  await (await usdc.connect(lender).approve(await addr(market), MaxUint256)).wait();
  await (await market.connect(lender).deposit(1_000_000n * MICRO)).wait();
  await (await usdc.mint(await borrower.getAddress(), 2_000_000n * MICRO)).wait();
  await (await usdc.connect(borrower).approve(await addr(aqua), MaxUint256)).wait();
  await (await market.connect(lender).approve(await addr(router), MaxUint256)).wait();

  // The strategy is compiled from the addendum's terms.
  const opcodes = loadOpcodes();
  const policyGuardOpcode = Number(await router.policyGuardOpcode());
  const fixedRateBalancesOpcode = Number(await router.fixedRateBalancesOpcode());
  const terms = buybackTermsFrom(policy);
  const now = (await provider.getBlock('latest')).timestamp;
  const deadline = now + 30 * 86400;
  const program = buildBuybackProgram({
    opcodes, policyGuardOpcode, fixedRateBalancesOpcode, policyHash: policy.hash, action: policy.actionOrder.indexOf('transfer'),
    deadline, positionToken: await addr(market), asset: await addr(usdc),
    capPosition: terms.capPosition, capAsset: terms.capAsset,
  });
  const order = buildAquaOrder(await borrower.getAddress(), program);
  const strategy = encodeOrder(order);
  const takerData = (thresholdOut) => buildTakerData({ threshold: thresholdOut, deadline: now + 3600 });
  const quote = (signer, amountIn) => router.connect(signer).quote.staticCall(order, market.target, usdc.target, amountIn, takerData(0n));

  await t.test('the router carries the policy and appends its opcodes after the official set', async () => {
    assert.equal(await router.policyHash(), policy.hash);
    assert.equal(await router.clauseTableHash(), clauseTable.clauseTableHash);
    assert.equal(policyGuardOpcode, opcodes.count, 'appended right after the official set');
    assert.equal(fixedRateBalancesOpcode, opcodes.count + 1);
    assert.equal(await router.hash(order), keccak256(strategy), 'Aqua strategy hash and SwapVM order hash must coincide');
  });

  await t.test('the borrower ships the buyback to Aqua and no capital moves', async () => {
    const before = await usdc.balanceOf(await borrower.getAddress());
    await (await aqua.connect(borrower).ship(await addr(router), strategy, [market.target, usdc.target], [terms.capPosition, terms.capAsset])).wait();
    assert.equal(await usdc.balanceOf(await borrower.getAddress()), before, 'ship records a virtual balance only');
    const [balanceIn, balanceOut] = await aqua.safeBalances(await borrower.getAddress(), await addr(router), keccak256(strategy), market.target, usdc.target);
    assert.equal(balanceIn, terms.capPosition);
    assert.equal(balanceOut, terms.capAsset);
  });

  await t.test('an admitted lender is quoted the addendum price and fills against the borrower wallet', async () => {
    const amountIn = 100_000n * MICRO;
    const [quotedIn, quotedOut] = await quote(lender, amountIn);
    assert.equal(quotedIn, amountIn);
    assert.equal(quotedOut, amountIn * 96n / 100n, 'price is the compiled 0.96');

    const lenderUsdcBefore = await usdc.balanceOf(await lender.getAddress());
    const borrowerUsdcBefore = await usdc.balanceOf(await borrower.getAddress());
    const borrowerPositionBefore = await market.balanceOf(await borrower.getAddress());
    await (await router.connect(lender).swap(order, market.target, usdc.target, amountIn, takerData(quotedOut))).wait();
    assert.equal(await usdc.balanceOf(await lender.getAddress()) - lenderUsdcBefore, quotedOut);
    assert.equal(borrowerUsdcBefore - await usdc.balanceOf(await borrower.getAddress()), quotedOut, 'pulled from the borrower wallet at fill time');
    assert.equal(await market.balanceOf(await borrower.getAddress()) - borrowerPositionBefore, amountIn, 'the borrower now holds its own debt');
  });

  await t.test('a stranger is refused at quote time, naming the clause and the party', async () => {
    const strangerAddress = await stranger.getAddress();
    await assert.rejects(quote(stranger, 10n * MICRO), (error) => {
      const parsed = refusal(error);
      assert.ok(parsed, `expected a decodable refusal, got ${error.message}`);
      assert.equal(parsed.name, 'CounterpartyRefused');
      assert.equal(parsed.args.subject, strangerAddress);
      assert.equal(parsed.args.policyHash, policy.hash);
      assert.equal(clauseOf(parsed.args.clauseId).action, 'transfer');
      return true;
    });
  });

  await t.test('a sanctions designation makes the same strategy unfillable for that lender', async () => {
    await (await sanctions.setSanctioned(await lender.getAddress(), true)).wait();
    await assert.rejects(quote(lender, 10n * MICRO), (error) => {
      const parsed = refusal(error);
      return parsed?.name === 'CounterpartyRefused' && clauseOf(parsed.args.clauseId).ruleId === 'transfer-sanctions';
    });
    await assert.rejects(router.connect(lender).swap(order, market.target, usdc.target, 10n * MICRO, takerData(0n)));
    await (await sanctions.setSanctioned(await lender.getAddress(), false)).wait();
    await quote(lender, 10n * MICRO);
  });

  await t.test('the maker is checked too: a borrower whose screening lapsed has a strategy that stops filling', async () => {
    const borrowerAddress = await borrower.getAddress();
    await (await attestor.revokeFacts(borrowerAddress, policy.hash, bit('lenderCheckPassed'))).wait();
    await assert.rejects(quote(lender, 10n * MICRO), (error) => refusal(error)?.name === 'CounterpartyRefused' && refusal(error).args.subject === borrowerAddress);
    await attest(await borrower.getAddress(), ATTESTED);
    await quote(lender, 10n * MICRO);
  });

  await t.test('the cumulative cap and the deadline hold', async () => {
    await assert.rejects(quote(lender, terms.capPosition), (error) => /InvalidatorsTokenInExceeded|revert/.test(error.message) || refusal(error) !== null);
    await warp(provider, 31 * 86400);
    await assert.rejects(quote(lender, 10n * MICRO), (error) => /DeadlineReached|revert/.test(error.message));
  });

  await t.test('docking withdraws the bid', async () => {
    await (await aqua.connect(borrower).dock(await addr(router), keccak256(strategy), [market.target, usdc.target])).wait();
    await assert.rejects(router.connect(lender).swap(order, market.target, usdc.target, 10n * MICRO, takerData(0n)));
  });
});

test('the tender-offer template improves the price from the floor to the ceiling and then expires', { timeout: 300_000 }, async (t) => {
  const { buildDutchBuybackProgram } = await import('../../src/policy/programs.js');
  const { provider } = await startAnvil(t);
  const admin = new Wallet(DEV_KEY, provider);
  const borrower = await provider.getSigner(1);
  const lender = await provider.getSigner(2);
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
  const roleProvider = await deploy('MirrortechRoleProvider', await addr(oracle));
  const usdc = await deploy('MockERC20', 'Mock USD Coin', 'mUSDC');
  const market = await deploy('MockWildcatMarket', await addr(usdc), await addr(roleProvider), await borrower.getAddress());
  await (await oracle.bindMarket(await addr(market))).wait();
  const weth = await deploy('MockERC20', 'Wrapped Ether', 'WETH');
  const aqua = await deploy('Aqua');
  const router = await deploy('MirrortechRouter', await addr(aqua), await addr(weth), admin.address, await addr(oracle));
  await (await market.connect(borrower).setVenue(await addr(router), true)).wait();
  const attest = async (subject) => {
    const { known, value } = pack(ATTESTED);
    const now = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(subject, policy.hash, known, value, now, now + policy.config.attestationValiditySeconds)).wait();
  };
  await attest(await borrower.getAddress());
  await attest(await lender.getAddress());
  await (await usdc.mint(await lender.getAddress(), 1_000_000n * MICRO)).wait();
  await (await usdc.connect(lender).approve(await addr(market), MaxUint256)).wait();
  await (await market.connect(lender).deposit(1_000_000n * MICRO)).wait();
  await (await usdc.mint(await borrower.getAddress(), 2_000_000n * MICRO)).wait();
  await (await usdc.connect(borrower).approve(await addr(aqua), MaxUint256)).wait();
  await (await market.connect(lender).approve(await addr(router), MaxUint256)).wait();

  const opcodes = loadOpcodes();
  const terms = buybackTermsFrom(policy);
  assert.equal(terms.ceiling, '1.00');
  assert.equal(terms.windowSeconds, 6 * 3600);
  const start = (await provider.getBlock('latest')).timestamp;
  const program = buildDutchBuybackProgram({
    opcodes, policyGuardOpcode: Number(await router.policyGuardOpcode()), fixedRateBalancesOpcode: Number(await router.fixedRateBalancesOpcode()),
    policyHash: policy.hash, action: policy.actionOrder.indexOf('transfer'), deadline: start + 30 * 86400,
    positionToken: market.target, asset: usdc.target, capPosition: terms.capPosition, capAssetFloor: terms.capAsset,
    floor: terms.price, ceiling: terms.ceiling, startTime: start, windowSeconds: terms.windowSeconds,
  });
  const order = buildAquaOrder(await borrower.getAddress(), program);
  const strategy = encodeOrder(order);
  await (await aqua.connect(borrower).ship(await addr(router), strategy, [market.target, usdc.target], [terms.capPosition, terms.capAssetCeiling])).wait();
  const quote = async () => (await router.connect(lender).quote.staticCall(order, market.target, usdc.target, 100_000n * MICRO, buildTakerData({ threshold: 0n, deadline: start + 8 * 3600 })))[1];

  const opening = await quote();
  assert.ok(opening >= 96_000n * MICRO && opening < 96_100n * MICRO, `opens at the floor, got ${opening}`);
  await warp(provider, 3 * 3600);
  const midway = await quote();
  assert.ok(midway > opening && midway < 100_000n * MICRO, `improves over the window, got ${midway}`);
  await warp(provider, 3 * 3600 - 30);
  const closing = await quote();
  assert.ok(closing > midway && closing <= 100_000n * MICRO, `approaches the ceiling, got ${closing}`);
  const now = (await provider.getBlock('latest')).timestamp;
  await (await router.connect(lender).swap(order, market.target, usdc.target, 100_000n * MICRO, buildTakerData({ threshold: 0n, deadline: now + 3600 }))).wait();
  await warp(provider, 120);
  await assert.rejects(quote(), (error) => /DutchAuctionExpired|revert/.test(error.message));
});
