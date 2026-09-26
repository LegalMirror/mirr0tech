import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HumanRegistry, WorldIdError } from '../src/worldid.js';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const canonical = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const code = (expected) => (error) => error instanceof WorldIdError && error.code === expected;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mirr0tech-worldid-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'humans.json') };
}

test('registry persists canonical bindings across restarts and rejects second wallets', async (t) => {
  const { path, dir } = await fixture(t);
  const registry = await new HumanRegistry(path).load();
  await registry.bind('0xAB', A);
  await registry.bind(canonical(171), A.toUpperCase().replace('0X', '0x'));
  await assert.rejects(registry.bind('0x00ab', B), (error) => error.code === 'HUMAN_ALREADY_BOUND' && error.status === 409);
  const reloaded = await new HumanRegistry(path).load();
  assert.equal(reloaded.walletOf('0xab'), A);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { [canonical(171)]: A });
  assert.deepEqual(await readdir(dir), ['humans.json'], 'no temporary snapshots or locks left behind');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('malformed or structurally corrupt persistence never becomes an empty registry', async (t) => {
  const { path } = await fixture(t);
  for (const contents of ['', '{', 'null', '[]', '"text"', '{"0xab":null}', '{"0xab":"Investor"}', JSON.stringify({ notHex: A }), JSON.stringify({ ['0x' + 'a'.repeat(65)]: A }), JSON.stringify({ '0xab': A, '0x00AB': B })]) {
    await writeFile(path, contents);
    const registry = new HumanRegistry(path);
    await assert.rejects(registry.load(), code('REGISTRY_UNAVAILABLE'));
    await assert.rejects(registry.bind('0xcd', B), code('REGISTRY_UNAVAILABLE'));
    assert.equal(await readFile(path, 'utf8'), contents, 'never overwrite corrupt evidence');
    assert.throws(() => registry.walletOf('0xab'), code('REGISTRY_UNAVAILABLE'));
  }
});

test('invalid binding inputs are rejected without changing persistence', async (t) => {
  const { path } = await fixture(t);
  const registry = await new HumanRegistry(path).load();
  await registry.bind('0xab', A);
  const before = await readFile(path, 'utf8');
  for (const nullifier of [undefined, null, {}, '', '0x', '123', '0xzz', '0x' + '1'.repeat(65)]) {
    await assert.rejects(registry.bind(nullifier, B), code('INVALID_PROOF'));
  }
  for (const wallet of [null, {}, 'Investor', '0x1', '']) {
    await assert.rejects(registry.bind('0xcd', wallet), code('INVALID_PROOF'));
  }
  assert.equal(await readFile(path, 'utf8'), before);
});

test('concurrent binds across registry instances serialize without losing updates', async (t) => {
  const { path, dir } = await fixture(t);
  const one = await new HumanRegistry(path).load();
  const two = await new HumanRegistry(path).load();
  await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? one : two).bind(canonical(i + 1), i % 2 ? A : B)));
  const restarted = await new HumanRegistry(path).load();
  for (let i = 0; i < 24; i++) assert.equal(restarted.walletOf(canonical(i + 1)), i % 2 ? A : B);
  assert.equal(Object.keys(JSON.parse(await readFile(path, 'utf8'))).length, 24);
  assert.deepEqual(await readdir(dir), ['humans.json']);
});

test('concurrent conflicting binds have exactly one winner and leave the queue usable', async (t) => {
  const { path } = await fixture(t);
  const one = await new HumanRegistry(path).load();
  const two = await new HumanRegistry(path).load();
  const results = await Promise.allSettled([one.bind('0xab', A), two.bind('0x00AB', B)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'HUMAN_ALREADY_BOUND');
  await two.bind('0xcd', B);
  const restarted = await new HumanRegistry(path).load();
  assert.equal(restarted.walletOf('0xab'), A);
  assert.equal(restarted.walletOf('0xcd'), B);
});

test('a stale or foreign-process lock fails closed, never steals the lock or overwrites data', async (t) => {
  const { path } = await fixture(t);
  const registry = await new HumanRegistry(path).load();
  await registry.bind('0xab', A);
  const before = await readFile(path, 'utf8');
  await writeFile(`${path}.lock`, 'another writer');
  await assert.rejects(registry.bind('0xcd', B), code('REGISTRY_BUSY'));
  await assert.rejects(new HumanRegistry(path).load(), code('REGISTRY_BUSY'));
  assert.equal(await readFile(`${path}.lock`, 'utf8'), 'another writer');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(registry.walletOf('0xcd'), null);
  await rm(`${path}.lock`);
  await registry.bind('0xcd', B);
});

test('corruption, removal or rollback after loading cannot forget an observed binding', async (t) => {
  const { path } = await fixture(t);
  const registry = await new HumanRegistry(path).load();
  await registry.bind('0xab', A);
  const before = await readFile(path, 'utf8');
  for (const contents of ['{', '{}', JSON.stringify({ [canonical(171)]: B }), null]) {
    if (contents === null) await rm(path); else await writeFile(path, contents);
    await assert.rejects(registry.bind('0xcd', B), code('REGISTRY_UNAVAILABLE'));
    assert.equal(registry.walletOf('0xcd'), null, 'no speculative binding in memory');
    await writeFile(path, before);
  }
  await registry.bind('0xcd', B);
  assert.equal((await new HumanRegistry(path).load()).walletOf('0xcd'), B);
});

test('filesystem read/write errors are surfaced and do not publish bindings', async (t) => {
  const { dir } = await fixture(t);
  const directoryInsteadOfFile = join(dir, 'not-a-file');
  await mkdir(directoryInsteadOfFile);
  await assert.rejects(new HumanRegistry(directoryInsteadOfFile).load(), code('REGISTRY_UNAVAILABLE'));
  const parentIsFile = join(dir, 'parent');
  await writeFile(parentIsFile, 'not a directory');
  const registry = new HumanRegistry(join(parentIsFile, 'humans.json'));
  await assert.rejects(registry.bind('0xab', A), code('REGISTRY_UNAVAILABLE'));
  assert.equal(Object.keys(registry.byNullifier).length, 0);
});

test('in-memory local registry is deterministic, but not persistent', async () => {
  const registry = await new HumanRegistry().load();
  const results = await Promise.allSettled([registry.bind('0xab', A), registry.bind('0x00AB', B)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'HUMAN_ALREADY_BOUND');
  assert.equal(registry.walletOf('0xab'), A);
  assert.equal((await new HumanRegistry().load()).walletOf('0xab'), null);
});
