import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readDocument } from '../src/policy/document.js';
import { extractAst } from '../src/policy/extract.js';
import { sampleFixture } from '../src/policy/fixture.js';

const args = process.argv.slice(2);
const fixture = args.includes('--fixture');
const paths = args.filter((arg) => arg !== '--fixture');
const source = paths[0] ?? 'test/human_contracts/ea026411904ex10-9.htm';
const destination = paths[1] ?? 'generated/ast.json';
const document = await readDocument(source);
const result = fixture ? sampleFixture(document) : await extractAst(document, { model: process.env.OPENAI_MODEL });
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Wrote ${destination} (${result.extraction.provider}; ${result.ast.nodes?.length ?? result.ast.rules.length} nodes; ${result.ast.issues?.length ?? result.ast.unresolved.length} open issues)`);
