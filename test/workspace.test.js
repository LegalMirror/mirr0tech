import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Agreements } from '../src/agreements.js';
import { createWorkspaceApp } from '../src/routes.js';
import { extractWorkspace } from '../src/openai-extract.js';
import { workspaceChain } from '../src/onchain/workspace-chain.js';

test('workspace startup reports an occupied port without reading a null server address', { timeout: 15000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const occupied = createServer().listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => occupied.close());
  const directory = await mkdtemp(join(tmpdir(), 'mirr0-port-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = occupied.address().port;
  const child = spawn(process.execPath, ['scripts/start.js'], {
    env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', WORKSPACE_DIR: directory, WORLD_SESSION_DB: join(directory, 'sessions.sqlite'), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`Port ${port} is already in use`));
  assert.doesNotMatch(stderr, /TypeError|reading 'port'/);
  assert.doesNotMatch(stdout, /mirr0tech workspace:/);
});

const text = await readFile('test/human_contracts/ea026411904ex10-9.htm', 'utf8');
test('local workspace saves uploads, compiles demo, reconnects after restart and rejects foreign origins', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mirr0-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { path: join(directory, 'agreements.json'), uploadsPath: join(directory, 'uploads'), extract: (input) => extractWorkspace({ ...input, apiKey: '' }) };
  const agreements = await new Agreements(options).init();
  const server = createWorkspaceApp(agreements, { apiKey: '' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/v1/workspace/session`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${url}/v1/agreements`)).status, 401);
  const { accessToken } = await (await fetch(`${url}/v1/workspace/session`, { method: 'POST', headers: { origin: 'http://localhost:3100' } })).json();
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const source = text;
  const response = await fetch(`${url}/v1/agreements`, { method: 'POST', headers, body: JSON.stringify({ name: 'Demo', generation: 'demo', documents: [{ name: '../../contract.htm', text: source }] }) });
  assert.equal(response.status, 201);
  const created = await response.json();
  await agreements.settled();
  assert.equal(agreements.get(created.id).status, 'compiled');
  assert.equal(agreements.get(created.id).extraction.provider, 'demo');
  const filenames = await readdir(join(directory, 'uploads', created.id));
  assert.deepEqual(filenames, ['1-contract.htm']);
  assert.equal(await readFile(join(directory, 'uploads', created.id, filenames[0]), 'utf8'), source);
  const restored = await new Agreements(options).init();
  assert.equal(restored.list().length, 1);
  assert.equal(restored.get(created.id).status, 'compiled');
  const uploaded = await fetch(`${url}/v1/agreements`, { method: 'POST', headers, body: JSON.stringify({ name: 'Custom', generation: 'openai', documents: [{ name: 'custom.txt', text: 'Transfers require KYC approval.' }] }) });
  assert.equal(uploaded.status, 201);
  const custom = await uploaded.json();
  await agreements.settled();
  assert.equal(agreements.get(custom.id).status, 'failed');
  assert.match(agreements.get(custom.id).error, /OPENAI_API_KEY/);
  assert.equal(await readFile(join(directory, 'uploads', custom.id, '1-custom.txt'), 'utf8'), 'Transfers require KYC approval.');
});
test('workspace never launches Anvil and rejects non-Sepolia configuration', async () => {
  const chain = await workspaceChain({});
  assert.equal(chain.deployer, null);
  assert.equal(chain.status, null);
  await assert.rejects(workspaceChain({ RPC_URL: 'http://localhost:8545', EXPECTED_CHAIN_ID: '31337' }), /Sepolia/);
});

test('a validated OpenAI AST remains readable when the selected compiler cannot compile it', async () => {
  const ast = { schemaVersion: '1.0', title: 'Custom agreement', parties: [], rules: [], terms: [], unresolved: [{ clause: '1', description: 'No supported token permissions.' }] };
  const agreements = new Agreements({ extract: async ({ document }) => ({ envelope: { ast, source: document, extraction: { provider: 'openai', model: 'test' } }, verification: null }) });
  const created = await agreements.create({ name: 'Custom', generation: 'openai', documents: [{ name: 'custom.txt', text: 'A service agreement with no token permissions.' }] });
  await agreements.settled();
  const record = agreements.get(created.id);
  assert.equal(record.status, 'failed');
  assert.deepEqual(record.ast, ast);
  assert.equal(record.export, null);
  assert.equal(agreements.ast(created.id).nodes[0].label, ast.title);
});

test('Sepolia adapter does not connect until requested and recovers from an unavailable RPC', async () => {
  const { lazyWorkspaceChain } = await import('../src/onchain/workspace-chain.js');
  let attempts = 0;
  let closed = false;
  const chain = lazyWorkspaceChain(async () => {
    attempts++;
    if (attempts === 1) throw new Error('RPC offline');
    return { status: { chainId: 11155111 }, deployer: async () => ({ ok: true }), close: () => { closed = true; } };
  });
  assert.equal(attempts, 0);
  assert.equal(await chain.status(), null);
  const [first, second] = await Promise.all([chain.status(), chain.status()]);
  assert.equal(attempts, 2);
  assert.deepEqual(first, { chainId: 11155111 });
  assert.deepEqual(second, first);
  assert.deepEqual(await chain.deployer({}), { ok: true });
  chain.close();
  assert.equal(closed, true);
});

test('pnpm start serves health and requires World ID before uploads without contacting Sepolia RPC', { timeout: 15000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  let rpcCalls = 0;
  const rpc = createServer((_req, res) => { rpcCalls++; res.writeHead(503).end(); }).listen(0, '127.0.0.1');
  await once(rpc, 'listening');
  t.after(() => { rpc.close(); rpc.closeAllConnections(); });
  const directory = await mkdtemp(join(tmpdir(), 'mirr0-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['scripts/start.js'], {
    env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', WORKSPACE_DIR: directory, WORLD_SESSION_DB: join(directory, 'sessions.sqlite'), PORT: '0', RPC_URL: `http://127.0.0.1:${rpc.address().port}`, EXPECTED_CHAIN_ID: '11155111', OPENAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (data) => { output += data; const match = output.match(/workspace: (http:\/\/localhost:\d+)/); if (match) resolve(match[1]); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Workspace exited before listening (${code})`)));
  });
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/v1/workspace/session`, { method: 'POST' })).status, 401);
  const headers = { 'content-type': 'application/json' };
  const upload = await fetch(`${url}/v1/agreements`, { method: 'POST', headers, body: JSON.stringify({ name: 'Demo', generation: 'demo', documents: [{ name: 'contract.htm', text }] }) });
  assert.equal(upload.status, 401);
  assert.equal(rpcCalls, 0, 'startup and the login gate do not touch RPC');
});
