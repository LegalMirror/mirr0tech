// Saves the lender list of a running stack (a Sepolia one) so the static site can show the real
// wallets: STACK_URL=http://127.0.0.1:3300 API_KEY=… node scripts/snapshot-parties.js
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { PROFILES } from './export-ui.js';

const base = (process.env.STACK_URL ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
const out = process.argv[2] ?? 'deployments/sepolia-parties.json';
const parties = {};
for (const { profile } of PROFILES) {
  const response = await fetch(`${base}/v1/lenders?profile=${profile}`, { headers: { Authorization: `Bearer ${process.env.API_KEY}` } });
  if (!response.ok) throw new Error(`${profile}: ${response.status}`);
  parties[profile] = await response.json();
  console.log(`${profile.padEnd(15)} ${parties[profile].map((party) => `${party.name ?? party.id}:${party.status ?? '?'}`).join(' ')}`);
}
await writeFile(out, `${JSON.stringify(parties, null, 2)}\n`);
console.log(`wrote ${out}`);
