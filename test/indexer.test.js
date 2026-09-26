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
    { action: '2', allowed: 'true', at: 't2', clauseid: '0', subject: '0xinvestor', tx: '0xa' },
    { action: '2', allowed: 'false', at: 't1', clauseid: '12', subject: '0xstranger', tx: '0xb' },
  ],
  [SIGNATURES.attested]: [{ at: 't0', expiresat: '1792992504', known: '131135', subject: '0xinvestor', tx: '0xc', value: '131135' }],
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
