import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { deploymentPrivateKey } from '../src/onchain/signer.js';
import { VenueService } from '../src/onchain/venues.js';
import { createApp } from '../src/routes.js';
import { openapiDocument } from '../src/openapi.js';

test('deployment credentials accept either key, with deployment-specific key taking precedence', () => {
  assert.equal(deploymentPrivateKey({ PRIVATE_KEY: 'generic-key' }), 'generic-key');
  assert.equal(deploymentPrivateKey({ DEPLOYER_PRIVATE_KEY: 'deployment-key' }), 'deployment-key');
  assert.equal(deploymentPrivateKey({ PRIVATE_KEY: 'generic-key', DEPLOYER_PRIVATE_KEY: 'deployment-key' }), 'deployment-key');
  assert.equal(deploymentPrivateKey({ PRIVATE_KEY: 'generic-key', DEPLOYER_PRIVATE_KEY: '  ' }), 'generic-key');
  assert.equal(deploymentPrivateKey({}), null);
});
test('wallet settings are absent from both the authenticated API and its specification', async (t) => {
  const key = 'a-test-operator-key-at-least-24-characters';
  const server = createApp(null, key).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/settings/signing`;
  for (const method of ['GET', 'PUT'])
    assert.equal((await fetch(url, { method, headers: { authorization: `Bearer ${key}` } })).status, 404);
  assert.equal(openapiDocument().paths['/v1/settings/signing'], undefined);
});
test('venue events return gateway audit records without claiming complete chain indexing', async () => {
  const audit = [{ id: 'event', type: 'attest', status: 'ok', txHash: '0x123' }];
  assert.deepEqual(await VenueService.prototype.events.call({ audit }), { source: 'local', events: audit });
});

test('Sepolia connection accepts PRIVATE_KEY or DEPLOYER_PRIVATE_KEY without submitting transactions', async (t) => {
  const { createServer } = await import('node:http');
  const { Wallet } = await import('ethers');
  const { workspaceChain } = await import('../src/onchain/workspace-chain.js');
  const calls = [];
  const rpc = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const respond = (request) => { calls.push(request.method); return { jsonrpc: '2.0', id: request.id, result: '0xaa36a7' }; };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Array.isArray(input) ? input.map(respond) : respond(input)));
  }).listen(0, '127.0.0.1');
  await once(rpc, 'listening');
  t.after(() => { rpc.close(); rpc.closeAllConnections(); });
  // Public deterministic test keys; no funds or transaction submission.
  const first = `0x${'1'.padStart(64, '0')}`;
  const second = `0x${'2'.padStart(64, '0')}`;
  for (const [keys, expected] of [
    [{ PRIVATE_KEY: first }, first],
    [{ DEPLOYER_PRIVATE_KEY: second }, second],
    [{ PRIVATE_KEY: first, DEPLOYER_PRIVATE_KEY: second }, second],
  ]) {
    const chain = await workspaceChain({ RPC_URL: `http://127.0.0.1:${rpc.address().port}`, ...keys });
    try {
      assert.equal(chain.status.deployer, new Wallet(expected).address);
      assert.equal(chain.status.chainId, 11155111);
      assert.equal(typeof chain.deployer, 'function');
    } finally { chain.close(); }
  }
  assert.deepEqual(calls, ['eth_chainId', 'eth_chainId', 'eth_chainId']);
});
