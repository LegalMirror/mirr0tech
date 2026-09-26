// Extraction *is* a deliberation. The document (and a draft, when one exists) go to the
// orchestrator's native route under a policy (its seat list), the settled result is the AST, and the
// job's history and reference tree give every claim its verdicts and the confidence.
// EXTRACTOR picks the engine: `noolog` (live, NOOLOG_API_KEY), `mock` (the in-process orchestrator
// mock, no model), or `openai` (one model call on any OpenAI-compatible endpoint, no deliberation
// and no verdicts). Unset, it follows the keys present: noolog, then openai, then mock.
import { once } from 'node:events';
import { ACTIONS, astSchema, validateAst } from '../policy/schema.js';
import { enforceableActions, profileComponents } from '../onchain/components.js';
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

/// The instructions for one deployment: only the actions its venue components enforce become rules.
export function instructionsFor(config = { profile: 'rwa-secondary' }) {
  const actions = enforceableActions(config, ACTIONS);
  return `${INSTRUCTIONS}
This deployment enforces these actions only: ${actions.join(', ')}. Emit rules for no other action; put obligations about anything else under "unresolved". Emit a term only for a number the agreement states that a venue must enforce (a price, a cap, a period); every other number belongs under "unresolved". Every rule and every term carries a "rationale".`;
}

