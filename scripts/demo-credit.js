// Walks the lender lifecycle a borrower's compliance team runs by hand today, against a local
// chain. No API key, no network, no real market. Run with: npm run demo:credit
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { ContractFactory, JsonRpcProvider, Wallet, id } from 'ethers';
import { readDocuments } from '../src/policy/document.js';
import { mlaFixture } from '../src/policy/mla-fixture.js';
import { compilePolicy } from '../src/policy/compile.js';

const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const say = (line = '') => console.log(line);
const step = (title) => { say(); say(`── ${title}`); };

const document = await readDocuments(['test/human_contracts/wildcat-mla.md', 'test/human_contracts/lender-check-policy.md', 'test/human_contracts/buyback-addendum.md']);
const config = JSON.parse(await readFile('examples/wildcat-config.json', 'utf8'));
const compiled = compilePolicy(mlaFixture(document), config, document, { demo: true });
const clauses = compiled.clauseTable.clauses;
const FACTS = compiled.policy.factOrder;
const ACTIONS = compiled.policy.actionOrder;
const bit = (name) => 1n << BigInt(FACTS.indexOf(name));

step('The agreement');
say(`  document        ${document.name}`);
say(`  sha256          0x${document.sha256}`);
say(`  rules compiled  ${compiled.policy.ast.rules.length}`);
say(`  unresolved      ${compiled.policy.ast.unresolved.length} (compilation would be refused without --demo)`);
say(`  policyHash      ${compiled.policy.hash}`);
say(`  proved on-chain programs match the interpreter over ${compiled.equivalenceChecks} three-valued assignments`);

const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
anvil.on('error', () => { console.error('This demo needs Foundry/Anvil on PATH.'); process.exit(1); });
const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, { chainId: 31337, name: 'anvil' }, { cacheTimeout: -1, staticNetwork: true });
provider.pollingInterval = 50;
for (let attempt = 0; attempt < 200; attempt++) {
  try { if (await provider.getBlockNumber() >= 0) break; } catch {}
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const admin = new Wallet(DEV_KEY, provider);
const load = async (name) => JSON.parse(await readFile(`artifacts/wildcat-credit/${name}.json`, 'utf8'));
const attestorArtifact = await load('PolicyAttestor');
const providerArtifact = await load('MirrortechRoleProvider');
const oracleArtifact = await load('PolicyOracle');
const sanctionsArtifact = await load('MockSanctionsOracle');
const marketArtifact = await load('MockWildcatMarket');
const tokenArtifact = await load('MockERC20');
if (providerArtifact.policyHash !== compiled.policy.hash) {
  console.error('Build the credit artifacts first: npm run build:credit');
  process.exit(1);
}

const attestor = await new ContractFactory(attestorArtifact.abi, attestorArtifact.bytecode, admin).deploy(admin.address);
await attestor.waitForDeployment();
await (await attestor.grantRole(id('ATTESTOR_ROLE'), admin.address)).wait();
await (await attestor.grantRole(id('WATCHER_ROLE'), admin.address)).wait();
const sanctions = await new ContractFactory(sanctionsArtifact.abi, sanctionsArtifact.bytecode, admin).deploy(admin.address);
await sanctions.waitForDeployment();
const oracle = await new ContractFactory(oracleArtifact.abi, oracleArtifact.bytecode, admin).deploy(await attestor.getAddress(), await sanctions.getAddress());
await oracle.waitForDeployment();
const roleProvider = await new ContractFactory(providerArtifact.abi, providerArtifact.bytecode, admin).deploy(await oracle.getAddress());
await roleProvider.waitForDeployment();
const usdc = await new ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, admin).deploy('Mock USD Coin', 'mUSDC');
await usdc.waitForDeployment();
const market = await new ContractFactory(marketArtifact.abi, marketArtifact.bytecode, admin).deploy(await usdc.getAddress(), await roleProvider.getAddress(), admin.address);
await market.waitForDeployment();
await (await oracle.bindMarket(await market.getAddress())).wait();

