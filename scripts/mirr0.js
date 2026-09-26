#!/usr/bin/env node
// The flow from a terminal: log in, upload an agreement, watch it compile, put a World ID constraint
// on it, deploy, verify a wallet, and use the policy-hooked pool. Every command is one gateway call.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { mockProof } from '../src/worldid.js';

const RC = '.mirr0rc.json';
const USAGE = `mirr0 <command> [args] [--json]

  login <url> <key>                         remember the gateway and the operator key (${RC})
  status                                    model, compiler, chain
  upload <file> [--name N] [--profile P]    upload an agreement; it generates and compiles in the background
  list | show <id> [--wait <state>]         records; --wait polls until the state (or failed)
  ast <id>                                  the tree: agreement → actions → rules → facts
  constrain <id> [--credential C] [--actions a,b] [--quote "…"] [--none]
                                            put a World ID constraint on the agreement (or lift it)
  deploy <id> [--wait]                      oracle, token, hook and pool for this agreement
  wallets <id> | explain <id> <wallet> [--action transfer]
  facts <id> <wallet> k=v …                 attest facts (rwa policy)
  fund <id> <wallet> <amount>               give a demo wallet mock USD (and gas on a public chain)
  verify <id> <wallet> [--proof file.json]  World ID proof for the wallet (a mock proof without --proof)
  mint <id> <amount> | release <id> <wallet> <amount>
  pool <id> create|liquidity|swap <wallet> [--hookless]
  audit <id>`;

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const key = args[i].slice(2); const next = args[i + 1]; if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true; }
  else positional.push(args[i]);
}
const [command, ...rest] = positional;
const out = (value, human) => { if (flags.json || human === undefined) console.log(JSON.stringify(value, null, 2)); else console.log(human); };
const fail = (message) => { console.error(message); process.exit(1); };

