import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readDocuments } from '../src/policy/document.js';
import { sampleFixture } from '../src/policy/fixture.js';
import { mlaFixture } from '../src/policy/mla-fixture.js';
import { compilePolicy } from '../src/policy/compile.js';
import { astSchema } from '../src/policy/schema.js';
import { buybackTermsFrom } from '../src/policy/programs.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
// --mla compiles the sample Master Loan Agreement for a Wildcat market instead of the custodial
// RWA agreement. Both paths run the same compiler and emit the same on-chain policy library.
const credit = args.includes('--mla');
// --secondary compiles the RWA agreement with the transfer rules a Uniswap v4 hook enforces.
const secondary = args.includes('--secondary');
const paths = args.filter((arg) => !arg.startsWith('--'));

const defaults = credit
  ? { document: 'test/human_contracts/wildcat-mla.md,test/human_contracts/lender-check-policy.md,test/human_contracts/buyback-addendum.md', config: 'examples/wildcat-config.json', fixture: mlaFixture }
  : secondary
    ? { document: 'test/human_contracts/ea026411904ex10-9.htm', config: 'examples/rwa-secondary-config.json', fixture: (document) => sampleFixture(document, { secondary: true }) }
    : { document: 'test/human_contracts/ea026411904ex10-9.htm', config: 'examples/demo-config.json', fixture: sampleFixture };

// Several documents may be compiled as one bundle: pass them comma-separated.
const document = await readDocuments((paths[1] ?? defaults.document).split(','));
const envelope = paths[0] ? JSON.parse(await readFile(paths[0], 'utf8')) : defaults.fixture(document);
const config = JSON.parse(await readFile(paths[2] ?? defaults.config, 'utf8'));
const result = compilePolicy(envelope, config, document, { demo });

await mkdir('generated', { recursive: true });
const files = {
  'ast.schema.json': JSON.stringify(astSchema, null, 2),
  'ast.json': JSON.stringify(envelope, null, 2),
  'policy.json': JSON.stringify(result.policy, null, 2),
  'policy.mjs': result.javascript,
  'CompiledPolicy.sol': result.compiledPolicy,
  'clause-table.json': JSON.stringify(result.clauseTable, null, 2),
  'components.json': JSON.stringify({ policyHash: result.policy.hash, profile: result.policy.profile, components: result.components }, null, 2),
};
if (result.solidity) files['CompiledMirrorToken.sol'] = result.solidity;
if (result.policy.ast.terms.some((term) => term.name === 'buybackPrice')) {
  const terms = buybackTermsFrom(result.policy);
  files['buyback-terms.json'] = JSON.stringify({ policyHash: result.policy.hash, ...terms }, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
}
for (const [name, body] of Object.entries(files)) await writeFile(`generated/${name}`, `${body}\n`);

console.log(`Compiled ${envelope.ast.rules.length} rules from ${document.name} (${result.policy.profile})`);
console.log(`  policyHash      ${result.policy.hash}`);
console.log(`  clauseTableHash ${result.clauseTable.clauseTableHash}`);
console.log(`  proved the on-chain programs match the interpreter over ${result.equivalenceChecks} three-valued assignments`);
console.log(`  linked against ${result.components.map((component) => `${component.id}@${component.version}`).join(', ')}`);
console.log(`Artifacts: generated/{${Object.keys(files).join(',')}}`);
