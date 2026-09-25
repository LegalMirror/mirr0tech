import { validateAst } from './schema.js';

const fact = (name) => ({ type: 'fact', name });
const all = (...names) => ({ type: 'all', children: names.map(fact) });
const none = (name) => ({ type: 'not', child: fact(name) });

// A hand-authored reading of the sample Master Loan Agreement. In production this is the borrower's
// counsel attesting to the structured policy; the compiler's job is to prove every rule is backed by
// a verbatim quote and to bind the result to the document's hash.
export function mlaFixture(document) {
  const rule = (id, action, effect, condition, clause, quote, rationale) =>
    ({ id, action, effect, condition, source: { clause, quote }, rationale });
  const ast = {
    schemaVersion: '1.0',
    title: 'Master Loan Agreement (sample) — executable lender admission subset',
    parties: [{ name: 'Borrower', role: 'borrower' }, { name: 'Lender', role: 'lender' }],
    rules: [
      rule('deposit-admission', 'deposit', 'permit',
        all('mlaExecuted', 'kycApproved', 'amlApproved', 'jurisdictionPermitted', 'accreditedInvestor'),
        '2.1–2.4', 'No person may deposit into the Market unless that person has executed this Agreement',
        'Admission requires an executed agreement, completed due diligence, a permitted jurisdiction and professional status.'),
      rule('deposit-due-diligence', 'deposit', 'require', all('kycApproved', 'amlApproved'), '2.2',
        'completed customer due diligence, including identification and verification of the Lender',
        'Customer due diligence covers both identity verification and the entity-level checks folded into the AML result.'),
      rule('deposit-jurisdiction', 'deposit', 'require', fact('jurisdictionPermitted'), '2.3',
        'resident in, or organised under the laws of, a jurisdiction in which the offering of participations in the Market is prohibited',
        'A lender in a prohibited jurisdiction may not be admitted.'),
      rule('deposit-screening-current', 'deposit', 'require', fact('screeningCurrent'), '3.1',
        'a Lender whose screening has lapsed shall be treated as not having satisfied Clause 2 until screening is renewed',
        'Lapsed screening removes the admission itself, so the fact returns to unknown and the deposit is denied.'),
      rule('deposit-capacity', 'deposit', 'require', fact('lenderCapacityAvailable'), '4.2',
        'No deposit shall be accepted where it would cause the Lender’s participation to exceed the capacity allocated to that Lender'
          .replace('’', "'"),
        'Deposits are capped at the capacity the borrower allocated to that lender.'),
      rule('deposit-sanctions', 'deposit', 'forbid', none('sanctionsClear'), '2.5',
        'shall apply blocks in accordance with Sanctions Laws',
        'A lender without a clear sanctions result is blocked, and an unknown result is treated the same way.'),

      rule('withdraw-cycle', 'withdraw', 'permit', fact('withdrawalWindowOpen'), '5.1',
        'withdrawal of principal and accrued interest in accordance with the withdrawal cycle of the Market',
        'Withdrawals are permitted within the market’s withdrawal cycle.'.replace('’', "'")),
      rule('withdraw-conditions-at-payment', 'withdraw', 'require',
        all('mlaExecuted', 'kycApproved', 'amlApproved', 'jurisdictionPermitted', 'screeningCurrent'), '5.2',
        'No payment shall be made to a Lender in respect of whom the conditions of Clause 2 have ceased to be satisfied at the time the payment is to be made',
        'Eligibility is re-evaluated at the moment of payment, not at onboarding.'),
      rule('withdraw-lockup', 'withdraw', 'require', fact('lockupElapsed'), '5.3',
        'A Lender may not withdraw before the expiry of the minimum commitment period',
        'The minimum commitment period must have elapsed.'),
      rule('withdraw-sanctions', 'withdraw', 'forbid', none('sanctionsClear'), '2.5',
        'shall not admit, and shall not permit any dealing by, any person who appears on a sanctions list',
        'Paying a sanctioned counterparty is a dealing, so the block applies at payment time.'),

      rule('transfer-to-admitted-lender', 'transfer', 'permit', all('mlaExecuted', 'kycApproved', 'screeningCurrent'), '6.1',
        'may not be transferred except to a person who has themselves been admitted under Clause 2 and whose screening is current at the time of transfer',
        'Only an admitted lender with current screening may receive market tokens.'),
      rule('transfer-sanctions', 'transfer', 'forbid', none('sanctionsClear'), '2.5',
        'apply blocks in accordance with Sanctions Laws',
        'Transfers to or from a sanctioned wallet are blocked.'),
    ],
    unresolved: [
      { clause: '3.2', description: 'The obligation to act immediately on an adverse result between screenings is operational. The attestor exposes instant fact revocation, but whether it is used, and how fast, is a process commitment outside this compilation.' },
      { clause: '4.1', description: 'Capacity allocated to each lender is set by the borrower outside the agreement text. The compiled policy consumes it as an attested fact and does not derive the number.' },
      { clause: '5.1, 5.3', description: 'The withdrawal cycle and minimum commitment period are defined in the market terms rather than the agreement, so both arrive as attested facts.' },
      { clause: 'Agreement generally', description: 'Interest, fees, delinquency, events of default, governing law and dispute resolution are not compiled. This subset covers lender admission, payment eligibility and transfer restrictions only.' },
    ],
  };
  validateAst(ast, document.text);
  return {
    source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256 },
    extraction: { provider: 'hand-authored-demo', model: null, responseId: null }, ast,
  };
}
