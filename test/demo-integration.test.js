import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/routes.js';
import { Agreements } from '../src/agreements.js';
import { DemoWorkspaces } from '../src/demo-workspaces.js';

const key = 'test-maintenance-key-at-least-24-characters';

test('public demo mounts before operator auth without granting operator authority', async (t) => {
  const agreements = await new Agreements({ deployer: async () => ({ testOnly: true }) }).init();
  const workspaces = await new DemoWorkspaces({ agreements, chainId: 31337 }).init();
  const app = createApp(null, key, null, null, null, agreements, { demoWorkspaces: workspaces });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, token, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('/v1/demo/config')).body.enabled, true);
  const a = (await call('/v1/demo/session', null, {})).body.accessToken;
  const b = (await call('/v1/demo/session', null, {})).body.accessToken;
  assert.match(a, /^demo_/);
  assert.notEqual(a, b);
  assert.equal((await call('/v1/status', a)).body.chain.chainId, 31337);
  const created = await call('/v1/agreements', a, { name: 'My public demo', documents: [{ name: 'ea026411904ex10-9.htm', text: await readFile('test/human_contracts/ea026411904ex10-9.htm', 'utf8') }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await agreements.settled();
  assert.equal((await call(`/v1/agreements/${created.body.id}`, a)).body.status, 'compiled');
  assert.equal((await call(`/v1/agreements/${created.body.id}`, b)).status, 404);
  assert.deepEqual((await call('/v1/agreements', b)).body, []);
  for (const path of ['/v1/settings/signing', '/v1/stack/wallets', '/v1/audit']) {
    assert.equal((await call(path, a)).status, 403, path);
  }
  assert.equal((await call('/v1/stack/rwa/mint', a, { amount: '1' })).status, 403);
  assert.equal((await call('/v1/agreements', 'ia_not-a-workspace-token')).status, 401);
  assert.equal((await call('/v1/agreements', key)).status, 200, 'maintenance operator access stays separate');
});
