// The component library the compiler links against. A component declares which rules and terms it
// can enforce, which contracts it needs built, and the clause a lawyer pastes into an agreement to
// authorize it. The compiler resolves every rule and term to at least one enforcing component;
// anything unclaimed is a compile error, not a guess. Component ids and versions are committed
// inside the policy hash, so the hash names the exact audited blocks that enforce a document.
//
// Parameters, never shape: a clause fills a slot in a component; it never assembles code.

const CORE = 'core';
const V4 = 'uniswap-v4';
const SWAPVM = 'swapvm';

const byAction = (...actions) => (rule) => actions.includes(rule.action);
const byTerm = (...names) => (term) => names.includes(term.name);

export const COMPONENTS = [
  {
    id: 'policy-eval', version: '1.0.0', kind: 'logic',
    description: 'Three-valued evaluator; every boolean rule is compiled to DNF bitmasks it decides from.',
    coversRule: () => true, coversTerm: () => false,
    contracts: [[CORE, 'contracts/PolicyEval.sol', null]],
  },
  {
    id: 'attestor', version: '1.0.0', kind: 'facts',
    description: 'Attested facts with expiry and revocation; a re-screening interval bounds the attestation window.',
    coversRule: () => false, coversTerm: byTerm('rescreeningIntervalDays'),
    contracts: [[CORE, 'contracts/PolicyAttestor.sol', 'PolicyAttestor']],
    check(ast, config) {
      const term = ast.terms.find((entry) => entry.name === 'rescreeningIntervalDays');
      if (term && config.attestationValiditySeconds > Number(term.value) * 86400) {
        throw new Error(`Attestations may not outlive the re-screening interval the agreement requires (${term.value} days)`);
      }
    },
  },
  {
    id: 'policy-oracle', version: '1.0.0', kind: 'facts',
    description: 'Assembles attested, derived and observable facts once for every venue; the sanctions oracle the agreement names is read, never attested.',
    coversRule: () => false, coversTerm: () => false,
    contracts: [[CORE, 'contracts/PolicyOracle.sol', 'PolicyOracle'], [CORE, 'contracts/MockSanctionsOracle.sol', 'MockSanctionsOracle'], [CORE, 'contracts/test/MockERC20.sol', 'MockERC20']],
  },
  {
    id: 'custodial-token', version: '1.0.0', kind: 'venue', venue: 'token',
    description: 'Permissioned ERC-20 under custody: mint and burn under the agreement, transfers off until a venue is configured.',
    coversRule: byAction('mint', 'burn'), coversTerm: () => false,
    contracts: [[CORE, 'contracts/MirrorToken.sol', 'MirrorToken'], [CORE, 'generated/CompiledMirrorToken.sol', 'CompiledMirrorToken']],
    clauseTemplate: 'Shares shall be issued and redeemed only for investors who have completed the onboarding described in {{onboardingClause}}.',
  },
  {
    id: 'v4-transfer-gate', version: '1.0.0', kind: 'venue', venue: 'uniswap-v4',
    description: 'Uniswap v4 hook enforcing the transfer rules on add/remove liquidity and swap; the token\'s only door into a pool.',
    coversRule: byAction('transfer'), coversTerm: () => false,
    contracts: [[V4, 'contracts/MirrorPolicyHook.sol', 'MirrorPolicyHook'], [V4, 'contracts/test/MirrorLiquidityRouter.sol', 'MirrorLiquidityRouter'], [V4, 'contracts/test/MockERC20.sol', 'MockERC20'], [V4, 'node_modules/@uniswap/v4-core/src/PoolManager.sol', 'PoolManager']],
    clauseTemplate: 'Shares may be pooled or exchanged only at a venue that admits each counterparty under {{transferClause}} at the time of the transfer.',
  },
  {
    id: 'wildcat-admission', version: '1.0.0', kind: 'venue', venue: 'wildcat',
    description: 'Wildcat role provider: deposit credentials, payment-time eligibility and transfer restriction from the agreement.',
    coversRule: byAction('deposit', 'withdraw', 'transfer'), coversTerm: () => false,
    contracts: [[CORE, 'contracts/MirrortechRoleProvider.sol', 'MirrortechRoleProvider'], [CORE, 'contracts/MockWildcatMarket.sol', 'MockWildcatMarket']],
    clauseTemplate: 'The Borrower shall admit Lenders through a Role Provider that grants a Deposit Credential only on successful completion of the Lender Check Process set out in {{lenderCheckPolicy}}.',
  },
  {
    id: 'swapvm-buyback', version: '1.0.0', kind: 'venue', venue: 'aqua',
    description: '1inch Aqua strategy with the agreement as an opcode: a standing buyback at a fixed price, capped and dated, refusing ineligible parties at quote time.',
    coversRule: byAction('transfer'), coversTerm: byTerm('buybackPrice', 'buybackCap', 'buybackDeadline', 'buybackCeiling', 'buybackWindowHours'),
    contracts: [[SWAPVM, 'contracts/swapvm/MirrortechRouter.sol', 'MirrortechRouter'], [SWAPVM, 'vendor/aqua/src/Aqua.sol', 'Aqua']],
    clauseTemplate: 'The Borrower will purchase Market Tokens from any Known Lender at a price of not less than {{price}} per Market Token, up to an aggregate of {{cap}} Market Tokens, until {{deadline}}, through a venue that admits as counterparty only a Wallet Address holding a valid Deposit Credential. The Borrower may open the offer at that price and improve it over a window of not more than {{windowHours}} hours, up to a ceiling of {{ceiling}} per Market Token.',
  },
  {
    id: 'market-terms', version: '1.0.0', kind: 'terms',
    description: 'Term Sheet figures captured with their quotes for display; compiling them to market parameters is roadmap.',
    coversRule: () => false, coversTerm: byTerm('capacity', 'baseAprBps', 'penaltyAprBps', 'reserveRatioBps', 'withdrawalCycleDays', 'gracePeriodDays', 'minimumDeposit'),
    contracts: [],
  },
];

