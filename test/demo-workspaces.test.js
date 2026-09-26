import { extractDemo } from '../src/openai-extract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Agreements } from '../src/agreements.js';
import { agreementRoutes, demoWorkspaceRoutes } from '../src/routes.js';
import { DemoWorkspaces } from '../src/demo-workspaces.js';

// node:test isolates test files; these tests must never contact a paid model.
delete process.env.OPENAI_API_KEY;
const html = await readFile('test/human_contracts/ea026411904ex10-9.htm', 'utf8');
const addendum = await readFile('test/human_contracts/nav-cashier-addendum.md', 'utf8');
const cashier = JSON.parse(await readFile('examples/rwa-cashier-config.json', 'utf8'));
const upload = { name: 'Private demo', documents: [{ name: 'fund.htm', text: html }] };
const rejected = (status, code) => (error) => error.status === status && (!code || error.code === code);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'demo-workspaces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function service(options = {}) {
  const agreements = options.agreements ?? new Agreements({ extract: extractDemo, deployer: async () => ({ chainId: 31337, token: '0xtest' }) });
  const workspaces = await new DemoWorkspaces({ agreements, chainId: 31337, ...options }).init();
  return { agreements, workspaces };
}
async function created(workspaces, agreements, token, body = upload) {
  const record = await workspaces.create(token, body);
  await agreements.settled();
  assert.equal(agreements.get(record.id).status, 'compiled', agreements.get(record.id).error ?? '');
  return record.id;
}
async function http(t, options = {}, trustProxy = false) {
  const { agreements, workspaces } = await service(options);
  const app = express();
  app.set('trust proxy', trustProxy);
  const status = async () => ({ model: { url: 'https://secret.invalid/key', apiKey: 'secret' }, compiler: { solidity: { core: '0.8.37+commit.123', 'uniswap-v4': '0.8.26', secret: 'secret' } }, chain: { chainId: 1, deployer: 'private-signer', wallet: 'private-wallet' }, secret: 'secret' });
  app.use('/v1', demoWorkspaceRoutes(workspaces, status));
  const passed = [];
  app.use('/v1', (req, res, next) => {
    passed.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer operator-maintenance') return next();
    if (req.headers.authorization === 'Bearer investor_parent_token') return res.status(418).json({ handledBy: 'parent-investor-auth' });
    res.status(401).json({ error: { code: 'OPERATOR_AUTH' } });
  });
  app.use(express.json({ limit: '4mb' }));
  app.use('/v1', agreementRoutes(agreements, status));
  app.use('/v1', (_req, res) => res.json({ operatorOnly: true }));
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: { code: error.code } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await agreements.settled();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  const call = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const session = async () => {
    const response = await call('/demo/session', { method: 'POST' });
    assert.equal(response.status, 201);
    return response.data.accessToken;
  };
  return { agreements, workspaces, call, session, passed };
}

test('constructor restricts chain, durable Sepolia state and safety ceilings', async (t) => {
  const agreements = new Agreements({ extract: extractDemo });
  for (const chainId of [1, 10, 8453, '11155111', undefined]) assert.throws(() => new DemoWorkspaces({ agreements, chainId }), rejected(500, 'CONFIG'));
  assert.throws(() => new DemoWorkspaces({ agreements, chainId: 11155111 }), /durable/);
  for (const options of [{ sessionsPerIp: 0 }, { sessionTtlSeconds: 86400 }, { maxParts: 9 }, { maxRequestBytes: 5_000_000 }, { unknown: 1 }]) assert.throws(() => new DemoWorkspaces({ agreements, chainId: 31337, ...options }), rejected(500, 'CONFIG'));
  const path = join(await temporary(t), 'workspaces.json');
  assert.throws(() => new DemoWorkspaces({ agreements: new Agreements({ extract: extractDemo, path }), chainId: 31337, path }), /different paths/);
  const demo = await new DemoWorkspaces({ agreements, chainId: 11155111, path }).init();
  assert.equal(demo.config().chainId, 11155111);
});

