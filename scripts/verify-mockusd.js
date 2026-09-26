// Verify the saved shared faucet using Etherscan's V2 API. Never log credentials.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { FetchRequest, JsonRpcProvider, keccak256 } from 'ethers';
import { compilerFor } from '../src/onchain/solc.js';

const recordPath = new URL('../deployments/sepolia-mockusd.json', import.meta.url);
const sourcesPath = new URL('../deployments/sepolia-mockusd.sources.json', import.meta.url);
const apiKey = process.env.ETHERSCAN_V2_KEY;
const rpcUrl = process.env.RPC_URL;
if (!apiKey || !rpcUrl) throw new Error('Set ETHERSCAN_V2_KEY and RPC_URL in .env.');
const request = new FetchRequest(rpcUrl);
request.timeout = 20000;
const provider = new JsonRpcProvider(request, 11155111, { staticNetwork: true });
const clean = (value) => String(value).replaceAll(apiKey, '<redacted>').replaceAll(rpcUrl, '<redacted-rpc>');
try {
  const deployment = JSON.parse(await readFile(recordPath, 'utf8'));
  if (deployment.chainId !== 11155111 || BigInt(await provider.send('eth_chainId', [])) !== 11155111n)
    throw new Error('Verification is limited to the saved Sepolia deployment.');
  const compiler = await compilerFor('core');
  if (compiler.version() !== deployment.compiler) throw new Error('Install the exact compiler version recorded at deployment.');
  const path = 'contracts/test/MockUSD.sol';
  const sources = { [path]: { content: await readFile(path, 'utf8') } };
  const input = { language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: false, evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  } };
  const check = (output) => {
    const error = output.errors?.find((item) => item.severity === 'error');
    if (error) throw new Error(error.formattedMessage);
    return output.contracts[path].MockUSD;
  };
  // Collect only the faucet's actual import closure, not unrelated generated agreement sources.
  check(JSON.parse(compiler.compile(JSON.stringify(input), { import: (sourcePath) => {
    for (const candidate of [sourcePath, `node_modules/${sourcePath}`]) {
      try {
        const content = readFileSync(candidate, 'utf8');
        sources[sourcePath] = { content };
        return { contents: content };
      } catch {}
    }
    return { error: `Missing Solidity dependency: ${sourcePath}` };
  } })));
  const artifact = check(JSON.parse(compiler.compile(JSON.stringify(input))));
  const [transaction, runtime] = await Promise.all([
    provider.getTransaction(deployment.transactionHash), provider.getCode(deployment.address),
  ]);
  if (!transaction || transaction.to !== null || transaction.data !== `0x${artifact.evm.bytecode.object}`
    || runtime !== `0x${artifact.evm.deployedBytecode.object}` || keccak256(runtime) !== deployment.runtimeCodeHash)
    throw new Error('Rebuilt creation/runtime bytecode does not exactly match the saved deployment. No source was submitted.');
  await writeFile(sourcesPath, `${JSON.stringify(input, null, 2)}\n`);
  console.log(`Exact creation and runtime bytecode match: ${deployment.address}`);
  const api = async (action, fields = null) => {
    const url = new URL('https://api.etherscan.io/v2/api');
    for (const [key, value] of Object.entries({ chainid: '11155111', module: 'contract', action, apikey: apiKey })) url.searchParams.set(key, value);
    const options = { signal: AbortSignal.timeout(30000) };
    if (action === 'verifysourcecode') {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      options.body = new URLSearchParams(fields);
    } else for (const [key, value] of Object.entries(fields ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`);
    return response.json();
  };
  const save = async (verification) => {
    deployment.verification = { ...deployment.verification, ...verification, url: `https://sepolia.etherscan.io/address/${deployment.address}#code` };
    const temporary = new URL(`${recordPath.href}.tmp`);
    await writeFile(temporary, `${JSON.stringify(deployment, null, 2)}\n`);
    await rename(temporary, recordPath);
  };
  const verifiedSource = async () => {
    const result = await api('getsourcecode', { address: deployment.address });
    return result.status === '1' && result.result?.[0]?.SourceCode && result.result[0].ContractName === 'MockUSD';
  };
  if (await verifiedSource()) {
    await save({ status: 'verified', verifiedAt: new Date().toISOString() });
    console.log(`Verified: ${deployment.verification.url}`);
  } else {
    let guid = deployment.verification?.status === 'pending' ? deployment.verification.guid : null;
    if (!guid) {
      const result = await api('verifysourcecode', {
        contractaddress: deployment.address, sourceCode: JSON.stringify(input),
        codeformat: 'solidity-standard-json-input', contractname: `${path}:MockUSD`,
        compilerversion: `v${compiler.version().split('.Emscripten')[0]}`,
        optimizationUsed: '1', runs: '200', constructorArguments: '', evmVersion: 'cancun', licenseType: '1',
      });
      if (result.status !== '1') throw new Error(`Etherscan submission: ${result.result}`);
      guid = result.result;
      await save({ status: 'pending', guid, submittedAt: new Date().toISOString() });
      console.log(`Verification submitted: ${guid}`);
    }
    let finished = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const result = await api('checkverifystatus', { guid });
      console.log(clean(`Etherscan: ${result.result}`));
      if (result.status === '1' || /already verified/i.test(result.result)) {
        if (!await verifiedSource()) continue;
        await save({ status: 'verified', verifiedAt: new Date().toISOString() });
        console.log(`Verified: ${deployment.verification.url}`);
        finished = true;
        break;
      }
      if (!/pending|queue|in progress/i.test(result.result)) {
        await save({ status: 'failed', result: clean(result.result) });
        throw new Error(`Etherscan verification failed: ${result.result}`);
      }
    }
    if (!finished) { console.log('Verification is still pending. Rerun pnpm verify:mockusd to check the saved request.'); process.exitCode = 2; }
  }
} catch (error) {
  console.error(clean(error.shortMessage ?? error.message));
  process.exitCode = 1;
} finally { provider.destroy(); }
