// Deploy the shared, permissionless six-decimal Sepolia faucet exactly once.
import 'dotenv/config';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider, Wallet, formatEther, keccak256 } from 'ethers';
import { compileBundle } from '../src/onchain/solc.js';
import { deploymentPrivateKey } from '../src/onchain/signer.js';

const output = new URL('../deployments/sepolia-mockusd.json', import.meta.url);
const pendingPath = new URL('../deployments/sepolia-mockusd.pending.json', import.meta.url);
const rpcUrl = process.env.RPC_URL;
const key = deploymentPrivateKey();
if (!rpcUrl || !key) throw new Error('Set RPC_URL and DEPLOYER_PRIVATE_KEY or PRIVATE_KEY in .env.');
const rpc = new FetchRequest(rpcUrl);
rpc.timeout = 20000;
const provider = new JsonRpcProvider(rpc, 11155111, { staticNetwork: true, cacheTimeout: -1 });
provider.pollingInterval = 2000;
try {
  if (BigInt(await provider.send('eth_chainId', [])) !== 11155111n) throw new Error('RPC_URL must point to Sepolia (11155111).');
  let existing;
  try { existing = JSON.parse(await readFile(output, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (existing.chainId !== 11155111 || await provider.getCode(existing.address) === '0x') throw new Error('Saved faucet deployment does not exist on Sepolia. Inspect the deployment record before retrying.');
    console.log(JSON.stringify({ reused: true, ...existing }, null, 2));
  } else {
    const { MockUSD: artifact } = await compileBundle('core', [['contracts/test/MockUSD.sol', 'MockUSD']]);
    const signer = new Wallet(key, provider);
    let pending;
    try { pending = JSON.parse(await readFile(pendingPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!pending) {
      const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
      const request = await factory.getDeployTransaction();
      const gas = await signer.estimateGas(request);
      const fees = await provider.getFeeData();
      const balance = await provider.getBalance(signer.address);
      const estimatedCost = gas * (fees.maxFeePerGas ?? fees.gasPrice);
      if (balance < estimatedCost) throw new Error(`The deployment wallet needs more Sepolia ETH (estimated ${formatEther(estimatedCost)} ETH).`);
      console.log(JSON.stringify({ chainId: 11155111, deployer: signer.address, estimatedGas: gas.toString(), estimatedMaxCostEth: formatEther(estimatedCost) }));
      const contract = await factory.deploy();
      pending = { chainId: 11155111, address: await contract.getAddress(), transactionHash: contract.deploymentTransaction().hash, deployer: signer.address, compiler: artifact.compiler };
      await mkdir(new URL('../deployments/', import.meta.url), { recursive: true });
      await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, { flag: 'wx' });
      console.log(`Deployment submitted: ${pending.transactionHash}`);
    }
    if (pending.chainId !== 11155111 || pending.deployer.toLowerCase() !== signer.address.toLowerCase()) throw new Error('Inspect the pending faucet deployment before retrying with another signer.');
    const receipt = await provider.waitForTransaction(pending.transactionHash, 1, 180000);
    if (!receipt || receipt.status !== 1) throw new Error('The faucet deployment did not confirm successfully. Check its transaction before retrying.');
    const token = new Contract(pending.address, artifact.abi, provider);
    const [name, symbol, decimals, bytecode] = await Promise.all([token.name(), token.symbol(), token.decimals(), provider.getCode(pending.address)]);
    if (symbol !== 'mUSDC' || decimals !== 6n || bytecode === '0x') throw new Error('Unexpected faucet contract metadata.');
    // eth_call from an unrelated address proves mint has no deployer-only gate; no tokens are issued here.
    await token.mint.staticCall(signer.address, 1n, { from: '0x0000000000000000000000000000000000000001' });
    const deployment = { ...pending, name, symbol, decimals: Number(decimals), blockNumber: receipt.blockNumber,
      runtimeCodeHash: keccak256(bytecode), deployedAt: new Date().toISOString() };
    await writeFile(output, `${JSON.stringify(deployment, null, 2)}\n`, { flag: 'wx' });
    await unlink(pendingPath);
    console.log(JSON.stringify(deployment, null, 2));
  }
} catch (error) {
  // RPC errors can include provider URLs or signed transaction payloads; keep public output bounded.
  console.error(error.shortMessage ?? (error.code ? `Faucet deployment failed (${error.code}); check the saved transaction record.` : error.message));
  process.exitCode = 1;
} finally { provider.destroy(); }
