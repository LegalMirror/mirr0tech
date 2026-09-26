import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { WorldLogin } from '../src/world-login.js';
import { createWorkspaceApp, createApp } from '../src/routes.js';

const worldSessionId = `session_${'ab'.repeat(64)}`;
let proofCounter = 0;
const proofFor = (challenge) => ({ protocol_version: '4.0', environment: 'sandbox', nonce: challenge.rp_context.nonce,
  session_id: worldSessionId, responses: [{ identifier: 'proof_of_human', issuer_schema_id: 1,
    signal_hash: hashSignal(challenge.signal), session_nullifier: [`0x${(++proofCounter).toString(16)}`, '0x2'],
    proof: ['0x1', '0x2', '0x3', '0x4', '0x5'], expires_at_min: 0 }] });
const upstream = async (_url, init) => {
  const proof = JSON.parse(init.body);
  return { ok: true, json: async () => ({ success: true, environment: 'sandbox', session_id: proof.session_id,
    results: [{ identifier: 'proof_of_human', success: true }] }) };
};
const options = { path: ':memory:', mode: 'sandbox', appId: 'app_test', rpId: 'rp_test', signingKey: `0x${'12'.repeat(32)}`, fetchImpl: upstream };
async function opened(t, overrides = {}) {
  const login = await WorldLogin.open({ ...options, ...overrides });
  t.after(() => login.close());
  return login;
}
async function signIn(login, patch = {}) {
  const challenge = login.challenge();
  return login.login({ challengeToken: challenge.challengeToken, proof: { ...proofFor(challenge), ...patch } });
}

test('sandbox login persists hashed tokens across restart; logout and expiry revoke access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mirr0-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'sessions.sqlite');
  let now = Date.now();
  const login = await WorldLogin.open({ ...options, path, clock: () => now });
  const first = await signIn(login);
  assert.equal(first.account.environment, 'sandbox');
  assert.equal(first.account.passportVerified, false);
  assert.notEqual(login.db.prepare('SELECT hash FROM world_sessions').get().hash, first.accessToken);
  login.close();
  const restored = await opened(t, { path, clock: () => now });
  assert.equal(restored.authenticate(first.accessToken).account.id, first.account.id);
  const challenge = restored.challenge({ existingSessionId: worldSessionId });
  const second = await restored.login({ challengeToken: challenge.challengeToken, proof: proofFor(challenge) });
  assert.equal(second.account.id, first.account.id);
  restored.logout(first.accessToken);
  assert.throws(() => restored.authenticate(first.accessToken), { code: 'WORLD_SESSION_REQUIRED' });
  now += 24 * 3600 * 1000;
  assert.throws(() => restored.authenticate(second.accessToken), { code: 'WORLD_SESSION_REQUIRED' });
});

test('rejects wrong environment, nonce, signal, credential and mismatched returning account before contacting World', async (t) => {
  let calls = 0;
  const login = await opened(t, { fetchImpl: async (...args) => { calls++; return upstream(...args); } });
  for (const mutate of [
    (p) => { p.environment = 'production'; }, (p) => { p.nonce = '0xdead'; },
    (p) => { p.responses[0].signal_hash = '0x123'; }, (p) => { p.responses[0].issuer_schema_id = 9303; },
    (p) => { p.protocol_version = '3.0'; }, (p) => { p.responses.push(p.responses[0]); },
  ]) {
    const c = login.challenge(); const p = proofFor(c); mutate(p);
    await assert.rejects(login.login({ challengeToken: c.challengeToken, proof: p }), { code: 'INVALID_LOGIN_PROOF' });
  }
  assert.equal(calls, 0);
  await signIn(login);
  const c = login.challenge({ existingSessionId: worldSessionId });
  await assert.rejects(login.login({ challengeToken: c.challengeToken, proof: { ...proofFor(c), session_id: `session_${'cd'.repeat(64)}` } }), { code: 'INVALID_LOGIN_PROOF' });
  assert.equal(calls, 1);
});

