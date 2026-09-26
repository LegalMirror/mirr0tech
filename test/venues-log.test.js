import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import { VenueService } from '../src/onchain/venues.js';

const REFUSALS = new Interface(['error TransferRefused(address to, uint16 clauseId)']);
const table = { clauses: [{ clauseId: 1, ruleId: 'transfer-identity-verified', clause: '3', quote: 'An investor must verify their identity' }] };
const service = (lines) => ({
  audit: [], log: (line) => lines.push(line), persist: async () => {}, settled: async () => {},
  policy: () => ({ clauseTable: table }), name: (address) => address, record: { rwa: { router: '0x0000000000000000000000000000000000000001' } },
});
const sent = { wait: async () => ({ hash: '0xswap', blockNumber: 1, logs: [] }) };

test('every venue call logs its outcome: the transaction when it went through, the clause when the policy refused', async () => {
  const lines = [];
  const self = service(lines);
  await VenueService.prototype.run.call(self, 'rwa.pool.swap', { policy: 'rwa', wallet: 'Investor', hooked: true }, async () => sent);
  assert.equal(lines.at(-1), 'rwa.pool.swap Investor ok tx=0xswap');
  await VenueService.prototype.run.call(self, 'rwa.mint', { policy: 'rwa', amount: '100' }, async () => sent);
  assert.equal(lines.at(-1), 'rwa.mint ok tx=0xswap');
  const refused = Object.assign(new Error('execution reverted'), { data: REFUSALS.encodeErrorResult('TransferRefused', ['0x00000000000000000000000000000000000000aa', 1]) });
  await assert.rejects(VenueService.prototype.run.call(self, 'rwa.pool.swap', { policy: 'rwa', wallet: 'Stranger', hooked: true }, async () => { throw refused; }), (error) => error.status === 403);
  assert.equal(lines.at(-1), 'rwa.pool.swap Stranger refused transfer-identity-verified');
  await assert.rejects(VenueService.prototype.run.call(self, 'rwa.pool.swap', { policy: 'rwa', wallet: 'Investor', hooked: true }, async () => { throw new Error('nonce too low'); }), (error) => error.status === 500);
  assert.equal(lines.at(-1), 'rwa.pool.swap Investor refused nonce too low');
  assert.equal(self.audit.length, 4, 'the audit keeps every outcome the log names');
});
