import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Wallet, getAddress, id, parseUnits } from 'ethers';
import { InvestorService } from '../src/investor-service.js';
import { InvestorAuth } from '../src/investor-auth.js';
import { indexedAddressEvents, syncFundDeployment } from '../src/multibaas.js';

const NOW = 2_000_000_000;
const M = 1_000_000n;
const address = (n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const HASH = id('investor transaction');
const OTHER_HASH = id('other transaction');
const BLOCK = id('canonical block');
const ERC20 = new Interface([
  'function approve(address spender,uint256 amount) returns (bool)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const ROUTER = new Interface([
  'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,uint256 minOut,uint256 deadline,uint8 route) returns (uint256)',
  'event Executed(address indexed subject,uint8 route,uint256 amountIn,uint256 amountOut)',
]);
const HOOK = new Interface(['event CashierExecuted(address indexed subject,bool indexed buy,uint256 amountIn,uint256 amountOut,bytes32 termsHash)']);
const ATTESTOR = new Interface([
  'event Attested(address indexed subject,bytes32 indexed policyHash,uint256 known,uint256 value,uint32 expiresAt)',
  'event Revoked(address indexed subject,bytes32 indexed policyHash,uint256 clearedBits)',
  'event Overridden(address indexed subject,bytes32 indexed policyHash,uint256 bits)',
]);
const swapOrder = { kind: 'swap', buy: true, amount: '10', minOut: '9', route: 'cashier' };
const approvalOrder = { kind: 'approval', buy: true, amount: '10', route: 'cashier' };
const errorCode = (code) => (error) => { assert.equal(error.code, code, error.message); return true; };

// No JsonRpcProvider, environment configuration, proof verifier or network client is constructed here.
// Unexpected signing/admin calls are recorded AND throw, even if the service catches the error.
function fixture({ chainId = 11155111, mock = false, offset = 0 } = {}) {
  const a = Object.fromEntries(['wallet', 'other', 'token', 'asset', 'router', 'hook', 'oracle', 'attestor', 'manager', 'issuer']
    .map((key, i) => [key, address(offset + i + 1)]));
  const calls = { forbidden: [], connects: [], simulations: [], identity: [], logs: [], transactions: [], receipts: [] };
  const forbidden = (name) => (...args) => { calls.forbidden.push([name, args]); throw new Error(`Forbidden: ${name}`); };
  const state = { now: NOW, timestamp: NOW, canonical: true, blockNumber: 2500, balance: 1000n * M, allowance: 1000n * M,
    native: 10n ** 18n, decimals: 6, reserve: 1000n * M, supply: 100n * M, cap: 10000n * M,
    paused: false, mintEnabled: true, burnEnabled: true, decisions: [true, true, true], quoteOut: 10n * M,
    facts: [0n, 0n, 0n], oldExpiry: 0n, transaction: null, receipt: null, logs: [] };
  const policy = { hash: id(`policy ${offset}`), actionOrder: ['mint', 'burn', 'transfer'],
    factOrder: ['kycApproved', 'identityVerified', 'amlApproved', 'subscriptionAccepted'],
    cashier: { termsHash: id(`terms ${offset}`), configurationHash: id(`configuration ${offset}`) } };
  state.configHash = policy.cashier.configurationHash;
  state.routerConfigHash = policy.cashier.configurationHash;
  const clauseTable = { clauses: [{ clause: 'Independent screening', quote: 'KYC and AML are independent of World ID.' }] };
  const record = { chainId, attestor: a.attestor, usdc: a.asset, rwa: { token: a.token, router: a.router, hook: a.hook,
    oracle: a.oracle, poolManager: a.manager, policyHash: policy.hash, cashier: { enabled: true, asset: a.asset },
    poolKey: { currency0: a.token, currency1: a.asset, fee: 3000, tickSpacing: 60, hooks: a.hook } } };
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getBlock: async (number) => number === 'latest'
      ? { number: state.blockNumber, timestamp: state.timestamp, hash: BLOCK }
      : state.canonical ? { number, timestamp: state.timestamp, hash: BLOCK } : null,
    getBalance: async (wallet) => { assert.equal(wallet, a.wallet); return state.native; },
    call: async (transaction) => {
      calls.simulations.push(structuredClone(transaction));
      if (state.simulationError) throw state.simulationError;
      if (state.simulation !== undefined) return state.simulation;
      return transaction.to === a.router ? ROUTER.encodeFunctionResult('swap', [state.quoteOut]) : ERC20.encodeFunctionResult('approve', [true]);
    },
    getTransaction: async (hash) => { calls.transactions.push(hash); return state.transaction; },
    getTransactionReceipt: async (hash) => { calls.receipts.push(hash); if (state.receiptError) throw state.receiptError; return state.receipt; },
    getLogs: async (filter) => { calls.logs.push(filter); if (state.logsError) throw state.logsError; return state.logs; },
    getSigner: forbidden('provider.getSigner'), send: forbidden('provider.send'), broadcastTransaction: forbidden('provider.broadcastTransaction'),
  };
  const signer = { address: a.issuer, getAddress: async () => a.issuer,
    sendTransaction: forbidden('issuer.sendTransaction'), signTransaction: forbidden('issuer.signTransaction') };
  const readContract = (name, methods) => ({ ...methods, connect: (runner) => {
    calls.connects.push([name, runner]); assert.equal(runner, provider, `${name} must use a read-only provider`); return methods;
  } });
  const asset = readContract('asset', {
    decimals: async () => state.decimals, symbol: async () => 'mUSD',
    balanceOf: async (wallet) => { assert.ok([a.wallet, a.hook].includes(wallet)); return wallet === a.hook ? state.reserve : state.balance; },
    allowance: async (owner, spender) => { assert.equal(owner, a.wallet); assert.equal(spender, a.router); return state.allowance; },
    approve: forbidden('asset.approve'), mint: forbidden('asset.mint'), transfer: forbidden('asset.transfer'),
  });
  const token = readContract('token', { ...asset, symbol: async () => 'FUND',
    policyHash: async () => policy.hash, policyOracle: async () => a.oracle, venueHook: async () => a.hook,
    totalSupply: async () => state.supply, maxSupply: async () => state.cap, paused: async () => state.paused,
    mintEnabled: async () => state.mintEnabled, burnEnabled: async () => state.burnEnabled,
  });
  const c = { token, usdc: asset, cashierAsset: asset,
    rwaOracle: readContract('oracle', { policyHash: async () => policy.hash, attestor: async () => a.attestor,
      decide: async (wallet, index) => { assert.equal(wallet, a.wallet); return [state.decisions[index], state.decisions[index] ? 0n : 1n]; } }),
    hook: readContract('hook', { poolManager: async () => a.manager, router: async () => a.router, asset: async () => a.asset,
      token: async () => a.token, oracle: async () => a.oracle, policyHash: async () => policy.hash,
      configurationHash: async () => state.configHash, termsHash: async () => policy.cashier.termsHash,
      nav: async () => M, subscriptionFeeBps: async () => 25n, redemptionFeeBps: async () => 25n,
      poolFee: async () => 3000n, tickSpacing: async () => 60n, quote: async () => state.quoteOut }),
    v4Router: readContract('router', { configurationHash: async () => state.routerConfigHash, poolManager: async () => a.manager, swap: forbidden('router.swap') }),
  };
  const reader = { factsOf: async () => state.facts, expiresAt: async () => state.oldExpiry };
  c.attestor = { connect: (runner) => {
    calls.connects.push(['attestor', runner]);
    if (runner === provider) return reader;
    assert.equal(runner, signer);
    return { attest: async (...args) => {
      calls.identity.push(args);
      if (state.attestError) throw state.attestError;
      if (state.attest) return { hash: HASH, from: a.issuer, to: a.attestor, ...await state.attest(...args) };
      const [subject, hash, known, value, , expiresAt] = args;
      state.receipt = receipt({ from: a.issuer, to: a.attestor }, [log(ATTESTOR, 'Attested', [subject, hash, known, value, expiresAt], a.attestor)]);
      return { hash: HASH, from: a.issuer, to: a.attestor, wait: async () => state.receipt };
    } };
  } };
  const verifier = { credential: 'document', environment: mock ? 'mock' : 'sandbox', mock, action: 'onboard-investor',
    verify: forbidden('world.verify'), context: forbidden('world.context'), secret: 'never-public' };
  const venue = { provider, signer, c, record, worldId: { verifier }, policy: (name) => { assert.equal(name, 'rwa'); return { policy, clauseTable }; } };
  for (const name of ['signerFor', 'fund', 'deploy', 'attest', 'attestMerged', 'verifyHuman', 'cashierSwap', 'cashierPrefund', 'swap', 'mint', 'release']) venue[name] = forbidden(`venue.${name}`);
  const session = { id: 'authenticated-session-1', wallet: a.wallet, fundId: 'stack', policyHash: policy.hash, chainId,
    expiresAt: NOW + 900, credential: 'document', environment: verifier.environment, mock,
    verification: { success: true, nullifier: id('fake verified nullifier'), credential: 'document', environment: verifier.environment, mock, action: verifier.action } };
  const service = new InvestorService({ venues: venue, clock: () => state.now * 1000 });
  return { a, calls, state, policy, record, provider, c, venue, session, service, clauseTable };
}
function log(iface, name, args, contract, extra = {}) {
  return { ...iface.encodeEventLog(iface.getEvent(name), args), address: contract, transactionHash: HASH,
    blockNumber: 2499, blockHash: BLOCK, index: 0, removed: false, ...extra };
}
function receipt(transaction, logs = [], extra = {}) {
  return { hash: HASH, from: transaction.from, to: transaction.to, blockNumber: 2499, blockHash: BLOCK, status: 1, logs, ...extra };
}
async function prepared(f, input = swapOrder) {
  const intent = await f.service.prepare(f.session, input);
  f.state.transaction = { ...intent.transaction, hash: HASH };
  const event = input.kind === 'approval'
    ? log(ERC20, 'Approval', [f.a.wallet, f.a.router, parseUnits(input.amount, 6)], intent.transaction.to)
    : log(ROUTER, 'Executed', [f.a.wallet, input.route === 'amm' ? 1 : 2, parseUnits(input.amount, 6), 10n * M], f.a.router);
  f.state.receipt = receipt(intent.transaction, [event]);
  return intent;
}
const confirm = (f, intent, txHash = HASH, session = f.session) => f.service.confirm(session, { intentId: intent.intentId, txHash });
function indexedRow(iface, name, args, contract, extra = {}) {
  const fragment = iface.getEvent(name);
  return { event: { contract: { address: contract }, name, signature: fragment.format('sighash'), indexInLog: 0,
    inputs: fragment.inputs.map((field, i) => ({ name: field.name, value: typeof args[i] === 'bigint' ? String(args[i]) : args[i], hashed: false })) },
  transaction: { txHash: HASH, blockNumber: 2499, blockHash: BLOCK }, ...extra };
}
function fakeIndexer(rows, calls = []) {
  return { events: { listEvents: async (...args) => { calls.push(args); return { data: { status: 200, result: rows } }; } } };
}

