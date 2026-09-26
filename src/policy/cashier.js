import { AbiCoder, keccak256 } from 'ethers';
import { canonical, sha256 } from './document.js';
import { sampleFixture } from './fixture.js';

// Only this separately authored DEMO grammar is supported, never arbitrary legal prose.
const EXECUTION_QUOTE = 'The DEMO cashier may issue or redeem only for a wallet admitted by the transfer policy and the applicable issuance or redemption policy. Only full exact-input orders are supported. A trusted router may try the real AMM execution and revert that attempt if its output is below the cashier quote, then execute the cashier through Uniswap v4 custom accounting. Subscriptions must actually pay mockUSD into the cashier reserve; redemptions burn shares and pay only from prefunded available mockUSD reserves. A caller minimum output and deadline apply to both routes. Zero-output orders are refused. No reserve withdrawal is authorized in this demo.';
const RATIONALE = 'Explicit DEMO addendum only; not economics attributed to the base agreement.';
const SPECS = [
  ['navUsd', 'USD/share', 'DEMO NAV', /DEMO NAV is USD ([0-9.]+) per share; shares and mockUSD each use six decimals\./g],
  ['subscriptionFeeBps', 'bps', 'DEMO subscription fee', /The DEMO subscription fee is ([0-9]+) basis points added to NAV, so exact-input subscriptions issue floor\(mockUSD input \/ ([0-9.]+)\) share units\./g],
  ['redemptionFeeBps', 'bps', 'DEMO redemption fee', /The DEMO redemption fee is ([0-9]+) basis points deducted from NAV, so exact-input redemptions pay floor\(share input \* ([0-9.]+)\) mockUSD units\./g],
  ['cashierSupplyCap', 'shares', 'DEMO supply cap', /The DEMO maximum outstanding supply is ([0-9.]+) shares, including custodial and cashier issuance\./g],
];

