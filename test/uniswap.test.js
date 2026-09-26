import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { UniswapSwaps, PERMIT2, UNIVERSAL_ROUTER, SEPOLIA_POOL_MANAGER, swapDeployment } from '../src/uniswap.js';
import { UNISWAP } from '../src/onchain/uniswap-config.js';
import { agreementRoutes } from '../src/routes.js';

const token = `0x${'1'.repeat(40)}`;
const asset = JSON.parse(readFileSync(new URL('../deployments/sepolia-mockusd.json', import.meta.url), 'utf8')).address;
const hook = `0x${'3'.repeat(40)}`;
const wallet = `0x${'4'.repeat(40)}`;
const policyHash = `0x${'a'.repeat(64)}`;
const poolKey = { currency0: token, currency1: asset, fee: 3000, tickSpacing: 60, hooks: hook };
const poolId = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], Object.values(poolKey)));
const record = { id: 'agr_swap', status: 'deployed', policyHash, deployment: {
  routing: 'uniswap-api', router: UNIVERSAL_ROUTER, positionManager: UNISWAP.positionManager, chainId: 11155111, token, hook, policyHash, poolKey, poolId, poolManager: SEPOLIA_POOL_MANAGER,
} };
const body = { wallet, direction: 'buy', amount: '1000000', slippageBps: 50 };
const erc20 = new Interface(['function approve(address,uint256)']);
function response(request) {
  return { routing: 'CLASSIC', permitData: null, quote: {
    tradeType: request.type, swapper: request.swapper, slippage: request.slippageTolerance,
    input: { token: request.tokenIn, amount: request.amount }, output: { token: request.tokenOut, amount: '990000' },
    route: [[{ type: 'v4-pool', address: poolId, hooks: hook, fee: '3000', tickSpacing: '60',
      tokenIn: { address: request.tokenIn, chainId: 11155111 }, tokenOut: { address: request.tokenOut, chainId: 11155111 } }]],
  } };
}
function harness({ transform = (value) => value, approval, swap, apiKey = 'secret-test-key' } = {}) {
  let now = 1000000;
  const calls = [];
  const service = new UniswapSwaps({ apiKey, now: () => now, fetcher: async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, request, headers: init.headers });
    const result = url.endsWith('/quote') ? transform(response(request)) : url.endsWith('/check_approval')
      ? approval ?? { cancel: null, approval: { to: request.token, from: wallet, chainId: 11155111, value: '0', data: erc20.encodeFunctionData('approve', [PERMIT2, (1n << 256n) - 1n]) } }
      : swap ?? { swap: { to: UNIVERSAL_ROUTER, from: wallet, chainId: 11155111, data: '0x1234', value: '0' } };
    return { ok: true, json: async () => result };
  } });
  return { service, calls, advance: () => { now += 120001; } };
}

test('quote pins the deployed pool, direction, base units and slippage without exposing API credentials', async () => {
  const { service, calls } = harness();
  const quote = await service.quote(record, body);
  assert.equal(quote.tokenIn, asset);
  assert.equal(quote.tokenOut, token);
  assert.equal(quote.minAmountOut, '985050');
  assert.equal(quote.poolId, poolId);
  assert.equal(quote.expiresAt, 1120000);
  assert.ok(!JSON.stringify(quote).includes('secret-test-key'));
  assert.deepEqual(calls[0].request.protocols, ['V4']);
  assert.equal(calls[0].headers['x-permit2-disabled'], 'false');
  const sell = await service.quote(record, { ...body, direction: 'sell' });
  assert.equal(sell.tokenIn, token);
  assert.equal(sell.tokenOut, asset);
});

test('rejects other pools, paths, chains, wallets, token pairs, simulation errors and changed amounts', async () => {
  const changes = [
    (r) => { r.quote.route[0][0].address = `0x${'f'.repeat(64)}`; },
    (r) => { r.quote.route[0][0].hooks = wallet; },
    (r) => { r.quote.route[0][0].fee = '500'; },
    (r) => { r.quote.route[0][0].tokenIn.chainId = 1; },
    (r) => { r.quote.route.push(r.quote.route[0]); },
    (r) => { r.quote.route[0].push(r.quote.route[0][0]); },
    (r) => { r.quote.output.token = wallet; },
    (r) => { r.quote.input.amount = '2'; },
    (r) => { r.quote.swapper = hook; },
    (r) => { r.quote.output.recipient = hook; },
    (r) => { r.quote.slippage = 50; },
    (r) => { r.quote.txFailureReason = 'NotRouter'; },
    (r) => { r.permitData = { unexpected: true }; },
  ];
  for (const change of changes) {
    const { service } = harness({ transform: (r) => { change(r); return r; } });
    await assert.rejects(service.quote(record, body), (error) => ['POOL_NOT_ROUTED', 'UNISWAP_INVALID_RESPONSE', 'SWAP_SIMULATION_FAILED'].includes(error.code));
  }
});

