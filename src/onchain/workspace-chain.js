import { deploymentPrivateKey } from './signer.js';
import { readFile } from 'node:fs/promises';
import { JsonRpcProvider, Wallet, FetchRequest } from 'ethers';
import { deployFund, deployCredit } from './deploy.js';
import { createRwaMinter } from './mint.js';
import { createPoolSeeder } from './liquidity.js';

export const WORKSPACE_CHAIN_ID = 11155111;
// Reuse Sepolia infrastructure; startup never starts Anvil or deploys a stack.
export async function workspaceChain(env = process.env) {
  if (!env.RPC_URL) return { status: null, deployer: null, close() {} };
  if (env.EXPECTED_CHAIN_ID && Number(env.EXPECTED_CHAIN_ID) !== WORKSPACE_CHAIN_ID)
    throw new Error('The workspace uses Sepolia (11155111). Remove local Anvil configuration.');
  const request = new FetchRequest(env.RPC_URL);
  request.timeout = 5000;
  const provider = new JsonRpcProvider(request, WORKSPACE_CHAIN_ID, { staticNetwork: true });
  try {
    // Query eth_chainId explicitly even when ethers has a configured static network.
    const chainId = Number(BigInt(await provider.send('eth_chainId', [])));
    if (chainId !== WORKSPACE_CHAIN_ID) throw new Error('RPC_URL must point to Sepolia (11155111); local Anvil is not supported.');
    const record = JSON.parse(await readFile(env.DEPLOYMENT_PATH || 'deployments/sepolia.json', 'utf8'));
    if (record.chainId !== WORKSPACE_CHAIN_ID || !record.attestor || !record.rwa?.poolManager)
      throw new Error('DEPLOYMENT_PATH must name an existing Sepolia stack deployment.');
    const key = deploymentPrivateKey(env);
    const signer = key ? new Wallet(key, provider) : null;
    return {
      status: { chainId, ...(signer ? { deployer: signer.address } : {}), attestor: record.attestor, poolManager: record.rwa.poolManager },
      deployer: signer ? async ({ profile, sources }) => {
        if (Number(BigInt(await provider.send('eth_chainId', []))) !== WORKSPACE_CHAIN_ID)
          throw new Error('RPC chain changed; refusing deployment.');
        return profile === 'wildcat-credit' ? deployCredit(signer, { record, sources }) : deployFund(signer, { record, sources });
      } : null,
      seeder: signer ? createPoolSeeder(signer) : null,
      minter: signer ? createRwaMinter(signer, { mockSanctionsAddress: record.sanctions, sanctionsAdmin: env.PRIVATE_KEY ? new Wallet(env.PRIVATE_KEY.trim(), provider) : signer }) : null,
      close: () => provider.destroy(),
    };
  } catch (error) { provider.destroy(); throw error; }
}

// Constructing this adapter does no I/O. A failed status check is retried on the next request.
export function lazyWorkspaceChain(connect = () => workspaceChain()) {
  let pending = null;
  let connection = null;
  let closed = false;
  const get = () => {
    if (closed) return Promise.reject(new Error('Workspace is shutting down'));
    if (!pending) pending = Promise.resolve().then(connect).then((value) => {
      if (closed) { value.close(); throw new Error('Workspace is shutting down'); }
      connection = value;
      return value;
    }).catch((error) => { pending = null; throw error; });
    return pending;
  };
  return {
    async status() { try { return (await get()).status; } catch { return null; } },
    async deployer(input) {
      const value = await get();
      if (!value.deployer) throw new Error('Configure a Sepolia RPC and DEPLOYER_PRIVATE_KEY or PRIVATE_KEY to deploy.');
      return value.deployer(input);
    },
    async minter(input) {
      const value = await get();
      if (!value.minter) throw new Error('Configure the backend deployment signer to mint.');
      return value.minter(input);
    },
    seeder: {
      async state(record) {
        const value = await get();
        if (!value.seeder) throw new Error('Configure the backend signer to seed pools.');
        return value.seeder.state(record);
      },
      async seed(input) {
        const value = await get();
        if (!value.seeder) throw new Error('Configure the backend signer to seed pools.');
        return value.seeder.seed(input);
      },
    },
    close() { closed = true; connection?.close(); },
  };
}