// Profiles are named component sets — sugar over the registry, nothing more.
export const PROFILES = {
  'custodial-rwa': ['policy-eval', 'attestor', 'policy-oracle', 'custodial-token'],
  'rwa-secondary': ['policy-eval', 'attestor', 'policy-oracle', 'custodial-token', 'v4-transfer-gate'],
  'wildcat-credit': ['policy-eval', 'attestor', 'policy-oracle', 'wildcat-admission', 'swapvm-buyback', 'market-terms'],
};

export const componentById = (id) => {
  const component = COMPONENTS.find((entry) => entry.id === id);
  if (!component) throw new Error(`Unknown component: ${id}`);
  return component;
};

// Links the AST against the profile's components. Every rule needs an enforcing venue component for
// its action and every term needs a component that consumes it; otherwise compilation fails.
export function resolveComponents(ast, config) {
  const profile = config.profile ?? 'custodial-rwa';
  const ids = PROFILES[profile];
  if (!ids) throw new Error(`Unknown deployment profile: ${profile}`);
  const components = ids.map(componentById);
  const rules = {};
  for (const rule of ast.rules) {
    const enforcers = components.filter((component) => component.kind === 'venue' && component.coversRule(rule, config)).map((component) => component.id);
    if (enforcers.length === 0) throw new Error(`No component in profile ${profile} enforces action "${rule.action}" (rule ${rule.id})`);
    rules[rule.id] = enforcers;
  }
  const terms = {};
  for (const term of ast.terms) {
    const consumers = components.filter((component) => component.coversTerm(term, config)).map((component) => component.id);
    if (consumers.length === 0) throw new Error(`No component in profile ${profile} consumes term "${term.name}"`);
    terms[term.name] = consumers;
  }
  for (const component of components) component.check?.(ast, config);
  return {
    components: components.map(({ id, version }) => ({ id, version })),
    coverage: { rules, terms },
    contracts: components.flatMap((component) => component.contracts),
    manifest: components.map(({ id, version, kind, venue, description, clauseTemplate, contracts }) => ({
      id, version, kind, venue: venue ?? null, description, clauseTemplate: clauseTemplate ?? null,
      contracts: contracts.map(([bundle, path, name]) => ({ bundle, path, name })),
      rules: Object.entries(rules).filter(([, ids]) => ids.includes(id)).map(([ruleId]) => ruleId),
      terms: Object.entries(terms).filter(([, ids]) => ids.includes(id)).map(([name]) => name),
    })),
  };
}
