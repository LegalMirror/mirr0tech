// Registers a deployment with Curvegrid MultiBaas so its indexer, transaction explorer and event
// queries cover every mirr0tech contract: the attestor's Attested/Revoked, the role provider's
// CredentialDecision, the hook's PolicyChecked, Aqua's Pushed/Pulled and the router's Swapped.
// MultiBaas only sees chains it supports, so this runs after a Sepolia (or other public) deploy.
import { createHash } from 'node:crypto';
import { Interface } from 'ethers';
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

/// ABI-only registration for one cashier fund's investor activity. Shared/base aliases are never
/// rewritten. Caller supplies deployed token/asset/attestor ABIs; hook/router ABIs come from deployFund.
/// This registers indexer resources, not an assertion that historical events have been indexed.
export async function syncFundDeployment(record, { fundId, abis, client, startingBlock, log = () => {} } = {}) {
  const r = record?.rwa;
  const address = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value);
  if (typeof fundId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(fundId)
    || !Number.isSafeInteger(record?.chainId) || record.chainId <= 0 || record.chainId === 31337
    || r?.cashier?.enabled !== true || !/^0x[0-9a-fA-F]{64}$/.test(r.policyHash)) throw new Error('Invalid cashier fund indexing scope');
  if (typeof startingBlock !== 'string' || !/^(latest|0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(startingBlock)
    || (startingBlock !== 'latest' && !Number.isSafeInteger(Number(startingBlock)))) throw new Error('Choose an explicit fund indexing start block');
  // Validate the whole registration before any API writes. No legacy artifact/bytecode fallback.
  const entries = [
    ['token', 'CompiledMirrorToken', r.token, abis?.token, ['Transfer(address,address,uint256)', 'Approval(address,address,uint256)']],
    ['asset', 'MockUSD', r.cashier.asset, abis?.asset, ['Transfer(address,address,uint256)', 'Approval(address,address,uint256)']],
    ['router', 'MirrorCashierRouter', r.router, r.cashier.routerAbi, ['Executed(address,uint8,uint256,uint256)']],
    ['hook', 'MirrorCashierHook', r.hook, r.cashier.hookAbi, ['CashierExecuted(address,bool,uint256,uint256,bytes32)']],
    ['attestor', 'PolicyAttestor', record.attestor, abis?.attestor, ['Attested(address,bytes32,uint256,uint256,uint32)', 'Revoked(address,bytes32,uint256)', 'Overridden(address,bytes32,uint256)']],
  ].map(([role, name, contractAddress, abi, events]) => {
    if (!address(contractAddress) || !abi) throw new Error(`Missing deployed ${role} address or ABI`);
    const iface = Interface.from(abi);
    if (events.some((event) => !iface.getEvent(event))) throw new Error(`Incorrect deployed ${role} event ABI`);
    const rawAbi = iface.formatJson();
    const scope = createHash('sha256').update(JSON.stringify([fundId, record.chainId, r.policyHash.toLowerCase(), role, contractAddress.toLowerCase(), rawAbi])).digest('hex').slice(0, 32);
    return { role, name, address: contractAddress.toLowerCase(), rawAbi, label: `mf_${scope}`, version: '1.0.0' };
  });
  client ??= multibaasClient();
  const options = { timeout: 5000 };
  const request = async (operation, name, tolerated = null) => {
    let data;
    try { data = (await operation()).data; }
    catch (error) {
      if (tolerated !== null && error.response?.status === tolerated) return { skipped: true };
      throw new Error(`MultiBaas fund registration failed: ${name}`);
    }
    if (tolerated !== null && data?.status === tolerated) return { skipped: true };
    if (!Number.isInteger(data?.status) || data.status < 200 || data.status >= 300) throw new Error(`MultiBaas fund registration failed: ${name}`);
    return { result: data.result };
  };
  const results = [];
  for (const entry of entries) {
    const contract = await request(() => client.contracts.createContract(entry.label, {
      label: entry.label, contractName: entry.name, version: entry.version, rawAbi: entry.rawAbi,
    }, options), 'createContract', 409);
    let existing = await request(() => client.addresses.getAddress(entry.address, undefined, options), 'getAddress', 404);
    let aliased = false;
    if (existing.skipped) {
      const created = await request(() => client.addresses.setAddress({ alias: entry.label, address: entry.address }, options), 'setAddress', 409);
      aliased = !created.skipped;
      // Also reconcile a concurrent registration; never retry by renaming the existing address.
      existing = await request(() => client.addresses.getAddress(entry.address, undefined, options), 'getAddress');
    }
    if (existing.result?.address?.toLowerCase() !== entry.address || typeof existing.result.alias !== 'string') {
      throw new Error('MultiBaas returned a mismatched fund address');
    }
    const link = await request(() => client.contracts.linkAddressContract(entry.address,
      { label: entry.label, version: entry.version, startingBlock }, options), 'linkAddressContract', 409);
    const outcome = { fundId, chainId: record.chainId, policyHash: r.policyHash, role: entry.role, address: entry.address,
      alias: existing.result.alias, contract: entry.label, version: entry.version, created: !contract.skipped, aliased,
      linked: !link.skipped, ...(link.skipped ? { note: 'Link already exists or conflicts; inspect its indexing configuration' } : {}) };
    results.push(outcome);
    log(`${entry.role} ${entry.address}: ${outcome.linked ? 'indexing link accepted' : outcome.note}`);
  }
  return results;
}

/// Address-scoped read model. SDK 1.1.x puts contractAddress in argument seven and axios
/// options in argument twelve. Callers must still validate each returned event and its subject.
export async function indexedAddressEvents(client, addresses, { limit = 50 } = {}) {
  if (!Array.isArray(addresses) || addresses.length > 8 || !addresses.length
    || addresses.some((address) => !/^0x[0-9a-fA-F]{40}$/.test(address))
    || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid indexed event scope');
  const pages = await Promise.all([...new Set(addresses.map((address) => address.toLowerCase()))].map(async (address) => {
    const response = await client.events.listEvents(undefined, undefined, undefined, undefined, undefined, undefined,
      address, undefined, undefined, limit, 0, { timeout: 5000 });
    if (response.data?.status !== 200 || !Array.isArray(response.data.result)) throw new Error('Indexed events unavailable');
    return response.data.result.slice(0, limit);
  }));
  return pages.flat();
}

/// Recent indexed events for a linked contract, for the audit screen.
export async function indexedEvents(client, { contractLabel, eventSignature, limit = 50 } = {}) {
  const response = await client.events.listEvents(undefined, undefined, undefined, undefined, undefined, undefined, undefined, contractLabel, eventSignature, limit);
  return response.data.result;
}
