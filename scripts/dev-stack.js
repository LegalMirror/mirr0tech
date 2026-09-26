// Local development stack: starts anvil (unless RPC_URL is set), deploys both acts (or reuses the
// record at DEPLOYMENT_PATH when it is on this chain), writes generated/deployment.json and serves
// the operator API with the venue routes at /v1/stack.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { JsonRpcProvider, Wallet } from 'ethers';
import { deployStack, deployFund, ANVIL_DEV_KEY } from '../src/deploy.js';
import { Agreements } from '../src/agreements.js';
import { VenueService } from '../src/venues.js';
import { multibaasClient } from '../src/multibaas.js';
import { MultiBaasSigner, cloudWallet } from '../src/multibaas-signer.js';
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
// The operator signs from a file key, or from a MultiBaas Cloud Wallet (HSM) when one is named.
let signer;
if (process.env.SIGNER === 'multibaas') {
  if (!multibaas) throw new Error('SIGNER=multibaas needs MULTIBAAS_URL and MULTIBAAS_API_KEY on a public chain');
  signer = new MultiBaasSigner(multibaas, (await cloudWallet(multibaas)).publicAddress, provider);
  console.log(`operator signs from the MultiBaas Cloud Wallet ${await signer.getAddress()}`);
} else {
  const key = process.env.DEPLOYER_PRIVATE_KEY ?? (chainId === 31337n ? ANVIL_DEV_KEY : undefined);
  if (!key) throw new Error(`Set DEPLOYER_PRIVATE_KEY for chain ${chainId}, or SIGNER=multibaas`);
  signer = new Wallet(key, provider);
}
const canonical = { poolManager: process.env.POOL_MANAGER, aqua: process.env.AQUA, weth: process.env.WETH };
const saved = process.env.DEPLOYMENT_PATH ? JSON.parse(await readFile(process.env.DEPLOYMENT_PATH, 'utf8')) : null;
if (saved && saved.chainId !== Number(chainId)) console.warn(`DEPLOYMENT_PATH is for chain ${saved.chainId}, RPC is chain ${chainId}: deploying fresh`);
const record = saved?.chainId === Number(chainId) ? saved : (await deployStack(signer, { borrower: process.env.BORROWER_ADDRESS, canonical, log: console.log })).record;
await mkdir('generated', { recursive: true });
await writeFile('generated/deployment.json', `${JSON.stringify(record, null, 2)}\n`);
const dataDir = process.env.DATA_DIR ?? 'generated';
const worldId = { verifier: new WorldIdVerifier(), registry: new HumanRegistry(`${dataDir}/humans-${record.chainId}.json`) };
const venues = await new VenueService({ provider, signer, record, multibaas, worldId, auditPath: process.env.AUDIT_PATH ?? `${dataDir}/audit-${record.chainId}.json` }).init();
const apiKey = process.env.API_KEY ?? 'local-dev-stack-operator-key-only';
const host = process.env.HOST ?? '127.0.0.1';
const policyData = loadPolicyData();
const agreements = await new Agreements({
  path: `${dataDir}/agreements-${record.chainId}.json`, log: (line) => console.log(`agreement ${line}`),
  deployer: ({ sources }) => deployFund(signer, { record, sources, log: console.log }),
}).init();
const server = createApp(null, apiKey, venues, policyData, process.env.VIEWER_KEY ?? null, agreements).listen(Number(process.env.PORT ?? 3000), host, () =>
  console.log(`\nmirr0tech stack API: http://${host}:${server.address().port}/v1/stack (chain ${record.chainId}, bearer ${apiKey === 'local-dev-stack-operator-key-only' ? 'local-dev-stack-operator-key-only' : '<API_KEY>'})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); provider.destroy(); anvil?.kill('SIGTERM'); });
