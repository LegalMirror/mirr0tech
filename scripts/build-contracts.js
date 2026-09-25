import solcLatest from 'solc';
import solcV4 from 'solc-v4';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const policy = JSON.parse(readFileSync('generated/policy.json', 'utf8'));
const credit = policy.profile === 'wildcat-credit';

// The venue contracts are pinned to the compiler Uniswap v4 requires; everything else builds on the
// repository's own compiler. Source keys are repository paths so relative imports resolve.
const support = ['contracts/PolicyEval.sol', 'contracts/wildcat/IRoleProvider.sol', 'generated/CompiledPolicy.sol', 'contracts/PolicyAttestor.sol'];

const bundles = [
  {
    compiler: solcLatest, evmVersion: 'cancun',
    targets: credit
      ? [['contracts/PolicyAttestor.sol', 'PolicyAttestor'], ['contracts/MirrortechRoleProvider.sol', 'MirrortechRoleProvider']]
      : [['contracts/MirrorToken.sol', 'MirrorToken'], ['generated/CompiledMirrorToken.sol', 'CompiledMirrorToken'],
         ['contracts/PolicyAttestor.sol', 'PolicyAttestor']],
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
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: bundle.evmVersion, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }), { import: (path) => {
    // Imports arrive either as package specifiers or already resolved against the repository root.
    for (const candidate of [path, `node_modules/${path}`]) {
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
    built.push(name);
  }
}
console.log(`Compiled ${built.join(', ')}`);
