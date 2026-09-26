import 'dotenv/config';
import { resolve } from 'node:path';
import { Agreements } from '../src/agreements.js';
import { extractWorkspace } from '../src/openai-extract.js';
import { createWorkspaceApp } from '../src/routes.js';
import { lazyWorkspaceChain } from '../src/onchain/workspace-chain.js';
import { WorldLogin } from '../src/world-login.js';

const directory = resolve(process.env.WORKSPACE_DIR || '.data/workspace');
const chain = lazyWorkspaceChain();
const agreements = await new Agreements({
  path: resolve(directory, 'agreements.json'), uploadsPath: resolve(directory, 'uploads'),
  extract: extractWorkspace, deployer: chain.deployer, log: console.log,
}).init();
const worldLogin = await WorldLogin.open();
const port = Number(process.env.PORT || 3000);
const server = createWorkspaceApp(agreements, { chainStatus: chain.status, worldLogin }).listen(port, '127.0.0.1');
server.once('listening', () => {
  console.log(`mirr0tech workspace: http://localhost:${server.address().port}`);
  console.log(`Files and contracts: ${directory}`);
  console.log((process.env.OPENAI_API_KEY || process.env.OPENAPI_KEY) ? 'OpenAI file generation ready. Demo generation is also available.' : 'Demo ready. Set OPENAI_API_KEY in .env to generate ASTs from your files.');
});
server.once('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the previous server or choose another PORT, then run pnpm start again.` : error.message);
  chain.close();
  worldLogin.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(async () => { await agreements.settled(); await agreements.persist(); chain.close(); worldLogin.close(); });
  server.closeIdleConnections();
});