test('HTTP: keyless sessions run the real scoped lifecycle without exposing operator records', async (t) => {
  const { agreements, call, session, passed } = await http(t);
  const operator = await agreements.create({ ...upload, name: 'Operator secret' });
  await agreements.settled();
  const config = await call('/demo/config');
  assert.equal(config.status, 200);
  assert.deepEqual(Object.keys(config.data), ['enabled', 'chainId', 'limits']);
  assert.equal(config.data.limits.deploysPerInterval, 5);
  assert.equal(config.headers.get('cache-control'), 'no-store');
  const issued = await call('/demo/session', { method: 'POST' });
  const token = issued.data.accessToken;
  assert.match(token, /^demo_[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(issued.data), ['accessToken', 'expiresAt', 'role', 'chainId']);
  assert.equal(issued.data.role, 'demo');
  assert.ok(issued.data.expiresAt > Date.now() / 1000 && issued.data.expiresAt < Date.now() / 1000 + 10801);
  assert.equal(issued.headers.get('set-cookie'), null);
  const other = await session();
  assert.deepEqual((await call('/agreements', { token })).data, []);
  const result = await call('/agreements', { token, method: 'POST', body: { name: 'Mine', filename: 'fund.htm', text: html } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.status, 'extracting');
  const id = result.data.id;
  await agreements.settled();
  const record = await call(`/agreements/${id}`, { token });
  assert.equal(record.data.status, 'compiled');
  assert.equal(record.data.export.documents.length, 1);
  assert.ok(record.data.export.equivalenceChecks > 0);
  assert.equal(record.data.export.verification, null);
  assert.equal(record.data.extraction.provider, 'demo');
  assert.deepEqual((await call('/agreements', { token })).data.map((record) => record.id), [id]);
  assert.equal((await call('/agreements', { token })).data[0].export, undefined);
  assert.deepEqual((await call('/agreements', { token: other })).data, []);
  assert.ok((await call(`/agreements/${id}/ast`, { token })).data.nodes.length > 10);
  assert.equal((await call(`/agreements/${id}/constraints`, { token })).data.identity.credential, 'document');
  assert.equal((await call(`/agreements/${id}/constraints`, { token, method: 'PUT', body: { identity: null } })).status, 200);
  assert.equal((await call(`/agreements/${id}/regenerate`, { token, method: 'POST' })).status, 202);
  await agreements.settled();
  assert.equal((await call(`/agreements/${id}/deploy`, { token, method: 'POST' })).status, 202);
  await agreements.settled();
  assert.equal((await call(`/agreements/${id}`, { token })).data.status, 'deployed');
  for (const foreign of [id, operator.id, 'agr_000000000000']) {
    for (const [method, suffix] of [['GET', ''], ['GET', '/ast'], ['GET', '/constraints'], ['PUT', '/constraints'], ['POST', '/regenerate'], ['POST', '/deploy']]) {
      const response = await call(`/agreements/${foreign}${suffix}`, { token: other, method, ...(method === 'PUT' ? { body: { identity: null } } : {}) });
      assert.equal(response.status, 404);
      assert.deepEqual(response.data, { error: { code: 'NOT_FOUND', message: 'Agreement not found' } });
    }
  }
  const sanitized = await call('/status', { token });
  assert.deepEqual(sanitized.data, { model: { provider: 'demo', mode: 'mock' }, compiler: { solidity: { core: '0.8.37+commit.123', 'uniswap-v4': '0.8.26' } }, chain: { chainId: 31337 } });
  assert.equal(passed.length, 0, 'all demo agreement requests terminate in the router');
  assert.equal((await call('/demo/logout', { token, method: 'POST' })).data.revoked, true);
  assert.equal((await call('/agreements', { token })).status, 401);
});

test('demo deny-by-default covers venues, identity, receipts, funding, settings and unknown methods', async (t) => {
  const { call, session, passed } = await http(t);
  const token = await session();
  for (const path of ['/stack/wallets', '/stack/funding', '/stack/facts', '/settings/keys', '/webhooks/payments', '/identity/attest', '/receipts', '/deposits', '/mints', '/redemptions', '/investor/session', '/agreements/agr_000000000000/stack/wallets', '/agreements/agr_000000000000/receipt', '/agreements/future-operation']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await call(path, { token, method });
      assert.ok([403, 404].includes(response.status), `${method} ${path}`);
      assert.equal(response.data.operatorOnly, undefined);
    }
  }
  assert.equal((await call('/agreements', { token, method: 'PATCH' })).status, 403);
  assert.equal(passed.length, 0);
  assert.equal((await call('/agreements', { token: 'demo_unknown' })).status, 401);
  assert.equal((await call('/agreements', { token: `demo_${'f'.repeat(64)}` })).status, 401);
  assert.equal(passed.length, 0);
});

test('non-demo credentials pass unchanged; operator maintenance remains intact and investors never become demo', async (t) => {
  const { call, passed, workspaces, agreements } = await http(t);
  assert.equal((await call('/agreements')).status, 401);
  assert.equal((await call('/agreements', { token: 'unknown' })).status, 401);
  for (const path of ['/demo/session', '/agreements']) {
    const response = await call(path, { method: 'POST', token: 'investor_parent_token' });
    assert.equal(response.status, 418);
    assert.equal(response.data.handledBy, 'parent-investor-auth');
  }
  assert.equal(Object.keys(workspaces.state.sessions).length, 0);
  const record = await call('/agreements', { token: 'operator-maintenance', method: 'POST', body: upload });
  assert.equal(record.status, 201);
  await agreements.settled();
  assert.equal((await call('/agreements', { token: 'operator-maintenance' })).data.length, 1);
  assert.ok(passed.includes('Bearer investor_parent_token'));
});

test('session issuance and authentication are IP/global limited, ignoring forged XFF even with trust proxy', async (t) => {
  const { call, workspaces } = await http(t, { sessionsPerIp: 2, requestsPerIp: 4 }, true);
  for (const ip of ['1.2.3.4', '5.6.7.8']) assert.equal((await call('/demo/session', { method: 'POST', headers: { 'X-Forwarded-For': ip } })).status, 201);
  assert.equal((await call('/demo/session', { method: 'POST', headers: { 'X-Forwarded-For': '9.8.7.6' } })).status, 429);
  assert.equal((await call('/agreements', { token: 'demo_invalid' })).status, 401);
  assert.equal((await call('/agreements', { token: 'demo_another', headers: { 'X-Forwarded-For': '3.3.3.3' } })).status, 429);
  assert.equal(Object.keys(workspaces.state.sessions).length, 2);
  assert.equal(workspaces.state.requests.length, 4);
  assert.ok(!JSON.stringify(workspaces.state).includes('1.2.3.4'));
  const global = (await service({ sessionsPerInterval: 2, requestsPerInterval: 2 })).workspaces;
  await global.session('ip1'); await global.session('ip2');
  await assert.rejects(global.session('ip3'), rejected(429));
  await global.admit('ip1'); await global.admit('ip2');
  await assert.rejects(global.admit('ip3'), rejected(429));
});

test('TTL, revocation and the bounded session table do not transfer ownership', async () => {
  let now = 1_000_000;
  const { agreements, workspaces } = await service({ maxSessions: 1, sessionTtlSeconds: 60, clock: () => now });
  const first = await workspaces.session('ip');
  const id = await created(workspaces, agreements, first.accessToken);
  await assert.rejects(workspaces.session('other-ip'), rejected(429));
  now += 60_000;
  await assert.rejects(workspaces.read(first.accessToken, 'get', id), rejected(401));
  const second = await workspaces.session('other-ip');
  assert.equal(Object.keys(workspaces.state.sessions).length, 1);
  assert.deepEqual(await workspaces.read(second.accessToken, 'list'), []);
  await assert.rejects(workspaces.read(second.accessToken, 'get', id), rejected(404));
  await workspaces.logout(second.accessToken);
  await assert.rejects(workspaces.read(second.accessToken, 'list'), rejected(401));
  assert.equal(Object.keys(workspaces.state.sessions).length, 0);
});

test('public config is a bounded allowlist; cashier UI config and both supported profiles compile', async () => {
  const { agreements, workspaces } = await service();
  const { accessToken: token } = await workspaces.session('ip');
  for (const config of [{ maxSupply: '1000000000001' }, { maxSupply: '-1' }, { maxSupply: 1.5 }, { maxSupply: '1e12' }, { maxSupply: '9'.repeat(500) }, { profile: 'wildcat-credit' }, { url: 'https://evil.invalid' }, { compiler: { url: 'https://evil.invalid' } }, { assumptions: ['https://evil.invalid'] }, { worldId: { credential: 'document', action: 'https://evil.invalid' } }, { cashier: { enabled: true, pool: { fee: 3000, tickSpacing: 60, url: 'https://evil.invalid' } } }]) {
    await assert.rejects(workspaces.create(token, { ...upload, config }), rejected(400, 'INVALID_BODY'));
  }
  await assert.rejects(workspaces.create(token, { ...upload, profile: 'wildcat-credit' }), rejected(400));
  await assert.rejects(workspaces.create(token, { ...upload, config: [] }), rejected(400));
  await assert.rejects(workspaces.create(token, { ...upload, documents: Array(5).fill(upload.documents[0]) }), rejected(400));
  assert.equal(agreements.list().length, 0);
  assert.equal(workspaces.state.uploads.length, 0, 'cheap shape checks run before reservations');
  const custody = await created(workspaces, agreements, token, { ...upload, profile: 'custodial-rwa', config: { maxSupply: 1000000 } });
  assert.equal(agreements.get(custody).export.profile, 'custodial-rwa');
  for (const identity of [{ credential: '__proto__' }, { actions: ['deposit'] }, { actions: Array(100).fill('mint') }, { clause: 'x'.repeat(4001) }, { url: 'https://evil.invalid' }]) await assert.rejects(workspaces.mutate(token, custody, 'constrain', { identity }), rejected(400));
  const cashierId = await created(workspaces, agreements, token, { ...upload, documents: [...upload.documents, { name: 'nav-cashier-addendum.md', text: addendum }], config: cashier });
  assert.equal(agreements.get(cashierId).export.config.cashier.enabled, true);
  assert.equal(agreements.get(cashierId).export.config.maxSupply, '1000000000000');
});

test('HTTP body limit and compiler document limit reject oversize uploads', async (t) => {
  const { call, session, agreements } = await http(t);
  const token = await session();
  assert.equal((await call('/agreements', { token, method: 'POST', body: { name: 'large', text: 'x'.repeat(4 * 1024 * 1024) } })).status, 413);
  const part = await call('/agreements', { token, method: 'POST', body: { name: 'large', text: 'x'.repeat(2_000_001) } });
  assert.equal(part.status, 400);
  assert.equal(part.data.error.code, 'INVALID_DOCUMENT');
  assert.equal(agreements.list().length, 0);
});

test('unsupported/new documents are UNAVAILABLE, consume attempted work quota and create no fake success', async () => {
  const { agreements, workspaces } = await service({ uploadsPerInterval: 1 });
  const one = await workspaces.session('ip1');
  await assert.rejects(workspaces.create(one.accessToken, { name: 'New', text: 'A previously unseen agreement.' }), rejected(503, 'UNAVAILABLE'));
  assert.equal(agreements.list().length, 0);
  assert.equal(workspaces.state.uploads.length, 1);
  const two = await workspaces.session('ip2');
  await assert.rejects(workspaces.create(two.accessToken, upload), rejected(429));
});

test('custom extractors cannot make paid calls through public demo routes', async () => {
  const custom = await service({ agreements: new Agreements({ extract: async () => { throw new Error('must not run'); } }) });
  const other = await custom.workspaces.session('ip');
  await assert.rejects(custom.workspaces.create(other.accessToken, upload), rejected(503, 'UNAVAILABLE'));
});

test('workspace and global uploads/jobs are reserved before concurrent work; a new token cannot evade global quotas', async () => {
  const { agreements, workspaces } = await service({ uploadsPerWorkspace: 1, uploadsPerInterval: 2, jobsPerInterval: 2 });
  const one = await workspaces.session('ip1');
  const two = await workspaces.session('ip2');
  const three = await workspaces.session('ip3');
  const results = await Promise.allSettled([workspaces.create(one.accessToken, upload), workspaces.create(one.accessToken, upload), workspaces.create(two.accessToken, upload), workspaces.create(three.accessToken, upload)]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled', 'rejected']);
  for (const result of results.filter((result) => result.status === 'rejected')) assert.equal(result.reason.status, 429);
  await agreements.settled();
  await assert.rejects(workspaces.mutate(one.accessToken, results[0].value.id, 'constrain', { identity: null }), rejected(429));
  assert.equal(workspaces.state.jobs.length, 2);
  assert.equal(agreements.list().length, 2);
});

test('durable hashed tokens/ownership and global gas reservations survive restart and ambiguous deployment failures', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'workspaces.json');
  const agreementPath = join(directory, 'agreements.json');
  let now = 1_000_000;
  let calls = 0;
  const deployer = async () => {
    calls++;
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(persisted.deploys.length, 1, 'gas reservation is on disk before invoking the deployer');
    throw new Error('RPC disconnected after broadcast: https://secret.invalid/private-key');
  };
  const agreements = new Agreements({ extract: extractDemo, path: agreementPath, deployer });
  const options = { path, chainId: 11155111, clock: () => now, deploysPerInterval: 1 };
  const first = (await service({ ...options, agreements })).workspaces;
  const { accessToken: token } = await first.session('ip1');
  const id = await created(first, agreements, token);
  await first.mutate(token, id, 'deploy');
  await agreements.settled();
  assert.equal(calls, 1);
  assert.equal(agreements.get(id).status, 'compiled');
  assert.doesNotMatch((await first.read(token, 'get', id)).error, /secret/);
  const raw = await readFile(path, 'utf8');
  assert.ok(!raw.includes(token) && !raw.includes(html) && !raw.includes('ip1'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reloadedAgreements = await new Agreements({ extract: extractDemo, path: agreementPath, deployer }).init();
  const second = (await service({ ...options, agreements: reloadedAgreements })).workspaces;
  assert.deepEqual((await second.read(token, 'list')).map((record) => record.id), [id]);
  await assert.rejects(second.mutate(token, id, 'deploy'), rejected(429));
  const fresh = await second.session('ip2');
  assert.deepEqual(await second.read(fresh.accessToken, 'list'), []);
  const another = await created(second, reloadedAgreements, fresh.accessToken);
  await assert.rejects(second.mutate(fresh.accessToken, another, 'deploy'), rejected(429));
  assert.equal(calls, 1);
  now += 3_600_000;
  await second.mutate(fresh.accessToken, another, 'deploy');
  await reloadedAgreements.settled();
  assert.equal(calls, 2);
  await second.logout(token);
  const third = (await service({ ...options, agreements: reloadedAgreements })).workspaces;
  await assert.rejects(third.read(token, 'get', id), rejected(401));
});

test('corrupt or unwritable durable state fails closed before new work, and interval changes cannot reset budgets', async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'workspaces.json');
  const { agreements, workspaces } = await service({ path });
  const { accessToken: token } = await workspaces.session('ip');
  await assert.rejects(service({ agreements, path, intervalSeconds: 60 }), rejected(503, 'UNAVAILABLE'));
  await writeFile(path, 'not json');
  await assert.rejects(service({ agreements, path }), rejected(503, 'UNAVAILABLE'));
  workspaces.path = join(directory, 'not-a-file');
  await mkdir(workspaces.path); // rename over a directory fails; no agreement may be created afterward.
  await assert.rejects(workspaces.create(token, upload), rejected(503, 'UNAVAILABLE'));
  assert.equal(agreements.list().length, 0);
  await assert.rejects(workspaces.read(token, 'list'), rejected(503, 'UNAVAILABLE'));
});