test('public config and explicit publication never enumerate private uploads or expose venue secrets', async () => {
  const f = fixture(); const accesses = [];
  const agreements = { record: (fundId) => { accesses.push(fundId); return { status: fundId === 'draft' ? 'analysed' : 'deployed', name: 'Published fund', source: 'private document' }; },
    venue: async () => f.venue, list: () => assert.fail('Do not enumerate uploads') };
  const service = new InvestorService({ venues: f.venue, agreements, publishedAgreementIds: ['stack', 'published', 'draft'] });
  assert.deepEqual(service.config(), { chainId: 11155111, credential: 'document', environment: 'sandbox', mock: false });
  assert.equal((await service.resolveFund('stack')).venue, f.venue);
  for (const fundId of ['unpublished', '../private', null, 123]) await assert.rejects(service.resolveFund(fundId), errorCode('FUND_NOT_FOUND'));
  assert.deepEqual(accesses, []);
  const funds = await service.funds();
  assert.deepEqual(funds.map((fund) => fund.id), ['stack', 'published']);
  assert.equal(funds[1].symbol, 'FUND');
  assert.doesNotMatch(JSON.stringify(funds), /private document|never-public|signer|verification|nullifier/);
  assert.deepEqual(accesses, ['published', 'draft']);
  for (const publishedAgreementIds of [null, 'all', [5], ['a'.repeat(129)]]) {
    assert.throws(() => new InvestorService({ venues: f.venue, publishedAgreementIds }), errorCode('INVALID_PUBLICATION'));
  }
  assert.deepEqual(await new InvestorService({ venues: null }).funds(), []);
});

test('snapshot has explicit wallet-scoped balances, source clauses, cashier limits and noncustodial capabilities', async () => {
  const f = fixture(); f.state.decisions[0] = false;
  const view = await f.service.snapshot(f.session);
  assert.equal(view.wallet, f.a.wallet); assert.equal(view.policyHash, f.policy.hash);
  assert.equal(view.balances.asset.balanceRaw, String(f.state.balance));
  assert.equal(view.balances.token.spender, f.a.router);
  assert.deepEqual(view.policy.mint.clause, f.clauseTable.clauses[0]);
  assert.equal(view.cashier.reserveRaw, String(f.state.reserve));
  assert.equal(view.cashier.configurationHash, f.policy.cashier.configurationHash);
  assert.deepEqual(view.capabilities, { readOnly: false, prepareApproval: true, prepareSwap: true, browserWalletRequired: true,
    identityAttestation: true, serverTrading: false, funding: false, deployment: false });
  assert.deepEqual(f.calls.forbidden, []);
});

test('sessions and on-chain context are checked before any simulation or issuer write', async (t) => {
  const cases = [
    ['missing', (f) => { f.session = null; }, 'INVALID_SESSION'],
    ['missing session ID', (f) => { delete f.session.id; }, 'INVALID_SESSION'],
    ['empty session ID', (f) => { f.session.id = ''; }, 'INVALID_SESSION'],
    ['oversized session ID', (f) => { f.session.id = 'x'.repeat(129); }, 'INVALID_SESSION'],
    ['invalid wallet', (f) => { f.session.wallet = 'Investor'; }, 'INVALID_SESSION'],
    ['invalid hash', (f) => { f.session.policyHash = 'old'; }, 'INVALID_SESSION'],
    ['expired wall clock', (f) => { f.session.expiresAt = NOW; }, 'INVALID_SESSION'],
    ['expired chain clock', (f) => { f.state.timestamp = f.session.expiresAt; }, 'SESSION_EXPIRED'],
    ['changed credential', (f) => { f.venue.worldId.verifier.credential = 'selfie'; }, 'SESSION_CONTEXT_CHANGED'],
    ['changed environment', (f) => { f.venue.worldId.verifier.environment = 'production'; }, 'SESSION_CONTEXT_CHANGED'],
    ['changed mock provenance', (f) => { f.session.mock = true; }, 'SESSION_CONTEXT_CHANGED'],
    ['unverified', (f) => { f.session.verification.success = false; }, 'INVALID_VERIFICATION'],
    ['missing verification', (f) => { delete f.session.verification; }, 'INVALID_VERIFICATION'],
    ['foreign action', (f) => { f.session.verification.action = 'other-action'; }, 'INVALID_VERIFICATION'],
    ['foreign verified credential', (f) => { f.session.verification.credential = 'selfie'; }, 'INVALID_VERIFICATION'],
    ['oversized nullifier', (f) => { f.session.verification.nullifier = 'a'.repeat(257); }, 'INVALID_VERIFICATION'],
    ['changed policy', (f) => { f.record.rwa.policyHash = OTHER_HASH; }, 'SESSION_CONTEXT_CHANGED'],
    ['changed chain', (f) => { f.record.chainId = 1; }, 'SESSION_CONTEXT_CHANGED'],
    ['wrong RPC chain', (f) => { f.provider.getNetwork = async () => ({ chainId: 1n }); }, 'CHAIN_BINDING_CHANGED'],
    ['wrong oracle binding', (f) => { f.record.rwa.oracle = f.a.other; }, 'CHAIN_BINDING_CHANGED'],
    ['wrong attestor binding', (f) => { f.record.attestor = f.a.other; }, 'CHAIN_BINDING_CHANGED'],
    ['RPC failure', (f) => { f.provider.getBlock = async () => { throw new Error('secret RPC url'); }; }, 'CHAIN_UNAVAILABLE'],
  ];
  for (const [name, change, code] of cases) await t.test(name, async () => {
    const f = fixture(); change(f);
    await assert.rejects(f.service.prepare(f.session, swapOrder), (error) => {
      errorCode(code)(error); assert.doesNotMatch(error.message, /secret RPC/); return true;
    });
    assert.equal(f.calls.simulations.length, 0); assert.equal(f.calls.identity.length, 0); assert.deepEqual(f.calls.forbidden, []);
  });
});

