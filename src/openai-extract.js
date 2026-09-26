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

export async function extractWorkspace({ generation = defaultGeneration(), draft, document, profile, onProgress = null, config = { profile }, ...options }) {
  // The live legal_rwa_pro deliberation: seats read the document alone, the result is fitted to the deployment.
  if (generation === 'noolog') return extractWithNoolog({ profile, document, live: true, onProgress, config });
  if (generation === 'demo') {
    if (!draft) throw new Error('Demo generation supports the bundled demo documents. Choose Upload files for your own contract.');
    return { envelope: { ast: validateAst(draft, document.text), source: sourceOf(document), extraction: { provider: 'demo', model: 'deterministic-fixture' } }, verification: null };
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