test('traffic queues are bounded without creating an unbounded per-IP map', async () => {
  const { workspaces } = await service({ maxPendingRequests: 1 });
  const admitted = workspaces.admit('one');
  await assert.rejects(workspaces.admit('two'), rejected(429, 'DEMO_LIMIT'));
  await admitted;
  assert.equal(workspaces.pending, 0);
  assert.equal(workspaces.state.requests.length, 1);
});

test('IP/session budgets persist, rolling windows expire, and a clock rollback cannot revive a token', async (t) => {
  let now = 1_000_000;
  const path = join(await temporary(t), 'workspaces.json');
  const options = { path, sessionsPerIp: 1, requestsPerIp: 1, intervalSeconds: 60, sessionTtlSeconds: 120, clock: () => now };
  const { workspaces: first } = await service(options);
  const session = await first.session('ip');
  await first.admit('ip');
  const { workspaces: second } = await service(options);
  await assert.rejects(second.session('ip'), rejected(429));
  await assert.rejects(second.admit('ip'), rejected(429));
  now += 60_000;
  await second.admit('ip');
  await second.session('ip');
  now += 120_000;
  await second.admit('ip'); // durably records the time high-water mark and prunes expired ownership.
  now -= 180_000;
  const { workspaces: third } = await service(options);
  await assert.rejects(third.read(session.accessToken, 'list'), rejected(401));
  assert.equal(Object.keys(third.state.sessions).length, 0);
});

