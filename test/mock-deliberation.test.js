import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDemo, mockDeliberationMs } from '../src/openai-extract.js';
import { draftFor } from '../src/agreements.js';
import { PROFILES } from '../scripts/export-ui.js';
import { readDocuments } from '../src/policy/document.js';

const document = await readDocuments(['test/human_contracts/ea026411904ex10-9.htm']);
const spec = PROFILES.find((entry) => entry.profile === 'rwa-secondary');
const draft = draftFor(spec, document, { profile: 'rwa-secondary' });

test('the pace comes from MOCK_DELIBERATION_SECONDS and is off by default', () => {
  assert.equal(mockDeliberationMs({}), 0);
  assert.equal(mockDeliberationMs({ MOCK_DELIBERATION_SECONDS: '12' }), 12000);
  assert.equal(mockDeliberationMs({ MOCK_DELIBERATION_SECONDS: 'x' }), 0);
});

test('without a pace the fixture reading is instant and carries no verdicts', async () => {
  const { envelope, verification } = await extractDemo({ profile: 'rwa-secondary', document, draft });
  assert.equal(envelope.extraction.provider, 'demo');
  assert.equal(verification, null);
});

test('with a pace the fixture reading plays a simulated deliberation: rounds, a climbing bar, the confidence so far, then verdicts', async () => {
  const seen = [];
  const started = Date.now();
  const { envelope, verification } = await extractDemo({ profile: 'rwa-secondary', document, draft, paceMs: 1200, tickMs: 50, onProgress: (state) => seen.push(state) });
  assert.ok(Date.now() - started >= 1200, 'the reading takes the whole pace');
  assert.deepEqual(envelope.ast, draft, 'the AST is the fixture, unchanged');
  assert.equal(envelope.extraction.provider, 'demo');
  assert.equal(envelope.extraction.simulated, true);
  assert.match(seen[0].job_id, /^mock-/);
  assert.ok(seen.every((state, index) => index === 0 || state.percent >= seen[index - 1].percent), 'the bar never goes back');
  assert.ok(seen.at(-1).percent <= 97, 'nothing short of completion reads 100');
  assert.deepEqual([...new Set(seen.map((state) => state.status.match(/round (\d)/)[1]))], ['1', '2', '3']);
  assert.equal(seen.find((state) => state.status.includes('round 1')).confidence, null, 'no confidence before a round is scored');
  assert.ok(seen.some((state) => typeof state.confidence === 'number'), 'later rounds report a confidence so far');
  assert.equal(verification.mock, true, 'the report says it is simulated');
  assert.ok(verification.claims.length > 0);
  assert.ok(verification.confidence.overall > 0 && verification.confidence.overall <= 1);
});