step('Deployed');
say(`  PolicyAttestor          ${await attestor.getAddress()}`);
say(`  MirrortechRoleProvider  ${await roleProvider.getAddress()}`);
say(`  MockWildcatMarket       ${await market.getAddress()} (mock; the provider interface is Wildcat's real one)`);
say('  A borrower registers this with addRoleProvider(provider, timeToLive). Nothing else changes.');

const lender = Wallet.createRandom().address;
const report = async (label) => {
  const credential = await roleProvider.getCredential(lender);
  const current = await attestor.isCurrent(lender, compiled.policy.hash);
  const [allowed, clauseId] = await roleProvider.explain(lender, ACTIONS.indexOf('deposit'));
  say(`  ${label}`);
  say(`    screening           ${current ? 'current' : 'none on file or lapsed'}`);
  say(`    deposit credential  ${credential === 0n ? 'none' : `granted (screened at ${new Date(Number(credential) * 1000).toISOString()})`}`);
  if (!allowed) {
    const clause = clauseId === 0n ? null : clauses[Number(clauseId) - 1];
    say(`    refused by          ${clause ? `clause ${clause.clause} (${clause.ruleId})` : 'no matching permission'}`);
    if (clause) say(`    the agreement says  “${clause.quote}”`);
  }
};
const attest = async (facts) => {
  let known = 0n;
  let value = 0n;
  for (const [name, boolean] of Object.entries(facts)) { known |= bit(name); if (boolean) value |= bit(name); }
  const now = (await provider.getBlock('latest')).timestamp;
  await (await attestor.attest(lender, compiled.policy.hash, known, value, now, now + config.attestationValiditySeconds)).wait();
};
const ADMITTED = { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true,
  screeningCurrent: true, sanctionsClear: true, openTermState: true };

step(`Lender ${lender} applies`);
await report('Before any screening:');

step('Compliance completes the lender check and signs the result');
await attest(ADMITTED);
await report('After screening:');

step('Thirty-one days pass and nobody re-screens');
await provider.send('evm_increaseTime', [config.attestationValiditySeconds + 86400]);
await provider.send('evm_mine', []);
await report('Without any transaction being sent:');
say('  Clause 3.1 says a lender whose screening has lapsed is treated as not having satisfied');
say('  Clause 2, so every fact reverts to unknown and a Clause 2 requirement is what refuses.');
say('  Nobody had to notice, and no transaction had to be sent.');

step('The lender is re-screened');
await attest(ADMITTED);
await report('After re-screening:');

step('A sanctions hit lands between scheduled screenings');
await (await sanctions.setSanctioned(lender, true)).wait();
await report('Immediately after the oracle designates the wallet:');

step('The lender is owed interest — is the borrower allowed to pay?');
await (await sanctions.setSanctioned(lender, false)).wait();
await attest(ADMITTED);
let [mayPay] = await roleProvider.mayWithdraw(lender);
say(`  With screening current:      ${mayPay ? 'payment permitted' : 'payment blocked'}`);
await (await sanctions.setSanctioned(lender, true)).wait();
let clauseId;
[mayPay, clauseId] = await roleProvider.mayWithdraw(lender);
const payClause = clauses[Number(clauseId) - 1];
say(`  After the hit:               ${mayPay ? 'payment permitted' : 'payment blocked'}`);
say(`  refused by                   clause ${payClause.clause} (${payClause.ruleId})`);
say(`  the agreement says           “${payClause.quote}”`);
say('  Eligibility is evaluated at the moment of payment, not at onboarding.');

step('Someone edits one word of the agreement');
const edited = { ...document, text: document.text.replace('thirty (30) days', 'ninety (90) days') };
const { sha256 } = await import('../src/policy/document.js');
say(`  original sha256  0x${document.sha256}`);
say(`  edited  sha256   0x${sha256(edited.text)} (text hash)`);
say('  A different document compiles to a different policyHash, so the attestations on file');
say('  do not apply to it and the deployed provider keeps enforcing the agreement as signed.');

say();
say('Done. Nothing here screened anybody: the facts are attested by the borrower’s compliance');
say('function and the compiler proves each rule is backed by a verbatim quote from the document.');
anvil.kill('SIGTERM');
provider.destroy();
