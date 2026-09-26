import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { Agreements } from '../src/agreements.js';

delete process.env.NOOLOG_API_KEY;
const html = await readFile('test/human_contracts/ea026411904ex10-9.htm', 'utf8');

test('the agreements API: upload, watch it compile, read the tree, regenerate, deploy, status', async (t) => {
  const agreements = new Agreements({ deployer: async ({ policyHash }) => ({ chainId: 31337, token: '0xt', policyHash }) });
  const key = 'a-test-operator-key-at-least-24-characters';
  const viewer = 'a-test-viewer-key-at-least-24-characters!';
  const server = createApp(null, key, null, null, viewer, agreements).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = key } = {}) => {
    const response = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };

  assert.equal((await fetch(`${url}/v1/agreements`)).status, 401);
  assert.equal((await call('/v1/agreements', { method: 'POST', body: { name: 'x' } })).data.error.code, 'INVALID_BODY');
  assert.equal((await call('/v1/agreements', { method: 'POST', body: { name: 'x', text: html, extra: 1 }, token: viewer })).status, 401, 'a viewer cannot upload');
  const status = await call('/v1/status');
  assert.equal(status.data.model.mode, 'mock');
  assert.equal(status.data.model.listed, true, 'the mock serves whatever model is configured');
  assert.match(status.data.compiler.solidity.core, /^0\.8\./);
  assert.equal(status.data.chain, null);

  assert.equal((await call('/v1/agreements', { method: 'POST', body: { name: 'x', text: 'y', filename: 'x.pdf' } })).data.error.code, 'INVALID_DOCUMENT');
  const created = await call('/v1/agreements', { method: 'POST', body: { name: 'BUIDL', text: html, filename: 'ea026411904ex10-9.htm' } });
  assert.equal(created.status, 201, 'a whole agreement fits in one upload');
  assert.equal(created.data.status, 'extracting');
  const id = created.data.id;
  await agreements.settled();
  const listed = await call('/v1/agreements', { token: viewer });
  assert.equal(listed.data[0].status, 'compiled');
  const one = await call(`/v1/agreements/${id}`);
  assert.equal(one.data.export.policyHash, listed.data[0].policyHash);
  const tree = await call(`/v1/agreements/${id}/ast`);
  assert.ok(tree.data.nodes.length > 10 && tree.data.edges.length >= tree.data.nodes.length - 1);
  assert.equal((await call('/v1/agreements/agr_nope/ast')).status, 404);

  assert.equal((await call(`/v1/agreements/${id}/regenerate`, { method: 'POST' })).status, 202);
  assert.equal((await call(`/v1/agreements/${id}/deploy`, { method: 'POST' })).data.error.code, 'INVALID_STATE');
  await agreements.settled();
  const deploy = await call(`/v1/agreements/${id}/deploy`, { method: 'POST' });
  assert.equal(deploy.status, 202);
  assert.equal(deploy.data.status, 'deploying');
  await agreements.settled();
  assert.equal((await call(`/v1/agreements/${id}`)).data.deployment.token, '0xt');
});
