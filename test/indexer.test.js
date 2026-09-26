import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { ledgerQueries, ledgerService, hookBoundaries, indexedContracts, registerIndexer, SIGNATURES } from '../src/onchain/indexer.js';
import { createApp } from '../src/routes.js';

const record = JSON.parse(readFileSync('deployments/sepolia.json', 'utf8'));
const agreement = JSON.parse(readFileSync('deployments/sepolia-agreements.json', 'utf8')).find((entry) => entry.deployment?.hook);
const rows = {
  [SIGNATURES.checked]: [
    { action: '2', allowed: 'true', at: '2026-09-26 19:38:12+00', clauseid: '0', subject: '0xinvestor', tx: '0xa' },
    { action: '2', allowed: 'false', at: '2026-09-26 19:37:48+00', clauseid: '12', subject: '0xstranger', tx: '0xb' },
  ],
  [SIGNATURES.attested]: [{ at: '2026-09-26 18:59:48+00', expiresat: '1792992504', known: '131135', subject: '0xinvestor', tx: '0xc', value: '131135' }],
  [SIGNATURES.operation]: [{ amount: '8500000000', ismint: 'true' }, { amount: '100', ismint: 'false' }],
};
const fakeClient = (calls) => ({ url: 'https://mb.test', queries: { executeArbitraryEventQuery: async (query, offset, limit) => { calls.push({ query, limit }); return { data: { result: { rows: rows[query.events[0].eventName] } } }; } } });

test('the three ledger queries use the shape MultiBaas accepts: aliased inputs, nested filters, a summed supply', () => {
  const { checks, attestations, supply } = ledgerQueries();
  for (const query of [checks, attestations, supply]) {
    const [event] = query.events;
    assert.ok(event.select.every((field) => field.alias), 'every selected field is aliased');
    assert.deepEqual(Object.keys(event.filter), ['rule', 'children'], 'conditions are nested under children');
    assert.equal(event.filter.children[0].fieldType, 'contract_address_alias');
  }
  assert.equal(checks.events[0].filter.children[0].value, 'mirr0_policy_hook');
  assert.equal(supply.groupBy, 'ismint');
  assert.equal(supply.events[0].select.find((field) => field.alias === 'amount').aggregator, 'add');
});

test('the hook\'s boundaries come from the deployment: gated callbacks, the pool, the clauses deciding a transfer', () => {
  const boundaries = hookBoundaries(agreement);
  assert.deepEqual(boundaries.callbacks, { beforeAddLiquidity: true, beforeRemoveLiquidity: true, beforeSwap: true });
  assert.deepEqual(boundaries.transferClauses.map((clause) => clause.ruleId), ['transfer-onboarded-holder', 'transfer-sanctions-block', 'transfer-identity-verified']);
  assert.ok(boundaries.transferClauses.every((clause) => clause.quote));
  assert.equal(boundaries.poolKey.hooks, agreement.deployment.hook);
  assert.deepEqual(indexedContracts(record, agreement).map((entry) => entry.alias), ['mirr0_attestor', 'mirr0_fund_token', 'mirr0_policy_hook']);
});

test('the ledger reads decisions with their clause, refusals by clause, attestations and supply, and caches to spare the quota', async () => {
  const calls = [];
  let now = 0;
  const ledger = ledgerService({ client: fakeClient(calls), record, agreement, cacheMs: 1000, clock: () => now });
  const first = await ledger();
  assert.equal(first.decisions[0].action, 'transfer');
  assert.equal(first.decisions[0].allowed, true);
  assert.equal(first.decisions[1].clause.ruleId, 'transfer-identity-verified', 'a refusal names its clause');
  const tally = Object.fromEntries(first.byClause.map(({ ruleId, allowed, refused }) => [ruleId ?? 'admitted', [allowed, refused]]));
  assert.deepEqual(tally, { admitted: [1, 0], 'transfer-identity-verified': [0, 1] });
  assert.deepEqual(first.supply, { minted: '8500000000', burned: '100' });
  assert.equal(first.attestations[0].expiresAt, 1792992504);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.limit === 50), 'a page MultiBaas accepts');
  assert.equal((await ledger()).cached, true);
  assert.equal(calls.length, 3, 'a second read inside the window costs no API calls');
  now = 2000;
  await ledger();
  assert.equal(calls.length, 6);
});

