// Curvegrid MultiBaas as the policy ledger: three contracts of the Sepolia agreement are indexed
// (attestor, fund token, policy hook) and three event queries answer the dashboard. The free plan
// allows 10 active contracts, 2 indexed events a second, 100 blocks of backfill and 30k API calls a
// month, so registration touches three contracts and the ledger is cached server-side.
import { readFileSync } from 'node:fs';
import { Configuration, ContractsApi, AddressesApi, EventQueriesApi } from '@curvegrid/multibaas-sdk';
import { buildOnchainPolicy } from './policy.js';

const artifact = (name) => JSON.parse(readFileSync(new URL(`../../artifacts/rwa-secondary/${name}.json`, import.meta.url), 'utf8'));
export const HOOK_FLAGS = { beforeAddLiquidity: 1n << 11n, beforeRemoveLiquidity: 1n << 9n, beforeSwap: 1n << 7n };
const ACTIONS = ['mint', 'burn', 'transfer', 'deposit', 'withdraw'];
export const SIGNATURES = {
  checked: 'PolicyChecked(bytes32,address,uint8,bool,uint16)',
  attested: 'Attested(address,bytes32,uint256,uint256,uint32)',
  operation: 'Operation(bytes32,bool,uint256)',
  released: 'Released(bytes32,address,uint256)',
};

export function multibaasClient({ url = process.env.MULTIBAAS_URL, apiKey = process.env.MULTIBAAS_API_KEY } = {}) {
  if (!url || !apiKey) return null;
  const configuration = new Configuration({ basePath: `${url.replace(/\/$/, '')}/api/v0`, accessToken: apiKey });
  return { url: url.replace(/\/$/, ''), contracts: new ContractsApi(configuration), addresses: new AddressesApi(configuration), queries: new EventQueriesApi(configuration) };
}

/// The agreement the ledger watches, and the three contracts to index for it.
export function indexedContracts(record, agreement) {
  const version = `policy-${agreement.policyHash.slice(2, 10)}`;
  return [
    { alias: 'mirr0_attestor', label: 'mirr0_policy_attestor', name: 'PolicyAttestor', address: record.attestor, version: '1.0.0', artifact: 'PolicyAttestor' },
    { alias: 'mirr0_fund_token', label: 'mirr0_fund_token', name: 'CompiledMirrorToken', address: agreement.deployment.token, version, artifact: 'CompiledMirrorToken' },
    { alias: 'mirr0_policy_hook', label: 'mirr0_policy_hook', name: 'MirrorPolicyHook', address: agreement.deployment.hook, version, artifact: 'MirrorPolicyHook' },
  ];
}

const tolerate = async (promise) => {
  try { return (await promise).data; } catch (error) {
    const message = error.response?.data?.message ?? error.message;
    if (error.response?.status === 409 || /already|exists|conflict/i.test(message)) return { skipped: message };
    throw new Error(`MultiBaas: ${message}`);
  }
};

/// Uploads each ABI, aliases each address and links them, indexing from 100 blocks back (the plan's limit).
export async function registerIndexer(client, contracts, { startingBlock = '-100', log = () => {} } = {}) {
  const results = [];
  for (const entry of contracts) {
    const { abi, bytecode } = artifact(entry.artifact);
    await tolerate(client.contracts.createContract(entry.label, { label: entry.label, contractName: entry.name, version: entry.version, rawAbi: JSON.stringify(abi), bin: bytecode }));
    await tolerate(client.addresses.setAddress({ alias: entry.alias, address: entry.address }));
    const link = await tolerate(client.contracts.linkAddressContract(entry.alias, { label: entry.label, version: entry.version, startingBlock }));
    log(`${entry.alias.padEnd(18)} ${entry.address} ${entry.label}@${entry.version}${link?.skipped ? ` (${link.skipped})` : ''}`);
    results.push({ ...entry, linked: !link?.skipped });
  }
  return results;
}

// MultiBaas wants every selected input aliased and a filter's conditions nested under `children`.
const input = (name, inputIndex) => ({ type: 'input', name, inputIndex, alias: name.toLowerCase() });
const meta = (type, alias) => ({ type, alias });
const byContract = (alias) => ({ rule: 'and', children: [{ fieldType: 'contract_address_alias', operator: 'equal', value: alias }] });

