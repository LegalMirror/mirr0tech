// A stand-in for the Noolog orchestrator with the same routes and schemas, so the pipeline runs
// with no model behind it. Two agents deliberate over a candidate extraction: the extractor
// proposes it, the critic checks every claim against the document, the extractor re-proposes
// without what failed. Verdicts follow the SDK: verified | contested | unverified | wrong.
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { FACTS } from '../policy/schema.js';
import { VERDICT_WEIGHT } from './verify.js';

const claimId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 6);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/// The claims a candidate extraction makes, each checkable against the document text.
export function claimsOf(ast, text) {
  const claims = [];
  const verbatim = (quote) => text.includes(quote);
  for (const rule of ast.rules ?? []) {
    claims.push({ key: `rule:${rule.id}:quote`, claim: `${rule.source.clause} says “${rule.source.quote}”`,
      verdict: verbatim(rule.source.quote) ? 'verified' : 'wrong', reason: verbatim(rule.source.quote) ? 'quote found verbatim in the document' : 'quote is not in the document' });
    const facts = [...factsIn(rule.condition)];
    const known = facts.every((name) => FACTS.includes(name));
    claims.push({ key: `rule:${rule.id}:facts`, claim: `${rule.id} reads ${facts.join(', ')} under ${rule.action}`,
      verdict: known ? 'verified' : 'contested', reason: known ? 'every fact is in the schema' : 'a fact is outside the schema' });
  }
  for (const term of ast.terms ?? []) {
    claims.push({ key: `term:${term.name}:quote`, claim: `${term.source.clause} sets ${term.name} = ${term.value} ${term.unit ?? ''}`.trim(),
      verdict: verbatim(term.source.quote) ? 'verified' : 'wrong', reason: verbatim(term.source.quote) ? 'quote found verbatim in the document' : 'quote is not in the document' });
  }
  for (const entry of ast.unresolved ?? []) {
    claims.push({ key: `unresolved:${entry.clause}:open`, claim: `${entry.clause} cannot be compiled: ${entry.description}`,
      verdict: 'unverified', reason: 'a judgement call; no mechanical check' });
  }
  return claims;
}

function* factsIn(node) {
  if (!node) return;
  if (node.type === 'fact') yield node.name;
  if (node.child) yield* factsIn(node.child);
  for (const child of node.children ?? []) yield* factsIn(child);
}

/// Runs the whole deliberation synchronously and returns the job record the routes serve.
export function deliberate({ jobId, body }) {
  const text = body.messages?.find((m) => m.role === 'user')?.content ?? '';
  const candidate = JSON.parse(body.messages?.find((m) => m.role === 'assistant')?.content ?? '{}');
  const [extractor, critic] = body.agent_names;
  const totalRounds = body.deliberation_rounds ?? 2;
  const now = Date.now();
  const claims = claimsOf(candidate, text);
  const failed = new Set(claims.filter((c) => c.verdict === 'wrong').map((c) => c.key.split(':')[1]));
  const refined = { ...candidate, rules: (candidate.rules ?? []).filter((r) => !failed.has(r.id)), terms: (candidate.terms ?? []).filter((t) => !failed.has(t.name)) };
  const coverage = (ast) => ((ast.rules?.length ?? 0) + (ast.terms?.length ?? 0)) / Math.max(1, (candidate.rules?.length ?? 0) + (candidate.terms?.length ?? 0));
  const assess = (ast) => claimsOf(ast, text);
  const score = (ast) => Number((0.6 * mean(assess(ast).map((c) => VERDICT_WEIGHT[c.verdict])) + 0.4 * coverage(ast)).toFixed(4));

  const history = [];
  const roundStats = [];
  for (let round = 1; round <= totalRounds; round++) {
    const proposals = round === 1
      ? [{ author: extractor, ast: candidate, thought: 'Propose the candidate extraction as submitted.' },
         { author: critic, ast: refined, thought: 'Propose only what verifies against the document.' }]
      : [{ author: extractor, ast: refined, thought: 'Carry every verified claim; drop what the critic refuted.' },
         { author: critic, ast: refined, thought: 'Agree with the refined extraction.' }];
    for (const proposal of proposals) {
      const assessed = assess(proposal.ast);
      const evaluator = proposal.author === extractor ? critic : extractor;
      history.push({
        round, author_agent_id: proposal.author,
        proposal: { thought_process: proposal.thought, content: JSON.stringify(proposal.ast), proposal_type: 'text', skipped: false, final_scratchpad: null,
          token_usage_stats: null, operator_annotations: [], edited_by: null, finish_reason: 'stop', served_by: 'mock', published_at_ms: now + round * 1000 },
        evaluations: [{ evaluator_agent_id: evaluator, synthetic: false, evaluation: {
          score: score(proposal.ast), justification: `${assessed.filter((c) => c.verdict === 'verified').length} of ${assessed.length} claims verified against the document`,
          token_usage: null,
          claim_assessments: assessed.map((c) => ({ claim_id: claimId(c.key), claim: c.claim, verdict: c.verdict, reason: c.reason, anchor: null })),
          disagreements: assessed.filter((c) => c.verdict === 'wrong').map((c) => ({ claim_id: claimId(c.key), proposal_claims: c.claim, evaluator_position: 'the quote is not in the document', confidence: 'high', anchor: null })),
          stance: null, is_final_solution: round === totalRounds, category_scores: null, operator_annotations: [], edited_by: null, finish_reason: 'stop', published_at_ms: now + round * 1000 + 500,
        } }],
        aggregated_score: score(proposal.ast),
        _claims: assessed,
      });
    }
    const inRound = history.filter((h) => h.round === round);
    const scores = inRound.map((h) => h.aggregated_score);
    roundStats.push({ round, convergence_score: Number(mean(inRound.flatMap((h) => h._claims.map((c) => (c.verdict === 'verified' ? 1 : 0)))).toFixed(4)),
      decisiveness: Number(Math.abs(scores[0] - scores[1]).toFixed(4)), claim_convergence: 1 });
  }
  const last = history.filter((h) => h.round === totalRounds);
  const best = last.reduce((a, b) => (b.aggregated_score > a.aggregated_score ? b : a));
  return {
    jobId, roomId: body.room_id, query: body.user_query, messages: body.messages ?? [], history, rounds: roundStats,
    effort: body.effort ?? 0.5, minRounds: body.min_rounds ?? 1,
    winner: { round: best.round, author_agent_id: best.author_agent_id }, finalResult: best.proposal.content, polls: 0,
  };
}

