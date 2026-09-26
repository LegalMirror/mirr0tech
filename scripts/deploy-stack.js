import { deploymentPrivateKey } from '../src/onchain/signer.js';
// Deploys both acts to RPC_URL (a local anvil by default) and writes generated/deployment.json.
// On a public chain set DEPLOYER_PRIVATE_KEY and, where they exist, POOL_MANAGER, AQUA and WETH.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { JsonRpcProvider, Wallet } from 'ethers';
import { deployStack, ANVIL_CHAIN_ID, ANVIL_DEV_KEY } from '../src/onchain/deploy.js';

const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'http://127.0.0.1:8545', undefined, { cacheTimeout: -1 });
try {
  const chainId = (await provider.getNetwork()).chainId;
  const key = deploymentPrivateKey() ?? (chainId === ANVIL_CHAIN_ID ? ANVIL_DEV_KEY : undefined);
  if (!key) throw new Error(`Set DEPLOYER_PRIVATE_KEY or PRIVATE_KEY for chain ${chainId}; only anvil (31337) has a default key`);
  const signer = new Wallet(key, provider);
  const canonical = { poolManager: process.env.POOL_MANAGER, aqua: process.env.AQUA, weth: process.env.WETH };
  const { record } = await deployStack(signer, { borrower: process.env.BORROWER_ADDRESS, canonical, log: console.log });
  await mkdir('generated', { recursive: true });
  await writeFile('generated/deployment.json', `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nWrote generated/deployment.json for chain ${record.chainId}`);
  console.log(`fund policy   ${record.rwa.policyHash}\ncredit policy ${record.credit.policyHash}`);
} finally { provider.destroy(); }
