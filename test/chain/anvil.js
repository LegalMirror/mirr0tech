import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { JsonRpcProvider } from 'ethers';

// Public Anvil development key, never use for assets or a public chain.
export const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export async function startAnvil(t) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let startupError;
  anvil.on('error', (error) => { startupError = error; });
  let stderr = '';
  anvil.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (anvil.exitCode === null && !startupError) { const exited = once(anvil, 'exit'); anvil.kill('SIGTERM'); await exited; }
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (startupError) throw new Error(`Install Foundry/Anvil to run chain tests: ${startupError.message}`);
    if (anvil.exitCode !== null) throw new Error(`Anvil exited: ${stderr}`);
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if ((await response.json()).result === '0x7a69') {
        const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
        provider.pollingInterval = 50;
        t.after(() => provider.destroy());
        return { provider, rpcUrl };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Anvil did not start: ${stderr}`);
}

export const warp = (provider, seconds) => provider.send('evm_increaseTime', [seconds]).then(() => provider.send('evm_mine', []));