test('legacy router, unsupported network and unsupported decimals remain read-only', async (t) => {
  for (const mode of ['legacy', 'network', 'decimals']) await t.test(mode, async () => {
    const f = fixture({ chainId: mode === 'network' ? 1 : 11155111 });
    if (mode === 'legacy') delete f.record.rwa.cashier;
    if (mode === 'decimals') f.state.decimals = 18;
    const snapshot = await f.service.snapshot(f.session);
    assert.equal(snapshot.capabilities.readOnly, true); assert.equal(snapshot.capabilities.prepareSwap, false);
    assert.ok(snapshot.disabledReason);
    const quote = await f.service.quote(f.session, swapOrder);
    assert.ok(quote.blockers.some((blocker) => blocker.code === 'READ_ONLY_FUND'));
    for (const input of [swapOrder, approvalOrder]) await assert.rejects(f.service.prepare(f.session, input), errorCode('READ_ONLY_FUND'));
    if (mode === 'legacy') { assert.equal(quote.amountOut, null); assert.equal(quote.kind, 'unavailable'); }
    assert.equal(f.calls.simulations.length, 0);
  });
});

test('cashier binding fails closed for changed addresses, pool fields and unequal configuration commitments', async (t) => {
  for (const [name, change] of [
    ['manager', (f) => { f.record.rwa.poolManager = f.a.other; }],
    ['asset', (f) => { f.record.rwa.cashier.asset = f.a.other; }],
    ['pair', (f) => { f.record.rwa.poolKey.currency0 = f.a.other; }],
    ['hook', (f) => { f.record.rwa.poolKey.hooks = f.a.other; }],
    ['fee', (f) => { f.record.rwa.poolKey.fee++; }],
    ['spacing', (f) => { f.record.rwa.poolKey.tickSpacing++; }],
    ['router commitment', (f) => { f.state.routerConfigHash = OTHER_HASH; }],
  ]) await t.test(name, async () => {
    const f = fixture(); change(f);
    await assert.rejects(f.service.snapshot(f.session), errorCode('CASHIER_BINDING_CHANGED'));
  });
});

test('REGRESSION: matching hook/router commitments must also match the published policy commitment', async () => {
  const f = fixture(); f.state.configHash = f.state.routerConfigHash = OTHER_HASH;
  await assert.rejects(f.service.snapshot(f.session), errorCode('CASHIER_BINDING_CHANGED'));
});

test('amount and order grammar rejects implicit numbers, precision loss, nonpositive and int128 overflow', async () => {
  const f = fixture();
  for (const amount of [undefined, null, 10, 0, '', '0', '0.000000', '-1', '+1', '01', '.1', '1.', '1e6', ' 1', '1.0000001', '1'.repeat(41), '170141183460469231731687303715884.105728']) {
    await assert.rejects(f.service.quote(f.session, { ...swapOrder, amount }), errorCode('INVALID_AMOUNT'));
  }
  for (const input of [null, {}, { ...swapOrder, buy: 'true' }, { ...swapOrder, route: 'admin' }]) {
    await assert.rejects(f.service.quote(f.session, input), errorCode('INVALID_ORDER'));
  }
  await assert.rejects(f.service.prepare(f.session, { ...swapOrder, kind: 'fund' }), errorCode('INVALID_KIND'));
  assert.equal(f.calls.simulations.length, 0);
});

