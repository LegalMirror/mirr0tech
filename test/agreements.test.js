import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agreements, astGraph, draftFor, STATES } from '../src/agreements.js';
import { documentFrom, readDocument } from '../src/policy/document.js';
import { PROFILES } from '../scripts/export-ui.js';

delete process.env.NOOLOG_API_KEY;
const FUND = 'test/human_contracts/ea026411904ex10-9.htm';
const fund = { name: 'BUIDL fund agreement', documents: [{ name: 'ea026411904ex10-9.htm', text: await readFile(FUND, 'utf8') }] };
const upload = async (agreements, body = fund) => {
  const created = await agreements.create(body);
  await agreements.settled();
  return agreements.get(created.id);
};

test('an uploaded document is the same document the compiler reads from disk', async () => {
  const fromDisk = await readDocument(FUND);
  const fromUpload = documentFrom('anything/ea026411904ex10-9.htm', fund.documents[0].text);
  assert.equal(fromUpload.textSha256, fromDisk.textSha256);
  assert.equal(fromUpload.name, fromDisk.name);
  assert.throws(() => documentFrom('x.pdf', 'text'), /text, Markdown, or HTML/);
  assert.throws(() => documentFrom('x.md', '  '), /empty/);
});

test('upload → extracting → verified → compiled, with the record telling the story', async () => {
  const agreements = new Agreements();
  const created = await agreements.create(fund);
  assert.equal(created.status, 'extracting');
  assert.equal(created.documents, undefined, 'the summary does not carry the document bytes');
  assert.match(created.id, /^agr_[0-9a-f]{12}$/);
  await agreements.settled();
  const record = agreements.get(created.id);
  assert.equal(record.status, 'compiled', record.error ?? '');
  assert.deepEqual(record.history.map((entry) => entry.status), ['uploaded', 'extracting', 'verified', 'compiled']);
  assert.match(record.policyHash, /^0x[0-9a-f]{64}$/);
  assert.equal(record.extraction.provider, 'noolog');
  assert.ok(record.verification.confidence.overall > 0 && record.verification.confidence.total > 0);
  assert.equal(record.coverage.total, 194);
  assert.ok(record.export.rules.some((rule) => rule.id === 'transfer-identity-verified'));
  assert.equal(record.export.documents.length, 1);
  assert.equal(agreements.list().length, 1);
  assert.equal(agreements.list()[0].export, undefined);
  assert.ok(STATES.includes(record.status));
});

test('the tree: agreement → actions → rules → facts, each rule carrying its verdict', async () => {
  const agreements = new Agreements();
  const record = await upload(agreements);
  const graph = agreements.ast(record.id);
  const kinds = new Set(graph.nodes.map((node) => node.kind));
  assert.deepEqual([...kinds].sort(), ['action', 'agreement', 'fact', 'rule', 'unresolved']);
  assert.ok(graph.edges.some((edge) => edge.from === 'action:transfer' && edge.to === 'rule:transfer-identity-verified'));
  assert.ok(graph.edges.some((edge) => edge.from === 'rule:transfer-identity-verified' && edge.to === 'fact:identityVerified'));
  const rule = graph.nodes.find((node) => node.id === 'rule:transfer-identity-verified');
  assert.ok(['verified', 'contested'].includes(rule.status));
  assert.equal(typeof rule.confidence, 'number');
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length, 'no duplicate nodes');
  const bare = astGraph({ title: 't', rules: [], terms: [{ name: 'capPosition', value: '1', source: { clause: '3' } }], unresolved: [] });
  assert.equal(bare.nodes.find((node) => node.kind === 'term').status, 'unverified');
});

test('a document the demo readings do not fit needs the model, and says so', async () => {
  const agreements = new Agreements();
  const record = await upload(agreements, { name: 'Other', documents: [{ name: 'other.md', text: 'A short agreement nobody has read before.' }] });
  assert.equal(record.status, 'failed');
  assert.match(record.error, /NOOLOG_API_KEY/);
  assert.equal(draftFor(PROFILES[1], documentFrom('other.md', 'nothing quoted here')), null);
  assert.throws(() => agreements.ast(record.id), (error) => error.status === 409);
  assert.throws(() => agreements.get('agr_nope'), (error) => error.status === 404);
  await assert.rejects(agreements.create({ name: 'x', documents: fund.documents, profile: 'nope' }), (error) => error.status === 400);
});

test('regenerate runs a new deliberation and keeps the earlier policy hash in the history', async () => {
  const agreements = new Agreements();
  const record = await upload(agreements);
  const again = agreements.regenerate(record.id);
  assert.equal(again.status, 'extracting');
  assert.throws(() => agreements.regenerate(record.id), (error) => error.status === 409, 'not while a job is in flight');
  await agreements.settled();
  const after = agreements.get(record.id);
  assert.equal(after.status, 'compiled');
  assert.equal(after.history.filter((entry) => entry.status === 'compiled').length, 2);
  assert.equal(after.history.find((entry) => entry.status === 'compiled').policyHash, record.policyHash);
});

test('deploy hands the generated Solidity to the chain and records what came back', async () => {
  const calls = [];
  const agreements = new Agreements({ deployer: async (input) => { calls.push(input); return { chainId: 31337, token: '0xtoken', policyHash: input.policyHash }; } });
  const record = await upload(agreements);
  assert.throws(() => agreements.deploy('agr_nope'), (error) => error.status === 404);
  const deploying = agreements.deploy(record.id);
  assert.equal(deploying.status, 'deploying');
  assert.throws(() => agreements.deploy(record.id), (error) => error.status === 409);
  await agreements.settled();
  const deployed = agreements.get(record.id);
  assert.equal(deployed.status, 'deployed');
  assert.equal(deployed.deployment.token, '0xtoken');
  assert.equal(calls[0].policyHash, record.policyHash);
  assert.match(calls[0].sources.token, new RegExp(record.policyHash));
  assert.match(calls[0].sources.compiledPolicy, /library CompiledPolicy/);

  const failing = new Agreements({ deployer: async () => { throw new Error('out of gas'); } });
  const other = await upload(failing);
  failing.deploy(other.id);
  await failing.settled();
  assert.equal(failing.get(other.id).status, 'compiled');
  assert.match(failing.get(other.id).error, /out of gas/);
  assert.throws(() => new Agreements().deploy(other.id), (error) => error.status === 404);
  const unsigned = new Agreements();
  const third = await upload(unsigned);
  assert.throws(() => unsigned.deploy(third.id), (error) => error.status === 503);
});

test('records survive a restart; an interrupted job is reported, not resumed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agreements-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'agreements.json');
  const first = new Agreements({ path });
  const record = await upload(first);
  const created = await first.create(fund);
  assert.equal(created.status, 'extracting');
  await first.persist();
  await first.settled();

  const second = await new Agreements({ path }).init();
  assert.equal(second.list().length, 2);
  const reloaded = second.get(record.id);
  assert.equal(reloaded.status, 'compiled');
  assert.equal(reloaded.export.policyHash, record.policyHash, 'the export is recomputed from the record');
  assert.equal(second.ast(record.id).nodes.length, first.ast(record.id).nodes.length);

  const stale = JSON.parse(await readFile(path, 'utf8')).map((entry) => ({ ...entry, status: 'extracting' }));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path, JSON.stringify(stale)));
  const third = await new Agreements({ path }).init();
  assert.ok(third.list().every((entry) => entry.status === 'failed' && /Interrupted/.test(entry.error)));
});
