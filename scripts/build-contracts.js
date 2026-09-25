import solcLatest from 'solc';
import solcV4 from 'solc-v4';
import solcSwapVM from 'solc-swapvm';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';

const policy = JSON.parse(readFileSync('generated/policy.json', 'utf8'));
const profile = policy.profile;
// The resolved components say which contracts to build and with which compiler.
const manifest = JSON.parse(readFileSync('generated/components.json', 'utf8'));
if (manifest.policyHash !== policy.hash) throw new Error('generated/components.json is stale; rerun the compiler');
const targetsFor = (bundle) => {
  const seen = new Set();
  return manifest.components.flatMap((component) => component.contracts)
    .filter((contract) => contract.bundle === bundle && contract.name && !seen.has(contract.name) && seen.add(contract.name))
    .map((contract) => [contract.path, contract.name]);
};
// Source keys are repository paths so relative imports between contracts and generated code resolve.
const support = ['contracts/PolicyEval.sol', 'contracts/wildcat/IRoleProvider.sol', 'generated/CompiledPolicy.sol', 'contracts/PolicyAttestor.sol', 'contracts/PolicyOracle.sol'];

const compilers = {
  core: { compiler: solcLatest, evmVersion: 'cancun' },
  // 1inch SwapVM and Aqua pin 0.8.30 and need the IR pipeline; the router is a modified SwapVM redeploy.
  swapvm: { compiler: solcSwapVM, evmVersion: 'cancun', viaIR: true, runs: 200 },
  // Uniswap's PoolManager pins solidity 0.8.26 exactly, so the venue bundle uses that compiler.
  'uniswap-v4': { compiler: solcV4, evmVersion: 'cancun' },
};
const bundles = Object.entries(compilers).map(([name, settings]) => ({ ...settings, targets: targetsFor(name) })).filter((bundle) => bundle.targets.length);

await mkdir(`artifacts/${profile}`, { recursive: true });
const built = [];
for (const bundle of bundles) {
  const sources = Object.fromEntries([...bundle.targets.map(([path]) => path), ...support]
    .filter((path) => existsSync(path))
    .map((path) => [path, { content: readFileSync(path, 'utf8') }]));
  const output = JSON.parse(bundle.compiler.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: bundle.runs ?? 200, ...(bundle.optimizerDetails ? { details: bundle.optimizerDetails } : {}) }, viaIR: bundle.viaIR ?? false, evmVersion: bundle.evmVersion, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }), { import: (path) => {
    // Imports arrive either as package specifiers or already resolved against the repository root.
    for (const candidate of [path, `node_modules/${path}`, path.replace(/^@1inch\/aqua\//, 'vendor/aqua/')]) {
      try { return { contents: readFileSync(candidate, 'utf8') }; } catch {}
    }
    return { error: `Import not found: ${path}` };
  } }));
  for (const error of output.errors ?? []) if (error.severity === 'error') throw new Error(error.formattedMessage);
  for (const [file, name] of bundle.targets) {
    const contract = output.contracts[file][name];
    await writeFile(`artifacts/${profile}/${name}.json`, JSON.stringify({
      abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, compiler: bundle.compiler.version(),
      policyHash: policy.hash, clauseTableHash: policy.clauseTableHash,
    }, null, 2));
    const size = contract.evm.bytecode.object.length / 2;
    built.push(`${name}${size > 24_576 ? ` (${size} bytes: OVER the 24576 limit)` : ''}`);
  }
}
// The artifact directory is self-contained: the policy and clause table travel with the bytecode.
await copyFile('generated/policy.json', `artifacts/${profile}/policy.json`);
await copyFile('generated/clause-table.json', `artifacts/${profile}/clause-table.json`);
console.log(`Compiled ${built.join(', ')} → artifacts/${profile}/`);
