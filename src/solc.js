// One compile path for the build script and the runtime deploy: a bundle names the compiler and
// its settings, the targets name the contracts wanted, `overrides` supplies generated sources that
// are not (or not yet) on disk. Imports resolve against the repository root and node_modules.
import { existsSync, readFileSync } from 'node:fs';

const PACKAGES = {
  core: 'solc',
  // 1inch SwapVM and Aqua pin 0.8.30 and need the IR pipeline; the router is a modified SwapVM redeploy.
  swapvm: 'solc-swapvm',
  // Uniswap's PoolManager pins solidity 0.8.26 exactly, so the venue bundle uses that compiler.
  'uniswap-v4': 'solc-v4',
};
const SETTINGS = {
  core: { evmVersion: 'cancun' },
  swapvm: { evmVersion: 'cancun', viaIR: true, runs: 200 },
  'uniswap-v4': { evmVersion: 'cancun' },
};
// Source keys are repository paths so relative imports between contracts and generated code resolve.
export const SUPPORT = ['contracts/PolicyEval.sol', 'contracts/wildcat/IRoleProvider.sol', 'generated/CompiledPolicy.sol', 'contracts/PolicyAttestor.sol', 'contracts/PolicyOracle.sol'];

const loaded = {};
/// The compilers are large; each loads on first use.
export async function compilerFor(bundle) {
  if (!PACKAGES[bundle]) throw new Error(`Unknown compiler bundle: ${bundle}`);
  return (loaded[bundle] ??= (await import(PACKAGES[bundle])).default);
}

export async function compilerVersions() {
  const entries = await Promise.all(Object.keys(PACKAGES).map(async (bundle) => [bundle, (await compilerFor(bundle)).version()]));
  return Object.fromEntries(entries);
}

const resolve = (path, overrides) => {
  if (overrides[path]) return { contents: overrides[path] };
  // Imports arrive either as package specifiers or already resolved against the repository root.
  for (const candidate of [path, `node_modules/${path}`, path.replace(/^@1inch\/aqua\//, 'vendor/aqua/')]) {
    try { return { contents: readFileSync(candidate, 'utf8') }; } catch {}
  }
  return { error: `Import not found: ${path}` };
};

/// Returns { [name]: { abi, bytecode, compiler } } for each [path, name] target.
export async function compileBundle(bundle, targets, { overrides = {} } = {}) {
  const compiler = await compilerFor(bundle);
  const settings = SETTINGS[bundle];
  const paths = [...new Set([...targets.map(([path]) => path), ...SUPPORT])].filter((path) => overrides[path] || existsSync(path));
  const sources = Object.fromEntries(paths.map((path) => [path, { content: overrides[path] ?? readFileSync(path, 'utf8') }]));
  const output = JSON.parse(compiler.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: settings.runs ?? 200 }, viaIR: settings.viaIR ?? false, evmVersion: settings.evmVersion, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }), { import: (path) => resolve(path, overrides) }));
  for (const error of output.errors ?? []) if (error.severity === 'error') throw new Error(error.formattedMessage);
  return Object.fromEntries(targets.map(([path, name]) => {
    const contract = output.contracts[path][name];
    return [name, { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, compiler: compiler.version() }];
  }));
}