function scaledDecimal(value, decimals, label) {
  const pattern = new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`);
  if (typeof value !== 'string' || value.length > 90 || !pattern.test(value)) throw new Error(`Invalid ${label}: exact decimal with at most ${decimals} places required`);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}

export function readCashierTerms(document) {
  const matches = SPECS.map(([name, unit, clause, pattern]) => {
    const found = [...document.text.matchAll(pattern)];
    if (found.length !== 1) throw new Error(`Cashier term ${name} requires exactly one supported DEMO addendum sentence`);
    const [quote, value, factor] = found[0];
    return { term: { name, value, unit, source: { clause, quote }, rationale: RATIONALE }, factor };
  });
  if (document.text.split(EXECUTION_QUOTE).length !== 2) throw new Error('Cashier term cashierExecution requires exactly one supported DEMO addendum sentence');
  const nav = scaledDecimal(matches[0].term.value, 6, 'NAV');
  if (nav === 0n || nav >= 2n ** 128n) throw new Error('Cashier NAV must be a nonzero uint128 in micro USD');
  const fees = matches.slice(1, 3).map(({ term }) => {
    if (!/^(0|[1-9][0-9]*)$/.test(term.value) || BigInt(term.value) >= 10000n) throw new Error('Cashier fees must be integer basis points below 10000');
    return BigInt(term.value);
  });
  // Factors have up to ten decimal places: six for NAV and four for the BPS denominator.
  if (scaledDecimal(matches[1].factor, 10, 'subscription factor') !== nav * (10000n + fees[0])) throw new Error('Subscription quote factor disagrees with the document NAV and fee');
  if (scaledDecimal(matches[2].factor, 10, 'redemption factor') !== nav * (10000n - fees[1])) throw new Error('Redemption quote factor disagrees with the document NAV and fee');
  const cap = scaledDecimal(matches[3].term.value, 6, 'supply cap');
  if (cap === 0n || cap >= 2n ** 256n) throw new Error('Cashier supply cap must fit a nonzero uint256');
  return [...matches.map(({ term }) => term), { name: 'cashierExecution', value: '1', unit: 'enabled',
    source: { clause: 'DEMO execution and reserves', quote: EXECUTION_QUOTE }, rationale: RATIONALE }];
}

export function cashierFixture(document) {
  const envelope = sampleFixture(document, { secondary: true });
  envelope.ast.terms.push(...readCashierTerms(document));
  return envelope;
}

export function validateCashier(ast, config, document, demo) {
  if (config.cashier === undefined) return null;
  if (!demo || config.profile !== 'rwa-secondary' || canonical(config.cashier) !== canonical({ enabled: true, pool: config.cashier?.pool })) {
    throw new Error('Cashier requires DEMO rwa-secondary and cashier: { enabled: true, pool: { fee, tickSpacing } }; economics cannot be set in config');
  }
  const pool = config.cashier.pool;
  if (!pool || canonical(pool) !== canonical({ fee: pool.fee, tickSpacing: pool.tickSpacing })
      || !Number.isInteger(pool.fee) || pool.fee < 0 || pool.fee >= 1_000_000
      || !Number.isInteger(pool.tickSpacing) || pool.tickSpacing < 1 || pool.tickSpacing > 32767) {
    throw new Error('Cashier pool requires a static v4 fee in [0, 1000000) and tickSpacing in [1, 32767]');
  }
  const expected = readCashierTerms(document);
  for (const evidence of expected) {
    const term = ast.terms.find((entry) => entry.name === evidence.name);
    if (!term || term.value !== evidence.value || term.unit !== evidence.unit || canonical(term.source) !== canonical(evidence.source)) {
      throw new Error(`Cashier term ${evidence.name} must match the supported DEMO addendum verbatim`);
    }
  }
  const byName = Object.fromEntries(expected.map((term) => [term.name, term.value]));
  const navMicroUsd = scaledDecimal(byName.navUsd, 6, 'NAV').toString();
  const maxSupply = scaledDecimal(byName.cashierSupplyCap, 6, 'supply cap').toString();
  if (config.maxSupply !== maxSupply) throw new Error('Cashier supply cap disagrees with DEMO addendum');
  if (config.priceModel === 'one-token-per-usd' && navMicroUsd !== '1000000') throw new Error('A non-dollar NAV requires priceModel: fixed-nav');
  for (const action of ['mint', 'burn', 'transfer']) {
    if (!ast.rules.some((rule) => rule.action === action && rule.effect === 'permit')) throw new Error(`Cashier requires ${action} policy`);
  }
  return { navMicroUsd, subscriptionFeeBps: Number(byName.subscriptionFeeBps), redemptionFeeBps: Number(byName.redemptionFeeBps),
    shareDecimals: 6, assetDecimals: 6, maxSupply, pool: { ...pool },
    termsHash: `0x${sha256(canonical(ast.terms.filter((term) => expected.some(({ name }) => name === term.name))))}` };
}

// Must match CashierConfig.Parameters exactly; fixed-width types bound the Solidity arithmetic.
export const CASHIER_CONFIG_ABI = 'tuple(uint128 navMicroUsd,uint16 subscriptionFeeBps,uint16 redemptionFeeBps,uint8 shareDecimals,uint8 assetDecimals,uint256 maxSupply,bytes32 termsHash,tuple(uint16 navUsd,uint16 subscriptionFeeBps,uint16 redemptionFeeBps,uint16 cashierSupplyCap,uint16 cashierExecution) clauseIds,tuple(uint24 fee,int24 tickSpacing) pool)';
export function cashierConstructorConfig(cashier) {
  const { navMicroUsd, subscriptionFeeBps, redemptionFeeBps, shareDecimals, assetDecimals, maxSupply, termsHash, clauseIds, pool } = cashier;
  return { navMicroUsd, subscriptionFeeBps, redemptionFeeBps, shareDecimals, assetDecimals, maxSupply, termsHash, clauseIds, pool };
}
export const cashierConfigurationHash = (cashier) => keccak256(AbiCoder.defaultAbiCoder().encode([CASHIER_CONFIG_ABI], [cashierConstructorConfig(cashier)]));

export function bindCashierClauses(onchain, ast, cashier) {
  if (!cashier) return;
  cashier.clauseIds = {};
  for (const name of [...SPECS.map(([name]) => name), 'cashierExecution']) {
    const term = ast.terms.find((entry) => entry.name === name);
    const clauseId = onchain.clauses.length + 1;
    onchain.clauses.push({ clauseId, ruleId: `term:${name}`, action: 'cashier', effect: 'term', ...term.source });
    cashier.clauseIds[name] = clauseId;
  }
  onchain.clauseTableHash = `0x${sha256(canonical(onchain.clauses))}`;
  cashier.configurationHash = cashierConfigurationHash(cashier);
}

export function emitCashierTerms(cashier) {
  if (!cashier) return null;
  if (cashier.configurationHash !== cashierConfigurationHash(cashier)) throw new Error('Cashier configuration commitment mismatch');
  return `// SPDX-License-Identifier: UNLICENSED
// Only the authorization commitment is compiled in. Quote terms are constructor arguments.
pragma solidity ^0.8.24;
library CompiledCashierTerms {
    bytes32 internal constant CONFIGURATION_HASH = ${cashier.configurationHash};
}
`;
}
