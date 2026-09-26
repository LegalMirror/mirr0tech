// Turns a finished deliberation into the verification report the compiler and the dashboard carry:
// one entry per claim the agents assessed, and a confidence per rule, term and open item.
export const VERDICT_WEIGHT = { verified: 1, unverified: 0.5, unknown: 0.5, contested: 0.25, wrong: 0 };

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/// `ref` of a claim key: "rule:<id>:quote" → "rule:<id>".
export const refOf = (key) => key.split(':').slice(0, 2).join(':');

// The orchestrator's tree names the winner as `final_result` in the details and `on_winner_path`
// on proposals; the mock's tree carries `winner` outright. Scores are in [-1, 1] live, [0, 1] mocked.
const unit = (score) => (score === null || score === undefined ? null : score < 0 ? (score + 1) / 2 : score);

export function verificationFrom({ jobId, details, references }) {
  const tree = references.rounds ?? [];
  const last = tree.at(-1);
  const onPath = last?.proposals.find((proposal) => proposal.on_winner_path);
  const winner = references.winner
    ?? (details.final_result ? { round: details.final_result.round, author_agent_id: details.final_result.author_agent_id } : null)
    ?? (onPath ? { round: last.round, author_agent_id: onPath.author_agent_id } : null);
  const winning = tree.find((round) => round.round === winner?.round)?.proposals.find((proposal) => proposal.author_agent_id === winner?.author_agent_id);
  // A winning answer the evaluators did not decompose still has claims assessed on its rivals that round.
  const assessed = winning?.claims?.length ? winning.claims : (tree.find((round) => round.round === winner?.round)?.proposals ?? []).flatMap((proposal) => proposal.claims ?? []);
  const claims = assessed.map((claim) => ({
    key: claim.key, ref: refOf(claim.key), claim: claim.claim,
    verdicts: claim.verdicts.map((v) => ({ agent: v.evaluator_agent_id, verdict: v.verdict, reason: v.reason ?? null })),
    disputed: Boolean(claim.disputed),
    score: mean(claim.verdicts.map((v) => VERDICT_WEIGHT[v.verdict] ?? 0)),
  }));
  const byRef = {};
  for (const claim of claims) (byRef[claim.ref] ??= []).push(claim.score);
  const byId = new Map(claims.map((claim) => [claim.key, claim]));
  const idOf = new Map(assessed.map((claim) => [claim.claim_id, claim.key]));
  const record = details.history.find((entry) => entry.round === winner?.round && entry.author_agent_id === winner?.author_agent_id);
  // What the evaluators pushed back on, with their counter-position and how sure they were.
  const contested = (record?.evaluations ?? []).flatMap((evaluation) => (evaluation.evaluation.disagreements ?? []).map((d) => ({
    key: idOf.get(d.claim_id) ?? null, ref: idOf.has(d.claim_id) ? refOf(idOf.get(d.claim_id)) : null,
    claim: d.proposal_claims, evaluator: evaluation.evaluator_agent_id, position: d.evaluator_position, confidence: d.confidence,
    verdict: byId.get(idOf.get(d.claim_id))?.verdicts[0]?.verdict ?? null,
  })));
  // Seats that score the answer without decomposing it still say how sure they are: their scores, in [0, 1].
  const raw = (record?.evaluations ?? []).map((evaluation) => evaluation.evaluation?.score).filter(Number.isFinite);
  const live = raw.some((score) => score < 0) || (winning?.aggregated_score ?? 0) < 0;
  const scored = live ? raw.map((score) => (score + 1) / 2) : raw;
  // What each evaluating model said about the final answer: the evidence when no claims are split out.
  const evaluations = (record?.evaluations ?? []).filter((evaluation) => Number.isFinite(evaluation.evaluation?.score)).map((evaluation) => ({
    agent: evaluation.evaluator_agent_id,
    score: Number((live ? (evaluation.evaluation.score + 1) / 2 : evaluation.evaluation.score).toFixed(2)),
    justification: typeof evaluation.evaluation.justification === 'string' && evaluation.evaluation.justification.trim() ? evaluation.evaluation.justification.slice(0, 600) : null,
  }));
  const counts = { verified: 0, contested: 0, unverified: 0, wrong: 0, unknown: 0 };
  for (const claim of claims) for (const v of claim.verdicts) counts[v.verdict in counts ? v.verdict : 'unknown']++;
  const rounds = details.rounds ?? [];
  return {
    provider: 'noolog', jobId,
    agents: [...new Set(details.history.map((entry) => entry.author_agent_id))],
    rounds: rounds.length || Math.max(0, ...details.history.map((entry) => entry.round)),
    winner: winner ? { round: winner.round, agent: winner.author_agent_id, score: unit(winning?.aggregated_score ?? null) } : null,
    convergence: rounds.at(-1)?.convergence_score ?? null,
    claims,
    contested,
    evaluations,
    confidence: {
      overall: claims.length ? Number(mean(claims.map((claim) => claim.score)).toFixed(4)) : Number(mean(scored.length ? scored : [unit(winning?.aggregated_score) ?? 0]).toFixed(4)),
      // What the number rests on: assessed claims, the seats' scores of the answer, or the winner's aggregate alone.
      basis: claims.length ? 'claims' : scored.length ? 'evaluations' : 'winner',
      byRef: Object.fromEntries(Object.entries(byRef).map(([ref, scores]) => [ref, Number(mean(scores).toFixed(4))])),
      verified: claims.filter((claim) => claim.score === 1).length,
      total: claims.length,
      counts,
    },
  };
}
