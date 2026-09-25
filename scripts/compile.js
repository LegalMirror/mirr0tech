import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readDocument } from '../src/policy/document.js';
import { sampleFixture } from '../src/policy/fixture.js';
import { mlaFixture } from '../src/policy/mla-fixture.js';
import { compilePolicy } from '../src/policy/compile.js';
import { astSchema } from '../src/policy/schema.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
// --mla compiles the sample Master Loan Agreement for a Wildcat market instead of the custodial
// RWA agreement. Both paths run the same compiler and emit the same on-chain policy library.
const credit = args.includes('--mla');
const paths = args.filter((arg) => !arg.startsWith('--'));

const defaults = credit
  ? { document: 'test/human_contracts/sample-mla.md', config: 'examples/wildcat-config.json', fixture: mlaFixture }
  : { document: 'test/human_contracts/ea026411904ex10-9.htm', config: 'examples/demo-config.json', fixture: sampleFixture };

const document = await readDocument(paths[1] ?? defaults.document);
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
};
if (result.solidity) files['CompiledMirrorToken.sol'] = result.solidity;
for (const [name, body] of Object.entries(files)) await writeFile(`generated/${name}`, `${body}\n`);

console.log(`Compiled ${envelope.ast.rules.length} rules from ${document.name} (${result.policy.profile})`);
console.log(`  policyHash      ${result.policy.hash}`);
console.log(`  clauseTableHash ${result.clauseTable.clauseTableHash}`);
console.log(`  proved the on-chain programs match the interpreter over ${result.equivalenceChecks} three-valued assignments`);
console.log(`Artifacts: generated/{${Object.keys(files).join(',')}}`);
