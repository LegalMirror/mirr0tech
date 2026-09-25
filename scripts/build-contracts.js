import solc from 'solc';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const sources = Object.fromEntries([
  ['MirrorToken.sol', 'contracts/MirrorToken.sol'], ['CompiledMirrorToken.sol', 'generated/CompiledMirrorToken.sol'],
].map(([name, path]) => [name, { content: readFileSync(path, 'utf8') }]));
const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
}), { import: (path) => {
  try { return { contents: readFileSync(`node_modules/${path}`, 'utf8') }; }
  catch { return { error: `Import not found: ${path}` }; }
} }));
for (const error of output.errors ?? []) if (error.severity === 'error') throw new Error(error.formattedMessage);
await mkdir('artifacts', { recursive: true });
const policy = JSON.parse(readFileSync('generated/policy.json', 'utf8'));
for (const name of ['MirrorToken', 'CompiledMirrorToken']) {
  const contract = output.contracts[`${name}.sol`][name];
  await writeFile(`artifacts/${name}.json`, JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`, compiler: solc.version(), policyHash: policy.hash }, null, 2));
}
console.log(`Compiled MirrorToken and CompiledMirrorToken with solc ${solc.version()}`);
