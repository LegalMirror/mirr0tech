import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface, id } from 'ethers';
import { Agreements } from '../src/agreements.js';
import { VenueService } from '../src/venues.js';
import { venueRoutes } from '../src/venues-api.js';
import { decodeCashierRefusal } from '../src/policy/cashier-refusal.js';

const config = JSON.parse(await readFile('examples/rwa-cashier-config.json', 'utf8'));
const documents = await Promise.all(['ea026411904ex10-9.htm', 'nav-cashier-addendum.md'].map(async (name) => ({ name, text: await readFile(`test/human_contracts/${name}`, 'utf8') })));

test('uploaded cashier addendum compiles through agreement export and hands bound terms to deployer', async () => {
  let sources;
  const agreements = new Agreements({
    extract: async ({ document, draft }) => ({ envelope: { source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256 }, ast: draft },
      verification: { confidence: { overall: 1, verified: 1, total: 1, counts: {}, byRef: {} }, contested: [] } }),
    deployer: async (request) => { sources = request.sources; return { localTestOnly: true }; },
  });
  const created = await agreements.create({ name: 'DEMO cashier', documents, config });
  await agreements.settled();
  const result = agreements.get(created.id);
  assert.equal(result.status, 'compiled', result.error);
  assert.equal(result.export.cashier.navMicroUsd, '1000000');
  assert.equal(result.export.documents.length, 2);
  assert.ok(result.export.terms.every((term) => term.quotes.every((quote) => quote.part === 1)));
  for (const term of result.export.terms) assert.equal(term.clauseId, result.export.cashier.clauseIds[term.name]);
  assert.equal(result.export.clauseTable.length, result.export.rules.length + 5);
  agreements.deploy(created.id);
  await agreements.settled();
  assert.deepEqual(sources.cashier, result.export.cashier);
  assert.equal(sources.cashier.subscriptionFeeBps, 25);
  assert.equal(sources.cashier.redemptionFeeBps, 25);
  assert.deepEqual(sources.cashier.pool, config.cashier.pool);
  assert.ok(sources.cashierTerms.includes(sources.cashier.configurationHash));
  assert.doesNotMatch(sources.cashierTerms, /NAV =|FEE_BPS =/);
  assert.match(sources.token, /MirrorCashierToken/);
});

test('cashier refusals decode nested v4 errors only against the matching policy hash', () => {
  const iface = new Interface(['error CashierRefused(uint16 clauseId, bytes32 policyHash, uint8 reason)', 'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);
  const policyHash = id('cashier policy');
  const clause = { quote: 'prefunded available mockUSD reserves' };
  const inner = iface.encodeErrorResult('CashierRefused', [1, policyHash, 2]);
  const data = iface.encodeErrorResult('WrappedError', ['0x0000000000000000000000000000000000000001', '0x00000000', inner, '0x']);
  const decoded = decodeCashierRefusal({ data }, { policyHash, clauses: [clause] });
  assert.equal(decoded.clause, clause);
  assert.equal(decoded.reason, 2);
  assert.equal(decoded.description, 'Insufficient prefunded reserve');
  assert.equal(decodeCashierRefusal({ data }, { policyHash: id('different'), clauses: [clause] }), null);
});

function venue(assetFirst = true) {
  const low = '0x0000000000000000000000000000000000000001';
  const high = '0x0000000000000000000000000000000000000002';
  const asset = assetFirst ? low : high;
  const token = assetFirst ? high : low;
  const service = new VenueService({ record: { chainId: 31337, usdc: low, rwa: { token, hook: high, router: high, poolKey: { currency0: low, currency1: high, fee: 500, tickSpacing: 10, hooks: high }, cashier: { enabled: true, asset } } },
    policies: { rwa: { policy: { hash: id('policy'), cashier: { termsHash: id('terms') } }, clauseTable: {} } } });
  const calls = [];
  service.wallets = { Investor: low };
  service.signerFor = async () => ({ testSigner: true });
  service.c = {
    hook: { quote: async (buy, amount) => buy ? amount * 10000n / 10025n : amount * 9975n / 10000n },
    v4Router: { connect: () => ({ swap: async (...args) => { calls.push(args); return { testReceipt: true }; } }) },
    cashierAsset: { connect: () => ({ transfer: async (...args) => { calls.push(args); return { testReceipt: true }; } }) },
  };
  return { service, calls };
}

test('venue maps human units and both currency sorts to authenticated bounded exact-input calls', async () => {
  for (const assetFirst of [true, false]) {
    const { service, calls } = venue(assetFirst);
    for (const buy of [true, false]) {
      const entry = await service.cashierSwap('Investor', { buy, amount: '100.25', minOut: '90', deadline: 2000000000, route: 'auto' });
      assert.equal(entry.status, 'ok');
      const [pool, params, minimum, deadline, mode] = calls.at(-1);
      assert.equal(pool.fee, 500);
      assert.equal(pool.tickSpacing, 10);
      assert.equal(params.zeroForOne, assetFirst === buy);
      assert.equal(params.amountSpecified, -100250000n);
      assert.equal(minimum, 90000000n);
      assert.equal(deadline, 2000000000);
      assert.equal(mode, 0);
    }
    const quote = await service.cashierQuote({ buy: true, amount: '100.25' });
    assert.equal(quote.amountOut, '100.0');
    assert.equal(quote.kind, 'nav-only');
    assert.equal(quote.executable, null);
    await service.cashierPrefund('Investor', '15.5');
    assert.equal(calls.at(-1)[1], 15500000n);
  }
});

test('swap audit exposes actual route and output from the trusted router receipt', async () => {
  const { service } = venue();
  const iface = new Interface(['event Executed(address indexed subject, uint8 route, uint256 amountIn, uint256 amountOut)']);
  service.c.v4Router.interface = iface;
  service.settled = async () => true;
  const event = iface.encodeEventLog(iface.getEvent('Executed'), [service.wallets.Investor, 2, 100000000n, 99750000n]);
  const entry = await service.run('rwa.cashier.swap', { policy: 'rwa', route: 'auto' }, async () => ({ wait: async () => ({
    hash: id('receipt'), blockNumber: 1, logs: [{ address: service.record.rwa.router, ...event }],
  }) }));
  assert.equal(entry.actualRoute, 'cashier');
  assert.equal(entry.amountOut, '99.75');
});

test('API requires explicit bounds, rejects bad amounts/modes and leaves non-cashier deployments disabled', async () => {
  const { service } = venue();
  for (const amount of ['0', '-1', '1e3', '0.0000001', 'foo', '01', '1000000000000000000000000000000000']) {
    assert.throws(() => service.cashierAmount(amount), (error) => error.code === 'INVALID_AMOUNT');
  }
  const order = { buy: true, amount: '1', minOut: '0.9', deadline: 2000000000 };
  for (const patch of [{ minOut: undefined }, { deadline: undefined }, { route: 'exact-output' }, { buy: 'true' }]) {
    await assert.rejects(service.cashierSwap('Investor', { ...order, ...patch }), (error) => error.status === 400);
  }
  await assert.rejects(service.swap('Investor', true), (error) => error.code === 'BOUNDED_ORDER_REQUIRED');
  delete service.record.rwa.cashier;
  await assert.rejects(service.cashierQuote({ buy: true, amount: '1' }), (error) => error.code === 'NO_CASHIER');
  const routes = venueRoutes(service).stack.filter((layer) => layer.route).map((layer) => layer.route.path);
  for (const path of ['/rwa/cashier', '/rwa/cashier/quote', '/rwa/cashier/swap', '/rwa/cashier/prefund']) assert.ok(routes.includes(path));
});