test('Agreements serializes operator and demo deployer calls and preserves jobs/settled after a failure', async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const secondEntered = deferred();
  const releaseSecond = deferred();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const agreements = new Agreements({ extract: extractDemo, deployer: async () => {
    const call = ++calls;
    active++;
    maximum = Math.max(maximum, active);
    try {
      if (call === 1) { firstEntered.resolve(); await releaseFirst.promise; throw new Error('ambiguous operator deployment'); }
      secondEntered.resolve(); await releaseSecond.promise;
      return { chainId: 31337, token: '0xqueued' };
    } finally { active--; }
  } });
  const { workspaces } = await service({ agreements });
  const { accessToken: token } = await workspaces.session('ip');
  const id = await created(workspaces, agreements, token);
  const operator = await agreements.create({ ...upload, name: 'Operator deployment' });
  await agreements.settled();
  agreements.deploy(operator.id);
  await firstEntered.promise;
  const queued = await workspaces.mutate(token, id, 'deploy');
  assert.equal(queued.status, 'deploying');
  assert.equal(agreements.jobs.size, 2);
  assert.equal(calls, 1);
  let settled = false;
  const jobs = agreements.settled().then(() => { settled = true; });
  releaseFirst.resolve();
  await secondEntered.promise;
  assert.equal(settled, false);
  assert.equal(agreements.get(operator.id).status, 'compiled');
  releaseSecond.resolve();
  await jobs;
  assert.equal(maximum, 1);
  assert.equal(agreements.jobs.size, 0);
  assert.equal(agreements.get(id).status, 'deployed');
});

