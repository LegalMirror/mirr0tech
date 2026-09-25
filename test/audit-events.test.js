import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEvents } from '../src/audit-events.js';

const entries = [
  { id: '1', at: '2026-09-25T19:47:00Z', type: 'attest', policy: 'credit', wallet: 'Lender A', status: 'ok', facts: { mlaCountersigned: true }, txHash: '0xaa' },
  { id: '2', at: '2026-09-25T19:48:00Z', type: 'sanction', wallet: 'Lender C', sanctioned: true, status: 'ok', txHash: '0xbb' },
  { id: '3', at: '2026-09-25T19:49:00Z', type: 'credit.deposit', policy: 'credit', wallet: 'Lender A', amount: '1000000', status: 'ok', txHash: '0xcc' },
  { id: '4', at: '2026-09-25T19:50:00Z', type: 'credit.buyback.quote', policy: 'credit', wallet: 'Stranger', status: 'refused', refusal: { name: 'CounterpartyRefused', clause: { clauseId: 4, clause: 'Lender Check Policy 4.2', quote: 'Market Tokens may be transferred only' } } },
  { id: '5', at: '2026-09-25T19:51:00Z', type: 'rwa.pool.swap', policy: 'rwa', wallet: 'Investor', hooked: true, status: 'ok', txHash: '0xdd' },
];

test('audit entries become timeline events, newest first, with the chain outcome and explorer links', () => {
  const credit = auditEvents(entries, 'wildcat-credit', 11155111);
  assert.deepEqual(credit.map((e) => e.id), ['4', '3', '2', '1'], 'rwa entries are filtered out; facts-only entries stay');
  const [quote, deposit, sanction, attest] = credit;
  assert.equal(quote.kind, 'QuoteRefused'); assert.equal(quote.outcome, 'refused'); assert.equal(quote.clauseId, 4); assert.equal(quote.action, 'transfer');
  assert.match(quote.summary, /Lender Check Policy 4\.2/); assert.equal(quote.explorer, null);
  assert.equal(deposit.kind, 'CredentialDecision'); assert.equal(deposit.action, 'deposit'); assert.equal(deposit.outcome, 'ok');
  assert.equal(deposit.explorer, 'https://sepolia.etherscan.io/tx/0xcc'); assert.equal(deposit.summary, 'deposited 1000000');
  assert.equal(sanction.kind, 'Revoked'); assert.equal(sanction.action, 'sanction');
  assert.equal(attest.kind, 'Attested'); assert.deepEqual(attest.facts, { mlaCountersigned: true });
  assert.equal(auditEvents(entries, 'wildcat-credit', 31337)[1].explorer, null, 'no explorer for a local chain');
  const rwa = auditEvents(entries, 'rwa-secondary', 11155111);
  assert.deepEqual(rwa.map((e) => e.id), ['5', '2'], 'the sanction shows on both acts');
  assert.equal(rwa[0].summary, 'swapped in the hooked pool');
});
