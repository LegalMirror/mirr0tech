import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { verifyPolicy } from '../src/policy/compile.js';

const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'http://127.0.0.1:8545', undefined, { cacheTimeout: -1 });
try {
  if ((await provider.getNetwork()).chainId !== 31337n) throw new Error('Deployment is limited to local development chain 31337');
  if (!process.env.MINTER_PRIVATE_KEY) throw new Error('Set MINTER_PRIVATE_KEY to a funded local development account');
  const wallet = new Wallet(process.env.MINTER_PRIVATE_KEY, provider);
  const policy = verifyPolicy(JSON.parse(await readFile('generated/policy.json', 'utf8')));
  const artifact = JSON.parse(await readFile('artifacts/custodial-rwa/CompiledMirrorToken.json', 'utf8'));
  if (artifact.policyHash !== policy.hash) throw new Error('Build artifacts are stale; run npm run build:contracts');
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, wallet).deploy(process.env.ADMIN_ADDRESS ?? wallet.address, wallet.address);
  await contract.waitForDeployment();
  if (await contract.policyHash() !== policy.hash) throw new Error('Build artifacts are stale; run npm run build');
  const deployment = { chainId: 31337, address: await contract.getAddress(), custodian: wallet.address, policyHash: policy.hash, transactionHash: contract.deploymentTransaction().hash };
  await mkdir('generated', { recursive: true });
  await writeFile('generated/deployment.json', `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`TOKEN_ADDRESS=${deployment.address}\nSet CHAIN_MODE=evm and use a fresh DATA_DIR for this deployment.`);
} finally { provider.destroy(); }
