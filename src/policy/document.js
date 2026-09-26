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
/// A document from bytes (or a string) already in hand: an upload, a test fixture, a file read.
export function documentFrom(name, bytes) {
  if (typeof bytes === 'string') bytes = Buffer.from(bytes, 'utf8');
  if (bytes.length > 2_000_000) throw new Error('Document exceeds 2 MB limit');
  const extension = extname(name).toLowerCase();
  if (!['.txt', '.md', '.htm', '.html'].includes(extension)) throw new Error('Use a text, Markdown, or HTML document');
  const raw = bytes.toString('utf8');
  const text = (extension.startsWith('.ht') ? convert(raw, {
    wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }],
  }) : raw).replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Document is empty');
  return { name: basename(name), sha256: sha256(bytes), textSha256: sha256(text), text };
}
export async function readDocument(path) {
  return documentFrom(path, await readFile(path));
}

// A policy may quote several documents at once: the agreement, the borrower's own policy, an
// addendum. They are read as one bundle so quote validation and hashing see a single text, while
// each part keeps its own hash for provenance.
export async function readDocuments(paths) {
  const parts = [];
  for (const path of paths) parts.push(await readDocument(path));
  return bundleDocuments(parts);
}

export function bundleDocuments(parts) {
  if (parts.length === 1) return parts[0];
  const text = parts.map((part) => part.text).join(' ');
  return {
    name: parts.map((part) => part.name).join('+'),
    sha256: sha256(canonical(parts.map((part) => part.sha256))),
    textSha256: sha256(text),
    text,
    sourceDocuments: parts.map((part, index) => ({ id: `document-${index + 1}`, name: part.name, sha256: part.sha256, textSha256: part.textSha256, text: part.text })),
    parts: parts.map(({ name, sha256: raw, textSha256 }) => ({ name, sha256: raw, textSha256 })),
  };
}
