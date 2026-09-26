// The raw deliberation request the tests use to exercise POST /deliberation directly.
export function deliberationRequest({ profile, envelope, document, rounds = 2 }) {
  return {
    room_id: `mirr0tech-${profile}-${document.sha256.slice(2, 10)}-raw`,
    user_query: 'Extract the executable rules and numeric terms of this agreement.',
    deliberation_rounds: rounds,
    agent_names: ['extractor', 'critic'],
    messages: [{ role: 'user', content: document.text }, { role: 'assistant', content: JSON.stringify(envelope.ast) }],
    service_tier: 'flex',
  };
}