test('a failed persist closes public work until the disk takes writes again; a stale temporary file does not block the boot', async (t) => {
  const { chmod } = await import('node:fs/promises');
  const directory = await temporary(t);
  const path = join(directory, 'state', 'demo.json');
  await mkdir(join(directory, 'state'));
  await writeFile(`${path}.tmp`, 'left by a crash');
  const { workspaces } = await service({ path });
  await assert.rejects(stat(`${path}.tmp`), /ENOENT/, 'the stale temporary file is removed at boot');
  await workspaces.admit('1.1.1.1');
  assert.equal(workspaces.broken, false);

  await chmod(join(directory, 'state'), 0o500);
  t.after(() => chmod(join(directory, 'state'), 0o700).catch(() => {}));
  await assert.rejects(workspaces.admit('1.1.1.1'), rejected(503, 'UNAVAILABLE'));
  assert.equal(workspaces.broken, true);
  await assert.rejects(workspaces.admit('1.1.1.1'), rejected(503, 'UNAVAILABLE'), 'still closed while the disk refuses');

  await chmod(join(directory, 'state'), 0o700);
  await workspaces.admit('1.1.1.1');
  assert.equal(workspaces.broken, false, 'healed once a persist succeeds');
  // The attempt made while the disk refused stays counted: quotas err on the side of less work.
  assert.equal(JSON.parse(await readFile(path, 'utf8')).requests.length, 3);
});

