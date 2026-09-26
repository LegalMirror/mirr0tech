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
  const seats = { policyFor: async () => ({ policy_id: 'b245' }) };
  const broke = { ...seats, startDeliberation: async () => { throw new NoologError(429, 'POST /deliberation: 429 {"error":"Insufficient budget","credits_remaining":0.0,"estimated_cost":50.0}'); } };
  await assert.rejects(extractWithNoolog({ profile: 'rwa-secondary', document, client: broke }), /out of credits \(429\)/);
  const down = { ...seats, startDeliberation: async () => { throw new NoologError(500, 'boom'); } };
  await assert.rejects(extractWithNoolog({ profile: 'rwa-secondary', document, client: down }), /boom/);
});

test('the native submit carries the instructions in the user turn, the draft as the assistant turn, and the policy seats', async () => {
  const { deliberationRequest, extractWithNoolog, extractorMode, MODES } = await import('../src/noolog/extract.js');
  const request = deliberationRequest({ profile: 'rwa-secondary', document, draft: envelope.ast, policyId: 'b245' });
  assert.equal(request.policy_id, 'b245');
  assert.equal(request.agent_names, undefined);
  assert.equal(request.deliberation_rounds, 2);
  assert.match(request.messages[0].content, /^Read the agreement[\s\S]*AGREEMENT:/);
  assert.ok(request.messages[0].content.endsWith(document.text));
  assert.equal(request.messages[1].role, 'assistant');
  const generic = deliberationRequest({ profile: 'rwa-secondary', document });
  assert.deepEqual(generic.agent_names, ['extractor', 'critic']);
  assert.equal(generic.messages.length, 1);

  // Live, the draft stays home: a fake orchestrator sees the document alone under the policy.
  const seats = { policyFor: async () => ({ policy_id: 'b245' }) };
  const sent = [];
  const live = { ...seats, startDeliberation: async (body) => { sent.push(body); throw new NoologError(500, 'stop here'); } };
  await assert.rejects(extractWithNoolog({ profile: 'rwa-secondary', document, draft: envelope.ast, client: live, live: true }), /stop here/);
  assert.equal(sent[0].policy_id, 'b245');
  assert.equal(sent[0].messages.length, 1, 'no assistant turn for the legal seats');

  // Progress: the mock walks pending → running → completed and the caller sees every step.
  const seen = [];
  const { envelope: out, verification } = await extractWithNoolog({ profile: 'rwa-secondary', document, draft: envelope.ast, onProgress: (state) => seen.push(state.status) });
  assert.deepEqual(seen, ['pending', 'running', 'completed']);
  assert.equal(out.extraction.provider, 'noolog');
  assert.equal(out.ast.rules.length, envelope.ast.rules.length);
  assert.ok(verification.mock);

  assert.deepEqual(MODES, ['mock', 'noolog', 'openai']);
  assert.equal(extractorMode({}), 'mock');
  assert.equal(extractorMode({ NOOLOG_API_KEY: 'k' }), 'noolog');
  assert.equal(extractorMode({ OPENAI_API_KEY: 'k' }), 'openai');
  assert.equal(extractorMode({ NOOLOG_API_KEY: 'k', EXTRACTOR: 'mock' }), 'mock', 'the switch wins over the keys');
  assert.throws(() => extractorMode({ EXTRACTOR: 'llama' }), /EXTRACTOR must be one of/);
});