test('NAV quotes are explicitly indicative and blockers preserve action/route scope', async () => {
  const f = fixture(); f.state.allowance = 0n; f.state.balance = 0n; f.state.native = 0n;
  f.state.decisions = [false, true, false]; f.state.paused = true; f.state.mintEnabled = false; f.state.cap = f.state.supply;
  const quote = await f.service.quote(f.session, swapOrder);
  assert.equal(quote.kind, 'nav-only'); assert.equal(quote.indicative, true); assert.equal(quote.simulated, false); assert.equal(quote.executable, null);
  assert.equal(quote.amountRaw, '10000000'); assert.equal(quote.amountOutRaw, '10000000');
  assert.deepEqual(new Set(quote.blockers.map((b) => b.code)), new Set(['POLICY_REFUSED', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_ALLOWANCE', 'GAS_REQUIRED', 'TOKEN_PAUSED', 'ACTION_DISABLED', 'SUPPLY_CAP']));
  assert.equal(quote.blockers.find((b) => b.action === 'transfer').scope, 'all');
  assert.equal(quote.blockers.find((b) => b.action === 'mint').scope, 'cashier');
  f.state.reserve = 0n;
  assert.ok((await f.service.quote(f.session, { ...swapOrder, buy: false })).blockers.some((b) => b.code === 'INSUFFICIENT_RESERVE'));
  assert.equal(f.calls.simulations.length, 0);
});

test('exact approvals and bounded swaps use investor from, correct token/direction and no server signing', async (t) => {
  for (const buy of [true, false]) for (const route of ['auto', 'amm', 'cashier']) await t.test(`${buy ? 'buy' : 'sell'} ${route}`, async () => {
    const f = fixture(); f.state.allowance = 0n;
    const approval = await f.service.prepare(f.session, { ...approvalOrder, buy, route, amount: '10.000001', spender: f.a.other, wallet: f.a.other, to: f.a.other, value: '1' });
    const decoded = ERC20.decodeFunctionData('approve', approval.transaction.data);
    assert.equal(decoded.spender, f.a.router); assert.equal(decoded.amount, 10n * M + 1n);
    assert.equal(approval.transaction.from, f.a.wallet); assert.equal(approval.transaction.to, buy ? f.a.asset : f.a.token);
    assert.equal(approval.transaction.value, '0x0'); assert.equal(approval.transaction.chainId, 11155111);
    assert.equal(approval.expiresAt, NOW + 180);
    await assert.rejects(f.service.prepare(f.session, { ...swapOrder, buy, route }), errorCode('INSUFFICIENT_ALLOWANCE'));
    f.state.allowance = 10n * M;
    const swap = await f.service.prepare(f.session, { ...swapOrder, buy, route, deadline: NOW + 100 });
    const args = ROUTER.decodeFunctionData('swap', swap.transaction.data);
    assert.equal(args.params.amountSpecified, -10n * M); assert.equal(args.params.zeroForOne, !buy);
    assert.equal(args.params.sqrtPriceLimitX96, buy ? 1461446703485210103287273052203988822378723970341n : 4295128740n);
    assert.equal(args.key.hooks, f.a.hook); assert.equal(args.minOut, 9n * M);
    assert.equal(args.deadline, BigInt(NOW + 100)); assert.equal(Number(args.route), ['auto', 'amm', 'cashier'].indexOf(route));
    assert.equal(swap.expiresAt, NOW + 100); assert.equal(swap.transaction.to, f.a.router);
    assert.deepEqual(f.calls.simulations, [approval.transaction, swap.transaction]);
    assert.equal(f.calls.identity.length, 0); assert.deepEqual(f.calls.forbidden, []);
    // A returned object is not the service's private intent storage.
    approval.transaction.to = f.a.other;
  });
});

test('deadline uses max(chain time, wall time), session lifetime and at most three minutes', async () => {
  const f = fixture();
  for (const deadline of [NOW, NOW - 1, NOW + 181, NOW + 0.5, '2000000100', Infinity, NaN]) {
    await assert.rejects(f.service.prepare(f.session, { ...swapOrder, deadline }), errorCode('INVALID_DEADLINE'));
  }
  for (const minOut of [undefined, '0', '-1', 1, '0.0000001']) await assert.rejects(f.service.prepare(f.session, { ...swapOrder, minOut }), errorCode('INVALID_AMOUNT'));
  f.state.timestamp = NOW + 50; f.session.expiresAt = NOW + 90;
  await assert.rejects(f.service.prepare(f.session, { ...swapOrder, deadline: NOW + 40 }), errorCode('INVALID_DEADLINE'));
  await assert.rejects(f.service.prepare(f.session, { ...swapOrder, deadline: NOW + 91 }), errorCode('INVALID_DEADLINE'));
  assert.equal((await f.service.prepare(f.session, swapOrder)).deadline, NOW + 90);
});

test('cashier-only blockers do not authorize AMM/auto without a successful RPC simulation', async () => {
  const f = fixture(); f.state.decisions[0] = false;
  await assert.rejects(f.service.prepare(f.session, swapOrder), errorCode('POLICY_REFUSED'));
  for (const route of ['amm', 'auto']) await f.service.prepare(f.session, { ...swapOrder, route });
  f.state.simulationError = new Error('private RPC credential and calldata');
  await assert.rejects(f.service.prepare(f.session, { ...swapOrder, route: 'auto' }), (error) => {
    errorCode('SIMULATION_REFUSED')(error); assert.doesNotMatch(JSON.stringify(error), /private RPC/); return true;
  });
  f.state.simulationError = null; f.state.decisions[2] = false;
  await assert.rejects(f.service.prepare(f.session, { ...swapOrder, route: 'amm' }), errorCode('POLICY_REFUSED'));
  assert.deepEqual(f.calls.forbidden, []);
});

test('approval false return is refused; empty-return ERC20 is supported; malformed result is not success', async () => {
  const f = fixture();
  f.state.simulation = ERC20.encodeFunctionResult('approve', [false]);
  await assert.rejects(f.service.prepare(f.session, approvalOrder), errorCode('APPROVAL_REFUSED'));
  f.state.simulation = '0x'; await f.service.prepare(f.session, approvalOrder);
  f.state.simulation = '0x1234'; await assert.rejects(f.service.prepare(f.session, approvalOrder), errorCode('CHAIN_UNAVAILABLE'));
});

test('intent capacity is bounded per wallet and expired entries are pruned', async () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) await f.service.prepare(f.session, approvalOrder);
  await assert.rejects(f.service.prepare(f.session, approvalOrder), errorCode('INTENT_LIMIT'));
  f.state.now += 181;
  await f.service.prepare(f.session, approvalOrder);
});

test('confirmation requires this session, fund, nullifier, policy and original immutable intent', async () => {
  const f = fixture(); const intent = await prepared(f);
  for (const patch of [{ id: 'another-login' }, { wallet: f.a.other }, { expiresAt: NOW + 899 },
    { verification: { ...f.session.verification, nullifier: OTHER_HASH } }]) {
    await assert.rejects(confirm(f, intent, HASH, { ...f.session, ...patch }), errorCode('INTENT_NOT_FOUND'));
  }
  f.service.agreements = { record: () => ({ status: 'deployed' }), venue: async () => f.venue };
  f.service.publishedAgreementIds.add('other-fund');
  await assert.rejects(confirm(f, intent, HASH, { ...f.session, fundId: 'other-fund' }), errorCode('INTENT_NOT_FOUND'));
  for (const value of [undefined, {}, { intentId: intent.intentId, txHash: '0x123' }]) {
    await assert.rejects(f.service.confirm(f.session, value), errorCode('INVALID_CONFIRMATION'));
  }
  intent.transaction.to = f.a.other;
  assert.equal((await confirm(f, intent)).status, 'confirmed');
  f.state.now = NOW + 180;
  await assert.rejects(confirm(f, intent), errorCode('INTENT_EXPIRED'));
});

test('REGRESSION: separate real auth sessions issued in the same second cannot share a prepared intent', async () => {
  const f = fixture(); const wallet = new Wallet(id('unit-test-only wallet; never funded'));
  f.a.wallet = wallet.address;
  const verifier = f.venue.worldId.verifier;
  verifier.appId = 'app_unittest'; verifier.rpId = 'rp_unittest';
  let nonce = 0;
  verifier.context = async () => ({ app_id: verifier.appId, rp_id: verifier.rpId, action: verifier.action,
    credential: verifier.credential, environment: verifier.environment, mock: false, allow_legacy_proofs: false,
    rp_context: { rp_id: verifier.rpId, nonce: id(`fake World request ${nonce++}`), created_at: NOW, expires_at: NOW + 300, signature: `0x${'11'.repeat(65)}` } });
  verifier.verify = async (_proof, subject) => {
    assert.equal(subject, wallet.address.toLowerCase()); return { ...f.session.verification };
  };
  // In-memory fake registry/verifier only: the path is a marker and is never opened.
  f.venue.worldId.registry = { path: 'unit-test-registry-not-on-disk', bind: async () => wallet.address };
  const origin = 'https://investor.example';
  const auth = new InvestorAuth({ resolveFund: (fundId) => f.service.resolveFund(fundId), allowedOrigins: [origin], clock: () => NOW * 1000 });
  const login = async () => {
    const metadata = { origin, clientIp: '127.0.0.1' };
    const challenge = await auth.challenge({ wallet: wallet.address, fundId: 'stack' }, metadata);
    return auth.verify({ challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message),
      proof: { nonce: challenge.world.rp_context.nonce } }, metadata);
  };
  const first = await login(); const second = await login();
  assert.notEqual(first.accessToken, second.accessToken);
  f.session = await auth.authenticate(first.accessToken);
  const otherSession = await auth.authenticate(second.accessToken);
  const intent = await prepared(f);
  await assert.rejects(confirm(f, intent, HASH, otherSession), errorCode('INTENT_NOT_FOUND'));
});

test('pending transaction/receipt, changed hash and canonical reorgs never fabricate confirmations or resend', async () => {
  const f = fixture(); const intent = await prepared(f); const tx = f.state.transaction; const mined = f.state.receipt;
  f.state.transaction = null;
  assert.equal((await confirm(f, intent)).status, 'pending'); assert.equal(f.calls.receipts.length, 0);
  f.state.transaction = tx; f.state.receipt = null;
  assert.equal((await confirm(f, intent)).status, 'pending');
  await assert.rejects(confirm(f, intent, OTHER_HASH), errorCode('INTENT_HASH_CHANGED'));
  f.state.receipt = mined; f.state.canonical = false;
  assert.equal((await confirm(f, intent)).status, 'pending');
  f.state.canonical = true;
  const result = await confirm(f, intent);
  assert.equal(result.status, 'confirmed'); assert.equal(result.source, 'rpc'); assert.equal(result.actualRoute, 'cashier');
  assert.equal(result.amountIn, '10.0'); assert.equal(result.amountOut, '10.0'); assert.equal(result.finality, 'mined-not-finalized');
  f.state.canonical = false;
  assert.equal((await confirm(f, intent)).status, 'pending', 'Do not cache a confirmation across a reorg');
  assert.equal(f.calls.simulations.length, 1); assert.deepEqual(f.calls.forbidden, []);
});

