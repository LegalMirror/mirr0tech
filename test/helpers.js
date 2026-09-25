import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocument } from '../src/policy/document.js';
import { sampleFixture } from '../src/policy/fixture.js';
import { compilePolicy } from '../src/policy/compile.js';
import { Store } from '../src/store.js';
import { MockChain } from '../src/chain.js';
import { MirrorService, COMPLIANCE_FIELDS } from '../src/service.js';

export const document = await readDocument('test/human_contracts/ea026411904ex10-9.htm');
export const envelope = sampleFixture(document);
export const config = JSON.parse(await readFile('examples/demo-config.json', 'utf8'));
export const compiled = compilePolicy(envelope, config, document, { demo: true });
export const compliant = Object.fromEntries(COMPLIANCE_FIELDS.map((field) => [field, true]));
export async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mirrortech-test-'));
  const store = new Store(directory);
  const policy = options.policy ?? compiled.policy;
  const chain = options.chain ?? new MockChain(store, policy);
  const service = await new MirrorService({ store, chain, policy }).init();
  t.after(async () => { await service.queue; chain.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, chain, service, policy };
}
export async function funded(service, amount = '100') {
  const investor = await service.createInvestor('Test investor');
  await service.setCompliance(investor.id, compliant);
  const deposit = await service.createDeposit(investor.id, amount);
  await service.settleMock('deposits', deposit.id);
  return { investor, deposit, body: { investorId: investor.id, depositId: deposit.id, amount } };
}