/// What the deployment cannot enforce is demoted to "unresolved" rather than failing the compile:
/// rules for actions no venue component covers, terms no component consumes. Returns the fitted AST
/// and what moved, so the record can say so.
export function fitToProfile(ast, config = { profile: 'rwa-secondary' }) {
  const components = profileComponents(config);
  const demoted = [];
  const rules = (ast.rules ?? []).filter((rule) => {
    const kept = components.some((component) => component.kind === 'venue' && component.coversRule(rule, config));
    if (!kept) demoted.push({ kind: 'rule', id: rule.id, action: rule.action, clause: rule.source?.clause ?? 'unknown' });
    return kept;
  });
  const terms = (ast.terms ?? []).filter((term) => {
    const kept = components.some((component) => component.coversTerm(term, config));
    if (!kept) demoted.push({ kind: 'term', name: term.name, clause: term.source?.clause ?? 'unknown' });
    return kept;
  });
  const unresolved = [...(ast.unresolved ?? []), ...demoted.map((entry) => ({
    clause: entry.clause,
    description: entry.kind === 'rule' ? `No venue in this deployment enforces the action "${entry.action}" (rule ${entry.id}); it stays a contractual obligation.` : `No component in this deployment consumes the term "${entry.name}"; it stays a contractual value.`,
  }))];
  return { ast: { ...ast, rules, terms, unresolved }, demoted };
}

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
export function deliberationRequest({ profile, document, draft = null, rounds = 2, model = MODEL, policyId = null, config = { profile }, room: nonce = room() }) {
  return {
    room_id: `mirr0tech-${profile}-${document.sha256.slice(2, 10)}-${nonce}`,
    deliberation_rounds: rounds,
    ...(policyId ? { policy_id: policyId } : { agent_names: AGENTS }),
    messages: [
      { role: 'user', content: `${instructionsFor(config)}\n\nAGREEMENT:\n${document.text}` },
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

// A whole agreement takes about four minutes a round on the legal seats (measured 2026-09-26).
export const ROUND_SECONDS = 240;

/// Percent done from the orchestrator's status line and time in the current round: each round is an
/// equal share, the share fills with elapsed time, and nothing short of completion reads 100.
export function progressOf(status, { rounds, roundStartedAt, now = Date.now() }) {
  const text = String(status ?? '');
  if (/^completed/i.test(text)) return 100;
  if (/^(pending|claimed|queued)/i.test(text)) return 2;
  const round = Number(text.match(/round\s+(\d+)/i)?.[1] ?? 1);
  const within = Math.min(0.9, Math.max(0, (now - roundStartedAt) / 1000 / ROUND_SECONDS));
  return Math.max(3, Math.min(97, Math.round(((Math.min(round, rounds) - 1 + within) / rounds) * 100)));
}

/// The confidence so far: the seats' scores of the latest scored round, mapped from [-1, 1] to [0, 1].
export function interimConfidence(details) {
  const history = details?.history ?? [];
  const latest = Math.max(0, ...history.map((entry) => entry.round ?? 0));
  const scores = history.filter((entry) => entry.round === latest).flatMap((entry) => (entry.evaluations ?? []).map((evaluation) => evaluation.evaluation?.score)).filter(Number.isFinite);
  if (!scores.length) return null;
  // The orchestrator scores in [-1, 1]; the mock never reports rounds, so it never reaches here.
  return Number((scores.reduce((sum, score) => sum + (score + 1) / 2, 0) / scores.length).toFixed(2));
}

const budgetError = (error) => {
  if ([402, 429].includes(error.status) && /budget|quota|credit/i.test(error.message)) return new Error(`The model account is out of credits (${error.status}); top up the Noolog account, or set EXTRACTOR=mock`);
  return error;
};

/// Returns { envelope, verification }: the AST the deliberation produced, and what it established about it.
/// `live` forces the orchestrator (default: EXTRACTOR=noolog); otherwise the in-process mock serves.
export async function extractWithNoolog({ profile, document, draft = null, client = null, pollMs = 10, onProgress = null, live = null, config = { profile } } = {}) {
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
    const policy = SEATED(MODEL) ? null : await client.policyFor(tagOf(MODEL));
    const policyId = policy?.policy_id ?? null;
    // The policy may run more rounds than requested; the larger bounds the progress bar.
    const rounds = Math.max(2, policy?.max_rounds ?? 2);
    // The legal seats review a draft instead of answering; live, they read the document alone. The mock needs the draft.
    let jobId;
    try { ({ job_id: jobId } = await client.startDeliberation(deliberationRequest({ profile, document, draft: server ? draft : null, policyId, config }))); } catch (error) { throw budgetError(error); }
    // A live deliberation with a legal seat list takes ~10 minutes per round on a whole agreement; the
    // wait matches the policy's own job timeout (an hour). The mock answers at once.
    let round = 0; let roundStartedAt = Date.now(); let confidence = null;
    const report = async (state) => {
      const current = Number(String(state.status).match(/round\s+(\d+)/i)?.[1] ?? 0);
      if (current > round) {
        round = current; roundStartedAt = Date.now();
        // A new round means the last one was scored: read the confidence so far.
        if (current > 1) confidence = interimConfidence(await client.details(jobId).catch(() => null)) ?? confidence;
      }
      await onProgress?.({ job_id: jobId, status: state.status, percent: progressOf(state.status, { rounds, roundStartedAt }), confidence });
    };
    const state = await client.waitForResult(jobId, server ? { pollMs, onProgress: report } : { pollMs: Math.max(pollMs, 3000), timeoutMs: 60 * 60_000, onProgress: report });
    if (state.status !== 'completed') throw new Error(`Deliberation ${jobId} ended ${state.status}`);
    // Demote first: what this deployment cannot enforce need not be well-formed to be set aside.
    const { ast: fitted, demoted } = fitToProfile(parseAstText(state.result), config);
    const ast = validateAst(fitted, document.text);
    const [details, references] = await Promise.all([client.details(jobId), client.references(jobId)]);
    const verification = { ...verificationFrom({ jobId, details, references }), mock: Boolean(server), model: MODEL };
    return {
      envelope: {
        ast, extraction: { provider: 'noolog', model: MODEL, responseId: jobId, agents: verification.agents, demoted },
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
export async function extractWithOpenAI({ profile = 'rwa-secondary', document, draft = null, fetchImpl = fetch, env = process.env, config = { profile } } = {}) {
  const { OPENAI_API_KEY: apiKey, OPENAI_MODEL: model = 'gpt-4.1', OPENAI_BASE_URL: base = 'https://api.openai.com/v1' } = env;
  if (!apiKey) throw new Error('Set OPENAI_API_KEY (and OPENAI_BASE_URL for another OpenAI-compatible endpoint)');
  const response = await fetchImpl(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: instructionsFor(config) }, { role: 'user', content: document.text }, ...(draft ? [{ role: 'assistant', content: JSON.stringify(draft) }, { role: 'user', content: 'Return the corrected JSON only.' }] : [])],
    }),
  });
  if (!response.ok) throw new Error(`Model call failed (HTTP ${response.status}): ${(await response.text().catch(() => '')).slice(0, 200)}`);
  const completion = await response.json();
  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error('The model returned no content');
  const { ast: fitted, demoted } = fitToProfile(parseAstText(content), config);
  const ast = validateAst(fitted, document.text);
  return {
    envelope: {
      ast, extraction: { provider: 'openai', model: completion.model ?? model, responseId: completion.id ?? null, baseUrl: base, demoted },
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