test('transaction mismatch: hash, wallet, destination, calldata, value and chain all fail closed', async (t) => {
  for (const [field, value] of Object.entries({ hash: OTHER_HASH, from: address(99), to: address(99), data: '0x', value: 1n, chainId: 1 })) {
    await t.test(field, async () => {
      const f = fixture(); const intent = await prepared(f); f.state.transaction[field] = value;
      await assert.rejects(confirm(f, intent), errorCode('TRANSACTION_MISMATCH')); assert.equal(f.calls.receipts.length, 0);
    });
  }
});

test('receipt mismatch: hash, sender, destination and block metadata fail closed', async (t) => {
  for (const [field, value] of Object.entries({ hash: OTHER_HASH, from: address(99), to: address(99), blockNumber: '2499', blockHash: '0x123' })) {
    await t.test(field, async () => {
      const f = fixture(); const intent = await prepared(f); f.state.receipt[field] = value;
      await assert.rejects(confirm(f, intent), errorCode('RECEIPT_MISMATCH'));
    });
  }
  const f = fixture(); const intent = await prepared(f); f.state.receipt.blockHash = OTHER_HASH;
  assert.equal((await confirm(f, intent)).status, 'pending');
});

test('canonical revert and invalid status do not count as executions', async () => {
  const f = fixture(); const intent = await prepared(f); f.state.receipt.status = 0;
  assert.equal((await confirm(f, intent)).status, 'reverted');
  f.state.receipt.status = 2; await assert.rejects(confirm(f, intent), errorCode('INVALID_RECEIPT'));
  f.state.receiptError = new Error('private RPC'); await assert.rejects(confirm(f, intent), errorCode('CHAIN_UNAVAILABLE'));
});

test('successful swap requires one exact known-router event and enforces input, output and chosen route', async (t) => {
  const changes = [
    ['foreign contract', (f, event) => { event.address = f.a.other; }],
    ['removed', (_f, event) => { event.removed = true; }],
    ['duplicate', (f, event) => { f.state.receipt.logs.push(event); }],
    ['malformed', (_f, event) => { event.data = '0x'; }],
    ['missing', (f) => { f.state.receipt.logs = []; }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const f = fixture(); const intent = await prepared(f); change(f, f.state.receipt.logs[0]);
    await assert.rejects(confirm(f, intent), errorCode('EXECUTION_NOT_PROVEN'));
  });
  for (const [name, args] of [
    ['foreign subject', [address(99), 2, 10n * M, 10n * M]], ['wrong input', [address(1), 2, 11n * M, 10n * M]],
    ['below minimum', [address(1), 2, 10n * M, 9n * M - 1n]], ['auto event is not a route', [address(1), 0, 10n * M, 10n * M]],
    ['wrong requested route', [address(1), 1, 10n * M, 10n * M]],
  ]) await t.test(name, async () => {
    const f = fixture(); const intent = await prepared(f); f.state.receipt.logs = [log(ROUTER, 'Executed', args, f.a.router)];
    await assert.rejects(confirm(f, intent), errorCode('EXECUTION_NOT_PROVEN'));
  });
  for (const actualRoute of [1, 2]) {
    const f = fixture(); const intent = await prepared(f, { ...swapOrder, route: 'auto' });
    f.state.receipt.logs = [log(ROUTER, 'Executed', [f.a.wallet, actualRoute, 10n * M, 9n * M], f.a.router)];
    assert.equal((await confirm(f, intent)).actualRoute, actualRoute === 1 ? 'amm' : 'cashier');
  }
});

test('approval receipt proves the exact token, owner, spender and amount, not just success status', async (t) => {
  for (const field of ['token', 'owner', 'spender', 'amount', 'removed']) await t.test(field, async () => {
    const f = fixture(); const intent = await prepared(f, approvalOrder);
    f.state.receipt.logs = [log(ERC20, 'Approval', [field === 'owner' ? f.a.other : f.a.wallet,
      field === 'spender' ? f.a.other : f.a.router, field === 'amount' ? 11n * M : 10n * M], field === 'token' ? f.a.other : f.a.asset, { removed: field === 'removed' })];
    await assert.rejects(confirm(f, intent), errorCode('APPROVAL_NOT_PROVEN'));
  });
  const f = fixture(); const intent = await prepared(f, approvalOrder);
  assert.equal((await confirm(f, intent)).status, 'confirmed');
});

test('identity-only attestation preserves independent known/value bits, screening date and shorter expiry', async () => {
  const f = fixture(); f.state.facts = [5n, 1n, BigInt(NOW - 1000)]; f.state.oldExpiry = BigInt(NOW + 60);
  const result = await f.service.attestIdentity(f.session);
  assert.equal(result.status, 'confirmed'); assert.equal(result.finality, 'mined-not-finalized');
  assert.deepEqual(f.calls.identity, [[f.a.wallet, f.policy.hash, 7n, 3n, BigInt(NOW - 1000), NOW + 60]]);
  assert.equal(3n & 4n, 0n, 'AML remains explicitly false');
  assert.deepEqual(f.calls.forbidden, []);
  const fresh = fixture(); fresh.state.oldExpiry = BigInt(NOW - 1); // Real factsOf returns zero for all expired facts.
  await fresh.service.attestIdentity(fresh.session);
  assert.deepEqual(fresh.calls.identity[0], [fresh.a.wallet, fresh.policy.hash, 2n, 2n, NOW, fresh.session.expiresAt]);
});

test('current identity is read-only; unsupported policy and mock Sepolia cannot spend issuer gas', async () => {
  const f = fixture(); f.state.facts = [7n, 3n, BigInt(NOW - 100)]; f.state.oldExpiry = BigInt(NOW + 30);
  assert.deepEqual(await f.service.attestIdentity(f.session), { status: 'already-attested', identityVerified: true, submitted: false, expiresAt: NOW + 30 });
  assert.equal(f.calls.identity.length, 0);
  f.policy.factOrder = ['kycApproved']; await assert.rejects(f.service.attestIdentity(f.session), errorCode('IDENTITY_NOT_SUPPORTED'));
  const mock = fixture({ mock: true }); await assert.rejects(mock.service.attestIdentity(mock.session), errorCode('MOCK_IDENTITY_LOCAL_ONLY'));
  assert.equal(mock.calls.identity.length, 0);
  const local = fixture({ chainId: 31337, mock: true }); assert.equal((await local.service.attestIdentity(local.session)).status, 'confirmed');
});

test('failed identity submissions are throttled across sessions and funds, without proof calls or automatic retries', async () => {
  const f = fixture(); f.session.expiresAt = NOW + 86400 * 2; f.state.attestError = new Error('private signer info');
  f.service.agreements = { record: () => ({ status: 'deployed' }), venue: async () => f.venue }; f.service.publishedAgreementIds.add('published');
  for (let i = 0; i < 3; i++) {
    const failed = await f.service.attestIdentity(f.session);
    assert.equal(failed.code, 'ATTESTATION_FAILED'); assert.doesNotMatch(JSON.stringify(failed), /private signer/);
    const cooldown = await f.service.attestIdentity({ ...f.session, id: `new-login-${i}`, fundId: 'published' });
    assert.equal(cooldown.code, 'IDENTITY_RATE_LIMIT'); assert.ok(cooldown.retryAfter > 0);
    f.state.now += 300;
  }
  assert.equal((await f.service.attestIdentity(f.session)).code, 'IDENTITY_RATE_LIMIT'); assert.equal(f.calls.identity.length, 3);
  f.state.now = NOW + 86400;
  assert.equal((await f.service.attestIdentity(f.session)).code, 'ATTESTATION_FAILED'); assert.equal(f.calls.identity.length, 4);
  assert.deepEqual(f.calls.forbidden, []);
});

