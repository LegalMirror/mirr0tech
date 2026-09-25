// Deploys the whole two-act stack against any EVM: a local anvil by default, a testnet when the
// canonical venue contracts are supplied. One attestor and one sanctions oracle serve both
// policies; everything policy-bound is deployed once per compiled profile.
import { readFile } from 'node:fs/promises';
import { AbiCoder, Contract, ContractFactory, concat, id } from 'ethers';
import { mineHookAddress, deploymentCalldata, DETERMINISTIC_DEPLOYER } from './policy/hookAddress.js';

export const ANVIL_CHAIN_ID = 31337n;
// Public anvil development key, never use for assets or a public chain.
export const ANVIL_DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export async function loadArtifacts(profile, names) {
  const entries = await Promise.all(names.map(async (name) => [name, JSON.parse(await readFile(`artifacts/${profile}/${name}.json`, 'utf8'))]));
  const policy = JSON.parse(await readFile(`artifacts/${profile}/policy.json`, 'utf8'));
  const clauseTable = JSON.parse(await readFile(`artifacts/${profile}/clause-table.json`, 'utf8'));
  return { artifacts: Object.fromEntries(entries), policy, clauseTable };
}

/// Deploys everything with `signer`, returning live contract handles and a serializable record.
/// `canonical` may supply { poolManager, aqua, weth } addresses on chains where they already exist.
export async function deployStack(signer, { borrower, canonical = {}, log = () => {} } = {}) {
  const provider = signer.provider;
  const chainId = (await provider.getNetwork()).chainId;
  const deployer = await signer.getAddress();
  borrower ??= deployer;
  const rwa = await loadArtifacts('rwa-secondary', ['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MockERC20', 'CompiledMirrorToken', 'MirrorPolicyHook', 'MirrorLiquidityRouter', 'PoolManager']);
  const credit = await loadArtifacts('wildcat-credit', ['PolicyOracle', 'MirrortechRoleProvider', 'MockWildcatMarket', 'MirrortechRouter', 'Aqua']);
  const deploy = async (artifact, label, ...args) => {
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
    await contract.waitForDeployment();
    log(`${label.padEnd(24)} ${await contract.getAddress()}`);
    return contract;
  };
  const at = (address, artifact) => new Contract(address, artifact.abi, signer);

  // Shared: facts and the sanctions oracle the agreements name as definitive.
  const attestor = await deploy(rwa.artifacts.PolicyAttestor, 'PolicyAttestor', deployer);
  for (const role of ['ATTESTOR_ROLE', 'WATCHER_ROLE']) await (await attestor.grantRole(id(role), deployer)).wait();
  await (await attestor.grantRole(id('BORROWER_ROLE'), borrower)).wait();
  const sanctions = await deploy(rwa.artifacts.MockSanctionsOracle, 'MockSanctionsOracle', deployer);
  const usdc = await deploy(rwa.artifacts.MockERC20, 'mUSDC', 'Mock USD Coin', 'mUSDC');

  // Act 1: the fund agreement → token + the hook that is its only door into Uniswap.
  const rwaOracle = await deploy(rwa.artifacts.PolicyOracle, 'PolicyOracle (fund)', await attestor.getAddress(), await sanctions.getAddress());
  const token = await deploy(rwa.artifacts.CompiledMirrorToken, 'CompiledMirrorToken', deployer, deployer);
  const poolManager = canonical.poolManager ? at(canonical.poolManager, rwa.artifacts.PoolManager) : await deploy(rwa.artifacts.PoolManager, 'PoolManager', deployer);
  const v4Router = await deploy(rwa.artifacts.MirrorLiquidityRouter, 'MirrorLiquidityRouter', await poolManager.getAddress());
  const initCode = concat([rwa.artifacts.MirrorPolicyHook.bytecode, AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address'], [await poolManager.getAddress(), await rwaOracle.getAddress(), await v4Router.getAddress(), await token.getAddress()])]);
  const mined = mineHookAddress(initCode);
  if (await provider.getCode(mined.address) === '0x') {
    await (await signer.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(mined.salt, initCode) })).wait();
  }
  const hook = at(mined.address, rwa.artifacts.MirrorPolicyHook);
  log(`${'MirrorPolicyHook'.padEnd(24)} ${mined.address} (salt ${mined.salt.slice(0, 10)}…, ${mined.attempts} tries)`);
  await (await token.configureSecondary(await rwaOracle.getAddress(), mined.address)).wait();

  // Act 2: the loan agreement → role provider for the market + the strategy venue.
  const creditOracle = await deploy(credit.artifacts.PolicyOracle, 'PolicyOracle (credit)', await attestor.getAddress(), await sanctions.getAddress());
  const roleProvider = await deploy(credit.artifacts.MirrortechRoleProvider, 'MirrortechRoleProvider', await creditOracle.getAddress());
  const market = await deploy(credit.artifacts.MockWildcatMarket, 'MockWildcatMarket', await usdc.getAddress(), await roleProvider.getAddress(), borrower);
  await (await creditOracle.bindMarket(await market.getAddress())).wait();
  const weth = canonical.weth ? canonical.weth : await (await deploy(rwa.artifacts.MockERC20, 'WETH (mock)', 'Wrapped Ether', 'WETH')).getAddress();
  const aqua = canonical.aqua ? at(canonical.aqua, credit.artifacts.Aqua) : await deploy(credit.artifacts.Aqua, 'Aqua (official code)');
  const swapRouter = await deploy(credit.artifacts.MirrortechRouter, 'MirrortechRouter', await aqua.getAddress(), weth, deployer, await creditOracle.getAddress());
  if (borrower === deployer) await (await market.setVenue(await swapRouter.getAddress(), true)).wait();

  const record = {
    chainId: Number(chainId), deployer, borrower, deterministicDeployer: DETERMINISTIC_DEPLOYER,
    attestor: await attestor.getAddress(), sanctions: await sanctions.getAddress(), usdc: await usdc.getAddress(),
    rwa: {
      policyHash: rwa.policy.hash, clauseTableHash: rwa.clauseTable.clauseTableHash,
      oracle: await rwaOracle.getAddress(), token: await token.getAddress(), poolManager: await poolManager.getAddress(),
      router: await v4Router.getAddress(), hook: mined.address, hookSalt: mined.salt,
    },
    credit: {
      policyHash: credit.policy.hash, clauseTableHash: credit.clauseTable.clauseTableHash,
      oracle: await creditOracle.getAddress(), roleProvider: await roleProvider.getAddress(), market: await market.getAddress(),
      aqua: await aqua.getAddress(), router: await swapRouter.getAddress(), weth,
      policyGuardOpcode: Number(await swapRouter.policyGuardOpcode()), fixedRateBalancesOpcode: Number(await swapRouter.fixedRateBalancesOpcode()),
    },
    // Keys the operator gateway reads for the fund token.
    address: await token.getAddress(), custodian: deployer, policyHash: rwa.policy.hash,
  };
  return {
    record, policies: { rwa: rwa.policy, credit: credit.policy }, clauseTables: { rwa: rwa.clauseTable, credit: credit.clauseTable },
    contracts: { attestor, sanctions, usdc, rwaOracle, token, poolManager, v4Router, hook, creditOracle, roleProvider, market, aqua, swapRouter },
  };
}
