// The product flow, end to end, from the terminal: upload → constrain with World ID → deploy →
// verify a wallet → the policy-hooked pool admits it and refuses a stranger with the sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { startAnvil, DEV_KEY } from './anvil.js';
import { deployStack, deployFund } from '../../src/onchain/deploy.js';
import { VenueService } from '../../src/onchain/venues.js';
import { Agreements } from '../../src/agreements.js';
import { createApp } from '../../src/routes.js';
import { HumanRegistry, WorldIdVerifier } from '../../src/worldid.js';

import { extractDemo } from '../../src/openai-extract.js';
const run = promisify(execFile);

test('the flow from the terminal: upload, constrain, deploy, verify, and use the policy-hooked pool', { timeout: 420_000 }, async (t) => {
  const { provider } = await startAnvil(t);
  const signer = new Wallet(DEV_KEY, provider);
  const { record } = await deployStack(signer);
  const registry = new HumanRegistry(null);
  const base = await new VenueService({ provider, signer, record, worldId: { verifier: new WorldIdVerifier(), registry } }).init();
  const agreements = new Agreements({ extract: extractDemo,
    deployer: ({ sources }) => deployFund(signer, { record, sources }),
    venueFactory: ({ deployment, policy, clauseTable, credential, action }) => new VenueService({
      provider, signer, policies: { rwa: { policy, clauseTable }, credit: base.policies.credit },
      record: { ...record, rwa: { ...record.rwa, policyHash: policy.hash, clauseTableHash: clauseTable.clauseTableHash, oracle: deployment.oracle, token: deployment.token, hook: deployment.hook }, address: deployment.token, policyHash: policy.hash },
      worldId: { verifier: new WorldIdVerifier({ credential, action }), registry },
    }).init(),
  });
  const key = 'test-stack-operator-key-only-24';
  const server = createApp(null, key, base, null, null, agreements).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const env = { ...process.env, MIRR0_URL: `http://127.0.0.1:${server.address().port}`, MIRR0_KEY: key };
  const cli = async (...args) => {
    try { const { stdout } = await run('node', ['scripts/mirr0.js', ...args, '--json'], { env }); return JSON.parse(stdout); }
    catch (error) { if (error.stdout) return JSON.parse(error.stdout); throw error; }
  };

  const status = await cli('status');
  assert.equal(status.chain.chainId, 31337);
  const uploaded = await cli('upload', 'test/human_contracts/ea026411904ex10-9.htm', '--name', 'BUIDL');
  assert.equal(uploaded.status, 'extracting');
  const compiled = await cli('show', uploaded.id, '--wait', 'compiled');
  assert.equal(compiled.status, 'compiled', compiled.error ?? '');
  const tree = await cli('ast', uploaded.id);
  assert.ok(tree.nodes.some((node) => node.id === 'fact:identityVerified'));

  // The issuer chooses the credential: a document, on mint and transfer.
  const constrained = await cli('constrain', uploaded.id, '--credential', 'document', '--actions', 'mint,transfer');
  assert.deepEqual(constrained.constraints.identity.actions, ['mint', 'transfer']);
  const deployed = await cli('deploy', uploaded.id, '--wait');
  assert.equal(deployed.status, 'deployed', deployed.error ?? '');
  assert.notEqual(deployed.deployment.token, record.rwa.token, 'its own token, not the stack\'s');

  // Facts alone do not admit; the World ID proof does.
  await cli('facts', uploaded.id, 'Investor', 'kycApproved=true', 'amlApproved=true', 'sanctionsClear=true');
  const before = await cli('explain', uploaded.id, 'Investor', '--action', 'transfer');
  assert.equal(before.allowed, false);
  assert.equal(before.clause.ruleId, 'transfer-identity-verified');
  const verified = await cli('verify', uploaded.id, 'Investor');
  assert.equal(verified.status, 'ok');
  const after = await cli('explain', uploaded.id, 'Investor', '--action', 'transfer');
  assert.equal(after.allowed, true);
  assert.equal(after.facts.identityVerified, true);

  // The token and its pool exist and enforce the agreement: the investor trades, the stranger reads the sentence.
  await cli('mint', uploaded.id, '10000');
  const released = await cli('release', uploaded.id, 'Investor', '5000');
  assert.equal(released.status, 'ok');
  await cli('facts', uploaded.id, 'Stranger', 'sanctionsClear=true');
  for (const wallet of ['Investor', 'Stranger']) assert.equal((await cli('fund', uploaded.id, wallet, '10000')).funded, '10000');
  // Deploy already initialized the hooked pool: the investor adds liquidity and swaps through it.
  assert.match(deployed.deployment.poolId, /^0x[0-9a-f]{64}$/);
  // Swaps after the first must work too: the pool price has moved off 1:1 by then.
  for (const step of ['liquidity', 'swap', 'swap', 'swap']) { const result = await cli('pool', uploaded.id, step, 'Investor'); assert.equal(result.status, 'ok', `${step}: ${JSON.stringify(result)}`); }
  const refused = await cli('pool', uploaded.id, 'swap', 'Stranger');
  assert.equal(refused.error.code, 'POLICY_REFUSED');
  assert.ok(refused.error.details.refusal.clause.quote, 'the sentence that refused');
  const wallets = await cli('wallets', uploaded.id);
  assert.ok(Number(wallets.find((w) => w.name === 'Investor').balances.MIRROR) > 0);
  const audit = await cli('audit', uploaded.id);
  assert.ok(audit.some((entry) => entry.type === 'worldid.verify' && entry.status === 'ok'));
  assert.ok(audit.some((entry) => entry.type === 'rwa.pool.swap' && entry.status === 'refused'));
  // The base stack is untouched by the agreement's venue.
  assert.equal(base.audit.length, 0);
});
