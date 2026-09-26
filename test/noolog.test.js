import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { NoologClient, NoologError } from '../src/noolog/client.js';
import { createMockNoolog, claimsOf } from '../src/noolog/mock.js';
import { verificationFrom, VERDICT_WEIGHT } from '../src/noolog/verify.js';
import { deliberateExtraction, deliberationRequest } from '../src/noolog/deliberate.js';
import { document, envelope } from './helpers.js';

test('the client sends the bearer token and surfaces the orchestrator status codes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 409, text: async () => 'job already running' }; };
  const client = new NoologClient({ url: 'https://noolog.test/', apiKey: 'k', fetchImpl });
  await assert.rejects(client.startDeliberation({ room_id: 'r' }), (error) => error instanceof NoologError && error.status === 409);
  assert.equal(calls[0].url, 'https://noolog.test/deliberation');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.throws(() => new NoologClient({ apiKey: undefined, url: 'x' }), /NOOLOG_API_KEY/);
});

test('the mock deliberates a candidate extraction end to end over HTTP with the documented routes', async () => {
  const server = createMockNoolog({ apiKey: 'secret' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const anon = await fetch(`${url}/deliberation`, { method: 'POST' });
    assert.equal(anon.status, 401);
    const client = new NoologClient({ url, apiKey: 'secret' });
    await assert.rejects(client.startDeliberation({ room_id: 'r', agent_names: ['one'] }), (e) => e.status === 400, 'fewer than two agents');
    const request = deliberationRequest({ profile: 'custodial-rwa', envelope, document });
    const { job_id: jobId } = await client.startDeliberation(request);
    assert.match(jobId, /^[0-9a-f-]{36}$/);
    await assert.rejects(client.startDeliberation(request), (e) => e.status === 409, 'the room is busy until the job completes');
    const first = await client.status(jobId);
    assert.equal(first.status, 'pending');
    const done = await client.waitForResult(jobId, { pollMs: 1 });
    assert.equal(done.status, 'completed');
    assert.equal(JSON.parse(done.result).rules.length, envelope.ast.rules.length, 'every quote verifies, so nothing is dropped');
    const details = await client.details(jobId);
    assert.deepEqual([...new Set(details.history.map((h) => h.author_agent_id))], ['extractor', 'critic']);
    assert.equal(details.history[0].evaluations[0].evaluator_agent_id, 'critic');
    assert.ok(details.history[0].evaluations[0].evaluation.claim_assessments.every((c) => ['verified', 'contested', 'unverified', 'wrong'].includes(c.verdict)));
    assert.equal(details.rounds.length, 2);
    const references = await client.references(jobId);
    assert.deepEqual(references.winner, { round: 2, author_agent_id: 'extractor' });
    assert.ok(references.edges.length > 0, 'claims carried from round 1 to round 2 form edges');
    assert.ok(references.edges.every((e) => e.from.round === 1 && e.to.round === 2));
    assert.equal((await fetch(`${url}/deliberation/nope/result`, { headers: { Authorization: 'Bearer secret' } })).status, 404);
  } finally { server.close(); }
});

test('claims are checked against the document: a fabricated quote is wrong and drops out of the refined extraction', async () => {
  const forged = structuredClone(envelope);
  forged.ast.rules[0].source.quote = 'a sentence that is not in the agreement';
  const claims = claimsOf(forged.ast, document.text);
  assert.equal(claims.find((c) => c.key === `rule:${forged.ast.rules[0].id}:quote`).verdict, 'wrong');
  assert.ok(claims.some((c) => c.verdict === 'unverified'), 'open items are unverified, never verified');
  const report = await deliberateExtraction({ profile: 'custodial-rwa', envelope: forged, document });
  assert.equal(report.mock, true);
  assert.ok(report.confidence.overall > 0 && report.confidence.overall < 1);
  assert.equal(JSON.parse(report.finalResult).rules.length, forged.ast.rules.length - 1, 'the winner dropped the forged rule');
  assert.ok(!report.claims.some((c) => c.ref === `rule:${forged.ast.rules[0].id}`), 'the winner carries no claim about the dropped rule');
});

test('the verification report scores every rule, term and open item from the winner\'s verdicts', async () => {
  const report = await deliberateExtraction({ profile: 'custodial-rwa', envelope, document });
  assert.equal(report.provider, 'noolog');
  assert.deepEqual(report.agents, ['extractor', 'critic']);
  assert.equal(report.rounds, 2);
  assert.equal(report.winner.agent, 'extractor');
  for (const rule of envelope.ast.rules) assert.equal(report.confidence.byRef[`rule:${rule.id}`], 1, `${rule.id} verifies`);
  for (const entry of envelope.ast.unresolved) assert.equal(report.confidence.byRef[`unresolved:${entry.clause}`], VERDICT_WEIGHT.unverified);
  assert.equal(report.confidence.total, report.claims.length);
  assert.ok(report.confidence.overall <= 1 && report.confidence.overall >= 0.5);
  const empty = verificationFrom({ jobId: 'x', details: { history: [], rounds: [] }, references: { rounds: [], edges: [], hunk_edges: [], winner: null } });
  assert.equal(empty.winner, null);
  assert.equal(empty.confidence.overall, 0);
});