test('global identity issuer budget caps writes across different wallets', async () => {
  const f = fixture(); f.state.attestError = new Error('test issuer refuses');
  for (let i = 0; i < 64; i++) {
    const result = await f.service.attestIdentity({ ...f.session, wallet: address(1000 + i) });
    assert.equal(result.code, 'ATTESTATION_FAILED');
  }
  const refused = await f.service.attestIdentity({ ...f.session, wallet: address(2000) });
  assert.equal(refused.code, 'IDENTITY_RATE_LIMIT'); assert.equal(f.calls.identity.length, 64);
});

test('pending identity for a different policy is reconciled, not replaced by a new write', async () => {
  const f = fixture(); f.state.attest = async () => ({ hash: HASH, wait: async () => {} });
  assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
  f.policy.hash = f.record.rwa.policyHash = OTHER_HASH;
  const pending = await f.service.attestIdentity({ ...f.session, policyHash: OTHER_HASH, id: 'reauthenticated' });
  assert.equal(pending.status, 'pending'); assert.match(pending.reason, /prior identity transaction/);
  assert.equal(f.calls.identity.length, 1);
});

test('concurrent identity calls share a wallet lock and pending receipts are reconciled without another write', async () => {
  const f = fixture(); let release; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.state.attest = async () => { entered(); await gate; return { hash: HASH, wait: async () => { throw new Error('timeout'); } }; };
  const first = f.service.attestIdentity(f.session); await started;
  assert.equal((await f.service.attestIdentity({ ...f.session, id: 'parallel' })).status, 'pending');
  release(); assert.equal((await first).status, 'pending');
  assert.equal((await f.service.attestIdentity(f.session)).status, 'pending'); assert.equal(f.calls.identity.length, 1);
  f.state.receipt = receipt({ from: f.a.issuer, to: f.a.attestor }, [log(ATTESTOR, 'Attested', [f.a.wallet, f.policy.hash, 2n, 2n, f.session.expiresAt], f.a.attestor)]);
  f.state.canonical = false; assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
  f.state.canonical = true; assert.equal((await f.service.attestIdentity(f.session)).status, 'confirmed');
  assert.equal(f.calls.identity.length, 1);
});

test('identity revert, outage, missing/foreign/removed events cannot grant a credential', async (t) => {
  for (const mode of ['reverted', 'outage', 'missing', 'foreign-policy', 'foreign-subject', 'removed', 'unknown-status']) await t.test(mode, async () => {
    const f = fixture();
    f.state.attest = async () => {
      f.state.receipt = receipt({ from: f.a.issuer, to: f.a.attestor }, mode === 'missing' ? [] : [log(ATTESTOR, 'Attested', [
        mode === 'foreign-subject' ? f.a.other : f.a.wallet, mode === 'foreign-policy' ? OTHER_HASH : f.policy.hash, 2n, 2n, f.session.expiresAt,
      ], f.a.attestor, { removed: mode === 'removed' })], { status: mode === 'reverted' ? 0 : mode === 'unknown-status' ? 2 : 1 });
      if (mode === 'outage') f.state.receiptError = new Error('RPC unavailable');
      return { hash: HASH, wait: async () => { throw new Error('wait unavailable'); } };
    };
    const result = await f.service.attestIdentity(f.session);
    assert.equal(result.status, mode === 'reverted' ? 'refused' : 'pending'); assert.notEqual(result.identityVerified, true);
    assert.equal(f.calls.identity.length, 1); assert.deepEqual(f.calls.forbidden, []);
  });
});

test('REGRESSION: identity confirmation must reject a receipt for a different transaction or destination', async (t) => {
  for (const patch of [{ hash: OTHER_HASH }, { to: address(99) }, { from: address(99) }]) await t.test(Object.keys(patch)[0], async () => {
    const f = fixture();
    f.state.attest = async () => {
      f.state.receipt = receipt({ from: f.a.issuer, to: f.a.attestor }, [log(ATTESTOR, 'Attested', [f.a.wallet, f.policy.hash, 2n, 2n, f.session.expiresAt], f.a.attestor)], patch);
      return { hash: HASH, from: f.a.issuer, to: f.a.attestor, wait: async () => f.state.receipt };
    };
    const result = await f.service.attestIdentity(f.session);
    assert.notEqual(result.status, 'confirmed', 'An unrelated receipt must never prove this submission');
    assert.notEqual(result.identityVerified, true);
    assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
    assert.equal(f.calls.identity.length, 1, 'Mismatched receipts must retain the pending submission, not resend');
  });
});

test('identity receipt rejects invalid block metadata, malformed logs and unknown statuses without clearing pending', async (t) => {
  for (const patch of [{ blockNumber: -1 }, { blockNumber: '2499' }, { blockNumber: 1.5 }, { blockNumber: Number.MAX_SAFE_INTEGER + 1 },
    { blockHash: '0x123' }, { blockHash: null }, { status: null }, { status: '0' }, { status: '1' }, { logs: null }, { logs: [null] }]) {
    await t.test(JSON.stringify(patch), async () => {
      const f = fixture();
      f.state.attest = async () => {
        f.state.receipt = receipt({ from: f.a.issuer, to: f.a.attestor }, [log(ATTESTOR, 'Attested',
          [f.a.wallet, f.policy.hash, 2n, 2n, f.session.expiresAt], f.a.attestor)], patch);
        return { hash: HASH, wait: async () => {} };
      };
      assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
      assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
      assert.equal(f.calls.identity.length, 1);
    });
  }
  const f = fixture(); const getBlock = f.provider.getBlock;
  f.provider.getBlock = async (number) => number === 'latest' ? getBlock(number) : { number: 9999, hash: BLOCK };
  assert.equal((await f.service.attestIdentity(f.session)).status, 'pending', 'The canonical block number must match too');
});

test('identity pins sender and destination before submission, not from the returned transaction or a rotated signer', async (t) => {
  for (const field of ['from', 'to']) await t.test(field, async () => {
    const f = fixture();
    f.state.attest = async () => {
      const foreign = { from: f.a.issuer, to: f.a.attestor, [field]: f.a.other };
      f.state.receipt = receipt(foreign, [log(ATTESTOR, 'Attested', [f.a.wallet, f.policy.hash, 2n, 2n, f.session.expiresAt], f.a.attestor)]);
      return { ...foreign, hash: HASH, wait: async () => {} };
    };
    assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
    // Issuer rotation must not change the expected sender of an already-submitted transaction.
    f.venue.signer = { getAddress: async () => f.a.other };
    assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
    f.state.receipt.from = f.a.issuer; f.state.receipt.to = f.a.attestor;
    assert.equal((await f.service.attestIdentity(f.session)).status, 'confirmed');
    assert.equal(f.calls.identity.length, 1);
  });
});

test('malformed submitted identity hash remains unresolved and is never queried or automatically retried', async () => {
  const f = fixture(); f.state.attest = async () => ({ hash: 'not-a-hash', wait: async () => {} });
  assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
  assert.equal((await f.service.attestIdentity(f.session)).status, 'pending');
  assert.equal(f.calls.identity.length, 1); assert.deepEqual(f.calls.receipts, []);
});

