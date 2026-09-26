// Extraction *is* a Noolog deliberation. The document (and a draft, when one exists) go to the
// OpenAI-compatible endpoint with a deliberating model; the winning proposal is the AST, and the
// job's history and reference tree give every claim its verdicts and the confidence.
// With NOOLOG_API_KEY set this talks to the orchestrator; otherwise the in-process mock serves the
// same routes with no model behind it.
import { once } from 'node:events';
import { astSchema, validateAst } from '../policy/schema.js';
import { NoologClient } from './client.js';
import { createMockNoolog } from './mock.js';
import { verificationFrom } from './verify.js';

export const AGENTS = ['extractor', 'critic'];
export const MODEL = process.env.NOOLOG_MODEL ?? 'nsed:deep';

const INSTRUCTIONS = `Read the agreement and return only JSON matching this schema: the executable rules and numeric terms, each quoting the document verbatim, and what cannot be compiled under "unresolved".
Schema: ${JSON.stringify(astSchema)}`;

export function chatRequest({ profile, document, draft = null, rounds = 2 }) {
  return {
    model: MODEL,
    stream: false,
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: document.text },
      ...(draft ? [{ role: 'assistant', content: JSON.stringify(draft) }] : []),
    ],
    nsed: { room_id: `mirr0tech-${profile}-${document.sha256.slice(2, 10)}`, agent_names: AGENTS, deliberation_rounds: rounds },
  };
}

/// Returns { envelope, verification }: the AST the deliberation produced, and what it established about it.
export async function extractWithNoolog({ profile, document, draft = null, client = null, pollMs = 10 } = {}) {
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
    const { completion, jobId } = await client.chatCompletion(chatRequest({ profile, document, draft }));
    const content = completion.choices?.[0]?.message?.content ?? '';
    const ast = validateAst(JSON.parse(content), document.text);
    const state = await client.waitForResult(jobId, { pollMs });
    if (state.status !== 'completed') throw new Error(`Deliberation ${jobId} ended ${state.status}`);
    const [details, references] = await Promise.all([client.details(jobId), client.references(jobId)]);
    const verification = { ...verificationFrom({ jobId, details, references }), mock: Boolean(server), model: MODEL };
    return {
      envelope: {
        ast, extraction: { provider: 'noolog', model: MODEL, responseId: jobId, agents: verification.agents },
        source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256, parts: document.parts },
      },
      verification,
    };
  } finally {
    server?.close();
  }
}