test('refuses absent, stale and malformed deployments, invalid inputs and missing credentials', async () => {
  assert.throws(() => swapDeployment({ ...record, status: 'compiled' }), { code: 'NOT_DEPLOYED' });
  assert.throws(() => swapDeployment({ ...record, policyHash: 'different' }), { code: 'STALE_DEPLOYMENT' });
  assert.throws(() => swapDeployment({ ...record, deployment: { ...record.deployment, poolId: policyHash } }), { code: 'INVALID_POOL' });
  assert.throws(() => swapDeployment({ ...record, deployment: { ...record.deployment, poolManager: hook } }), { code: 'UNSUPPORTED_POOL_MANAGER' });
  const { service } = harness();
  for (const change of [{ amount: '0' }, { amount: '-1' }, { amount: '1.0' }, { slippageBps: 501 }, { slippageBps: 0 }, { direction: 'transfer' }, { wallet: 'invalid' }])
    await assert.rejects(service.quote(record, { ...body, ...change }), { code: 'INVALID_SWAP' });
  await assert.rejects(harness({ apiKey: '' }).service.quote(record, body), { code: 'UNISWAP_NOT_CONFIGURED' });
});

test('approval is capped to exact input and swap requires simulation and a deadline', async () => {
  const { service, calls } = harness();
  const quote = await service.quote(record, body);
  const input = { quoteId: quote.id, wallet };
  const approvals = await service.approval(record, input);
  assert.equal(erc20.decodeFunctionData('approve', approvals.approval.data)[1], 1000000n);
  const swap = await service.swap(record, input);
  assert.equal(swap.transaction.to, UNIVERSAL_ROUTER);
  assert.equal(calls[2].request.simulateTransaction, true);
  assert.equal(calls[2].request.deadline, 1120);
  assert.ok(calls.every((call) => call.headers['x-universal-router-version'] === '2.1.2'));
});

test('rejects arbitrary approval spenders, swap targets, values and chains', async () => {
  const tx = { from: wallet, to: asset, chainId: 11155111, value: '0', data: erc20.encodeFunctionData('approve', [hook, 10]) };
  const badApproval = harness({ approval: { approval: tx } });
  const q = await badApproval.service.quote(record, body);
  await assert.rejects(badApproval.service.approval(record, { quoteId: q.id, wallet }), { code: 'UNISWAP_INVALID_RESPONSE' });
  for (const change of [{ to: hook }, { chainId: 1 }, { from: hook }, { value: '1' }]) {
    const { service } = harness({ swap: { swap: { ...tx, to: UNIVERSAL_ROUTER, ...change } } });
    const quote = await service.quote(record, body);
    await assert.rejects(service.swap(record, { quoteId: quote.id, wallet }), { code: 'UNISWAP_INVALID_RESPONSE' });
  }
});

test('quotes are bound to wallet, agreement and expiry', async () => {
  const { service, advance } = harness();
  const quote = await service.quote(record, body);
  await assert.rejects(service.swap(record, { quoteId: quote.id, wallet: hook }), { code: 'INVALID_QUOTE' });
  await assert.rejects(service.swap({ ...record, id: 'another' }, { quoteId: quote.id, wallet }), { code: 'INVALID_QUOTE' });
  advance();
  await assert.rejects(service.approval(record, { quoteId: quote.id, wallet }), { code: 'QUOTE_EXPIRED' });
  await assert.rejects(service.swap(record, { quoteId: quote.id, wallet }), { code: 'QUOTE_EXPIRED' });
});

test('legacy mUSDC pools are rejected instead of quoting a different same-symbol token', async () => {
  const legacyKey = { ...poolKey, currency1: `0x${'2'.repeat(40)}` };
  const legacyId = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], Object.values(legacyKey)));
  const legacy = { ...record, deployment: { ...record.deployment, poolKey: legacyKey, poolId: legacyId } };
  const { service, calls } = harness();
  await assert.rejects(service.quote(legacy, body), { code: 'LEGACY_POOL_ASSET' });
  assert.equal(calls.length, 0);
});

