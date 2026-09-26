import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { NoologClient, NoologError } from '../src/noolog/client.js';
import { createMockNoolog, claimsOf } from '../src/noolog/mock.js';
import { verificationFrom, VERDICT_WEIGHT } from '../src/noolog/verify.js';
import { extractWithNoolog, chatRequest } from '../src/noolog/extract.js';
import { deliberationRequest } from './noolog-request.js';
import { document, envelope } from './helpers.js';
import { readDocuments } from '../src/policy/document.js';
import { mlaFixture } from '../src/policy/mla-fixture.js';

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
    const chat = await client.chatCompletion(chatRequest({ profile: 'custodial-rwa', document, draft: envelope.ast }));
    assert.equal(chat.completion.object, 'chat.completion');
    assert.match(chat.jobId, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.parse(chat.completion.choices[0].message.content).rules.length, envelope.ast.rules.length);
    const noDraft = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(noDraft.status, 422, 'the mock needs a draft to deliberate over');
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
  const { envelope: generated, verification: report } = await extractWithNoolog({ profile: 'custodial-rwa', document, draft: forged.ast });
  assert.equal(report.mock, true);
  assert.ok(report.confidence.overall > 0 && report.confidence.overall < 1);
  assert.equal(generated.ast.rules.length, forged.ast.rules.length - 1, 'the winner dropped the forged rule');
  assert.equal(generated.extraction.provider, 'noolog');
  assert.equal(generated.extraction.responseId, report.jobId);
  assert.ok(!report.claims.some((c) => c.ref === `rule:${forged.ast.rules[0].id}`), 'the winner carries no claim about the dropped rule');
});

test('the verification report scores every rule, term and open item from the winner\'s verdicts', async () => {
  const { verification: report } = await extractWithNoolog({ profile: 'custodial-rwa', document, draft: envelope.ast });
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

test('the critic contests quotes that repeat in the agreement or are too short to anchor a clause', async () => {
  const bundle = await readDocuments(['test/human_contracts/wildcat-mla.md', 'test/human_contracts/lender-check-policy.md', 'test/human_contracts/buyback-addendum.md']);
  const credit = mlaFixture(bundle);
  const { envelope: generated, verification: report } = await extractWithNoolog({ profile: 'wildcat-credit', document: bundle, draft: credit.ast });
  assert.equal(generated.ast.rules.length, credit.ast.rules.length, 'contested claims stay; only wrong ones drop');
  assert.ok(report.confidence.counts.contested >= 2, 'the MLA repeats itself: at least two quotes are ambiguous');
  assert.equal(report.confidence.counts.wrong, 0);
  assert.ok(report.contested.every((item) => item.evaluator === 'critic' && item.position && ['medium', 'high'].includes(item.confidence)));
  const ambiguous = report.contested.find((item) => item.ref === 'rule:deposit-not-insolvent');
  assert.ok(ambiguous, 'the not-insolvent quote appears twice');
  assert.match(ambiguous.position, /occur elsewhere/);
  assert.equal(report.confidence.byRef['rule:deposit-not-insolvent'], (0.25 + 1) / 2, 'one contested claim and one verified claim about the rule');
  assert.ok(report.confidence.overall < 1 && report.confidence.overall > 0.8);
});

test('a request names a fresh room each run, seats only the generic model, and an empty budget reads plainly', async () => {
  const { chatRequest, extractWithNoolog } = await import('../src/noolog/extract.js');
  const { NoologError } = await import('../src/noolog/client.js');
  const a = chatRequest({ profile: 'rwa-secondary', document, model: 'nsed:deep' });
  const b = chatRequest({ profile: 'rwa-secondary', document, model: 'nsed:deep' });
  assert.notEqual(a.nsed.room_id, b.nsed.room_id, 'a repeated room id collides on the orchestrator');
  assert.match(a.nsed.room_id, /^mirr0tech-rwa-secondary-[0-9a-f]{8}-/);
  assert.deepEqual(a.nsed.agent_names, ['extractor', 'critic']);
  const policy = chatRequest({ profile: 'rwa-secondary', document, model: 'nsed:legal_rwa_pro' });
  assert.equal(policy.model, 'nsed:legal_rwa_pro');
  assert.equal(policy.nsed.agent_names, undefined, 'the policy brings its own seats');
  assert.equal(policy.nsed.deliberation_rounds, 2);
  const broke = { chatCompletion: async () => { throw new NoologError(429, 'POST /v1/chat/completions: 429 {"error":{"message":"Insufficient budget: 0.00 remaining, 50.00 estimated","type":"insufficient_quota"}}'); } };
  await assert.rejects(extractWithNoolog({ profile: 'rwa-secondary', document, client: broke }), /out of credits \(429\)/);
  const down = { chatCompletion: async () => { throw new NoologError(500, 'boom'); } };
  await assert.rejects(extractWithNoolog({ profile: 'rwa-secondary', document, client: down }), /boom/);
});

test('the models the token may name are listed, the mock included', async () => {
  const server = createMockNoolog({ apiKey: 'secret' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new NoologClient({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'secret' });
    assert.deepEqual(await client.models(), ['nsed:deep', 'nsed:legal_rwa_pro']);
  } finally { server.close(); }
});
