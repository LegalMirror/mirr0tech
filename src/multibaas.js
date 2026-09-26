// Registers a deployment with Curvegrid MultiBaas so its indexer, transaction explorer and event
// queries cover every mirr0tech contract: the attestor's Attested/Revoked, the role provider's
// CredentialDecision, the hook's PolicyChecked, Aqua's Pushed/Pulled and the router's Swapped.
// MultiBaas only sees chains it supports, so this runs after a Sepolia (or other public) deploy.
import { Configuration, ContractsApi, AddressesApi, EventsApi, HsmApi } from '@curvegrid/multibaas-sdk';
import { loadArtifacts } from './deploy.js';

const label = (name) => `mirr0tech_${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;

export function multibaasClient({ url = process.env.MULTIBAAS_URL, apiKey = process.env.MULTIBAAS_API_KEY } = {}) {
  if (!url || !apiKey) throw new Error('Set MULTIBAAS_URL and MULTIBAAS_API_KEY');
  const configuration = new Configuration({ basePath: `${url.replace(/\/$/, '')}/api/v0`, accessToken: apiKey });
  return { url, contracts: new ContractsApi(configuration), addresses: new AddressesApi(configuration), events: new EventsApi(configuration), hsm: new HsmApi(configuration) };
}

// Everything in a deployment record, with the artifact each address was built from.
export async function deploymentContracts(record) {
  const rwa = await loadArtifacts('rwa-secondary', ['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MockERC20', 'CompiledMirrorToken', 'MirrorPolicyHook', 'MirrorLiquidityRouter', 'PoolManager']);
  const credit = await loadArtifacts('wildcat-credit', ['PolicyOracle', 'MirrortechRoleProvider', 'MockWildcatMarket', 'MirrortechRouter', 'Aqua']);
  const version = (policy) => `policy-${policy.hash.slice(2, 10)}`;
  return [
    { alias: 'attestor', name: 'PolicyAttestor', address: record.attestor, artifact: rwa.artifacts.PolicyAttestor, version: '1.0.0' },
    { alias: 'sanctions_oracle', name: 'MockSanctionsOracle', address: record.sanctions, artifact: rwa.artifacts.MockSanctionsOracle, version: '1.0.0' },
    { alias: 'musdc', name: 'MockERC20', address: record.usdc, artifact: rwa.artifacts.MockERC20, version: '1.0.0' },
    { alias: 'fund_policy_oracle', name: 'PolicyOracle', address: record.rwa.oracle, artifact: rwa.artifacts.PolicyOracle, version: version(rwa.policy) },
    { alias: 'fund_token', name: 'CompiledMirrorToken', address: record.rwa.token, artifact: rwa.artifacts.CompiledMirrorToken, version: version(rwa.policy) },
    { alias: 'fund_hook', name: 'MirrorPolicyHook', address: record.rwa.hook, artifact: rwa.artifacts.MirrorPolicyHook, version: version(rwa.policy) },
    { alias: 'pool_router', name: 'MirrorLiquidityRouter', address: record.rwa.router, artifact: rwa.artifacts.MirrorLiquidityRouter, version: '1.0.0' },
    { alias: 'pool_manager', name: 'PoolManager', address: record.rwa.poolManager, artifact: rwa.artifacts.PoolManager, version: '1.0.0' },
    { alias: 'credit_policy_oracle', name: 'PolicyOracle', address: record.credit.oracle, artifact: credit.artifacts.PolicyOracle, version: version(credit.policy) },
    { alias: 'role_provider', name: 'MirrortechRoleProvider', address: record.credit.roleProvider, artifact: credit.artifacts.MirrortechRoleProvider, version: version(credit.policy) },
    { alias: 'market', name: 'MockWildcatMarket', address: record.credit.market, artifact: credit.artifacts.MockWildcatMarket, version: '1.0.0' },
    { alias: 'aqua', name: 'Aqua', address: record.credit.aqua, artifact: credit.artifacts.Aqua, version: '1.0.0' },
    { alias: 'swapvm_router', name: 'MirrortechRouter', address: record.credit.router, artifact: credit.artifacts.MirrortechRouter, version: version(credit.policy) },
  ];
}

const tolerate = async (promise, accept = /already|exists|conflict/i) => {
  try { return (await promise).data; } catch (error) {
    const message = error.response?.data?.message ?? error.message;
    if (error.response?.status === 409 || accept.test(message)) return { skipped: message };
    throw new Error(`MultiBaas: ${message}`);
  }
};

/// Uploads each contract (label + version + ABI + bytecode), aliases its address and links the two,
/// so MultiBaas starts indexing that address's events under the contract's ABI.
// MultiBaas indexes from `startingBlock`: absolute, or relative to the head (`-50000` ≈ a week of Sepolia).
export async function syncDeployment(record, { client = multibaasClient(), startingBlock = process.env.MULTIBAAS_STARTING_BLOCK ?? '-50000', log = () => {} } = {}) {
  const results = [];
  for (const entry of await deploymentContracts(record)) {
    const contractLabel = label(entry.name);
    const contract = await tolerate(client.contracts.createContract(contractLabel, {
      label: contractLabel, contractName: entry.name, version: entry.version,
      rawAbi: JSON.stringify(entry.artifact.abi), bin: entry.artifact.bytecode,
    }));
    const address = await tolerate(client.addresses.setAddress({ alias: entry.alias, address: entry.address }));
    // A plan caps linked contracts and log depth; a link the plan refuses is reported, not fatal.
    const link = await tolerate(client.contracts.linkAddressContract(entry.alias, { label: contractLabel, version: entry.version, startingBlock }), /already|exists|conflict|plan/i);
    const outcome = { alias: entry.alias, address: entry.address, contract: contractLabel, version: entry.version,
      created: !contract?.skipped, aliased: !address?.skipped, linked: !link?.skipped, ...(link?.skipped ? { note: link.skipped } : {}) };
    log(`${entry.alias.padEnd(22)} ${entry.address}  ${contractLabel}@${entry.version}${outcome.linked ? '' : ` (${link.skipped})`}`);
    results.push(outcome);
  }
  return results;
}

/// Recent indexed events for a linked contract, for the audit screen.
export async function indexedEvents(client, { contractLabel, eventSignature, limit = 50 } = {}) {
  const response = await client.events.listEvents(undefined, undefined, undefined, undefined, undefined, undefined, undefined, contractLabel, eventSignature, limit);
  return response.data.result;
}
