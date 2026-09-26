import { sourceDocuments } from '../legal/ast.js';
import { sampleFixture } from './fixture.js';
import { mlaFixture } from './mla-fixture.js';

// Explicit MVP mappings, not a model interpretation or a general legal-to-code compiler.
// Match the WHOLE normalized source set, not filenames or a handful of quoted phrases.
// An edit, extra document, missing addendum, or duplicate must not inherit this authority.
const FUND = 'afe4e4baf50e5c757d3bb9dec8583b6633786aeed0be5548af9d0cfa2b77d3c6';
const CREDIT = [
  '7f981acb175b949e0a271002739934f61e28790f3cca5891380ee127fd9247c5',
  '4bd44af3e896960e4d9edd8ba563fb1f19e37ebfa7665fafde2b2b21a61c2cae',
  '172b13d85f2a5c13e49b9bfe3c26631bad5b43a186461136d1f480d884fb4483',
];

export function testCompilerMapping(document, profile) {
  const hashes = sourceDocuments(document).map((doc) => doc.textSha256).sort();
  const matches = (expected) => JSON.stringify(hashes) === JSON.stringify([...expected].sort());
  let id, ast;
  if (matches([FUND]) && ['custodial-rwa', 'rwa-secondary'].includes(profile)) {
    id = `fund-${profile}-v1`;
    ast = sampleFixture(document, { secondary: profile === 'rwa-secondary' }).ast;
  } else if (matches(CREDIT) && profile === 'wildcat-credit') {
    id = 'wildcat-mla-lender-buyback-v1';
    ast = mlaFixture(document).ast;
  } else return null;
  return { ast, provenance: { provider: 'explicit-test-mapping', id, sourceTextHashes: hashes,
    scope: 'MVP executable subset with simulated compliance and settlement; unresolved provisions remain excluded.' } };
}
