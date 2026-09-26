import { validateAst } from './policy/schema.js';
import { extractAst, sourceOf } from './policy/extract.js';
export { OPENAI_MODEL } from './policy/extract.js';

export async function extractWithOpenAI({ document, apiKey = process.env.OPENAI_API_KEY || process.env.OPENAPI_KEY, ...options }) {
  return { envelope: await extractAst(document, { apiKey, ...options }), verification: null };
}

export async function extractWorkspace({ generation = 'openai', draft, document, ...options }) {
  if (generation === 'demo') {
    if (!draft) throw new Error('Demo generation supports the bundled demo documents. Choose Upload files for your own contract.');
    return { envelope: { ast: validateAst(draft, document.text), source: sourceOf(document), extraction: { provider: 'demo', model: 'deterministic-fixture' } }, verification: null };
  }
  return extractWithOpenAI({ document, ...options });
}

// Explicitly selected fixtures keep offline compiler demos independent of paid extraction.
export const extractDemo = (input) => extractWorkspace({ ...input, generation: 'demo' });