/// The three queries the ledger runs: every hook decision, every attestation, and supply by direction.
export function ledgerQueries() {
  return {
    checks: { events: [{ eventName: SIGNATURES.checked, filter: byContract('mirr0_policy_hook'), select: [input('subject', 1), input('action', 2), input('allowed', 3), input('clauseId', 4), meta('triggered_at', 'at'), meta('tx_hash', 'tx')] }], orderBy: 'at', order: 'DESC' },
    attestations: { events: [{ eventName: SIGNATURES.attested, filter: byContract('mirr0_attestor'), select: [input('subject', 0), input('known', 2), input('value', 3), input('expiresAt', 4), meta('triggered_at', 'at'), meta('tx_hash', 'tx')] }], orderBy: 'at', order: 'DESC' },
    // The query language aggregates: minted and burned totals come back as two rows, grouped by direction.
    supply: { events: [{ eventName: SIGNATURES.operation, filter: byContract('mirr0_fund_token'), select: [input('isMint', 1), { ...input('amount', 2), aggregator: 'add' }] }], groupBy: 'ismint' },
  };
}

/// What the hook can refuse, read from the deployment itself: the callbacks its address enables, the
/// pool it guards, and the clauses that decide a transfer.
export function hookBoundaries(agreement) {
  const flags = BigInt(agreement.deployment.hook);
  const onchain = buildOnchainPolicy(agreement.envelope.ast);
  const rules = new Map(agreement.envelope.ast.rules.map((rule) => [rule.id, rule]));
  const clauses = onchain.clauses.map((clause) => {
    const rule = rules.get(clause.ruleId);
    return { clauseId: clause.clauseId, ruleId: clause.ruleId, action: rule?.action ?? null, effect: rule?.effect ?? null, clause: rule?.source.clause ?? null, quote: rule?.source.quote ?? null };
  });
  return {
    hook: agreement.deployment.hook, token: agreement.deployment.token, poolId: agreement.deployment.poolId, poolKey: agreement.deployment.poolKey,
    callbacks: Object.fromEntries(Object.entries(HOOK_FLAGS).map(([name, bit]) => [name, (flags & bit) !== 0n])),
    transferClauses: clauses.filter((clause) => clause.action === 'transfer'),
    clauses,
  };
}

const rowsOf = (response) => response?.data?.result?.rows ?? [];
const short = (value) => (typeof value === 'string' ? value : String(value ?? ''));

/// The ledger the dashboard reads. `cacheMs` keeps a busy page from spending the monthly API budget.
export function ledgerService({ client, record, agreement, cacheMs = 120_000, clock = Date.now } = {}) {
  const boundaries = hookBoundaries(agreement);
  const clauseOf = new Map(boundaries.clauses.map((clause) => [clause.clauseId, clause]));
  let cached = null;
  return async function ledger() {
    if (cached && clock() - cached.at < cacheMs) return { ...cached.value, cached: true };
    const queries = ledgerQueries();
    const [checks, attestations, supply] = await Promise.all(Object.values(queries).map((query) => client.queries.executeArbitraryEventQuery(query, 0, 50)));
    const decisions = rowsOf(checks).map((row) => ({
      at: row.at, tx: row.tx, subject: short(row.subject), action: ACTIONS[Number(row.action)] ?? String(row.action),
      allowed: row.allowed === true || row.allowed === 'true', clauseId: Number(row.clauseid ?? row.clauseId ?? 0),
    })).map((decision) => ({ ...decision, clause: clauseOf.get(decision.clauseId) ?? null }));
    const byClause = {};
    for (const decision of decisions) {
      const key = decision.clauseId || 'none';
      byClause[key] ??= { clauseId: decision.clauseId || null, ruleId: decision.clause?.ruleId ?? null, allowed: 0, refused: 0 };
      byClause[key][decision.allowed ? 'allowed' : 'refused']++;
    }
    const totals = { minted: '0', burned: '0' };
    for (const row of rowsOf(supply)) totals[row.ismint === true || row.ismint === 'true' || row.isMint === true ? 'minted' : 'burned'] = short(row.amount);
    const value = {
      source: 'multibaas', url: client.url, chainId: record.chainId, agreement: agreement.id, policyHash: agreement.policyHash, fetchedAt: new Date(clock()).toISOString(),
      contracts: indexedContracts(record, agreement).map(({ alias, label, address }) => ({ alias, label, address })),
      boundaries, decisions, byClause: Object.values(byClause),
      attestations: rowsOf(attestations).map((row) => ({ at: row.at, tx: row.tx, subject: short(row.subject), known: short(row.known), value: short(row.value), expiresAt: Number(row.expiresat ?? row.expiresAt ?? 0) })),
      supply: totals,
    };
    cached = { at: clock(), value };
    return value;
  };
}
