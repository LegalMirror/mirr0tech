// Registers a deployment record (generated/deployment.json by default) with MultiBaas. Needs MULTIBAAS_URL and
// MULTIBAAS_API_KEY; the deployment must be on a chain MultiBaas supports (a local anvil is not).
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { syncDeployment, multibaasClient } from '../src/multibaas.js';

// The record to register: generated/deployment.json, or a path given on the command line.
const record = JSON.parse(await readFile(process.argv[2] ?? 'generated/deployment.json', 'utf8'));
if (record.chainId === 31337) console.warn('warning: chain 31337 is a local anvil; MultiBaas will not be able to index it');
const client = multibaasClient();
const results = await syncDeployment(record, { client, log: console.log });
await writeFile('generated/multibaas.json', `${JSON.stringify({ url: client.url, chainId: record.chainId, syncedAt: new Date().toISOString(), contracts: results }, null, 2)}\n`);
console.log(`\nRegistered ${results.length} contracts with ${client.url}; wrote generated/multibaas.json`);
