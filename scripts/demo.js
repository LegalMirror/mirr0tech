import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { MockChain } from '../src/onchain/chain.js';
import { MirrorService, COMPLIANCE_FIELDS } from '../src/service.js';
import { createApp } from '../src/routes.js';
import { readDocument } from '../src/policy/document.js';
import { sampleFixture } from '../src/policy/fixture.js';
import { compilePolicy } from '../src/policy/compile.js';

const document = await readDocument('test/human_contracts/ea026411904ex10-9.htm');
const config = JSON.parse(await readFile('examples/demo-config.json', 'utf8'));
const { policy } = compilePolicy(sampleFixture(document), config, document, { demo: true });
const directory = await mkdtemp(join(tmpdir(), 'mirrortech-demo-'));
const store = new Store(directory);
const chain = new MockChain(store, policy);
const service = await new MirrorService({ store, chain, policy }).init();
const apiKey = 'local-demo-operator-key-only';
const server = createApp(service, apiKey).listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
async function request(path, body, method = 'POST', key) {
  const response = await fetch(`${url}/v1${path}`, { method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
try {
  console.log(`Source: ${document.name}\nPolicy: ${policy.hash}\nHand-authored AST fixture; simulated chain, KYC and USD settlement.`);
  const { data: investor } = await request('/investors', { name: 'Demo Investor' });
  const { data: deposit } = await request('/deposits', { investorId: investor.id, amount: '100' });
  const mintBody = { investorId: investor.id, depositId: deposit.id, amount: '100' };
  const denied = await request('/mints', mintBody, 'POST', 'demo-mint');
  if (denied.status !== 403) throw new Error('Expected policy denial before onboarding and settlement');
  console.log(`Before onboarding/funding: ${denied.status} ${denied.data.error.code}`);
  await request(`/mock/investors/${investor.id}/compliance`, Object.fromEntries(COMPLIANCE_FIELDS.map((key) => [key, true])), 'PATCH');
  await request(`/mock/deposits/${deposit.id}/confirm`, {});
  const mint = await request('/mints', mintBody, 'POST', 'demo-mint');
  if (mint.data.status !== 'confirmed') throw new Error(JSON.stringify(mint));
  console.log(`Mint: ${mint.data.amount} tokens, ${mint.data.status}`);
  const replay = await request('/mints', mintBody, 'POST', 'demo-mint');
  if (replay.data.id !== mint.data.id) throw new Error('Duplicate operation detected');
  console.log('Retry with same key: original operation returned, no second mint');
  const redemption = await request('/redemptions', { investorId: investor.id, amount: '25' }, 'POST', 'demo-redeem');
  if (redemption.data.status !== 'confirmed') throw new Error(JSON.stringify(redemption));
  const payout = await request(`/mock/withdrawals/${redemption.data.withdrawalId}/settle`, {});
  console.log(`Redeem: ${redemption.data.amount} tokens burned; mock USD withdrawal ${payout.data.status}`);
  const { data: holder } = await request(`/investors/${investor.id}`, null, 'GET');
  console.log(`Final investor balance: ${Number(holder.balanceUnits) / 1e6} tokens; custody supply: ${Number(await chain.totalSupply()) / 1e6} tokens`);
} finally {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  store.close();
  await rm(directory, { recursive: true, force: true });
}
