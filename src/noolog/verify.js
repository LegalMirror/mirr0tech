// Turns a finished deliberation into the verification report the compiler and the dashboard carry:
// one entry per claim the agents assessed, and a confidence per rule, term and open item.
export const VERDICT_WEIGHT = { verified: 1, unverified: 0.5, unknown: 0.5, contested: 0.25, wrong: 0 };

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/// `ref` of a claim key: "rule:<id>:quote" → "rule:<id>".
export const refOf = (key) => key.split(':').slice(0, 2).join(':');

export function verificationFrom({ jobId, details, references }) {
  const winner = references.winner;
  const winning = references.rounds
    .find((round) => round.round === winner?.round)
    ?.proposals.find((proposal) => proposal.author_agent_id === winner?.author_agent_id);
  const claims = (winning?.claims ?? []).map((claim) => ({
    key: claim.key, ref: refOf(claim.key), claim: claim.claim,
    verdicts: claim.verdicts.map((v) => ({ agent: v.evaluator_agent_id, verdict: v.verdict, reason: v.reason ?? null })),
    disputed: Boolean(claim.disputed),
    score: mean(claim.verdicts.map((v) => VERDICT_WEIGHT[v.verdict] ?? 0)),
  }));
  const byRef = {};
  for (const claim of claims) (byRef[claim.ref] ??= []).push(claim.score);
  const byId = new Map(claims.map((claim) => [claim.key, claim]));
  const idOf = new Map((winning?.claims ?? []).map((claim) => [claim.claim_id, claim.key]));
  const record = details.history.find((entry) => entry.round === winner?.round && entry.author_agent_id === winner?.author_agent_id);
  // What the evaluators pushed back on, with their counter-position and how sure they were.
  const contested = (record?.evaluations ?? []).flatMap((evaluation) => (evaluation.evaluation.disagreements ?? []).map((d) => ({
    key: idOf.get(d.claim_id) ?? null, ref: idOf.has(d.claim_id) ? refOf(idOf.get(d.claim_id)) : null,
    claim: d.proposal_claims, evaluator: evaluation.evaluator_agent_id, position: d.evaluator_position, confidence: d.confidence,
    verdict: byId.get(idOf.get(d.claim_id))?.verdicts[0]?.verdict ?? null,
  })));
  const counts = { verified: 0, contested: 0, unverified: 0, wrong: 0, unknown: 0 };
  for (const claim of claims) for (const v of claim.verdicts) counts[v.verdict in counts ? v.verdict : 'unknown']++;
  const rounds = details.rounds ?? [];
  return {
    provider: 'noolog', jobId,
    agents: [...new Set(details.history.map((entry) => entry.author_agent_id))],
    rounds: rounds.length || Math.max(0, ...details.history.map((entry) => entry.round)),
    winner: winner ? { round: winner.round, agent: winner.author_agent_id, score: winning?.aggregated_score ?? null } : null,
    convergence: rounds.at(-1)?.convergence_score ?? null,
    claims,
    contested,
    confidence: {
      overall: winning?.aggregated_score ?? mean(claims.map((claim) => claim.score)),
      byRef: Object.fromEntries(Object.entries(byRef).map(([ref, scores]) => [ref, Number(mean(scores).toFixed(4))])),
      verified: claims.filter((claim) => claim.score === 1).length,
      total: claims.length,
      counts,
    },
  };
}