test('a public upload may ask for a Noolog deliberation, only when the gateway holds a Noolog key', async () => {
  const { workspaces } = await service();
  const body = { ...upload, generation: 'noolog' };
  const saved = process.env.NOOLOG_API_KEY;
  try {
    delete process.env.NOOLOG_API_KEY;
    assert.throws(() => workspaces.prepare(body), rejected(503, 'UNAVAILABLE'));
    process.env.NOOLOG_API_KEY = 'test-only-never-send';
    assert.equal(workspaces.prepare(body).generation, 'noolog');
    assert.equal(workspaces.prepare(upload).generation, 'demo', 'the bundled reading stays the default');
    assert.throws(() => workspaces.prepare({ ...upload, generation: 'openai' }), rejected(400, 'INVALID_BODY'));
  } finally {
    if (saved === undefined) delete process.env.NOOLOG_API_KEY; else process.env.NOOLOG_API_KEY = saved;
  }
});

test('EXTRACTOR=noolog with a key makes Noolog the hosted demo\'s default reader and the status says so', async () => {
  const { workspaces } = await service();
  const { noologDefault, noologStatus } = await import('../src/openai-extract.js');
  const saved = { EXTRACTOR: process.env.EXTRACTOR, NOOLOG_API_KEY: process.env.NOOLOG_API_KEY };
  try {
    process.env.EXTRACTOR = 'noolog';
    delete process.env.NOOLOG_API_KEY;
    assert.equal(noologDefault(), false, 'no key, no default');
    assert.equal(workspaces.prepare(upload).generation, 'demo');
    process.env.NOOLOG_API_KEY = 'test-only-never-send';
    assert.equal(noologDefault(), true);
    assert.equal(workspaces.prepare(upload).generation, 'noolog');
    assert.equal(workspaces.prepare({ ...upload, generation: 'demo' }).generation, 'demo', 'an explicit choice still wins');
    assert.deepEqual(noologStatus(), { provider: 'noolog', mode: 'live', model: process.env.NOOLOG_MODEL || 'nsed:legal_rwa_pro' });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
