import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { convert } from 'html-to-text';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export async function readDocument(path) {
  const bytes = await readFile(path);
  if (bytes.length > 2_000_000) throw new Error('Document exceeds 2 MB limit');
  const extension = extname(path).toLowerCase();
  if (!['.txt', '.md', '.htm', '.html'].includes(extension)) throw new Error('Use a text, Markdown, or HTML document');
  const raw = bytes.toString('utf8');
  const text = (extension.startsWith('.ht') ? convert(raw, {
    wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }],
  }) : raw).replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Document is empty');
  return { name: basename(path), sha256: sha256(bytes), textSha256: sha256(text), text };
}
