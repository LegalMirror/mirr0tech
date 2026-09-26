import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Store } from './store.js';
import { MockChain, EvmChain } from './onchain/chain.js';
import { MirrorService } from './service.js';
import { verifyPolicy } from './policy/compile.js';
import { createApp } from './routes.js';

const policy = verifyPolicy(JSON.parse(await readFile(process.env.POLICY_PATH ?? 'generated/policy.json', 'utf8')));
const store = new Store(process.env.DATA_DIR ?? '.data');
let chain;
try {
  const mode = process.env.CHAIN_MODE ?? 'mock';
  if (!['mock', 'evm'].includes(mode)) throw new Error('CHAIN_MODE must be mock or evm');
  chain = mode === 'mock' ? new MockChain(store, policy) : new EvmChain({
    rpcUrl: process.env.RPC_URL ?? 'http://127.0.0.1:8545',
    privateKey: process.env.MINTER_PRIVATE_KEY, tokenAddress: process.env.TOKEN_ADDRESS, policy,
  });
  const service = await new MirrorService({ store, chain, policy }).init();
  const app = createApp(service, process.env.API_KEY);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = app.listen(Number(process.env.PORT ?? 3000), host, () => console.log(`Mirrortech operator API: http://${host}:${server.address().port} (${mode}, simulated compliance and settlement)`));
  server.on('error', (error) => { console.error(error.message); chain.close(); store.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(async () => { await service.queue; chain.close(); store.close(); });
    server.closeIdleConnections();
  });
} catch (error) { chain?.close(); store.close(); throw error; }
