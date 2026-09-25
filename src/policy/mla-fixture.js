import { validateAst } from './schema.js';

const fact = (name) => ({ type: 'fact', name });
const all = (...nodes) => ({ type: 'all', children: nodes.map((node) => (typeof node === 'string' ? fact(node) : node)) });
const none = (name) => ({ type: 'not', child: fact(name) });

// A hand-authored reading of three documents compiled as one bundle: the Wildcat template Master
// Loan Agreement with an illustrative Term Sheet, the borrower's Lender Check Policy (the MLA
// delegates admission to it), and a one-clause buyback addendum. In production the borrower's
// counsel attests to this structure; the compiler's job is to prove every rule and term is backed
// by a verbatim quote and to bind the result to the bundle's hash.
export function mlaFixture(document) {
  const rule = (id, action, effect, condition, clause, quote, rationale) =>
    ({ id, action, effect, condition, source: { clause, quote }, rationale });
  const term = (name, value, unit, clause, quote, rationale) =>
    ({ name, value, unit, source: { clause, quote }, rationale });
  const ast = {
    schemaVersion: '1.0',
    title: 'Wildcat Master Loan Agreement + Lender Check Policy + Buyback Addendum — executable subset',
    parties: [{ name: 'Demo MM Ltd', role: 'borrower' }, { name: 'Lender', role: 'lender' }],
    terms: [
      term('rescreeningIntervalDays', '30', 'days', 'Lender Check Policy 3.1',
        'valid for thirty (30) days from the date the checks were completed',
        'Attestations may not outlive the re-screening interval; the compiler enforces this on the deployment config.'),
      term('buybackPrice', '0.96', 'asset per market token', 'Addendum A1.1',
        'at a price of not less than 0.96 units of the Digital Asset To Be Loaned per Market Token',
        'The standing bid price the borrower commits to.'),
      term('buybackCap', '1000000', 'market tokens', 'Addendum A1.1',
        'up to an aggregate of 1,000,000 Market Tokens',
        'Cumulative fill cap for the standing bid.'),
      term('buybackDeadline', '2026-12-31', 'date', 'Addendum A1.2',
        'remains open until 2026-12-31',
        'The offer expires on this date unless revoked earlier.'),
      term('capacity', '20000000', 'mUSDC', 'Exhibit A',
        '**Maximum Amount of Digital Asset To Be Loaned**: 20,000,000 mUSDC',
        'Market capacity from the Term Sheet; displayed, not compiled to market parameters in this version.'),
      term('baseAprBps', '1000', 'bps', 'Exhibit A', '**Base APR**: 10.00%', 'Displayed only.'),
      term('reserveRatioBps', '2000', 'bps', 'Exhibit A', '**Minimum Reserve Ratio**: 20.00%', 'Displayed only.'),
      term('withdrawalCycleDays', '7', 'days', 'Exhibit A', '**Withdrawal Cycle Duration**: 7 days', 'Displayed only.'),
    ],
    rules: [
      // Admission. The MLA delegates the criteria to the borrower's Lender Check Policy.
      rule('deposit-admission', 'deposit', 'permit', all('mlaCountersigned', 'lenderCheckPassed', 'amlKycProvided'),
        'MLA 1) Role Provider', 'the successful completion of which grants a Lender a Deposit Credential',
        'A Deposit Credential is granted on successful completion of the Lender Check Process, which the policy below defines.'),
      rule('deposit-countersigned', 'deposit', 'require', fact('mlaCountersigned'), 'Lender Check Policy 2.1',
        'has countersigned the Master Loan Agreement and Term Sheet for the Market from the Specified Wallet Address',
        'The lender must have countersigned from the wallet being admitted.'),
      rule('deposit-due-diligence', 'deposit', 'require', fact('lenderCheckPassed'), 'Lender Check Policy 2.2',
        "verification of the Lender's identity and, where the Lender is an entity, verification of its beneficial owners",
        'Identity and beneficial-owner verification must be complete.'),
      rule('deposit-aml-information', 'deposit', 'require', fact('amlKycProvided'), 'MLA 3) j)',
        'provide such information considered reasonably necessary to allow the other Party to conduct appropriate anti-money laundering and know your customer checks',
        'The lender must have supplied the information the AML/KYC checks require.'),
      rule('deposit-not-insolvent', 'deposit', 'require', fact('notInsolvent'), 'MLA 3) e)',
        'it is not insolvent and is not subject to any bankruptcy or insolvency proceedings',
        'The solvency representation is recorded as an attested fact.'),
      rule('deposit-screening-current', 'deposit', 'require', fact('screeningCurrent'), 'Lender Check Policy 3.2',
        'A Lender whose result has expired is treated as not having completed the Lender Check Process',
        'An expired result removes the admission itself; the fact reverts to unknown and the deposit is denied.'),
      rule('deposit-sanctions', 'deposit', 'forbid', none('sanctionsClear'), 'MLA 13) b)',
        'the Oracle shall serve as the definitive source for determining whether any Wallet Address associated with a Party is subject to sanctions',
        'The sanctions oracle is definitive; an unknown result is treated as a block.'),

      // Payment-time eligibility.
      rule('withdraw-open-term', 'withdraw', 'permit', all('openTermState', 'lenderCheckPassed'), 'MLA 2) f)',
        'may request a Withdrawal via the Market while the latter is in an Open Term State',
        'Withdrawals are permitted in an Open Term State by a lender who cleared the Lender Check Process.'),
      rule('withdraw-screening-current', 'withdraw', 'require', fact('screeningCurrent'), 'Lender Check Policy 4.1',
        "the Borrower confirms that the Lender's Lender Check Process result is current at the time of payment",
        'Eligibility is re-evaluated at the moment of payment, not at onboarding.'),
      rule('withdraw-sanctions', 'withdraw', 'forbid', all(none('sanctionsClear'), none('borrowerOverride')), 'MLA 13) c)',
        'if the Borrower explicitly overrides the sanction via the Market, which they may do if they determine the Oracle designation was erroneous',
        'A sanctioned wallet is not paid unless the borrower has explicitly overridden the designation under Section 13(c)(y).'),

      // Secondary transfers, including a fill on a venue.
      rule('transfer-known-lender', 'transfer', 'permit', all('mlaCountersigned', 'lenderCheckPassed', 'screeningCurrent'), 'MLA 12) b)',
        'provided that such Third Party Beneficiary successfully completes any Lender Check Processes as may be specified via Role Providers by the Borrower',
        'Only a wallet that cleared the Lender Check Process may receive Market Tokens.'),
      rule('transfer-deposit-credential', 'transfer', 'require', all('mlaCountersigned', 'lenderCheckPassed', 'amlKycProvided', 'screeningCurrent'), 'Lender Check Policy 4.2',
        'Market Tokens may be transferred only to a Wallet Address that holds a valid Deposit Credential',
        'The recipient must satisfy the same conditions as a fresh Deposit Credential.'),
      rule('transfer-transferability-level', 'transfer', 'require', fact('lenderCheckPassed'), 'Exhibit A — Market Token Transferability',
        'transferable only to Known Lenders or Wallet Addresses holding valid Deposit Credentials',
        'The Term Sheet selects transferability level (ii).'),
      rule('transfer-sanctions', 'transfer', 'forbid', none('sanctionsClear'), 'MLA 13) a)',
        'monitored by a Chainalysis Sanctions Screening Oracle',
        'Transfers to or from a sanctioned wallet are blocked.'),
    ],
    unresolved: [
      { clause: 'MLA 4), 5)', description: 'Events of default, cure periods and remedies form a state machine with notice periods and human judgement; not compiled.' },
      { clause: 'MLA 6), 7)', description: 'Limitations on liability and loss-of-access arrangements are not executable.' },
      { clause: 'MLA 11)', description: 'Governing law, jurisdiction and Process Agent appointment are outside what a venue can enforce.' },
      { clause: 'MLA 13) c), e)', description: 'Sanctions Escrow creation is performed by the protocol Sentinel, and sanctions disputes are an evidentiary process. The compiled policy only withholds payment and admission; it does not escrow.' },
      { clause: 'Lender Check Policy 2.2, 2.3', description: "What counts as satisfactory due diligence and AML review is the compliance function's judgement; the policy consumes the outcome as attested facts." },
      { clause: 'Exhibit A', description: 'Capacity, APRs, reserve ratio and withdrawal cycle are captured as terms for display; compiling them to market parameters is not implemented in this version.' },
    ],
  };
  validateAst(ast, document.text);
  return {
    source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256, parts: document.parts },
    extraction: { provider: 'hand-authored-demo', model: null, responseId: null }, ast,
  };
}
