import solcLatest from 'solc';
import solcV4 from 'solc-v4';
import solcSwapVM from 'solc-swapvm';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const policy = JSON.parse(readFileSync('generated/policy.json', 'utf8'));
const credit = policy.profile === 'wildcat-credit';

// The venue contracts are pinned to the compiler Uniswap v4 requires; everything else builds on the
// repository's own compiler. Source keys are repository paths so relative imports resolve.
const support = ['contracts/PolicyEval.sol', 'contracts/wildcat/IRoleProvider.sol', 'generated/CompiledPolicy.sol', 'contracts/PolicyAttestor.sol', 'contracts/PolicyOracle.sol'];

const bundles = [
  {
    compiler: solcLatest, evmVersion: 'cancun',
    targets: credit
      ? [['contracts/PolicyAttestor.sol', 'PolicyAttestor'], ['contracts/PolicyOracle.sol', 'PolicyOracle'],
         ['contracts/MockSanctionsOracle.sol', 'MockSanctionsOracle'], ['contracts/MockWildcatMarket.sol', 'MockWildcatMarket'],
         ['contracts/test/MockERC20.sol', 'MockERC20'], ['contracts/MirrortechRoleProvider.sol', 'MirrortechRoleProvider']]
      : [['contracts/MirrorToken.sol', 'MirrorToken'], ['generated/CompiledMirrorToken.sol', 'CompiledMirrorToken'],
         ['contracts/PolicyAttestor.sol', 'PolicyAttestor']],
  },
  {
    // 1inch SwapVM and Aqua pin 0.8.30 and need the IR pipeline; the router is a modified SwapVM redeploy.
    compiler: solcSwapVM, evmVersion: 'cancun', viaIR: true, runs: 200,
    targets: [['contracts/swapvm/MirrortechRouter.sol', 'MirrortechRouter'],
              ['vendor/aqua/src/Aqua.sol', 'Aqua']],
  },
  {
    // Uniswap's PoolManager pins solidity 0.8.26 exactly, so the venue bundle uses that compiler.
    compiler: solcV4, evmVersion: 'cancun',
    targets: [['contracts/MirrorPolicyHook.sol', 'MirrorPolicyHook'],
              ['contracts/test/MirrorLiquidityRouter.sol', 'MirrorLiquidityRouter'],
              ['contracts/test/MockERC20.sol', 'MockERC20'],
              ['node_modules/@uniswap/v4-core/src/PoolManager.sol', 'PoolManager']],
  },
];

await mkdir('artifacts', { recursive: true });
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
    await writeFile(`artifacts/${name}.json`, JSON.stringify({
      abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, compiler: bundle.compiler.version(),
      policyHash: policy.hash, clauseTableHash: policy.clauseTableHash,
    }, null, 2));
    const size = contract.evm.bytecode.object.length / 2;
    built.push(`${name}${size > 24_576 ? ` (${size} bytes: OVER the 24576 limit)` : ''}`);
  }
}
console.log(`Compiled ${built.join(', ')}`);
