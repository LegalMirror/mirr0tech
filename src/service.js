import { randomUUID } from 'node:crypto';
import { parseUnits, formatUnits } from 'ethers';
import { canonical, sha256 } from './policy/document.js';
import { evaluatePolicy } from './policy/evaluate.js';
import { ensure, AppError } from './errors.js';

const MAX_UINT = 2n ** 256n - 1n;
export function amountUnits(value) {
  ensure(typeof value === 'string' && /^(0|[1-9][0-9]{0,70})(\.[0-9]{1,6})?$/.test(value), 400, 'INVALID_AMOUNT', 'Amount must be a decimal string with at most six decimal places');
  const units = parseUnits(value, 6);
  ensure(units > 0n && units <= MAX_UINT, 400, 'INVALID_AMOUNT', 'Amount must be positive and fit uint256');
  return units;
}
export const COMPLIANCE_FIELDS = ['kycApproved', 'amlApproved', 'sanctionsClear', 'subscriptionAccepted', 'issuerAuthorized', 'offeringCompliant', 'redemptionAuthorized'];
const timestamp = () => new Date().toISOString();
const audit = (state, type, details) => state.audit.push({ id: randomUUID(), at: timestamp(), type, ...details });

export class MirrorService {
  constructor({ store, chain, policy }) { Object.assign(this, { store, chain, policy }); this.queue = Promise.resolve(); }
  async init() {
    await this.chain.validate();
    const namespace = this.chain.identity;
    ensure(!this.store.state.namespace || this.store.state.namespace === namespace, 500, 'LEDGER_MISMATCH', 'Ledger belongs to another chain, deployment or policy; use a separate DATA_DIR');
    this.store.update((state) => { state.namespace = namespace; });
    if (!this.pending()) await this.checkSupply();
    return this;
  }
  serial(work) {
    const task = this.queue.then(work);
    this.queue = task.catch(() => {});
    return task;
  }
  pending() { return Object.values(this.store.state.operations).find((op) => op.status === 'pending'); }
  idle() { const pending = this.pending(); ensure(!pending, 409, 'RECONCILIATION_REQUIRED', 'Retry the pending operation with its original Idempotency-Key and body before making other changes', pending ? { operationId: pending.id, idempotencyKey: pending.key } : undefined); }
  investor(id) {
    ensure(typeof id === 'string' && Object.hasOwn(this.store.state.investors, id), 404, 'INVESTOR_NOT_FOUND', 'Investor not found');
    return this.store.state.investors[id];
  }
  async checkSupply() {
    const ledger = Object.values(this.store.state.investors).reduce((total, investor) => total + BigInt(investor.balanceUnits), 0n);
    ensure(await this.chain.totalSupply() === ledger, 409, 'SUPPLY_MISMATCH', 'On-chain supply differs from the investor ledger; reconciliation is required');
  }
  createInvestor(name) {
    return this.serial(() => {
      this.idle();
      ensure(typeof name === 'string' && name.trim().length > 0 && name.length <= 120, 400, 'INVALID_NAME', 'Investor name is required (max 120 characters)');
      return this.store.update((state) => {
        const investor = { id: randomUUID(), name: name.trim(), balanceUnits: '0', ...Object.fromEntries(COMPLIANCE_FIELDS.map((field) => [field, false])) };
        state.investors[investor.id] = investor;
        audit(state, 'investor.created', { investorId: investor.id });
        return investor;
      });
    });
  }
  setCompliance(id, patch) {
    return this.serial(() => {
      this.idle(); this.investor(id);
      ensure(patch && Object.keys(patch).length > 0 && Object.entries(patch).every(([key, value]) => COMPLIANCE_FIELDS.includes(key) && typeof value === 'boolean'), 400, 'INVALID_COMPLIANCE', 'Supply only supported boolean compliance fields');
      return this.store.update((state) => {
        Object.assign(state.investors[id], patch);
        audit(state, 'mock.compliance.updated', { investorId: id, patch });
        return state.investors[id];
      });
    });
  }
  createDeposit(investorId, amount) {
    return this.serial(() => {
      this.idle(); this.investor(investorId);
      const units = amountUnits(amount);
      return this.store.update((state) => {
        const deposit = { id: randomUUID(), investorId, units: units.toString(), consumedUnits: '0', status: 'pending', currency: 'USD', simulated: true };
        state.deposits[deposit.id] = deposit;
        audit(state, 'deposit.created', { depositId: deposit.id, investorId });
        return deposit;
      });
    });
  }
  settleMock(collection, id) {
    return this.serial(() => {
      this.idle();
      ensure(['deposits', 'withdrawals'].includes(collection) && Object.hasOwn(this.store.state[collection], id), 404, 'PAYMENT_NOT_FOUND', 'Payment not found');
      return this.store.update((state) => {
        const item = state[collection][id];
        const status = collection === 'deposits' ? 'confirmed' : 'settled';
        if (item.status !== status) {
          item.status = status;
          audit(state, `mock.${collection}.${status}`, { paymentId: id });
        }
        return item;
      });
    });
  }
  decision(action, investor, deposit, units) {
    const facts = Object.fromEntries(COMPLIANCE_FIELDS.map((field) => [field, investor[field]]));
    Object.assign(facts, {
      depositConfirmed: deposit?.status === 'confirmed',
      depositAvailable: Boolean(deposit && deposit.investorId === investor.id && BigInt(deposit.units) - BigInt(deposit.consumedUnits) >= units),
      sufficientBalance: BigInt(investor.balanceUnits) >= units,
    });
    const decision = evaluatePolicy(this.policy.ast, action, facts);
    // Operational invariants cannot be relaxed by an LLM-supplied permission.
    const required = ['kycApproved', 'amlApproved', 'sanctionsClear', 'offeringCompliant', ...(action === 'mint'
      ? ['issuerAuthorized', 'subscriptionAccepted', 'depositConfirmed', 'depositAvailable']
      : ['redemptionAuthorized', 'sufficientBalance'])];
    const failures = required.filter((fact) => facts[fact] !== true).map((fact) => `INVARIANT_${fact}`);
    return { ...decision, allowed: decision.allowed && failures.length === 0, reasons: [...decision.reasons, ...failures], facts };
  }
  operate(action, body, key) {
    return this.serial(async () => {
      ensure(['mint', 'burn'].includes(action), 400, 'INVALID_ACTION', 'Unsupported action');
      ensure(typeof key === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(key), 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply an Idempotency-Key header (1–128 letters, numbers, dots, underscores or hyphens)');
      const units = amountUnits(body.amount);
      const investor = this.investor(body.investorId);
      const request = { action, investorId: investor.id, units: units.toString(), depositId: action === 'mint' ? body.depositId : null };
      ensure(action !== 'mint' || (typeof body.depositId === 'string' && Object.hasOwn(this.store.state.deposits, body.depositId)), 404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
      const fingerprint = sha256(canonical(request));
      const id = `0x${sha256(`${this.chain.identity}:${key}`)}`;
      let operation = this.store.state.operations[id];
      if (operation) {
        ensure(operation.fingerprint === fingerprint, 409, 'IDEMPOTENCY_CONFLICT', 'This key was already used for a different request');
        if (operation.status === 'confirmed') return structuredClone(operation);
        ensure(operation.status !== 'failed', 409, 'OPERATION_FAILED', 'This operation failed. Use a new key after correcting the cause.');
      } else {
        this.idle();
        await this.checkSupply();
        const deposit = action === 'mint' ? this.store.state.deposits[body.depositId] : null;
        const decision = this.decision(action, investor, deposit, units);
        if (!decision.allowed) {
          this.store.update((state) => audit(state, 'policy.denied', { investorId: investor.id, action, reasons: decision.reasons, policyHash: this.policy.hash }));
          throw new AppError(403, 'POLICY_DENIED', 'Policy denied this operation', decision);
        }
        if (action === 'mint') ensure((await this.chain.totalSupply()) + units <= BigInt(this.policy.config.maxSupply), 409, 'SUPPLY_CAP', 'Mint would exceed maximum supply');
        operation = this.store.update((state) => {
          const intent = { id, key, fingerprint, ...request, status: 'pending', policyHash: this.policy.hash, decision, createdAt: timestamp(), transactionHash: null };
          state.operations[id] = intent;
          audit(state, 'operation.pending', { operationId: id, action, investorId: investor.id });
          return intent;
        });
      }
      let receipt;
      try {
        receipt = await this.chain.execute({ ...operation, onBroadcast: (hash) => {
          operation.transactionHash = hash;
          this.store.update((state) => { state.operations[id].transactionHash = hash; });
        } });
      } catch (error) {
        if (error.code === 'CHAIN_REJECTED') {
          this.store.update((state) => { state.operations[id].status = 'failed'; audit(state, 'operation.failed', { operationId: id }); });
          throw error;
        }
        throw new AppError(503, 'CHAIN_CONFIRMATION_PENDING', 'Chain outcome is uncertain. Retry with the same Idempotency-Key and body.', { operationId: id });
      }
      // Burn confirmation precedes creation of a payable withdrawal. All ledger effects commit together.
      return this.store.update((state) => {
        const holder = state.investors[investor.id];
        holder.balanceUnits = (BigInt(holder.balanceUnits) + (action === 'mint' ? units : -units)).toString();
        if (action === 'mint') {
          const deposit = state.deposits[request.depositId];
          deposit.consumedUnits = (BigInt(deposit.consumedUnits) + units).toString();
        } else {
          state.withdrawals[id] = { id, investorId: investor.id, units: units.toString(), currency: 'USD', status: 'pending', simulated: true, operationId: id };
        }
        Object.assign(state.operations[id], receipt, { status: 'confirmed', confirmedAt: timestamp(), amount: formatUnits(units, 6), withdrawalId: action === 'burn' ? id : null });
        audit(state, 'operation.confirmed', { operationId: id, action, investorId: investor.id, units: units.toString(), policyHash: this.policy.hash });
        return state.operations[id];
      });
    });
  }
  snapshot() { return structuredClone(this.store.state); }
}
