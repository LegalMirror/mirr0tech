import { deploymentPrivateKey } from '../src/onchain/signer.js';
// The golden path, both acts, on a local chain. Nothing here is mocked except the chain itself,
// the USD, the sanctions oracle and the Wildcat market. Run with: pnpm run demo:golden
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { JsonRpcProvider, Wallet, id, keccak256, MaxUint256 } from 'ethers';
import { deployStack, ANVIL_DEV_KEY } from '../src/onchain/deploy.js';
import { decodeRefusal } from '../src/onchain/refusal.js';
import { loadOpcodes, buildBuybackProgram, buildDutchBuybackProgram, buildAquaOrder, encodeOrder, buildTakerData, buybackTermsFrom } from '../src/onchain/programs.js';
import { readDocuments, sha256 } from '../src/policy/document.js';

const say = (line = '') => console.log(line);
const step = (title) => { say(); say(`── ${title}`); };
const quote = (clause) => clause ? `“${clause.quote}”` : '(no clause)';
const M = 1_000_000n;

let anvil;
let rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
  anvil.on('error', () => { console.error('This demo needs Foundry/Anvil on PATH.'); process.exit(1); });
  rpcUrl = `http://127.0.0.1:${port}`;
}
const provider = new JsonRpcProvider(rpcUrl, { chainId: 31337, name: 'anvil' }, { cacheTimeout: -1, staticNetwork: true });
provider.pollingInterval = 50;
for (let attempt = 0; attempt < 200; attempt++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
const admin = new Wallet(deploymentPrivateKey() ?? ANVIL_DEV_KEY, provider);
const investor = await provider.getSigner(1);
const stranger = await provider.getSigner(2);
const lenderA = await provider.getSigner(3);
const lenderB = await provider.getSigner(4);
const lenderC = await provider.getSigner(5);
const naming = new Map([[await investor.getAddress(), 'Investor'], [await stranger.getAddress(), 'Stranger'], [await lenderA.getAddress(), 'Lender A'],
  [await lenderB.getAddress(), 'Lender B'], [await lenderC.getAddress(), 'Lender C'], [admin.address, 'Issuer/Borrower (Demo MM Ltd)']]);
const who = (address) => naming.get(address) ?? address;

step('Deploying both acts');
const { record, contracts, policies, clauseTables } = await deployStack(admin, { log: say });
const { attestor, sanctions, usdc, token, poolManager, v4Router, hook, roleProvider, market, aqua, swapRouter } = contracts;
say(`  fund agreement    ${policies.rwa.hash}`);
say(`  loan agreement    ${policies.credit.hash}`);

const facts = (policy) => (names) => {
  let known = 0n; let value = 0n;
  for (const name of names) { const bit = 1n << BigInt(policy.factOrder.indexOf(name)); known |= bit; value |= bit; }
  return { known, value };
};
const attest = async (policy, subject, names, days = 30) => {
  const { known, value } = facts(policy)(names);
  const now = (await provider.getBlock('latest')).timestamp;
  await (await attestor.attest(subject, policy.hash, known, value, now, now + days * 86400)).wait();
};
const refused = async (promise, table) => {
  try { await promise; return null; } catch (error) { return decodeRefusal(error, table); }
};
const report = (label, refusal) => {
  say(`  ${label}`);
  if (!refusal) { say('    → allowed'); return; }
  say(`    → refused: ${refusal.name}${refusal.subject ? ` (${who(refusal.subject)})` : ''}`);
  if (refusal.clause) { say(`      clause ${refusal.clause.clause} · rule ${refusal.clause.ruleId}`); say(`      ${quote(refusal.clause)}`); }
};

// ───────────────────────────── Act 1 — tokenize and trade ─────────────────────────────
step('Act 1 · Issue: shares minted to custody under the transfer-agent agreement');
await (await token.mint(id('mint-1'), 1_000_000n * M)).wait();
say(`  custody holds ${await token.balanceOf(admin.address) / M} MIRROR`);

step('Act 1 · Release: only an onboarded investor may hold shares');
report('Release 500,000 to the Stranger', await refused(token.release(id('release-0'), await stranger.getAddress(), 500_000n * M), clauseTables.rwa));
await attest(policies.rwa, await investor.getAddress(), ['kycApproved', 'amlApproved', 'identityVerified']);
report('Release 500,000 to the Investor after onboarding', await refused(token.release(id('release-1'), await investor.getAddress(), 500_000n * M), clauseTables.rwa));

step('Act 1 · Trade: anyone may create a pool with the hook — nobody asked the issuer');
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const [c0, c1] = BigInt(record.rwa.token) < BigInt(record.usdc) ? [record.rwa.token, record.usdc] : [record.usdc, record.rwa.token];
const hooked = { currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: record.rwa.hook };
const hookless = { ...hooked, hooks: '0x0000000000000000000000000000000000000000' };
await (await poolManager.connect(stranger).initialize(hooked, SQRT_PRICE_1_1)).wait();
say('  Stranger created the hooked MIRROR/mUSDC pool');
for (const party of [investor, stranger]) {
  await (await usdc.mint(await party.getAddress(), 10_000_000n * M)).wait();
  await (await usdc.connect(party).approve(record.rwa.router, MaxUint256)).wait();
  await (await token.connect(party).approve(record.rwa.router, MaxUint256)).wait();
}
const liquidity = { tickLower: -60, tickUpper: 60, liquidityDelta: 10n ** 12n, salt: id('position') };
await (await poolManager.connect(stranger).initialize(hookless, SQRT_PRICE_1_1)).wait();
say('  Stranger also created a pool WITHOUT the hook');
report('Investor adds liquidity to the hookless pool', await refused(v4Router.connect(investor).modifyLiquidity(hookless, liquidity), clauseTables.rwa));
say('    no policy, no door: the token refuses to settle with the pool manager');
report('Investor adds liquidity to the hooked pool', await refused(v4Router.connect(investor).modifyLiquidity(hooked, liquidity), clauseTables.rwa));
report('Investor swaps in the hooked pool', await refused(v4Router.connect(investor).swap(hooked, { zeroForOne: true, amountSpecified: -1000n, sqrtPriceLimitX96: SQRT_PRICE_1_1 - 1000n }), clauseTables.rwa));
report('Stranger adds liquidity to the hooked pool', await refused(v4Router.connect(stranger).modifyLiquidity(hooked, liquidity), clauseTables.rwa));

// ───────────────────────────── Act 2 — lend it out ─────────────────────────────
step('Act 2 · Admission under the Master Loan Agreement');
const ADMITTED = ['mlaCountersigned', 'lenderCheckPassed', 'amlKycProvided', 'notInsolvent'];
const credential = async (address) => (await roleProvider.getCredential(address)) === 0n ? 'none' : 'granted';
const explain = async (address, action) => {
  const [allowed, clauseId] = await roleProvider.explain(address, policies.credit.actionOrder.indexOf(action));
  return { allowed, clause: clauseId ? clauseTables.credit.clauses[Number(clauseId) - 1] : null };
};
for (const [signer, label] of [[lenderA, 'Lender A'], [lenderB, 'Lender B'], [lenderC, 'Lender C']]) {
  await (await usdc.mint(await signer.getAddress(), 5_000_000n * M)).wait();
  await (await usdc.connect(signer).approve(record.credit.market, MaxUint256)).wait();
  say(`  ${label}: credential ${await credential(await signer.getAddress())} before screening`);
}
await attest(policies.credit, await lenderA.getAddress(), ADMITTED);
say(`  Lender A screened → credential ${await credential(await lenderA.getAddress())}`);
await (await market.connect(lenderA).deposit(1_000_000n * M)).wait();
say(`  Lender A deposited 1,000,000 mUSDC → holds ${await market.balanceOf(await lenderA.getAddress()) / M} market tokens`);
await attest(policies.credit, await lenderB.getAddress(), ADMITTED.filter((name) => name !== 'mlaCountersigned'));
let verdict = await explain(await lenderB.getAddress(), 'deposit');
say(`  Lender B without a countersignature → review: ${verdict.clause.clause} ${quote(verdict.clause)}`);
await (await sanctions.setSanctioned(await lenderC.getAddress(), true)).wait();
await attest(policies.credit, await lenderC.getAddress(), ADMITTED);
verdict = await explain(await lenderC.getAddress(), 'deposit');
say(`  Lender C designated by the oracle → denied, no override: ${verdict.clause.clause} ${quote(verdict.clause)}`);
report('Lender C deposits anyway', await refused(market.connect(lenderC).deposit(10n * M), clauseTables.credit));

step('Act 2 · Exit: the borrower ships a standing buyback to Aqua — no capital moves');
const terms = buybackTermsFrom(policies.credit);
await attest(policies.credit, admin.address, ADMITTED);
say('  the borrower is checked too: Demo MM Ltd is attested under its own agreement before it can stand a bid');
await (await usdc.mint(admin.address, 2_000_000n * M)).wait();
await (await usdc.approve(record.credit.aqua, MaxUint256)).wait();
const now = (await provider.getBlock('latest')).timestamp;
const program = buildBuybackProgram({
  opcodes: loadOpcodes(), policyGuardOpcode: record.credit.policyGuardOpcode, fixedRateBalancesOpcode: record.credit.fixedRateBalancesOpcode,
  policyHash: policies.credit.hash, action: policies.credit.actionOrder.indexOf('transfer'), deadline: now + 30 * 86400,
  positionToken: record.credit.market, asset: record.usdc, capPosition: terms.capPosition, capAsset: terms.capAsset,
});
const order = buildAquaOrder(admin.address, program);
const strategy = encodeOrder(order);
const before = await usdc.balanceOf(admin.address);
await (await aqua.ship(record.credit.router, strategy, [record.credit.market, record.usdc], [terms.capPosition, terms.capAsset])).wait();
say(`  terms from the addendum: price ${terms.price}, cap ${terms.cap} market tokens, until ${terms.deadline}`);
say(`  program: Deadline · PolicyGuard(${policies.credit.hash.slice(0, 10)}…) · FixedRateBalances · LimitSwap · InvalidateTokenIn`);
say(`  strategyHash ${keccak256(strategy)}`);
say(`  borrower mUSDC before/after ship: ${before / M} / ${await usdc.balanceOf(admin.address) / M}`);
const takerData = (minOut) => buildTakerData({ threshold: minOut, deadline: now + 3600 });
const quoteFor = async (signer, amount) => swapRouter.connect(signer).quote.staticCall(order, record.credit.market, record.usdc, amount, takerData(0n));
await (await market.connect(lenderA).approve(record.credit.router, MaxUint256)).wait();
const [, out] = await quoteFor(lenderA, 100_000n * M);
say(`  Lender A quote: 100,000 market tokens → ${out / M} mUSDC (${Number(out) / Number(100_000n * M)} per token)`);
await (await swapRouter.connect(lenderA).swap(order, record.credit.market, record.usdc, 100_000n * M, takerData(out))).wait();
say(`  filled: borrower mUSDC now ${await usdc.balanceOf(admin.address) / M}, borrower holds ${await market.balanceOf(admin.address) / M} of its own debt`);
report('Stranger quotes the same strategy', await refused(quoteFor(stranger, 10n * M), clauseTables.credit));

step('Act 2 · The same addendum as a tender offer: the bid improves from the floor to the ceiling');
{
  const opened = (await provider.getBlock('latest')).timestamp;
  const auction = buildDutchBuybackProgram({
    opcodes: loadOpcodes(), policyGuardOpcode: record.credit.policyGuardOpcode, fixedRateBalancesOpcode: record.credit.fixedRateBalancesOpcode,
    policyHash: policies.credit.hash, action: policies.credit.actionOrder.indexOf('transfer'), deadline: opened + 30 * 86400,
    positionToken: record.credit.market, asset: record.usdc, capPosition: terms.capPosition, capAssetFloor: terms.capAsset,
    floor: terms.price, ceiling: terms.ceiling, startTime: opened, windowSeconds: terms.windowSeconds,
  });
  const auctionOrder = buildAquaOrder(admin.address, auction);
  const auctionStrategy = encodeOrder(auctionOrder);
  await (await aqua.ship(record.credit.router, auctionStrategy, [record.credit.market, record.usdc], [terms.capPosition, terms.capAssetCeiling])).wait();
  say(`  program: Deadline · PolicyGuard · FixedRateBalances · DutchAuctionBalanceOut(${terms.windowHours}h) · LimitSwap · InvalidateTokenIn`);
  const price = async () => Number((await swapRouter.connect(lenderA).quote.staticCall(auctionOrder, record.credit.market, record.usdc, 100_000n * M, buildTakerData({ threshold: 0n, deadline: opened + 8 * 3600 })))[1]) / Number(100_000n * M);
  say(`  price at open          ${(await price()).toFixed(4)}  (floor ${terms.price})`);
  await provider.send('evm_increaseTime', [3 * 3600]); await provider.send('evm_mine', []);
  say(`  price after 3 hours    ${(await price()).toFixed(4)}`);
  await provider.send('evm_increaseTime', [3 * 3600 - 60]); await provider.send('evm_mine', []);
  say(`  price near the close   ${(await price()).toFixed(4)}  (ceiling ${terms.ceiling})`);
  await (await aqua.dock(record.credit.router, keccak256(auctionStrategy), [record.credit.market, record.usdc])).wait();
  say('  The lender chooses when to accept; the borrower never parked a cent. A tender offer, compiled.');
}

step('Act 2 · A sanctions designation lands on Lender A between screenings');
await (await sanctions.setSanctioned(await lenderA.getAddress(), true)).wait();
report('Lender A quotes again', await refused(quoteFor(lenderA, 10n * M), clauseTables.credit));
verdict = await explain(await lenderA.getAddress(), 'withdraw');
say(`  Lender A owed interest → payment ${verdict.allowed ? 'permitted' : 'blocked'}: ${verdict.clause?.clause ?? ''} ${quote(verdict.clause)}`);
say('  Nothing was redeployed. The strategy simply stopped filling for that wallet.');
await (await aqua.dock(record.credit.router, keccak256(strategy), [record.credit.market, record.usdc])).wait();
say('  Borrower docked the strategy: the bid is withdrawn, still without any capital having been parked.');

step('Close · change one word in the loan agreement');
const bundle = await readDocuments(['test/human_contracts/wildcat-mla.md', 'test/human_contracts/lender-check-policy.md', 'test/human_contracts/buyback-addendum.md']);
say(`  text hash as signed  0x${bundle.textSha256}`);
say(`  text hash if edited  0x${sha256(bundle.text.replace('thirty (30) days', 'ninety (90) days'))}`);
say('  A different document compiles to a different policyHash; the deployed provider, hook and');
say('  strategy keep enforcing the agreement exactly as it was signed.');
say();
say('Every refusal above named a clause. Nothing here screened anybody: facts are attested by the');
say('compliance function, the oracle is the sanctions source the agreement names, and the compiler');
say('proved each rule is backed by a verbatim quote before a single byte was emitted.');
provider.destroy();
if (anvil) anvil.kill('SIGTERM');
