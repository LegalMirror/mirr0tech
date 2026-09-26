import { testCompilerMapping } from './policy/test-mapping.js';
import { validateAst } from './policy/schema.js';
import { extractAst, sourceOf } from './policy/extract.js';
import { extractWithNoolog } from './noolog/extract.js';
export { OPENAI_MODEL } from './policy/extract.js';

export async function extractWithOpenAI({ document, apiKey = process.env.OPENAI_API_KEY || process.env.OPENAPI_KEY, ...options }) {
  return { envelope: await extractAst(document, { apiKey, ...options }), verification: null };
}

// EXTRACTOR=noolog makes the Noolog deliberation the default for uploads that name no generation.
export const GENERATIONS = ['demo', 'openai', 'noolog'];
export const defaultGeneration = () => (process.env.EXTRACTOR === 'noolog' ? 'noolog' : 'openai');
/// Noolog is the default reader when EXTRACTOR=noolog and the gateway holds a key; status routes report it.
export const noologDefault = () => process.env.EXTRACTOR === 'noolog' && Boolean(process.env.NOOLOG_API_KEY);
export const noologStatus = () => ({ provider: 'noolog', mode: 'live', model: process.env.NOOLOG_MODEL || 'nsed:legal_rwa_pro' });

/// MOCK_DELIBERATION_SECONDS: how long the fixture reading plays a simulated deliberation (0, the default, is instant).
export const mockDeliberationMs = (env = process.env) => {
  const seconds = Number(env.MOCK_DELIBERATION_SECONDS ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
};
const ROUNDS = 3;

/// The fixture AST, paced like a deliberation: three rounds over `paceMs`, the bar climbing and the
/// confidence so far after each scored round, ending with the in-process mock seats' verdicts.
/// The AST stays the fixture; the report is marked mock so the UI says it is simulated.
async function simulateDeliberation({ profile, document, draft, config, onProgress, paceMs, tickMs }) {
  const { verification } = await extractWithNoolog({ profile, document, draft, live: false, config });
  const job = `mock-${document.sha256.slice(2, 10)}-${Date.now().toString(36)}`;
  const started = Date.now();
  for (;;) {
    const share = Math.min(1, (Date.now() - started) / paceMs);
    const round = Math.min(ROUNDS, Math.floor(share * ROUNDS) + 1);
    const confidence = round === 1 ? null : Number((verification.confidence.overall * (0.8 + 0.1 * (round - 1))).toFixed(2));
    await onProgress?.({ job_id: job, status: `running: round ${round} — simulated`, percent: Math.max(2, Math.min(97, Math.round(share * 100))), confidence });
    if (share >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(tickMs, paceMs - (Date.now() - started))));
  }
  return verification;
}

export async function extractWorkspace({ generation = defaultGeneration(), draft, document, profile, onProgress = null, config = { profile }, paceMs = mockDeliberationMs(), tickMs = 500, ...options }) {
  // The live legal_rwa_pro deliberation: seats read the document alone, the result is fitted to the deployment.
  if (generation === 'noolog') return extractWithNoolog({ profile, document, live: true, onProgress, config });
  if (generation === 'demo') {
    if (!draft) throw new Error('Demo generation supports the bundled demo documents. Choose Upload files for your own contract.');
    const ast = validateAst(draft, document.text);
    // Only a job someone watches is paced; the boot-time policy export reads instantly.
    const verification = paceMs > 0 && onProgress ? await simulateDeliberation({ profile, document, draft, config, onProgress, paceMs, tickMs }) : null;
    return { envelope: { ast, source: sourceOf(document), extraction: { provider: 'demo', model: 'deterministic-fixture', ...(verification ? { simulated: true } : {}) } }, verification };
  }
  const result = await extractWithOpenAI({ document, ...options });
  const mapping = testCompilerMapping(document, profile);
  if (mapping) {
    result.envelope.documentAst = result.envelope.ast;
    result.envelope.ast = mapping.ast;
    result.envelope.extraction.compilerMapping = mapping.provenance;
  }
  return result;
}

// Explicitly selected fixtures keep offline compiler demos independent of paid extraction.
export const extractDemo = (input) => extractWorkspace({ ...input, generation: 'demo' });
