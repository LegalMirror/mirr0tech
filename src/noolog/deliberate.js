// The one call the compiler makes: submit a candidate extraction and the document, wait, read the
// history and the reference tree, return the verification report. With NOOLOG_API_KEY set it talks
// to the real orchestrator; otherwise it starts the mock in-process and talks HTTP to that.
import { once } from 'node:events';
import { NoologClient } from './client.js';
import { createMockNoolog } from './mock.js';
import { verificationFrom } from './verify.js';

export const AGENTS = ['extractor', 'critic'];

export function deliberationRequest({ profile, envelope, document, rounds = 2 }) {
  return {
    room_id: `mirr0tech-${profile}-${document.sha256.slice(2, 10)}`,
    user_query: 'Extract the executable rules and numeric terms of this agreement. Every rule and term must quote the document verbatim; list what cannot be compiled.',
    deliberation_rounds: rounds,
    agent_names: AGENTS,
    messages: [{ role: 'user', content: document.text }, { role: 'assistant', content: JSON.stringify(envelope.ast) }],
    variables: { profile, document_sha256: document.sha256, extraction_provider: envelope.extraction?.provider ?? 'unknown' },
    service_tier: 'flex',
  };
}

export async function deliberateExtraction({ profile, envelope, document, client = null, pollMs = 10 } = {}) {
  let server = null;
  if (!client) {
    if (process.env.NOOLOG_API_KEY) client = new NoologClient();
    else {
      server = createMockNoolog().listen(0, '127.0.0.1');
      await once(server, 'listening');
      client = new NoologClient({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'mock' });
    }
  }
  try {
    const { job_id: jobId } = await client.startDeliberation(deliberationRequest({ profile, envelope, document }));
    const state = await client.waitForResult(jobId, { pollMs });
    if (state.status !== 'completed') throw new Error(`Deliberation ${jobId} ended ${state.status}`);
    const [details, references] = await Promise.all([client.details(jobId), client.references(jobId)]);
    return { ...verificationFrom({ jobId, details, references }), mock: Boolean(server), finalResult: state.result };
  } finally {
    server?.close();
  }
}