test('registration uploads, aliases and links each contract from 100 blocks back, tolerating what already exists', async () => {
  const seen = [];
  const conflict = () => { const error = new Error('exists'); error.response = { status: 409, data: { message: 'already exists' } }; throw error; };
  const client = {
    contracts: { createContract: async () => conflict(), linkAddressContract: async (alias, body) => { seen.push([alias, body.startingBlock]); return { data: {} }; } },
    addresses: { setAddress: async () => ({ data: {} }) },
  };
  const results = await registerIndexer(client, indexedContracts(record, agreement));
  assert.deepEqual(seen.map(([, block]) => block), ['-100', '-100', '-100']);
  assert.ok(results.every((entry) => entry.linked));
});

test('GET /v1/indexed/ledger is public and read-only', async (t) => {
  const ledger = ledgerService({ client: fakeClient([]), record, agreement });
  const server = createApp(null, 'a-test-operator-key-at-least-24-characters', null, null, null, null, { ledger }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/indexed/ledger`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, 'multibaas');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/v1/indexed/ledger`, { method: 'POST' })).status, 401, 'nothing to write');
});

test('refusals from the gateway audit merge into the ledger, off-chain and named by clause, newest first', async () => {
  const { refusalsFrom } = await import('../src/onchain/indexer.js');
  const lines = [];
  const audit = [
    { type: 'rwa.pool.swap', status: 'refused', at: '2026-09-26T19:40:00.000Z', wallet: 'Stranger', refusal: { clause: { clauseId: 12, ruleId: 'transfer-identity-verified' } } },
    { type: 'rwa.pool.swap', status: 'ok', at: '2026-09-26T19:39:00.000Z', wallet: 'Investor' },
    { type: 'attest', status: 'refused', at: '2026-09-26T19:38:00.000Z', wallet: 'X' },
  ];
  const ledger = ledgerService({ client: fakeClient([]), record, agreement, refusals: async () => audit, log: (line) => lines.push(line) });
  const value = await ledger();
  const refused = value.decisions.filter((decision) => decision.source === 'gateway');
  assert.equal(refused.length, 1, 'only venue refusals count; an ok entry and a non-venue entry do not');
  assert.equal(refused[0].venue, 'swap');
  assert.equal(refused[0].tx, null);
  assert.equal(refused[0].clause.ruleId, 'transfer-identity-verified');
  assert.ok(value.decisions.every((decision, index, all) => index === 0 || all[index - 1].at >= decision.at), 'newest first across both sources');
  const tally = value.byClause.find((entry) => entry.ruleId === 'transfer-identity-verified');
  assert.equal(tally.refused, 2, 'one on-chain refusal from the fake rows plus the audit refusal');
  assert.match(value.decisions.find((d) => d.source === 'multibaas').at, /^\d{4}-\d\d-\d\dT/, 'MultiBaas times are ISO');
  assert.deepEqual(refusalsFrom(undefined, new Map()), []);
  assert.match(lines[0], /^\[ledger\] refreshed ms=\d+ calls=3 total_calls=3 onchain=2 refused_offchain=1 attestations=1$/);
});

test('the quota counter tracks MultiBaas calls and cache hits, and a failed query is logged, counted and thrown', async () => {
  let now = 0;
  const ledger = ledgerService({ client: fakeClient([]), record, agreement, cacheMs: 1000, clock: () => now, log: () => {} });
  await ledger();
  const hit = await ledger();
  assert.deepEqual({ calls: hit.quota.calls, reads: hit.quota.reads, cacheHits: hit.quota.cacheHits, perRefresh: hit.quota.perRefresh }, { calls: 3, reads: 2, cacheHits: 1, perRefresh: 3 });
  const lines = [];
  const failing = ledgerService({ record, agreement, log: (line) => lines.push(line), client: { url: 'x', queries: { executeArbitraryEventQuery: async () => { const error = new Error('bad'); error.response = { status: 400, data: { message: 'invalid request' } }; throw error; } } } });
  await assert.rejects(failing(), /bad/);
  assert.match(lines[0], /\[ledger\] multibaas query failed status=400 message="invalid request"/);
});
