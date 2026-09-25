// Turns a revert into the sentence that caused it. Venues wrap errors differently — Uniswap's pool
// manager wraps a hook revert in WrappedError, a SwapVM quote reverts directly — so this unwraps
// what it can and then looks the clause up in the table whose hash is committed on chain.
import { Interface } from 'ethers';

const WRAPPER = new Interface(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);
const KNOWN = new Interface([
  'error LegalClauseViolation(uint16 clauseId, bytes32 policyHash)',
  'error CounterpartyRefused(address subject, uint16 clauseId, bytes32 policyHash)',
  'error PolicyDenied(uint16 clauseId, bytes32 policyHash)',
  'error TransferRefused(address to, uint16 clauseId)',
  'error WithdrawalRefused(address lender, uint16 clauseId)',
  'error NoDepositCredential(address lender)',
  'error NoPolicyDoor(address subject)',
  'error TransfersDisabled()',
  'error DeadlineReached(address taker, uint256 deadline)',
]);

export function revertData(error) {
  return error?.info?.error?.data ?? error?.data ?? error?.error?.data ?? null;
}

export function decodeRefusal(error, clauseTable) {
  let data = revertData(error);
  if (typeof data !== 'string') return null;
  for (let depth = 0; depth < 3; depth++) {
    try { const outer = WRAPPER.parseError(data); if (!outer) break; data = outer.args.reason; } catch { break; }
  }
  let parsed = null;
  try { parsed = KNOWN.parseError(data); } catch { parsed = null; }
  if (!parsed) return { name: 'unknown', data };
  const clauseId = parsed.args.clauseId === undefined ? null : Number(parsed.args.clauseId);
  const clause = clauseId ? clauseTable?.clauses?.[clauseId - 1] ?? null : null;
  return { name: parsed.name, clauseId, clause, subject: parsed.args.subject ?? parsed.args.to ?? parsed.args.lender ?? null, policyHash: parsed.args.policyHash ?? null };
}