test('the OpenAI-compatible bypass returns the AST with no verdicts, on any base URL', async () => {
  const { extractWithOpenAI, extractAgreement } = await import('../src/noolog/extract.js');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok: true, json: async () => ({ id: 'chatcmpl-1', model: 'astra-legal', choices: [{ message: { content: JSON.stringify(envelope.ast) } }] }) };
  };
  const env = { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'astra-legal', OPENAI_BASE_URL: 'https://astra.example/v1/' };
  const { envelope: out, verification } = await extractWithOpenAI({ document, draft: envelope.ast, fetchImpl, env });
  assert.equal(verification, null, 'one model call, nobody checked it');
  assert.deepEqual(out.extraction, { provider: 'openai', model: 'astra-legal', responseId: 'chatcmpl-1', baseUrl: 'https://astra.example/v1/', demoted: [], unanchored: [] });
  assert.equal(out.ast.rules.length, envelope.ast.rules.length);
  assert.equal(calls[0].url, 'https://astra.example/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.equal(calls[0].body.messages.length, 4, 'system, document, draft, ask');
  await assert.rejects(extractWithOpenAI({ document, fetchImpl, env: {} }), /OPENAI_API_KEY/);
  await assert.rejects(extractWithOpenAI({ document, env, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'nope' }) }), /HTTP 401/);
  await assert.rejects(extractWithOpenAI({ document, env, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"rules":[]}' } }] }) }) }), /Invalid policy AST/);

  const previous = { ...process.env };
  Object.assign(process.env, { EXTRACTOR: 'openai', OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'astra-legal', OPENAI_BASE_URL: 'https://astra.example/v1' });
  try {
    const routed = await extractAgreement({ profile: 'rwa-secondary', document, fetchImpl });
    assert.equal(routed.envelope.extraction.provider, 'openai');
  } finally {
    for (const key of ['EXTRACTOR', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test('the models the token may name are listed, the mock included', async () => {
  const server = createMockNoolog({ apiKey: 'secret' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new NoologClient({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'secret' });
    assert.deepEqual(await client.models(), ['nsed:deep', 'nsed:legal_rwa_pro']);
  } finally { server.close(); }
});

test('the report reads the orchestrator\'s own tree: winner from final_result, claims from the winner\'s round, scores in [-1, 1]', async () => {
  const { verificationFrom } = await import('../src/noolog/verify.js');
  const claim = (key, verdict, id) => ({ key, claim_id: id, claim: `claim ${id}`, anchor: null, verdicts: [{ evaluator_agent_id: 'RwaCompliance', verdict }], disputed: verdict === 'contested' });
  const references = { rounds: [
    { round: 1, proposals: [{ author_agent_id: 'RwaCompliance', aggregated_score: -0.97, on_winner_path: false, claims: [claim('rule:a:quote', 'verified', 'c1')] }, { author_agent_id: 'RwaScrivener', aggregated_score: 0, on_winner_path: false, claims: [] }] },
    { round: 2, proposals: [{ author_agent_id: 'RwaCompliance', aggregated_score: -0.8, on_winner_path: false, claims: [claim('rule:b:quote', 'verified', 'c2'), claim('rule:c:quote', 'contested', 'c3')] }, { author_agent_id: 'RwaScrivener', aggregated_score: 0, on_winner_path: true, claims: [] }] },
  ], edges: [], hunk_edges: [] };
  const details = { history: [
    { round: 1, author_agent_id: 'RwaCompliance', proposal: {}, evaluations: [], aggregated_score: -0.97 },
    { round: 2, author_agent_id: 'RwaScrivener', proposal: {}, evaluations: [{ evaluator_agent_id: 'RwaCompliance', evaluation: { score: 1, disagreements: [{ claim_id: 'c3', proposal_claims: 'claim c3', evaluator_position: 'no', confidence: 0.7 }] } }], aggregated_score: 0 },
  ], rounds: [{ round: 1, convergence_score: -1 }, { round: 2, convergence_score: 0 }], final_result: { round: 2, author_agent_id: 'RwaScrivener', aggregated_score: 0 } };
  const v = verificationFrom({ jobId: 'j', details, references });
  assert.deepEqual(v.winner, { round: 2, agent: 'RwaScrivener', score: 0 });
  assert.deepEqual(v.claims.map((c) => c.key), ['rule:b:quote', 'rule:c:quote'], 'the winner\'s round, not the winner alone');
  assert.equal(v.confidence.overall, (VERDICT_WEIGHT.verified + VERDICT_WEIGHT.contested) / 2, 'the mean of the assessed claims\' verdict weights');
  assert.deepEqual(v.confidence.counts, { verified: 1, contested: 1, unverified: 0, wrong: 0, unknown: 0 });
  assert.equal(v.contested[0].ref, 'rule:c');
  assert.equal(v.rounds, 2);
  assert.equal(v.confidence.basis, 'claims');
  const scoredOnly = verificationFrom({ jobId: 'j', details: { history: [{ round: 1, author_agent_id: 'X', proposal: {}, evaluations: [{ evaluator_agent_id: 'A', evaluation: { score: 1 } }, { evaluator_agent_id: 'B', evaluation: { score: -0.5 } }], aggregated_score: 0.25 }], rounds: [], final_result: { round: 1, author_agent_id: 'X', aggregated_score: 0.25 } }, references: { rounds: [{ round: 1, proposals: [{ author_agent_id: 'X', aggregated_score: 0.25, on_winner_path: true, claims: [] }] }] } });
  assert.equal(scoredOnly.confidence.basis, 'evaluations');
  assert.equal(scoredOnly.confidence.overall, 0.625, 'the seats\' scores 1 and -0.5, mapped to [0, 1], averaged');
  const bare = verificationFrom({ jobId: 'j', details: { history: [], rounds: [], final_result: { round: 1, author_agent_id: 'X', aggregated_score: -0.5 } }, references: { rounds: [{ round: 1, proposals: [{ author_agent_id: 'X', aggregated_score: -0.5, on_winner_path: true, claims: [] }] }] } });
  assert.equal(bare.confidence.basis, 'winner');
  assert.equal(bare.confidence.overall, 0.25, 'no claims, no scores: the winner\'s aggregate mapped to [0, 1]');
});

test('what the deployment cannot enforce is demoted to unresolved, and the instructions name the actions it can', async () => {
  const { fitToProfile, instructionsFor } = await import('../src/noolog/extract.js');
  const { compilePolicy } = await import('../src/policy/compile.js');
  const { sampleFixture } = await import('../src/policy/fixture.js');
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile('examples/rwa-secondary-config.json', 'utf8'));
  const envelope = sampleFixture(document, { secondary: true });
  assert.match(instructionsFor(config), /enforces these actions only: mint, burn, transfer\./);
  assert.match(instructionsFor({ profile: 'wildcat-credit', venue: 'wildcat' }), /deposit, withdraw/);
  const rule = (id, action) => ({ id, action, effect: 'require', condition: { type: 'fact', name: 'kycApproved' }, source: { clause: '2.2', quote: 'redemption is legally authorized.' }, rationale: 'r' });
  const wide = { ...envelope.ast, rules: [...envelope.ast.rules, rule('withdraw-redemption-payment', 'withdraw')], terms: [{ name: 'noticeWindow', value: '30', unit: 'days', source: { clause: '9.1', quote: 'redemption is legally authorized.' }, rationale: 'r' }] };
  const { ast, demoted } = fitToProfile(wide, config);
  assert.deepEqual(demoted, [{ kind: 'rule', id: 'withdraw-redemption-payment', action: 'withdraw', clause: '2.2' }, { kind: 'term', name: 'noticeWindow', clause: '9.1' }]);
  assert.equal(ast.rules.length, envelope.ast.rules.length);
  assert.equal(ast.terms.length, 0);
  assert.equal(ast.unresolved.length, envelope.ast.unresolved.length + 2);
  assert.match(ast.unresolved.at(-1).description, /term "noticeWindow"/);
  assert.doesNotThrow(() => compilePolicy({ ...envelope, ast }, config, document, { demo: true }));
  assert.throws(() => compilePolicy({ ...envelope, ast: wide }, config, document, { demo: true }), /withdraw/);
});

test('terms the deployment cannot enforce are set aside before validation, so a missing rationale on them does not fail the extraction', async () => {
  const { extractWithOpenAI, instructionsFor } = await import('../src/noolog/extract.js');
  const { sampleFixture } = await import('../src/policy/fixture.js');
  const draft = sampleFixture(document, { secondary: true }).ast;
  assert.match(instructionsFor({ profile: 'rwa-secondary' }), /Every rule and every term carries a "rationale"/);
  // What the legal seats returned live: contractual notice windows as terms, without a rationale.
  const answer = { ...draft, terms: [{ name: 'issuerBreachNoticeWindow', value: '30', unit: 'days', source: { clause: '9.2', quote: 'redemption is legally authorized.' } }] };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id: 'c', choices: [{ message: { content: JSON.stringify(answer) } }] }) });
  const env = { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' };
  const { envelope: out } = await extractWithOpenAI({ document, fetchImpl, env });
  assert.equal(out.ast.terms.length, 0);
  assert.deepEqual(out.extraction.demoted, [{ kind: 'term', name: 'issuerBreachNoticeWindow', clause: '9.2' }]);
  // A rule the deployment keeps must still be well-formed.
  const broken = { ...draft, rules: [{ ...draft.rules[0], rationale: undefined }] };
  const brokenFetch = async () => ({ ok: true, json: async () => ({ id: 'c', choices: [{ message: { content: JSON.stringify(broken) } }] }) });
  await assert.rejects(extractWithOpenAI({ document, fetchImpl: brokenFetch, env }), /rationale/);
});

test('progress is a percentage of rounds and time, never 100 before completion; confidence so far comes from the scored round', async () => {
  const { progressOf, interimConfidence, ROUND_SECONDS } = await import('../src/noolog/extract.js');
  const t0 = 1_000_000;
  const at = (seconds) => ({ rounds: 3, roundStartedAt: t0, now: t0 + seconds * 1000 });
  assert.equal(progressOf('pending', at(0)), 2);
  assert.equal(progressOf('running: round 1 — Starting', at(0)), 3);
  assert.equal(progressOf('running: round 1 — Starting', at(ROUND_SECONDS / 2)), 17);
  assert.equal(progressOf('running: round 2 — Starting', at(0)), 33);
  assert.equal(progressOf('running: round 3 — Starting', at(ROUND_SECONDS * 5)), 97, 'a long last round stops short of 100');
  assert.equal(progressOf('completed', at(0)), 100);
  assert.equal(progressOf('running: round 9', at(0)), 67, 'rounds beyond the bound count as the last');
  const details = { history: [
    { round: 1, evaluations: [{ evaluation: { score: -1 } }] },
    { round: 2, evaluations: [{ evaluation: { score: 1 } }, { evaluation: { score: 0 } }] },
  ] };
  assert.equal(interimConfidence(details), 0.75, 'the latest round, mapped from [-1, 1]');
  assert.equal(interimConfidence({ history: [] }), null);
  assert.equal(interimConfidence(null), null);
});

test('the report carries each model\'s score of the final answer, mapped to [0, 1] on live scores', async () => {
  const { verificationFrom } = await import('../src/noolog/verify.js');
  const details = { history: [{ round: 2, author_agent_id: 'RwaScrivener', proposal: {}, aggregated_score: 0,
    evaluations: [{ evaluator_agent_id: 'RwaCounsel', evaluation: { score: 1, justification: '' } }, { evaluator_agent_id: 'RwaCompliance', evaluation: { score: -0.5, justification: 'Missing the sanctions clause.' } }] }],
    rounds: [], final_result: { round: 2, author_agent_id: 'RwaScrivener', aggregated_score: 0 } };
  const references = { rounds: [{ round: 2, proposals: [{ author_agent_id: 'RwaScrivener', aggregated_score: 0, on_winner_path: true, claims: [] }] }] };
  const v = verificationFrom({ jobId: 'j', details, references });
  assert.deepEqual(v.evaluations, [
    { agent: 'RwaCounsel', score: 1, justification: null },
    { agent: 'RwaCompliance', score: 0.25, justification: 'Missing the sanctions clause.' },
  ]);
  assert.equal(v.confidence.basis, 'evaluations');
  assert.equal(v.confidence.overall, 0.625);
});

test('a live answer whose quotes differ from the source only in spacing or punctuation still compiles; an invented quote is set aside', async () => {
  const answer = structuredClone(envelope.ast);
  const [first] = answer.rules;
  first.source.quote = first.source.quote.replace(/ /g, '  ').replace(/'/g, '’');
  answer.rules.push({ ...structuredClone(first), id: 'invented-rule', source: { clause: 'X', quote: 'a sentence this agreement never contains' } });
  const client = {
    policyFor: async () => ({ policy_id: 'p', max_rounds: 2 }),
    startDeliberation: async () => ({ job_id: 'job-quotes' }),
    waitForResult: async () => ({ status: 'completed', result: JSON.stringify(answer) }),
    details: async () => ({ history: [], rounds: [] }),
    references: async () => ({ rounds: [], edges: [], hunk_edges: [], winner: null }),
  };
  const { envelope: generated } = await extractWithNoolog({ profile: 'rwa-secondary', document, client, live: true });
  const anchored = generated.ast.rules.find((rule) => rule.id === first.id);
  assert.ok(document.text.includes(anchored.source.quote), 'the quote is the verbatim source span');
  assert.equal(generated.ast.rules.some((rule) => rule.id === 'invented-rule'), false);
  assert.deepEqual(generated.extraction.unanchored, [{ kind: 'rule', id: 'invented-rule', clause: 'X' }]);
  assert.ok(generated.ast.unresolved.some((item) => /invented-rule was not found in the source/.test(item.description)));
});