test('HTTP preparation routes return unsigned transactions and recheck deployment after upstream work', async (t) => {
  const { service } = harness();
  let current = structuredClone(record);
  const app = express();
  app.use(express.json());
  app.use('/v1', agreementRoutes({ get: () => current }, async () => ({}), service));
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ code: error.code }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (step, value) => fetch(`http://127.0.0.1:${server.address().port}/v1/agreements/agr_swap/swap/${step}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const quote = await (await request('quote', body)).json();
  const tx = await (await request('transaction', { quoteId: quote.id, wallet })).json();
  assert.equal(tx.transaction.to, UNIVERSAL_ROUTER);
  const originalSwap = service.swap.bind(service);
  service.swap = async (...args) => { const result = await originalSwap(...args); current = { ...current, status: 'compiled' }; return result; };
  const refused = await request('transaction', { quoteId: quote.id, wallet });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'NOT_DEPLOYED');
});

test('HTTP viewers may prepare swaps but cannot deploy; demo sessions cannot quote another owner’s agreement', async (t) => {
  const { createApp, demoWorkspaceRoutes } = await import('../src/routes.js');
  const apiKey = 'operator-key-at-least-24-characters';
  const viewerKey = 'viewer-key-at-least-24-characters';
  const agreements = { get: () => ({ ...record, status: 'compiled' }) };
  const app = createApp(null, apiKey, null, null, viewerKey, agreements);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = async (suffix, key = viewerKey) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/agreements/agr_swap/${suffix}`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('swap/quote')).body.error.code, 'NOT_DEPLOYED');
  assert.equal((await call('swap/quote', 'bad-token')).status, 401);
  assert.equal((await call('deploy')).status, 401);

  let reads = 0;
  const demo = express();
  demo.use('/v1', demoWorkspaceRoutes({ limits: { maxRequestBytes: 4096 }, admit: async () => {}, authenticate: () => {}, read: async () => {
    reads++; const error = new Error('Agreement not found'); error.status = 404; error.code = 'NOT_FOUND'; throw error;
  } }));
  const demoServer = demo.listen(0, '127.0.0.1');
  await new Promise((resolve) => demoServer.once('listening', resolve));
  t.after(() => { demoServer.closeAllConnections(); demoServer.close(); });
  const res = await fetch(`http://127.0.0.1:${demoServer.address().port}/v1/agreements/other/swap/quote`, {
    method: 'POST', headers: { Authorization: 'Bearer demo_test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(res.status, 404);
  assert.equal(reads, 1);
});

test('Permit2 signatures bind exact amount, wallet, chain and Universal Router', async () => {
  const { Wallet } = await import('ethers');
  const signer = Wallet.createRandom();
  const permit = {
    domain: {name:'Permit2',chainId:11155111,verifyingContract:PERMIT2},
    types: {
      PermitDetails:[{name:'token',type:'address'},{name:'amount',type:'uint160'},{name:'expiration',type:'uint48'},{name:'nonce',type:'uint48'}],
      PermitSingle:[{name:'details',type:'PermitDetails'},{name:'spender',type:'address'},{name:'sigDeadline',type:'uint256'}],
    },
    values:{details:{token:asset,amount:body.amount,expiration:2000,nonce:0},spender:UNIVERSAL_ROUTER,sigDeadline:1500},
  };
  const h = harness({transform:r=>({...r,permitData:permit}),swap:{swap:{to:UNIVERSAL_ROUTER,from:signer.address,chainId:11155111,data:'0x1234',value:'0'}}});
  const quote = await h.service.quote(record,{...body,wallet:signer.address});
  const input = {quoteId:quote.id,wallet:signer.address};
  await assert.rejects(h.service.swap(record,input),{code:'INVALID_PERMIT'});
  const signature = await signer.signTypedData(permit.domain,permit.types,permit.values);
  await h.service.swap(record,{...input,signature});
  assert.equal(h.calls.at(-1).request.signature,signature);
  assert.deepEqual(h.calls.at(-1).request.permitData,permit);
  for(const change of [p=>p.values.details.amount='2000000',p=>p.values.spender=hook,p=>p.domain.chainId=1,p=>p.values.sigDeadline=999]) {
    const bad=structuredClone(permit);change(bad);
    await assert.rejects(harness({transform:r=>({...r,permitData:bad})}).service.quote(record,body),{code:'UNISWAP_INVALID_RESPONSE'});
  }
});

test('custom router deployments fail before requesting a Uniswap quote', async () => {
  const h=harness();
  await assert.rejects(h.service.quote({...record,deployment:{...record.deployment,routing:undefined,router:hook}},body),{code:'DEPRECATED_ROUTER'});
  assert.equal(h.calls.length,0);
});
