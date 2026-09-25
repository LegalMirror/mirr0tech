import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readDocument } from '../src/policy/document.js';
import { sampleFixture } from '../src/policy/fixture.js';
import { compilePolicy } from '../src/policy/compile.js';
import { astSchema } from '../src/policy/schema.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const paths = args.filter((arg) => arg !== '--demo');
const document = await readDocument(paths[1] ?? 'test/human_contracts/ea026411904ex10-9.htm');
const envelope = paths[0] ? JSON.parse(await readFile(paths[0], 'utf8')) : sampleFixture(document);
const config = JSON.parse(await readFile(paths[2] ?? 'examples/demo-config.json', 'utf8'));
const result = compilePolicy(envelope, config, document, { demo });
await mkdir('generated', { recursive: true });
for (const [name, body] of Object.entries({ 'ast.schema.json': JSON.stringify(astSchema, null, 2), 'ast.json': JSON.stringify(envelope, null, 2), 'policy.json': JSON.stringify(result.policy, null, 2), 'policy.mjs': result.javascript, 'CompiledMirrorToken.sol': result.solidity })) {
  await writeFile(`generated/${name}`, `${body}\n`);
}
console.log(`Compiled ${envelope.ast.rules.length} rules: ${result.policy.hash}\nArtifacts: generated/{ast.json,policy.json,policy.mjs,CompiledMirrorToken.sol}`);
