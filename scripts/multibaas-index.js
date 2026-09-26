// Registers the Sepolia agreement's attestor, fund token and hook with MultiBaas (three of the plan's
// ten contracts) and indexes them from 100 blocks back. Needs MULTIBAAS_URL and MULTIBAAS_API_KEY.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { multibaasClient, indexedContracts, registerIndexer } from '../src/onchain/indexer.js';

const record = JSON.parse(readFileSync('deployments/sepolia.json', 'utf8'));
const agreement = JSON.parse(readFileSync('deployments/sepolia-agreements.json', 'utf8')).find((entry) => entry.deployment?.hook);
const client = multibaasClient();
if (!client) throw new Error('Set MULTIBAAS_URL and MULTIBAAS_API_KEY');
const results = await registerIndexer(client, indexedContracts(record, agreement), { log: console.log });
console.log(`Indexed ${results.filter((entry) => entry.linked).length} of ${results.length} contracts for ${agreement.id}`);
