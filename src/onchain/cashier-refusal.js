import { Interface } from 'ethers';
import { revertData } from './refusal.js';

const WRAPPER = new Interface(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);
const ERRORS = new Interface([
  'error CashierRefused(uint16 clauseId, bytes32 policyHash, uint8 reason)',
  'error ExecutionRefused(uint16 clauseId, bytes32 policyHash, uint8 reason)',
]);
const REASONS = { 1: 'Unsupported or zero-output order', 2: 'Insufficient prefunded reserve', 3: 'Outstanding supply cap exceeded', 4: 'Minimum output or full-input bound not met', 5: 'Order deadline expired' };

export function decodeCashierRefusal(error, clauseTable) {
  let data = revertData(error);
  if (typeof data !== 'string') return null;
  for (let depth = 0; depth < 4; depth++) {
    try { const wrapped = WRAPPER.parseError(data); if (!wrapped) break; data = wrapped.args.reason; } catch { break; }
  }
  let parsed;
  try { parsed = ERRORS.parseError(data); } catch { return null; }
  if (!parsed || parsed.args.policyHash !== clauseTable?.policyHash) return null;
  const clauseId = Number(parsed.args.clauseId);
  const reason = Number(parsed.args.reason);
  return { name: parsed.name, policyHash: parsed.args.policyHash, clauseId, clause: clauseTable.clauses[clauseId - 1] ?? null,
    subject: null, reason, description: REASONS[reason] ?? 'Cashier refused' };
}