function registrationFixture() {
  const f = fixture();
  f.record.rwa.cashier.hookAbi = HOOK.formatJson(); f.record.rwa.cashier.routerAbi = ROUTER.formatJson();
  const abis = { token: ERC20, asset: JSON.parse(ERC20.formatJson()), attestor: ATTESTOR.formatJson() };
  const calls = { contracts: [], addresses: [], reads: [], links: [] };
  const addresses = new Map([[f.a.attestor.toLowerCase(), { address: f.a.attestor, alias: 'attestor' }]]);
  const client = { contracts: {
    createContract: async (...args) => { calls.contracts.push(args); return { data: { status: 201 } }; },
    linkAddressContract: async (...args) => { calls.links.push(args); return { data: { status: 200 } }; },
  }, addresses: {
    getAddress: async (contractAddress, ...rest) => {
      calls.reads.push([contractAddress, ...rest]);
      if (!addresses.has(contractAddress)) throw { response: { status: 404 } };
      return { data: { status: 200, result: addresses.get(contractAddress) } };
    },
    setAddress: async (...args) => { calls.addresses.push(args); addresses.set(args[0].address, args[0]); return { data: { status: 200 } }; },
  } };
  return { ...f, abis, calls, addresses, client, options: { fundId: 'agr_unit_test', abis, client, startingBlock: '-5000' } };
}

test('cashier fund registration uses deployed ABIs and new asset, with scoped labels and no base alias rewrites', async () => {
  const f = registrationFixture(); f.record.usdc = address(100);
  const result = await syncFundDeployment(f.record, f.options);
  assert.equal(result.length, 5); assert.ok(result.every((entry) => entry.created && entry.linked));
  assert.deepEqual(new Set(result.map((entry) => entry.address)), new Set([f.a.token, f.a.asset, f.a.router, f.a.hook, f.a.attestor].map((value) => value.toLowerCase())));
  assert.equal(result.find((entry) => entry.role === 'attestor').alias, 'attestor');
  assert.equal(f.calls.addresses.length, 4); assert.ok(f.calls.addresses.every(([entry]) => entry.alias.startsWith('mf_')));
  assert.ok(f.calls.links.every(([target, body, options]) => /^0x[0-9a-f]{40}$/.test(target) && body.startingBlock === '-5000' && options.timeout === 5000));
  for (const [label, body, options] of f.calls.contracts) {
    assert.match(label, /^mf_[0-9a-f]{32}$/); assert.equal(body.label, label); assert.equal(options.timeout, 5000);
    assert.equal(body.bin, undefined, 'Never claim a legacy build bytecode is the deployed cashier');
  }
  const hook = f.calls.contracts.find(([, body]) => body.contractName === 'MirrorCashierHook')[1];
  const router = f.calls.contracts.find(([, body]) => body.contractName === 'MirrorCashierRouter')[1];
  assert.ok(new Interface(hook.rawAbi).getEvent('CashierExecuted'));
  assert.ok(new Interface(router.rawAbi).getFunction('swap'));
  assert.ok(new Interface(router.rawAbi).getEvent('Executed'));
  const labels = result.map((entry) => entry.contract);
  const second = await syncFundDeployment(f.record, f.options);
  assert.deepEqual(second.map((entry) => entry.contract), labels); assert.equal(f.calls.addresses.length, 4);
  const other = await syncFundDeployment(f.record, { ...f.options, fundId: 'other-fund' });
  assert.ok(other.every((entry) => !labels.includes(entry.contract)));
  assert.equal(f.calls.addresses.length, 4, 'Even another fund must preserve shared, already-registered aliases');
});

test('fund registration validates the entire cashier scope and required ABIs before any writes', async (t) => {
  for (const [name, change] of [
    ['no fund ID', (f) => { delete f.options.fundId; }], ['foreign path', (f) => { f.options.fundId = '../private'; }],
    ['local chain', (f) => { f.record.chainId = 31337; }], ['legacy', (f) => { delete f.record.rwa.cashier; }],
    ['wrong policy hash', (f) => { f.record.rwa.policyHash = 'hash'; }], ['wrong asset address', (f) => { f.record.rwa.cashier.asset = 'asset'; }],
    ['missing asset ABI', (f) => { delete f.abis.asset; }], ['legacy hook ABI', (f) => { f.record.rwa.cashier.hookAbi = ERC20; }],
    ['legacy router ABI', (f) => { f.record.rwa.cashier.routerAbi = ERC20; }],
    ['missing start', (f) => { delete f.options.startingBlock; }], ['numeric start', (f) => { f.options.startingBlock = 500; }],
    ['malformed start', (f) => { f.options.startingBlock = 'yesterday'; }],
  ]) await t.test(name, async () => {
    const f = registrationFixture(); change(f);
    await assert.rejects(syncFundDeployment(f.record, f.options));
    assert.deepEqual(f.calls, { contracts: [], addresses: [], reads: [], links: [] });
  });
});

test('registration conflict, race and plan/outage errors do not masquerade as successful indexing', async () => {
  const conflict = { response: { status: 409 } };
  const f = registrationFixture();
  f.client.contracts.createContract = async () => { throw conflict; };
  f.client.contracts.linkAddressContract = async () => { throw conflict; };
  const result = await syncFundDeployment(f.record, f.options);
  assert.ok(result.every((entry) => !entry.created && !entry.linked && /inspect/.test(entry.note)));
  const race = registrationFixture();
  race.client.addresses.setAddress = async (entry) => {
    race.addresses.set(entry.address, { ...entry, alias: 'registered-concurrently' }); throw conflict;
  };
  const raced = await syncFundDeployment(race.record, race.options);
  assert.ok(raced.every((entry) => !entry.aliased));
  assert.equal(raced[0].alias, 'registered-concurrently');
  for (const status of [401, 403, 429, 500]) {
    const failed = registrationFixture(); failed.client.contracts.linkAddressContract = async () => { throw { response: { status, data: { message: 'private API detail' } } }; };
    await assert.rejects(syncFundDeployment(failed.record, failed.options), (error) => {
      assert.match(error.message, /linkAddressContract/); assert.doesNotMatch(error.message, /private API/); return true;
    });
  }
  const malformed = registrationFixture(); malformed.client.contracts.createContract = async () => ({ data: {} });
  await assert.rejects(syncFundDeployment(malformed.record, malformed.options), /createContract/);
  const mismatch = registrationFixture(); mismatch.client.addresses.getAddress = async () => ({ data: { status: 200, result: { address: address(99), alias: 'foreign' } } });
  await assert.rejects(syncFundDeployment(mismatch.record, mismatch.options), /mismatched fund address/);
  assert.deepEqual(mismatch.calls.addresses, []); assert.deepEqual(mismatch.calls.links, []);
});

test('indexedAddressEvents pins SDK contractAddress, limit, offset and timeout; deduplicates case-insensitively', async () => {
  const calls = []; const contract = address(171);
  const rows = Array.from({ length: 10 }, (_, i) => ({ testRow: i }));
  const result = await indexedAddressEvents(fakeIndexer(rows, calls), [contract, contract.toLowerCase()], { limit: 2 });
  assert.deepEqual(result, rows.slice(0, 2)); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [undefined, undefined, undefined, undefined, undefined, undefined, contract.toLowerCase(), undefined, undefined, 2, 0, { timeout: 5000 }]);
  for (const addresses of [[], null, ['not-address'], Array(9).fill(contract)]) await assert.rejects(indexedAddressEvents(fakeIndexer([], calls), addresses), /Invalid indexed event scope/);
  for (const limit of [0, 101, 1.5, '50']) await assert.rejects(indexedAddressEvents(fakeIndexer([], calls), [contract], { limit }), /Invalid indexed event scope/);
  assert.equal(calls.length, 1);
});

test('indexedAddressEvents rejects failed/malformed pages and never falls back to an unscoped query', async () => {
  for (const data of [{ status: 500, result: [] }, { status: 200 }, { status: 200, result: {} }]) {
    await assert.rejects(indexedAddressEvents({ events: { listEvents: async () => ({ data }) } }, [address(1)]), /Indexed events unavailable/);
  }
  const calls = [];
  await assert.rejects(indexedAddressEvents({ events: { listEvents: async (...args) => { calls.push(args); throw new Error('offline'); } } }, [address(1)]), /offline/);
  assert.equal(calls.length, 1); assert.equal(calls[0][6], address(1));
});

