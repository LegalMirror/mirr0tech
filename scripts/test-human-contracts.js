// Explicit integration test: --live spends API tokens; --deploy-sepolia spends test ETH.
// Never uses a local EVM or a mainnet signer. Generated files are separate from demo artifacts.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Contract, JsonRpcProvider, Wallet, FetchRequest, formatEther } from 'ethers';
import { readDocuments } from '../src/policy/document.js';
import { extractWorkspace } from '../src/openai-extract.js';
import { validateLegalAst } from '../src/legal/ast.js';
import { compilePolicy, verifyPolicy } from '../src/policy/compile.js';
import { compileBundle } from '../src/onchain/solc.js';
import { deployFund, deployCredit } from '../src/onchain/deploy.js';
import { deploymentPrivateKey } from '../src/onchain/signer.js';

const output = 'generated/human-contracts';
const cases = [
  { id: 'fund', names: ['ea026411904ex10-9.htm'], profile: 'rwa-secondary', config: 'examples/rwa-secondary-config.json' },
  { id: 'lender', names: ['lender-check-policy.md'], profile: 'wildcat-credit' },
  { id: 'buyback', names: ['buyback-addendum.md'], profile: 'wildcat-credit' },
  { id: 'mla', names: ['wildcat-mla.md'], profile: 'wildcat-credit' },
  { id: 'credit', names: ['wildcat-mla.md', 'lender-check-policy.md', 'buyback-addendum.md'], profile: 'wildcat-credit', config: 'examples/wildcat-config.json' },
];
const json = (value) => `${JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
const save = async (path, value) => writeFile(path, json(value));
const live = process.argv.includes('--live');
const deploy = process.argv.includes('--deploy-sepolia');
if (!live && !deploy) throw new Error('Use --live to test extraction and compilation, or --deploy-sepolia to deploy the previously verified artifacts.');
await mkdir(output, { recursive: true });

if (live) {
  const outcomes = await Promise.allSettled(cases.map(async (spec) => {
    const started = Date.now();
    const document = await readDocuments(spec.names.map((name) => `test/human_contracts/${name}`));
    const { envelope } = await extractWorkspace({ document, profile: spec.profile, agreementId: `integration-${spec.id}` });
    const ast = envelope.documentAst ?? envelope.ast;
    // Strip trusted fields before independently repeating the input validation.
    const { documents: _documents, ...candidate } = structuredClone(ast);
    for (const item of [...candidate.nodes, ...candidate.relations]) {
      const { start: _start, end: _end, ...source } = item.source;
      item.source = source;
    }
    validateLegalAst(candidate, document);
    await save(`${output}/${spec.id}.envelope.json`, envelope);
    return { id: spec.id, files: spec.names, elapsedMs: Date.now() - started,
      sourceHash: document.sha256, responseId: envelope.extraction.responseId,
      nodes: ast.nodes.length, relations: ast.relations.length, astValid: true };
  }));
  const failures = outcomes.filter((entry) => entry.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), 'Live extraction failed; successful cases were saved');
  const summaries = outcomes.map((entry) => entry.value);
  for (const spec of cases.filter((spec) => spec.config)) {
    const document = await readDocuments(spec.names.map((name) => `test/human_contracts/${name}`));
    const envelope = JSON.parse(await readFile(`${output}/${spec.id}.envelope.json`));
    const config = JSON.parse(await readFile(spec.config));
    const compiled = compilePolicy(envelope, config, document, { demo: true });
    const directory = `${output}/${spec.id}`;
    await mkdir(directory, { recursive: true });
    await save(`${directory}/policy.json`, compiled.policy);
    await save(`${directory}/clause-table.json`, compiled.clauseTable);
    await writeFile(`${directory}/CompiledPolicy.sol`, compiled.compiledPolicy);
    const overrides = { 'generated/CompiledPolicy.sol': compiled.compiledPolicy };
    if (compiled.solidity) {
      overrides['generated/CompiledMirrorToken.sol'] = compiled.solidity;
      await writeFile(`${directory}/CompiledMirrorToken.sol`, compiled.solidity);
    }
    const targets = spec.id === 'fund' ? {
      core: [['contracts/PolicyOracle.sol', 'PolicyOracle'], ['generated/CompiledMirrorToken.sol', 'CompiledMirrorToken']],
      'uniswap-v4': [['contracts/MirrorPolicyHook.sol', 'MirrorPolicyHook']],
    } : {
      core: [['contracts/PolicyOracle.sol', 'PolicyOracle'], ['contracts/MirrortechRoleProvider.sol', 'MirrortechRoleProvider'], ['contracts/MockWildcatMarket.sol', 'MockWildcatMarket'], ['contracts/test/MockUSD.sol', 'MockUSD']],
      swapvm: [['contracts/swapvm/MirrortechRouter.sol', 'MirrortechRouter']],
    };
    const artifacts = {};
    for (const [bundle, contracts] of Object.entries(targets)) Object.assign(artifacts, await compileBundle(bundle, contracts, { overrides }));
    for (const [name, artifact] of Object.entries(artifacts)) {
      assert.ok(artifact.bytecode.length > 2, `${name} has no deployable bytecode`);
      await save(`${directory}/${name}.json`, artifact);
    }
    Object.assign(summaries.find((entry) => entry.id === spec.id), { compiled: true, policyHash: compiled.policy.hash,
      rules: compiled.policy.ast.rules.length, terms: compiled.policy.ast.terms.length,
      equivalenceChecks: compiled.equivalenceChecks, contracts: Object.keys(artifacts),
      compilerMapping: envelope.extraction.compilerMapping });
  }
  await save(`${output}/report.json`, { testedAt: new Date().toISOString(), cases: summaries });
  console.log(json(summaries));
}

if (deploy) {
  const request = new FetchRequest(process.env.RPC_URL); request.timeout = 15000;
  const provider = new JsonRpcProvider(request, 11155111, { staticNetwork: true });
  try {
    assert.equal(Number(BigInt(await provider.send('eth_chainId', []))), 11155111, 'Only Sepolia is authorized');
    const signer = new Wallet(deploymentPrivateKey(), provider);
    const balance = await provider.getBalance(signer.address);
    console.log(`Sepolia deployer ${signer.address}: ${formatEther(balance)} test ETH`);
    assert.ok(balance > 0n, 'Fund the configured signer with Sepolia test ETH before deployment');
    const stack = JSON.parse(await readFile(process.env.DEPLOYMENT_PATH || 'deployments/sepolia.json'));
    assert.equal(stack.chainId, 11155111);
    for (const address of [stack.attestor, stack.sanctions, stack.usdc, stack.rwa.poolManager, stack.credit.aqua, stack.credit.weth, stack.deterministicDeployer]) {
      assert.notEqual(await provider.getCode(address), '0x', `Missing infrastructure at ${address}`);
    }
    const reportPath = 'deployments/sepolia-human-contracts.json';
    let report;
    try { report = JSON.parse(await readFile(reportPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    report ??= { chainId: 11155111, deployer: signer.address, deployments: {} };
    assert.equal(report.deployer, signer.address, 'Previous test deployments used a different signer');
    for (const spec of cases.filter((spec) => spec.config)) {
      const document = await readDocuments(spec.names.map((name) => `test/human_contracts/${name}`));
      const envelope = JSON.parse(await readFile(`${output}/${spec.id}.envelope.json`));
      const config = JSON.parse(await readFile(spec.config));
      const compiled = compilePolicy(envelope, config, document, { demo: true });
      const savedPolicy = verifyPolicy(JSON.parse(await readFile(`${output}/${spec.id}/policy.json`)));
      assert.equal(compiled.policy.hash, savedPolicy.hash, 'Re-run --live: source or configuration changed');
      if (report.deployments[spec.id]) {
        assert.equal(report.deployments[spec.id].policyHash, compiled.policy.hash, 'A different policy is already recorded; retain its report before deploying a replacement');
        console.log(`Reusing recorded ${spec.id} deployment`);
      } else {
        const sources = { compiledPolicy: compiled.compiledPolicy, token: compiled.solidity, policy: compiled.policy };
        const deployment = await (spec.id === 'fund' ? deployFund : deployCredit)(signer, { record: stack, sources, log: console.log });
        report.deployments[spec.id] = { ...deployment, files: spec.names };
        await save(reportPath, report);
      }
      const deployment = report.deployments[spec.id];
      for (const hash of Object.values(deployment.txs)) assert.equal((await provider.getTransactionReceipt(hash)).status, 1, `Failed transaction ${hash}`);
      for (const name of ['oracle', 'token', ...(spec.id === 'fund' ? ['hook'] : ['roleProvider', 'router'])]) {
        assert.notEqual(await provider.getCode(deployment[name]), '0x', `${name} has no on-chain code`);
      }
      const oracle = new Contract(deployment.oracle, ['function policyHash() view returns(bytes32)', 'function decide(address,uint8) view returns(bool,uint16)'], provider);
      assert.equal(await oracle.policyHash(), compiled.policy.hash);
      const stranger = '0x000000000000000000000000000000000000dEaD';
      const action = compiled.policy.actionOrder.indexOf(spec.id === 'fund' ? 'transfer' : 'deposit');
      assert.equal((await oracle.decide(stranger, action))[0], false, 'An unscreened wallet must be denied');
      if (spec.id === 'credit') {
        const role = new Contract(deployment.roleProvider, ['function policyHash() view returns(bytes32)', 'function clauseTableHash() view returns(bytes32)', 'function getCredential(address) view returns(uint32)'], provider);
        assert.equal(await role.policyHash(), compiled.policy.hash);
        assert.equal(await role.clauseTableHash(), compiled.policy.clauseTableHash);
        assert.equal(await role.getCredential(stranger), 0n);
      }
      deployment.verifiedAt = new Date().toISOString();
      deployment.checks = ['successful receipts', 'contract bytecode present', 'policy hash matches', 'unscreened wallet denied'];
      await save(reportPath, report);
    }
    console.log(`Verified Sepolia deployment report: ${reportPath}`);
  } finally { provider.destroy(); }
}