async function config() {
  if (process.env.MIRR0_URL && process.env.MIRR0_KEY) return { url: process.env.MIRR0_URL, key: process.env.MIRR0_KEY };
  try { return JSON.parse(await readFile(RC, 'utf8')); } catch { fail(`Not logged in: mirr0 login <url> <key> (or set MIRR0_URL and MIRR0_KEY)`); }
}
async function call(path, { method = 'GET', body } = {}) {
  const { url, key } = await config();
  const response = await fetch(`${url.replace(/\/$/, '')}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.error ?? { code: response.status, message: response.statusText };
    const clause = error.details?.refusal?.clause;
    if (flags.json) { console.log(JSON.stringify({ error }, null, 2)); process.exit(1); }
    fail(`${error.code}: ${error.message}${clause ? `\n  ↳ ${clause.ruleId ?? ''} — ${clause.clause}: “${clause.quote}”` : ''}`);
  }
  return data;
}
const line = (record) => `${record.id}  ${record.status.padEnd(10)}  ${record.name}${record.policyHash ? `  ${record.policyHash.slice(0, 10)}…` : ''}${record.deployment?.token ? `  token ${record.deployment.token}` : ''}${record.error ? `  ✗ ${record.error}` : ''}`;
async function waitFor(id, state) {
  let last = null;
  for (;;) {
    const record = await call(`/v1/agreements/${id}`);
    if (record.status === state || record.status === 'failed' || (state === 'deployed' && record.status === 'compiled' && record.error)) return record;
    const progress = record.progress?.status ?? record.status;
    if (progress !== last) { console.error(`  … ${progress}`); last = progress; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const stack = (id, path) => `/v1/agreements/${id}/stack${path}`;

const commands = {
  async login([url, key]) {
    if (!url || !key) fail('mirr0 login <url> <key>');
    await writeFile(RC, JSON.stringify({ url, key }), { mode: 0o600 });
    const status = await call('/v1/status');
    out(status, `Logged in to ${url} (chain ${status.chain?.chainId ?? 'none'}, model ${status.model.mode})`);
  },
  async status() { const status = await call('/v1/status'); out(status, `model ${status.model.mode} (${status.model.model})  solc ${status.compiler.solidity.core}  chain ${status.chain?.chainId ?? 'none'}`); },
  async upload([file]) {
    if (!file) fail('mirr0 upload <file>');
    const record = await call('/v1/agreements', { method: 'POST', body: { name: flags.name ?? basename(file), documents: [{ name: basename(file), text: await readFile(file, 'utf8') }], ...(flags.profile ? { profile: flags.profile } : {}) } });
    out(record, line(record));
  },
  async list() { const records = await call('/v1/agreements'); out(records, records.map(line).join('\n') || 'no agreements yet'); },
  async show([id]) {
    const record = flags.wait ? await waitFor(id, flags.wait) : await call(`/v1/agreements/${id}`);
    const { export: exported, ...summary } = record;
    out(flags.json ? record : summary, `${line(record)}\n  confidence ${record.verification?.confidence.overall ?? '-'}  rules ${record.coverage?.rules ?? '-'}  history ${record.history.map((entry) => entry.status).join(' → ')}`);
  },
  async ast([id]) {
    const graph = await call(`/v1/agreements/${id}/ast`);
    const children = (from) => graph.edges.filter((edge) => edge.from === from).map((edge) => graph.nodes.find((node) => node.id === edge.to));
    const mark = (node) => (node.status === 'contested' ? '?' : node.status === 'verified' ? '✓' : node.status === 'unresolved' ? '!' : '·');
    const render = (node, depth) => [`${'  '.repeat(depth)}${mark(node)} ${node.kind}: ${node.label}${node.effect ? ` (${node.effect})` : ''}`, ...children(node.id).flatMap((child) => render(child, depth + 1))];
    out(graph, render(graph.nodes[0], 0).join('\n'));
  },
  async constrain([id]) {
    const identity = flags.none ? null : { ...(flags.credential ? { credential: flags.credential } : {}), ...(flags.actions ? { actions: String(flags.actions).split(',') } : {}), ...(flags.quote ? { quote: flags.quote } : {}) };
    const record = await call(`/v1/agreements/${id}/constraints`, { method: 'PUT', body: { identity } });
    const now = await call(`/v1/agreements/${id}/constraints`);
    out({ record, constraints: now }, `${line(record)}\n  identity: ${now.identity ? `${now.identity.credential} on ${now.identity.actions.join(', ')} — “${now.identity.quote}”` : 'none'}\n  deploy again: the policy hash changed`);
  },
  async deploy([id]) {
    let record = await call(`/v1/agreements/${id}/deploy`, { method: 'POST' });
    if (flags.wait) record = await waitFor(id, 'deployed');
    const d = record.deployment;
    out(record, d ? `${line(record)}\n  oracle ${d.oracle}\n  hook   ${d.hook}\n  pool   ${d.poolId}` : line(record));
  },
  async wallets([id]) { const wallets = await call(stack(id, '/wallets')); out(wallets, wallets.map((w) => `${w.name.padEnd(10)} ${w.address}  MIRROR ${w.balances.MIRROR}  mUSDC ${w.balances.mUSDC}  transfer ${w.rwa.allowed ? 'allowed' : `refused (${w.rwa.clause?.ruleId ?? '-'})`}`).join('\n')); },
  async explain([id, wallet]) {
    const decision = await call(stack(id, `/wallets/${encodeURIComponent(wallet)}/explain?policy=rwa&action=${flags.action ?? 'transfer'}`));
    out(decision, `${decision.wallet} ${decision.action}: ${decision.allowed ? 'allowed' : 'refused'}${decision.clause ? ` — ${decision.clause.ruleId} — ${decision.clause.clause}: “${decision.clause.quote}”` : ''}\n  facts ${Object.entries(decision.facts).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join(' ') || 'none attested'}`);
  },
  async facts([id, wallet, ...pairs]) {
    const facts = Object.fromEntries(pairs.map((pair) => { const [k, v] = pair.split('='); return [k, v !== 'false']; }));
    const entry = await call(stack(id, `/wallets/${encodeURIComponent(wallet)}/facts`), { method: 'POST', body: { policy: 'rwa', facts } });
    out(entry, `attested ${Object.keys(facts).join(', ')} for ${wallet}  tx ${entry.txHash}`);
  },
  async verify([id, wallet]) {
    const wallets = await call(stack(id, '/wallets'));
    const address = wallets.find((w) => w.name === wallet)?.address ?? wallet;
    const proof = flags.proof ? JSON.parse(await readFile(flags.proof, 'utf8')) : mockProof(address);
    const entry = await call(stack(id, `/wallets/${encodeURIComponent(wallet)}/worldid`), { method: 'POST', body: { proof } });
    out(entry, `identity verified for ${wallet} (nullifier ${entry.nullifier?.slice(0, 10)}…)  tx ${entry.txHash}`);
  },
  async fund([id, wallet, amount]) { const result = await call(stack(id, `/wallets/${encodeURIComponent(wallet)}/fund`), { method: 'POST', body: { amount } }); out(result, `funded ${wallet} with ${amount} mUSDC`); },
  async mint([id, amount]) { const entry = await call(stack(id, '/rwa/mint'), { method: 'POST', body: { amount } }); out(entry, `minted ${amount} to custody  tx ${entry.txHash}`); },
  async release([id, wallet, amount]) { const entry = await call(stack(id, '/rwa/release'), { method: 'POST', body: { wallet, amount } }); out(entry, `released ${amount} to ${wallet}  tx ${entry.txHash}`); },
  async pool([id, what, wallet]) {
    const path = { create: '/rwa/pools', liquidity: '/rwa/liquidity', swap: '/rwa/swap' }[what];
    if (!path || !wallet) fail('mirr0 pool <id> create|liquidity|swap <wallet> [--hookless]');
    const entry = await call(stack(id, path), { method: 'POST', body: { wallet, hooked: !flags.hookless } });
    out(entry, `${what} by ${wallet} through the ${flags.hookless ? 'hookless' : 'policy-hooked'} pool: ${entry.status}  tx ${entry.txHash}`);
  },
  async audit([id]) { const entries = await call(stack(id, '/audit')); out(entries, entries.map((e) => `${e.at}  ${e.type.padEnd(22)} ${e.status.padEnd(7)} ${e.wallet ?? ''} ${e.refusal?.clause ? `— ${e.refusal.clause.ruleId}` : ''}`).join('\n')); },
};

if (!command || !commands[command] || flags.help) { console.log(USAGE); process.exit(command && !commands[command] ? 1 : 0); }
await commands[command](rest);
