import { validateAst } from './schema.js';

const fact = (name) => ({ type: 'fact', name });
const all = (...names) => ({ type: 'all', children: names.map(fact) });
// `secondary` adds the transfer rules a venue can enforce: only an onboarded investor may hold.
export function sampleFixture(document, { secondary = false } = {}) {
  const rule = (id, action, effect, condition, clause, quote, rationale) => ({ id, action, effect, condition, source: { clause, quote }, rationale });
  const ast = {
    schemaVersion: '1.0',
    title: 'Platform Services, Transfer Agent and Registrar Agreement — executable subset',
    parties: [{ name: 'Securitize LLC', role: 'transfer agent' }, { name: 'BlackRock USD Institutional Digital Liquidity Fund Ltd.', role: 'issuer' }],
    terms: [],
    rules: [
      rule('issuance-authorized', 'mint', 'permit', all('issuerAuthorized', 'offeringCompliant'), '2.1–2.2',
        'Securitize is authorized and directed to issue and credit', 'An operator must attest that issuance prerequisites and offering restrictions have been satisfied.'),
      rule('subscription-documents', 'mint', 'require', fact('subscriptionAccepted'), '2.2',
        'completed Subscription Documents determined to be in good form', 'Subscription documents must be accepted before issuance.'),
      rule('funds-received', 'mint', 'require', fact('depositConfirmed'), '2.2',
        'confirmation of receipt or crediting of funds for such order', 'Mint only after the custodian confirms funding.'),
      rule('redemption-authorized', 'burn', 'permit', all('redemptionAuthorized', 'offeringCompliant'), '2.2',
        'redemption is legally authorized.', 'The operator attests that this redemption is authorized and complies with the offering memorandum.'),
      ...(secondary ? [
        rule('transfer-onboarded-holder', 'transfer', 'permit', all('kycApproved', 'amlApproved'), 'Exhibit A — Investor Onboarding',
          'and sanctions checks during onboarding of investors and apply risk rating to each investor',
          'Only an investor who completed onboarding may receive or hold shares, at a venue or otherwise.'),
        rule('transfer-sanctions-block', 'transfer', 'forbid', { type: 'not', child: fact('sanctionsClear') }, 'Exhibit A — Investor Onboarding',
          'escalating and applying blocks in accordance with Sanctions Laws.', 'Shares do not move to or from a wallet without a clear sanctions result.'),
      ] : []),
      ...['mint', 'burn'].flatMap((action) => [
        rule(`${action}-onboarding`, action, 'require', all('kycApproved', 'amlApproved'), 'Exhibit A — Investor Onboarding',
          'and sanctions checks during onboarding of investors and apply risk rating to each investor',
          'MVP interpretation: require completed KYC/KYB and AML onboarding for token operations; entity-specific KYB is folded into the mock KYC result.'),
        rule(`${action}-sanctions-block`, action, 'forbid', { type: 'not', child: fact('sanctionsClear') }, 'Exhibit A — Investor Onboarding',
          'escalating and applying blocks in accordance with Sanctions Laws.', 'Block an investor without a clear sanctions result.'),
      ]),
    ],
    unresolved: [
      { clause: 'Preamble; 2.1–2.2', description: 'Omitted schedules, offering memorandum, legal opinion and issuer instructions must be supplied to establish real issuance and redemption eligibility. Demo attestations stand in for these prerequisites.' },
      { clause: 'Exhibit A', description: 'Risk ratings, KYB, ongoing monitoring and legal authorization require external compliance systems and judgment; boolean mock outcomes only approximate them.' },
      { clause: 'Agreement generally', description: 'This hand-authored fixture covers token operations only. Fees, confidentiality, tax reporting, distributions, termination and other obligations are not compiled.' },
    ],
  };
  validateAst(ast, document.text);
  return {
    source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256 },
    extraction: { provider: 'hand-authored-demo', model: null, responseId: null }, ast,
  };
}