test('single-use challenges block races and persisted nullifiers block replays', async (t) => {
  const login = await opened(t);
  const c = login.challenge(); const proof = proofFor(c);
  const result = await Promise.allSettled([login.login({ challengeToken: c.challengeToken, proof }), login.login({ challengeToken: c.challengeToken, proof })]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  const next = login.challenge(); const reused = proofFor(next);
  reused.responses[0].session_nullifier = proof.responses[0].session_nullifier;
  await assert.rejects(login.login({ challengeToken: next.challengeToken, proof: reused }), { code: 'LOGIN_REPLAY' });
});

test('failed/partial verification, provider errors and missing configuration never issue sessions', async (t) => {
  for (const response of [
    { success: false }, { success: true, session_id: worldSessionId, results: [] },
    { success: true, session_id: worldSessionId, results: [{ identifier: 'proof_of_human', success: false }] },
    { success: true, environment: 'production', session_id: worldSessionId, results: [{ identifier: 'proof_of_human', success: true }] },
    { success: true, session_id: 'other', results: [{ identifier: 'proof_of_human', success: true }] },
  ]) {
    const login = await opened(t, { fetchImpl: async () => ({ ok: true, json: async () => response }) });
    await assert.rejects(signIn(login), { code: 'WORLD_LOGIN_REJECTED' });
    assert.equal(login.db.prepare('SELECT count(*) AS n FROM world_sessions').get().n, 0);
  }
  const offline = await opened(t, { fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(signIn(offline), { code: 'WORLD_UNAVAILABLE' });
  const unconfigured = await opened(t, { signingKey: '' });
  assert.equal(unconfigured.config().configured, false);
  assert.throws(() => unconfigured.challenge(), { code: 'WORLD_LOGIN_CONFIG' });
});

test('HTTP login gates local workspace and hosted demo; CORS allows the session header', async (t) => {
  const login = await opened(t);
  const apps = [
    [createWorkspaceApp({}, { worldLogin: login }), '/v1/workspace/session'],
    [createApp(null, 'operator-key-with-at-least-24-chars', null, null, null, null, { worldLogin: login, demoWorkspaces: { limits: { maxRequestBytes: 4096 }, admit: async () => {}, session: async () => ({ role: 'demo' }) } }), '/v1/demo/session'],
  ];
  for (const [app, route] of apps) {
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.close(); server.closeAllConnections(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/v1/auth/world/mock`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${url}${route}`, { method: 'POST' })).status, 401);
    const preflight = await fetch(`${url}${route}`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3100' } });
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-World-Session/);
    const c = await (await fetch(`${url}/v1/auth/world/challenge`, { method: 'POST' })).json();
    const response = await fetch(`${url}/v1/auth/world/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeToken: c.challengeToken, proof: proofFor(c) }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-world-request-id'), /^[\da-f-]{36}$/);
    const { accessToken } = await response.json();
    const headers = { 'X-World-Session': accessToken };
    assert.ok((await fetch(`${url}${route}`, { method: 'POST', headers })).ok);
    assert.equal((await fetch(`${url}/v1/auth/world/session`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/v1/auth/world/logout`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${url}${route}`, { method: 'POST', headers })).status, 401);
  }
});

test('verification failure logs transport cause and correlation without proof or token material', async (t) => {
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const login = await opened(t, { fetchImpl: async () => { throw new Error('secret-upstream-body', { cause: { code: 'ECONNRESET' } }); } });
  const challenge = login.challenge();
  const proof = proofFor(challenge);
  await assert.rejects(login.login({ challengeToken: challenge.challengeToken, proof }, { requestId: 'test-request' }), { code: 'WORLD_UNAVAILABLE' });
  const output = JSON.stringify(logs);
  assert.match(output, /test-request/);
  assert.match(output, /ECONNRESET/);
  for (const secret of ['secret-upstream-body', challenge.challengeToken, challenge.signal, challenge.rp_context.signature, proof.session_id]) assert.ok(!output.includes(secret));
});

test('placeholder login opens a workspace without World credentials or a proof, restores and logs out', async (t) => {
  const login = await opened(t, { mode: 'mock', appId: '', rpId: '', signingKey: '', fetchImpl: () => { throw new Error('Mock login must not contact World'); } });
  const server = createWorkspaceApp({}, { worldLogin: login }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${url}/v1/auth/world/config`)).json(), { configured: true, environment: 'mock', mode: 'mock' });
  const response = await fetch(`${url}/v1/auth/world/mock`, { method: 'POST' });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session.account.mock, true);
  assert.equal(session.account.provider, 'world-id-mock');
  assert.equal(session.account.credential, null);
  assert.equal(session.account.passportVerified, false);
  const headers = { 'X-World-Session': session.accessToken };
  assert.equal((await fetch(`${url}/v1/workspace/session`, { method: 'POST', headers })).status, 200);
  const restored = await (await fetch(`${url}/v1/auth/world/session`, { headers })).json();
  assert.deepEqual(restored.account, session.account);
  assert.equal((await fetch(`${url}/v1/auth/world/logout`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${url}/v1/workspace/session`, { method: 'POST', headers })).status, 401);
});

test('mock sessions persist across restart and cannot authenticate after switching to sandbox', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mirr0-mock-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'sessions.sqlite');
  const login = await WorldLogin.open({ ...options, path, mode: 'mock' });
  const session = login.mockLogin();
  login.close();
  const restored = await WorldLogin.open({ ...options, path, mode: 'mock' });
  assert.equal(restored.authenticate(session.accessToken).account.mock, true);
  restored.close();
  const sandbox = await opened(t, { path });
  assert.throws(() => sandbox.authenticate(session.accessToken), { code: 'WORLD_SESSION_REQUIRED' });
  assert.throws(() => sandbox.mockLogin(), { code: 'MOCK_LOGIN_DISABLED' });
});

const legacyProofFor = (c) => ({ protocol_version: '3.0', environment: 'staging', nonce: c.rp_context.nonce,
  action: c.action, responses: [{ identifier: 'orb', signal_hash: hashSignal(c.signal),
    nullifier: '0x123', merkle_root: '0x456', proof: `0x${(++proofCounter).toString(16).padStart(512, '0')}` }] });
const legacyUpstream = async (_url, init) => {
  const p = JSON.parse(init.body);
  return { ok: true, json: async () => ({ success: true, environment: 'staging', action: p.action,
    results: [{ identifier: 'orb', success: true, nullifier: p.responses[0].nullifier }] }) };
};
const legacyOptions = { mode: 'v3', action: 'login', fetchImpl: legacyUpstream };
async function legacySignIn(login) {
  const c = login.challenge();
  return login.login({ challengeToken: c.challengeToken, proof: legacyProofFor(c) });
}

test('v3 environment config selects staging and requires a registered login action', async (t) => {
  const previous = { mode: process.env.WORLD_LOGIN_MODE, action: process.env.WORLD_LOGIN_ACTION };
  t.after(() => {
    for (const [key, value] of [['WORLD_LOGIN_MODE', previous.mode], ['WORLD_LOGIN_ACTION', previous.action]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.WORLD_LOGIN_MODE = 'v3';
  process.env.WORLD_LOGIN_ACTION = 'registered-login';
  const login = await opened(t, { mode: undefined });
  assert.deepEqual(login.config(), { configured: true, mode: 'v3', environment: 'staging' });
  assert.equal(login.challenge().action, 'registered-login');
  const missing = await opened(t, { ...legacyOptions, action: '' });
  assert.equal(missing.config().configured, false);
  assert.throws(() => missing.challenge(), { code: 'WORLD_LOGIN_CONFIG' });
  assert.throws(() => login.challenge({ existingSessionId: worldSessionId }), { code: 'LOGIN_SESSION' });
});

test('v3 forwards complete proofs and restores the same account with fresh proofs and a stable nullifier', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mirr0-v3-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'sessions.sqlite');
  const login = await WorldLogin.open({ ...options, ...legacyOptions, path, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://developer.world.org/api/v4/verify/rp_test');
    assert.deepEqual(JSON.parse(init.body).integrity_bundle, { test: 'unchanged' });
    return legacyUpstream(url, init);
  } });
  const c = login.challenge(); const proof = { ...legacyProofFor(c), integrity_bundle: { test: 'unchanged' } };
  const first = await login.login({ challengeToken: c.challengeToken, proof });
  assert.equal(first.account.environment, 'staging');
  assert.equal(first.account.credential, 'orb');
  assert.equal(first.account.passportVerified, false);
  assert.equal(first.worldSessionId, undefined);
  login.close();
  const restored = await opened(t, { ...legacyOptions, path });
  assert.equal(restored.authenticate(first.accessToken).account.id, first.account.id);
  assert.equal((await legacySignIn(restored)).account.id, first.account.id);
  const sandbox = await opened(t, { path });
  assert.throws(() => sandbox.authenticate(first.accessToken), { code: 'WORLD_SESSION_REQUIRED' });
  restored.logout(first.accessToken);
  assert.throws(() => restored.authenticate(first.accessToken), { code: 'WORLD_SESSION_REQUIRED' });
});

test('v3 rejects wrong protocol, environment, action, signal, nonce and credential before verification', async (t) => {
  let calls = 0;
  const login = await opened(t, { ...legacyOptions, fetchImpl: async (...args) => { calls++; return legacyUpstream(...args); } });
  for (const mutate of [
    p => { p.protocol_version = '4.0'; }, p => { p.environment = 'sandbox'; },
    p => { p.environment = 'production'; }, p => { p.action = 'other'; },
    p => { p.nonce = 'other'; }, p => { p.responses[0].signal_hash = '0x123'; },
    p => { p.responses[0].identifier = 'document'; }, p => { p.session_id = worldSessionId; },
    p => { p.responses[0].proof = '0x123'; }, p => { p.responses.push(p.responses[0]); },
  ]) {
    const c = login.challenge(); const p = legacyProofFor(c); mutate(p);
    await assert.rejects(login.login({ challengeToken: c.challengeToken, proof: p }), { code: 'INVALID_LOGIN_PROOF' });
  }
  assert.equal(calls, 0);
});

test('v3 blocks races, replayed proofs and provider rejection without blocking returning nullifiers', async (t) => {
  const login = await opened(t, legacyOptions);
  const c = login.challenge(); const proof = legacyProofFor(c);
  const results = await Promise.allSettled([login.login({ challengeToken: c.challengeToken, proof }), login.login({ challengeToken: c.challengeToken, proof })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const next = login.challenge(); const replay = legacyProofFor(next);
  replay.responses[0].proof = proof.responses[0].proof;
  await assert.rejects(login.login({ challengeToken: next.challengeToken, proof: replay }), { code: 'LOGIN_REPLAY' });
  for (const response of [
    { success: false }, { success: true, results: [] },
    { success: true, environment: 'production', results: [{ identifier: 'orb', success: true }] },
    { success: true, results: [{ identifier: 'orb', success: false }] },
    { success: true, results: [{ identifier: 'document', success: true }] },
  ]) {
    const rejected = await opened(t, { ...legacyOptions, fetchImpl: async () => ({ ok: true, json: async () => response }) });
    await assert.rejects(legacySignIn(rejected), { code: 'WORLD_LOGIN_REJECTED' });
    assert.equal(rejected.db.prepare('SELECT count(*) AS n FROM world_sessions').get().n, 0);
  }
});
