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

// A policy model (nsed:legal_rwa_pro …) brings its own seats; only the generic model needs agents named.
const SEATED = (model) => model === 'nsed:deep';

/// One room per run: the orchestrator holds a room slot per id, so a repeat would collide.
export function chatRequest({ profile, document, draft = null, rounds = 2, model = MODEL, room = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }) {
  return {
    model,
    stream: false,
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: document.text },
      ...(draft ? [{ role: 'assistant', content: JSON.stringify(draft) }] : []),
    ],
    nsed: { room_id: `mirr0tech-${profile}-${document.sha256.slice(2, 10)}-${room}`, ...(SEATED(model) ? { agent_names: AGENTS } : {}), deliberation_rounds: rounds },
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
    let started;
    try { started = await client.chatCompletion(chatRequest({ profile, document, draft })); } catch (error) {
      if ([402, 429].includes(error.status) && /budget|quota|credit/i.test(error.message)) throw new Error(`The model account is out of credits (${error.status}); top up the Noolog account, or unset NOOLOG_API_KEY for the mock`);
      throw error;
    }
    const { completion, jobId } = started;
    const content = completion.choices?.[0]?.message?.content ?? '';
    const ast = validateAst(JSON.parse(content), document.text);
    // A live deliberation with a legal seat list takes minutes; the mock answers at once.
    const state = await client.waitForResult(jobId, server ? { pollMs } : { pollMs: Math.max(pollMs, 2000), timeoutMs: 15 * 60_000 });
    if (state.status !== 'completed') throw new Error(`Deliberation ${jobId} ended ${state.status}`);
    const [details, references] = await Promise.all([client.details(jobId), client.references(jobId)]);
    const verification = { ...verificationFrom({ jobId, details, references }), mock: Boolean(server), model: MODEL };
    return {
      envelope: {
        ast, extraction: { provider: 'noolog', model: MODEL, responseId: jobId, agents: verification.agents },
        // No undefined keys: the source object is inside the policy hash.
        source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256, ...(document.parts ? { parts: document.parts } : {}) },
      },
      verification,
    };
  } finally {
    server?.close();
  }
}
