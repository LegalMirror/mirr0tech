// Writes the live MultiBaas ledger to dashboard/public/ledger.json, so the static site can show it
// when no gateway is reachable. Needs MULTIBAAS_URL and MULTIBAAS_API_KEY.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { multibaasClient, ledgerService } from '../src/onchain/indexer.js';

const record = JSON.parse(readFileSync('deployments/sepolia.json', 'utf8'));
const agreement = JSON.parse(readFileSync('deployments/sepolia-agreements.json', 'utf8')).find((entry) => entry.deployment?.hook);
const client = multibaasClient();
if (!client) throw new Error('Set MULTIBAAS_URL and MULTIBAAS_API_KEY');
const refusals = async () => { for (const path of [process.argv[2], 'deployments/sepolia-agreement-audit.json'].filter(Boolean)) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch {} } return []; };
const ledger = await ledgerService({ client, record, agreement, refusals })();
writeFileSync('dashboard/public/ledger.json', `${JSON.stringify({ ...ledger, snapshot: true }, null, 1)}\n`);
console.log(`ledger snapshot: ${ledger.decisions.length} decisions, ${ledger.attestations.length} attestations`);
