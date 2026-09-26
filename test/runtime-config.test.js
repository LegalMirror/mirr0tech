import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { stackRuntime, assertExpectedChain, reuseDeployment, createWriteQueue } from '../src/runtime-config.js';

const remote = { NODE_ENV: 'production', API_KEY: 'test-operator-key-at-least-24-chars', RPC_URL: 'https://rpc.example.invalid', EXPECTED_CHAIN_ID: '11155111' };

test('remote startup requires a private operator key and an explicit chain before RPC use', () => {
  assert.equal(stackRuntime({}).apiKey, 'local-dev-stack-operator-key-only');
  assert.equal(stackRuntime(remote).expectedChainId, 11155111n);
  for (const patch of [{ API_KEY: undefined }, { API_KEY: 'short' }, { API_KEY: 'local-dev-stack-operator-key-only' }, { RPC_URL: '' }, { EXPECTED_CHAIN_ID: undefined }]) {
    assert.throws(() => stackRuntime({ ...remote, ...patch }));
  }
});

test('invalid chain ids and viewer credentials fail closed', () => {
  for (const value of ['', '0', '-1', '1.1', '1e3', 'abc', '9007199254740992']) {
    assert.throws(() => stackRuntime({ ...remote, EXPECTED_CHAIN_ID: value }), /EXPECTED_CHAIN_ID/);
  }
  assert.throws(() => stackRuntime({ ...remote, VIEWER_KEY: remote.API_KEY }), /VIEWER_KEY/);
  assert.throws(() => stackRuntime({ ...remote, VIEWER_KEY: 'short' }), /VIEWER_KEY/);
  assert.equal(stackRuntime({ ...remote, VIEWER_KEY: '' }).viewerKey, null);
  assert.doesNotThrow(() => assertExpectedChain(11155111n, 11155111n));
  assert.throws(() => assertExpectedChain(1n, 11155111n), /no deployment was attempted/);
});

test('public-chain startup reuses its record and never falls back to spending gas on deployments', () => {
  assert.equal(reuseDeployment(11155111n, { chainId: 11155111 }), true);
  assert.throws(() => reuseDeployment(11155111n, null), /Public-chain startup never deploys/);
  assert.throws(() => reuseDeployment(11155111n, { chainId: 31337 }), /refusing to deploy a replacement/);
  assert.equal(reuseDeployment(31337n, null), false, 'only the explicit local chain may auto-deploy');
});

test('shared issuer writes stay serialized and recover after a failed transaction', async () => {
  const queue = createWriteQueue();
  const events = [];
  let release;
  const first = queue(async () => { events.push('deploy:start'); await new Promise((resolve) => { release = resolve; }); events.push('deploy:end'); });
  await Promise.resolve();
  const second = queue(async () => { events.push('identity'); throw new Error('test transaction refused'); });
  const rejected = assert.rejects(second, /test transaction refused/);
  const third = queue(async () => events.push('next'));
  assert.deepEqual(events, ['deploy:start']);
  release();
  await Promise.all([first, rejected, third]);
  assert.deepEqual(events, ['deploy:start', 'deploy:end', 'identity', 'next']);
});

test('remote entrypoint refuses demo seeding before starting Node or accessing any credentials', () => {
  const result = spawnSync('sh', ['deploy/api-entrypoint.sh'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', SEED: 'true' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set SEED=false/);
});

test('remote deployment keeps credentials out of frontend build arguments and excludes local secrets', async () => {
  const compose = await readFile('deploy/docker-compose.remote.yml', 'utf8');
  const dashboard = await readFile('deploy/Dockerfile.dashboard', 'utf8');
  const ignore = await readFile('.dockerignore', 'utf8');
  assert.ok(compose.includes('WORLD_ENVIRONMENT: ${WORLD_ENVIRONMENT:-staging}'));
  assert.match(compose, /WORLD_CREDENTIAL: document/);
  assert.match(compose, /WORLD_RP_SIGNING_KEY:/);
  assert.match(compose, /api-data:\/app\/\.data/);
  assert.doesNotMatch(compose, /\banvil:|\bports:/);
  assert.doesNotMatch(compose, /NEXT_PUBLIC_GATEWAY_KEY|local-dev-stack-operator-key-only/);
  assert.doesNotMatch(dashboard, /NEXT_PUBLIC_GATEWAY_KEY|ARG WORLD_RP_SIGNING_KEY|ARG DEPLOYER_PRIVATE_KEY/);
  for (const pattern of ['.env', '.env.*', '**/.env', '**/.env.*']) assert.ok(ignore.split('\n').includes(pattern));
});
