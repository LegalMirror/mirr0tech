// Local development stack: starts anvil (unless RPC_URL is set), deploys both acts (or reuses the
// record at DEPLOYMENT_PATH when it is on this chain), writes generated/deployment.json and serves
// the operator API with the venue routes at /v1/stack.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { deployStack, deployFund, ANVIL_DEV_KEY } from '../src/deploy.js';
import { Agreements } from '../src/agreements.js';
import { VenueService } from '../src/venues.js';
import { multibaasClient } from '../src/multibaas.js';
import { SigningSettings } from '../src/signing.js';
import { HumanRegistry, WorldIdVerifier } from '../src/worldid.js';
import { createApp } from '../src/app.js';
import { loadPolicyData } from '../src/dashboard-api.js';

let anvil = null;
let rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
  const port = Number(process.env.ANVIL_PORT ?? 8545);
  anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] });
  anvil.on('error', () => { console.error('This needs Foundry/Anvil on PATH.'); process.exit(1); });
  rpcUrl = `http://127.0.0.1:${port}`;
}
const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
provider.pollingInterval = 100;
for (let attempt = 0; attempt < 200; attempt++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 50)); } }
const chainId = (await provider.getNetwork()).chainId;
const multibaas = process.env.MULTIBAAS_API_KEY && chainId !== 31337n ? multibaasClient() : null;
const key = process.env.DEPLOYER_PRIVATE_KEY ?? (chainId === 31337n ? ANVIL_DEV_KEY : undefined);
if (!key) throw new Error(`Set DEPLOYER_PRIVATE_KEY for chain ${chainId}`);
const signer = new Wallet(key, provider);
const canonical = { poolManager: process.env.POOL_MANAGER, aqua: process.env.AQUA, weth: process.env.WETH };
const saved = process.env.DEPLOYMENT_PATH ? JSON.parse(await readFile(process.env.DEPLOYMENT_PATH, 'utf8')) : null;
if (saved && saved.chainId !== Number(chainId)) console.warn(`DEPLOYMENT_PATH is for chain ${saved.chainId}, RPC is chain ${chainId}: deploying fresh`);
const record = saved?.chainId === Number(chainId) ? saved : (await deployStack(signer, { borrower: process.env.BORROWER_ADDRESS, canonical, log: console.log })).record;
await mkdir('generated', { recursive: true });
await writeFile('generated/deployment.json', `${JSON.stringify(record, null, 2)}\n`);
const dataDir = process.env.DATA_DIR ?? 'generated';
const verifier = new WorldIdVerifier();
// Never mix forgeable demo bindings with a live RP's credential/action namespace.
const registries = new Map();
const identityFor = (verifier) => {
  const scope = keccak256(toUtf8Bytes(JSON.stringify([verifier.mock, verifier.rpId, verifier.environment, verifier.action, verifier.credential])));
  if (!registries.has(scope)) registries.set(scope, new HumanRegistry(`${dataDir}/humans-${record.chainId}-${scope}.json`));
  return { verifier, registry: registries.get(scope) };
};
const worldId = identityFor(verifier);
const venues = await new VenueService({ provider, signer, record, multibaas, worldId, auditPath: process.env.AUDIT_PATH ?? `${dataDir}/audit-${record.chainId}.json` }).init();
const apiKey = process.env.API_KEY ?? 'local-dev-stack-operator-key-only';
const host = process.env.HOST ?? '127.0.0.1';
const policyData = loadPolicyData();
const agreements = await new Agreements({
  path: `${dataDir}/agreements-${record.chainId}.json`, log: (line) => console.log(`agreement ${line}`),
  deployer: ({ sources }) => deployFund(venues.signer, { record, sources, log: console.log }),
  // One venue per deployed agreement: its token, oracle and hook; the stack's attestor, sanctions oracle and pool manager.
  venueFactory: ({ id, deployment, policy, clauseTable, credential, action }) => new VenueService({
    provider, signer: venues.signer, multibaas, policies: { rwa: { policy, clauseTable }, credit: venues.policies.credit },
    record: { ...record, rwa: { ...record.rwa, ...deployment, router: deployment.router ?? record.rwa.router, policyHash: policy.hash, clauseTableHash: clauseTable.clauseTableHash }, address: deployment.token, policyHash: policy.hash },
    worldId: identityFor(new WorldIdVerifier({ credential, action })),
    auditPath: `${dataDir}/audit-${record.chainId}-${id}.json`,
  }).init(),
}).init();
// Key custody: the saved choice wins; SIGNER=multibaas moves signing into the Cloud Wallet on this boot.
const signing = await new SigningSettings({ venues, fileSigner: signer, multibaas, agreements, path: `${dataDir}/signing-${record.chainId}.json` }).init();
if (process.env.SIGNER === 'multibaas' && signing.provider === 'key') await signing.configure({ provider: 'multibaas', wallet: process.env.MULTIBAAS_WALLET ?? null, gas: process.env.MULTIBAAS_WALLET_GAS ?? null });
if (signing.provider === 'multibaas') console.log(`operator signs from the MultiBaas Cloud Wallet ${signing.wallet.address}`);
const server = createApp(null, apiKey, venues, policyData, process.env.VIEWER_KEY ?? null, agreements, { signing }).listen(Number(process.env.PORT ?? 3000), host, () =>
  console.log(`\nmirr0tech stack API: http://${host}:${server.address().port}/v1/stack (chain ${record.chainId}, bearer ${apiKey === 'local-dev-stack-operator-key-only' ? 'local-dev-stack-operator-key-only' : '<API_KEY>'})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); provider.destroy(); anvil?.kill('SIGTERM'); });