/// The reference tree: proposals per round with their claims and verdicts, carried-claim edges, winner path.
export function referenceTree(job) {
  const rounds = [];
  const firstSeen = new Map();
  for (const entry of job.history) {
    const round = rounds.find((r) => r.round === entry.round) ?? rounds[rounds.push({ round: entry.round, proposals: [] }) - 1];
    const onWinnerPath = entry.author_agent_id === job.winner.author_agent_id;
    round.proposals.push({
      author_agent_id: entry.author_agent_id, aggregated_score: entry.aggregated_score, on_winner_path: onWinnerPath,
      claims: entry._claims.map((c) => {
        firstSeen.has(c.key) || firstSeen.set(c.key, { round: entry.round, author_agent_id: entry.author_agent_id });
        return { key: c.key, claim_id: claimId(c.key), claim: c.claim, anchor: null,
          verdicts: entry.evaluations.map((e) => ({ evaluator_agent_id: e.evaluator_agent_id, verdict: c.verdict, reason: c.reason })),
          disputed: c.verdict === 'contested' || c.verdict === 'wrong', first_seen: firstSeen.get(c.key) };
      }),
      consultations: [],
    });
  }
  const edges = [];
  for (let i = 1; i < rounds.length; i++) {
    for (const to of rounds[i].proposals) for (const claim of to.claims) {
      const from = rounds[i - 1].proposals.find((p) => p.author_agent_id === to.author_agent_id && p.claims.some((c) => c.key === claim.key));
      if (from) edges.push({ key: claim.key, claim: claim.claim, from: { round: rounds[i - 1].round, author_agent_id: from.author_agent_id }, to: { round: rounds[i].round, author_agent_id: to.author_agent_id }, on_winner_path: to.on_winner_path });
    }
  }
  return { rounds, edges, hunk_edges: [], winner: job.winner };
}

/// An Express app serving the four routes with the orchestrator's status codes.
export function createMockNoolog({ apiKey = null } = {}) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const jobs = new Map();
  app.use((req, res, next) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token || (apiKey && token !== apiKey)) return res.status(401).json({ error: 'missing or invalid bearer token' });
    next();
  });
  const statusOf = (job) => (job.polls < 1 ? 'pending' : job.polls < 2 ? 'running' : 'completed');
  app.post('/deliberation', (req, res) => {
    const body = req.body ?? {};
    if (!body.room_id || /[\s.*>]/.test(body.room_id)) return res.status(400).json({ error: 'room_id missing or NATS-incompatible' });
    if (!Array.isArray(body.agent_names) || body.agent_names.length < 2) return res.status(400).json({ error: 'fewer than 2 agents' });
    if ([...jobs.values()].some((job) => job.roomId === body.room_id && statusOf(job) !== 'completed')) return res.status(409).json({ error: 'job already running for this room' });
    const jobId = randomUUID();
    jobs.set(jobId, deliberate({ jobId, body }));
    res.status(202).json({ job_id: jobId });
  });
  const load = (req, res) => { const job = jobs.get(req.params.id); if (!job) res.status(404).json({ error: 'job not found' }); return job; };
  app.get('/deliberation/:id/result', (req, res) => {
    const job = load(req, res); if (!job) return;
    const status = statusOf(job); job.polls++;
    res.json({ job_id: job.jobId, status, result: status === 'completed' ? job.finalResult : null });
  });
  app.get('/deliberation/:id/details', (req, res) => {
    const job = load(req, res); if (!job) return;
    res.json({ job_id: job.jobId, query: job.query, finalized_by_user: null, history: job.history.map(({ _claims, ...entry }) => entry),
      final_result: job.finalResult, messages: job.messages, rounds: job.rounds, effort: job.effort, min_rounds: job.minRounds });
  });
  app.get('/deliberation/:id/references', (req, res) => { const job = load(req, res); if (job) res.json(referenceTree(job)); });
  return app;
}