test('MultiBaas history filters wallet, fund contracts, policy, cashier terms, router, malformed rows and private fields', async () => {
  const f = fixture(); const calls = [];
  const valid = [
    indexedRow(ERC20, 'Transfer', [f.a.other, f.a.wallet, M], f.a.token),
    indexedRow(ERC20, 'Transfer', [f.a.wallet, f.a.hook, M], f.a.asset),
    indexedRow(ERC20, 'Approval', [f.a.wallet, f.a.router, M], f.a.asset),
    indexedRow(ROUTER, 'Executed', [f.a.wallet, 2, M, M], f.a.router),
    indexedRow(HOOK, 'CashierExecuted', [f.a.wallet, true, M, M, f.policy.cashier.termsHash], f.a.hook),
    indexedRow(ATTESTOR, 'Attested', [f.a.wallet, f.policy.hash, 2n, 2n, NOW + 100], f.a.attestor),
  ];
  valid.forEach((row, i) => { row.event.indexInLog = i; row.secret = 'never-return-me'; row.transaction.privateInput = 'never-return-me'; });
  const invalid = [
    indexedRow(ERC20, 'Transfer', [f.a.other, address(99), M], f.a.token),
    indexedRow(ERC20, 'Transfer', [f.a.wallet, f.a.other, M], f.a.asset),
    indexedRow(ERC20, 'Approval', [f.a.wallet, f.a.other, M], f.a.asset),
    indexedRow(ERC20, 'Transfer', [f.a.other, f.a.wallet, M], address(99)),
    indexedRow(ROUTER, 'Executed', [f.a.wallet, 0, M, M], f.a.router),
    indexedRow(ROUTER, 'Executed', [f.a.other, 2, M, M], f.a.router),
    indexedRow(HOOK, 'CashierExecuted', [f.a.wallet, true, M, M, OTHER_HASH], f.a.hook),
    indexedRow(ATTESTOR, 'Attested', [f.a.wallet, OTHER_HASH, 2n, 2n, NOW + 100], f.a.attestor),
  ];
  for (const mutate of [
    (r) => { r.event.signature = 'forged'; }, (r) => { r.event.inputs = []; }, (r) => { r.event.inputs[0].hashed = true; },
    (r) => { r.event.inputs[2].value = '-1'; }, (r) => { r.transaction.txHash = 'fake'; },
    (r) => { r.transaction.blockNumber = '2499'; }, (r) => { r.event.indexInLog = -1; },
  ]) { const row = structuredClone(valid[0]); mutate(row); invalid.push(row); }
  f.venue.multibaas = fakeIndexer([...valid, ...invalid, ...valid], calls);
  const result = await f.service.activity(f.session);
  assert.equal(result.source, 'multibaas'); assert.equal(result.complete, false); assert.equal(result.status, 'indexed-events');
  assert.equal(result.events.length, valid.length); assert.equal(f.calls.logs.length, 0);
  assert.deepEqual(result.events.map((event) => event.logIndex), [5, 4, 3, 2, 1, 0]);
  for (const event of result.events) { assert.equal(event.wallet, f.a.wallet); assert.equal(event.fundId, 'stack'); assert.equal(event.policyHash, f.policy.hash); }
  assert.doesNotMatch(JSON.stringify(result), /never-return-me|privateInput|secret/);
  assert.deepEqual(new Set(calls.map((args) => args[6])), new Set([f.a.token, f.a.asset, f.a.router, f.a.hook, f.a.attestor].map((a) => a.toLowerCase())));
  assert.ok(calls.every((args) => args[9] === 50 && args[11].timeout === 5000));
});

test('shared asset/attestor do not leak another published fund\'s router approvals or policy events', async () => {
  const f = fixture(); const other = fixture({ offset: 100 });
  f.venue.multibaas = fakeIndexer([
    indexedRow(ERC20, 'Approval', [f.a.wallet, other.a.router, M], f.a.asset),
    indexedRow(ATTESTOR, 'Attested', [f.a.wallet, other.policy.hash, 2n, 2n, NOW + 100], f.a.attestor),
    indexedRow(ROUTER, 'Executed', [f.a.wallet, 2, M, M], other.a.router),
  ]);
  const result = await f.service.activity(f.session);
  assert.deepEqual(result.events, []); assert.equal(result.status, 'no-indexed-events');
});

test('empty/delayed MultiBaas is not success evidence; outage uses bounded RPC or explicit unavailable state', async () => {
  const f = fixture(); f.venue.multibaas = fakeIndexer([]);
  const empty = await f.service.activity(f.session);
  assert.equal(empty.indexer.status, 'empty-or-delayed'); assert.equal(empty.complete, false); assert.deepEqual(empty.events, []);
  f.venue.multibaas = { events: { listEvents: async () => { throw new Error('private indexer key'); } } };
  f.state.logs = [
    log(ROUTER, 'Executed', [f.a.wallet, 2, M, M], f.a.router),
    log(ERC20, 'Transfer', [f.a.other, f.a.wallet, M], f.a.token, { index: 1 }),
    log(ERC20, 'Transfer', [f.a.other, f.a.wallet, M], f.a.token, { index: 2, removed: true }),
    log(ERC20, 'Transfer', [f.a.other, address(99), M], f.a.token, { index: 3 }),
    log(ATTESTOR, 'Attested', [f.a.wallet, OTHER_HASH, 2n, 2n, NOW + 1], f.a.attestor, { index: 4 }),
  ];
  const fallback = await f.service.activity(f.session);
  assert.equal(fallback.source, 'rpc'); assert.equal(fallback.indexer.status, 'unavailable'); assert.equal(fallback.events.length, 2);
  assert.equal(f.calls.logs[0].fromBlock, 500); assert.equal(f.calls.logs[0].toBlock, 2500);
  assert.equal(f.calls.logs[0].address.length, 5); assert.equal(fallback.complete, false);
  f.state.logsError = new Error('private RPC key');
  const offline = await f.service.activity(f.session);
  assert.equal(offline.source, 'unavailable'); assert.equal(offline.status, 'activity-unavailable'); assert.deepEqual(offline.events, []);
  assert.doesNotMatch(JSON.stringify(offline), /private .* key/);
});

test('legacy fund activity never presents bounded-cashier execution evidence', async () => {
  const f = fixture(); delete f.record.rwa.cashier;
  f.venue.multibaas = fakeIndexer([
    indexedRow(ROUTER, 'Executed', [f.a.wallet, 2, M, M], f.a.router),
    indexedRow(HOOK, 'CashierExecuted', [f.a.wallet, true, M, M, f.policy.cashier.termsHash], f.a.hook),
  ]);
  assert.deepEqual((await f.service.activity(f.session)).events, []);
});

test('RPC history is bounded, sorted and deduplicated and never substitutes for confirmation', async () => {
  const f = fixture();
  f.state.logs = Array.from({ length: 1100 }, (_, index) => log(ERC20, 'Transfer', [f.a.other, f.a.wallet, M], f.a.token, { index }));
  const history = await f.service.activity(f.session);
  assert.equal(history.indexer.status, 'not-configured'); assert.equal(history.events.length, 100);
  assert.equal(history.events[0].logIndex, 1099); assert.equal(history.events.at(-1).logIndex, 1000);
  const intent = await prepared(f); f.state.receipt = null;
  f.venue.multibaas = fakeIndexer([indexedRow(ROUTER, 'Executed', [f.a.wallet, 2, 10n * M, 10n * M], f.a.router)]);
  assert.equal((await confirm(f, intent)).status, 'pending');
  assert.deepEqual(f.calls.forbidden, []);
});
