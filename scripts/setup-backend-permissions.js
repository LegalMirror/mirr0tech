// Inspect by default; --apply grants the roles required by the backend's RWA mint flow.
import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Contract, JsonRpcProvider, Wallet, id } from 'ethers';
import { deploymentPrivateKey } from '../src/onchain/signer.js';

const apply = process.argv.includes('--apply');
const provider = new JsonRpcProvider(process.env.RPC_URL);
const abi = ['function hasRole(bytes32,address) view returns(bool)', 'function getRoleAdmin(bytes32) view returns(bytes32)', 'function grantRole(bytes32,address)', 'function custodian() view returns(address)'];
try {
  if (Number(BigInt(await provider.send('eth_chainId', []))) !== 11155111) throw new Error('This setup script is for Sepolia only.');
  const backend = new Wallet(deploymentPrivateKey(), provider);
  const candidates = [backend];
  if (process.env.PRIVATE_KEY) {
    const fallback = new Wallet(process.env.PRIVATE_KEY.trim(), provider);
    if (fallback.address !== backend.address) candidates.push(fallback);
  }
  const stack = JSON.parse(await readFile(process.env.DEPLOYMENT_PATH || 'deployments/sepolia.json', 'utf8'));
  const records = JSON.parse(await readFile(resolve(process.env.WORKSPACE_DIR || '.data/workspace', 'agreements.json'), 'utf8'));
  const targets = new Map([[`${stack.attestor.toLowerCase()}:ATTESTOR_ROLE`, { address: stack.attestor, role: 'ATTESTOR_ROLE' }]]);
  const custody = [];
  for (const record of records.filter(r => r.deployment?.token && r.deployment?.oracle && r.deployment.chainId === 11155111)) {
    const oracle = new Contract(record.deployment.oracle, ['function attestor() view returns(address)'], provider);
    const attestor = await oracle.attestor();
    targets.set(`${attestor.toLowerCase()}:ATTESTOR_ROLE`, { address: attestor, role: 'ATTESTOR_ROLE' });
    const token = new Contract(record.deployment.token, abi, provider);
    const custodian = await token.custodian();
    const compatible = custodian.toLowerCase() === backend.address.toLowerCase();
    custody.push({ agreement: record.id, token: record.deployment.token, custodian, backendCustody: compatible, backendMinter: await token.hasRole(id('MINTER_ROLE'), backend.address) });
    if (compatible) targets.set(`${record.deployment.token.toLowerCase()}:MINTER_ROLE`, { address: record.deployment.token, role: 'MINTER_ROLE' });
  }
  const plan = [];
  for (const target of targets.values()) {
    const contract = new Contract(target.address, abi, provider);
    const role = id(target.role);
    if (await contract.hasRole(role, backend.address)) { plan.push({ ...target, status: 'already-granted' }); continue; }
    const adminRole = await contract.getRoleAdmin(role);
    let admin;
    for (const candidate of candidates) if (await contract.hasRole(adminRole, candidate.address)) { admin = candidate; break; }
    if (!admin) throw new Error(`No configured administrator can grant ${target.role} on ${target.address}.`);
    await contract.connect(admin).grantRole.staticCall(role, backend.address);
    plan.push({ ...target, status: 'ready', admin: admin.address });
  }
  console.log(JSON.stringify({ backend: backend.address, custody, plan }, null, 2));
  if (apply) {
    const report = { chainId: 11155111, backend: backend.address, checkedAt: new Date().toISOString(), custody, roles: plan };
    await mkdir('deployments', { recursive: true });
    const save = () => writeFile('deployments/sepolia-backend-permissions.json', `${JSON.stringify(report, null, 2)}\n`);
    for (const item of plan.filter(item => item.status === 'ready')) {
      const admin = candidates.find(candidate => candidate.address === item.admin);
      const contract = new Contract(item.address, abi, admin);
      const tx = await contract.grantRole(id(item.role), backend.address);
      item.txHash = tx.hash; item.status = 'submitted'; await save();
      console.log(`Submitted ${item.role}: ${tx.hash}`);
      const receipt = await provider.waitForTransaction(tx.hash, 1, 120000);
      if (receipt?.status !== 1 || !await contract.hasRole(id(item.role), backend.address)) throw new Error(`Grant not confirmed: ${tx.hash}`);
      item.status = 'confirmed'; await save();
      console.log(`Confirmed ${item.role} on ${item.address}`);
    }
    // Update the token checks after any grants.
    for (const item of custody) item.backendMinter = await new Contract(item.token, abi, provider).hasRole(id('MINTER_ROLE'), backend.address);
    await save();
  }
} finally { provider.destroy(); }
