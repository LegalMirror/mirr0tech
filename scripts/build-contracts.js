import { readFileSync } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { compileBundle } from '../src/solc.js';

const policy = JSON.parse(readFileSync('generated/policy.json', 'utf8'));
// Keep optional cashier artifacts separate from the default secondary stack.
const profile = policy.cashier ? 'rwa-cashier' : policy.profile;
// The resolved components say which contracts to build and with which compiler.
const manifest = JSON.parse(readFileSync('generated/components.json', 'utf8'));
if (manifest.policyHash !== policy.hash) throw new Error('generated/components.json is stale; rerun the compiler');
const targetsFor = (bundle) => {
  const seen = new Set();
  return manifest.components.flatMap((component) => component.contracts)
    .filter((contract) => contract.bundle === bundle && contract.name && !seen.has(contract.name) && seen.add(contract.name))
    .map((contract) => [contract.path, contract.name]);
};

await mkdir(`artifacts/${profile}`, { recursive: true });
const built = [];
for (const bundle of ['core', 'swapvm', 'uniswap-v4']) {
  const targets = targetsFor(bundle);
  if (!targets.length) continue;
  for (const [name, contract] of Object.entries(await compileBundle(bundle, targets))) {
    await writeFile(`artifacts/${profile}/${name}.json`, JSON.stringify({ ...contract, policyHash: policy.hash, clauseTableHash: policy.clauseTableHash }, null, 2));
    const size = (contract.bytecode.length - 2) / 2;
    built.push(`${name}${size > 24_576 ? ` (${size} bytes: OVER the 24576 limit)` : ''}`);
  }
}
// The artifact directory is self-contained: the policy and clause table travel with the bytecode.
await copyFile('generated/policy.json', `artifacts/${profile}/policy.json`);
await copyFile('generated/clause-table.json', `artifacts/${profile}/clause-table.json`);
if (policy.cashier) await writeFile(`artifacts/${profile}/cashier-config.json`, JSON.stringify(policy.cashier, null, 2));
console.log(`Compiled ${built.join(', ')} → artifacts/${profile}/`);
