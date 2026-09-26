import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/routes.js';
import { setup, compliant } from './helpers.js';

test('REST API enforces operator auth, validation, policy and a full mint/redemption flow', async (t) => {
  const { service } = await setup(t);
  const key = 'a-test-operator-key-at-least-24-characters';
  const server = createApp(service, key).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, method = 'POST', idempotencyKey) => {
    const response = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await fetch(`${url}/v1/policy`)).status, 401);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await request('/v1/investors', { name: 'Alice', kycApproved: true })).status, 400);
  const { data: investor, status } = await request('/v1/investors', { name: 'Alice' });
  assert.equal(status, 201);
  const { data: deposit } = await request('/v1/deposits', { investorId: investor.id, amount: '10' });
  const body = { investorId: investor.id, depositId: deposit.id, amount: '10' };
  assert.equal((await request('/v1/mints', body)).status, 400);
  assert.equal((await request('/v1/mints', body, 'POST', 'mint')).status, 403);
  await request(`/v1/mock/investors/${investor.id}/compliance`, compliant, 'PATCH');
  await request(`/v1/mock/deposits/${deposit.id}/confirm`, {});
  assert.equal((await request('/v1/mints', body, 'POST', 'mint')).data.status, 'confirmed');
  const { data: burn } = await request('/v1/redemptions', { investorId: investor.id, amount: '4' }, 'POST', 'burn');
  assert.equal(burn.status, 'confirmed');
  assert.equal((await request(`/v1/mock/withdrawals/${burn.id}/settle`, {})).data.status, 'settled');
  assert.equal((await request(`/v1/investors/${investor.id}`, null, 'GET')).data.balanceUnits, '6000000');
  const response = await fetch(`${url}/v1/investors`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
});

test('a viewer key opens the GET routes only', async (t) => {
  const { service } = await setup(t);
  const key = 'a-test-operator-key-at-least-24-characters';
  const viewer = 'a-test-viewer-key-at-least-24-characters!';
  assert.throws(() => createApp(service, key, null, null, 'short'), /VIEWER_KEY/);
  assert.throws(() => createApp(service, key, null, null, key), /different/);
  const server = createApp(service, key, null, null, viewer).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const as = (token, path, method = 'GET') => fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  assert.equal((await as(viewer, '/v1/policy')).status, 200);
  assert.equal((await as(viewer, '/v1/investors', 'POST')).status, 401, 'a viewer cannot write');
  assert.equal((await as('a-wrong-token-that-is-long-enough-too', '/v1/policy')).status, 401);
  assert.equal((await as(key, '/v1/investors', 'POST')).status, 400, 'the operator key still writes');
});
