// Extraction *is* a deliberation. The document (and a draft, when one exists) go to the
// orchestrator's native route under a policy (its seat list), the settled result is the AST, and the
// job's history and reference tree give every claim its verdicts and the confidence.
// EXTRACTOR picks the engine: `noolog` (live, NOOLOG_API_KEY), `mock` (the in-process orchestrator
// mock, no model), or `openai` (one model call on any OpenAI-compatible endpoint, no deliberation
// and no verdicts). Unset, it follows the keys present: noolog, then openai, then mock.
import { once } from 'node:events';
import { astSchema, validateAst } from '../policy/schema.js';
import { NoologClient } from './client.js';
import { createMockNoolog } from './mock.js';
import { verificationFrom } from './verify.js';

export const AGENTS = ['extractor', 'critic'];
export const MODEL = process.env.NOOLOG_MODEL ?? 'nsed:legal_rwa_pro';
export const MODES = ['mock', 'noolog', 'openai'];

export function extractorMode(env = process.env) {
  const mode = env.EXTRACTOR ?? (env.NOOLOG_API_KEY ? 'noolog' : env.OPENAI_API_KEY ? 'openai' : 'mock');
  if (!MODES.includes(mode)) throw new Error(`EXTRACTOR must be one of ${MODES.join(', ')}`);
  return mode;
}

const INSTRUCTIONS = `Read the agreement and return only JSON matching this schema: the executable rules and numeric terms, each quoting the document verbatim, and what cannot be compiled under "unresolved". Answer with the JSON object only: no prose, no headings, no code fence.
Schema: ${JSON.stringify(astSchema)}`;

// A policy model (nsed:legal_rwa_pro …) brings its own seats; only the generic model needs agents named.
const SEATED = (model) => model === 'nsed:deep';
const tagOf = (model) => model.replace(/^nsed:/, '');
const room = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/// One room per run: the orchestrator holds a room slot per id, so a repeat would collide.
export function chatRequest({ profile, document, draft = null, rounds = 2, model = MODEL, room: nonce = room() }) {
  return {
    model,
    stream: false,
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: document.text },
      ...(draft ? [{ role: 'assistant', content: JSON.stringify(draft) }] : []),
    ],
    nsed: { room_id: `mirr0tech-${profile}-${document.sha256.slice(2, 10)}-${nonce}`, ...(SEATED(model) ? { agent_names: AGENTS } : {}), deliberation_rounds: rounds },
  };
}

/// The native submit: the job id is the room id, so progress and the reference tree can be read back.
/// Instructions travel in the user turn (the orchestrator folds no system turn); the draft is the assistant turn.
export function deliberationRequest({ profile, document, draft = null, rounds = 2, model = MODEL, policyId = null, room: nonce = room() }) {
  return {
    room_id: `mirr0tech-${profile}-${document.sha256.slice(2, 10)}-${nonce}`,
    deliberation_rounds: rounds,
    ...(policyId ? { policy_id: policyId } : { agent_names: AGENTS }),
    messages: [
      { role: 'user', content: `${INSTRUCTIONS}\n\nAGREEMENT:\n${document.text}` },
      ...(draft ? [{ role: 'assistant', content: JSON.stringify(draft) }] : []),
    ],
  };
}

/// The settled answer should be JSON; a seat may wrap it in a code fence or lead with prose.
export function parseAstText(text) {
  const raw = String(text ?? '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [raw, fenced?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)].filter((candidate) => candidate && candidate.trim().startsWith('{'));
  for (const candidate of candidates) { try { return JSON.parse(candidate); } catch {} }
  throw new Error(`The model answered prose instead of the policy JSON: ${raw.replace(/\s+/g, ' ').slice(0, 300)}`);
}

const budgetError = (error) => {
  if ([402, 429].includes(error.status) && /budget|quota|credit/i.test(error.message)) return new Error(`The model account is out of credits (${error.status}); top up the Noolog account, or set EXTRACTOR=mock`);
  return error;
};

/// Returns { envelope, verification }: the AST the deliberation produced, and what it established about it.
/// `live` forces the orchestrator (default: EXTRACTOR=noolog); otherwise the in-process mock serves.
export async function extractWithNoolog({ profile, document, draft = null, client = null, pollMs = 10, onProgress = null, live = null } = {}) {
  let server = null;
  const orchestrator = live ?? extractorMode() === 'noolog';
  if (!client) {
    if (orchestrator) client = new NoologClient();
    else {
      server = createMockNoolog().listen(0, '127.0.0.1');
      await once(server, 'listening');
      client = new NoologClient({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'mock' });
    }
  }
  try {
    const policyId = SEATED(MODEL) ? null : (await client.policyFor(tagOf(MODEL))).policy_id;
    // The legal seats review a draft instead of answering; live, they read the document alone. The mock needs the draft.
    let jobId;
    try { ({ job_id: jobId } = await client.startDeliberation(deliberationRequest({ profile, document, draft: server ? draft : null, policyId }))); } catch (error) { throw budgetError(error); }
    // A live deliberation with a legal seat list takes minutes; the mock answers at once.
    const state = await client.waitForResult(jobId, server ? { pollMs, onProgress } : { pollMs: Math.max(pollMs, 2000), timeoutMs: 15 * 60_000, onProgress });
    if (state.status !== 'completed') throw new Error(`Deliberation ${jobId} ended ${state.status}`);
    const ast = validateAst(parseAstText(state.result), document.text);
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

/// One model call on an OpenAI-compatible endpoint (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL):
/// the AST without deliberation, so the agreement carries no verdicts and no confidence.
export async function extractWithOpenAI({ document, draft = null, fetchImpl = fetch, env = process.env } = {}) {
  const { OPENAI_API_KEY: apiKey, OPENAI_MODEL: model = 'gpt-4.1', OPENAI_BASE_URL: base = 'https://api.openai.com/v1' } = env;
  if (!apiKey) throw new Error('Set OPENAI_API_KEY (and OPENAI_BASE_URL for another OpenAI-compatible endpoint)');
  const response = await fetchImpl(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: document.text }, ...(draft ? [{ role: 'assistant', content: JSON.stringify(draft) }, { role: 'user', content: 'Return the corrected JSON only.' }] : [])],
    }),
  });
  if (!response.ok) throw new Error(`Model call failed (HTTP ${response.status}): ${(await response.text().catch(() => '')).slice(0, 200)}`);
  const completion = await response.json();
  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error('The model returned no content');
  const ast = validateAst(parseAstText(content), document.text);
  return {
    envelope: {
      ast, extraction: { provider: 'openai', model: completion.model ?? model, responseId: completion.id ?? null, baseUrl: base },
      source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256, ...(document.parts ? { parts: document.parts } : {}) },
    },
    verification: null,
  };
}

/// The engine EXTRACTOR names.
export function extractAgreement(input) {
  const mode = extractorMode();
  if (mode === 'openai') return extractWithOpenAI(input);
  return extractWithNoolog({ ...input, live: mode === 'noolog' });
}
