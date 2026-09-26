// Deploys the whole two-act stack against any EVM: a local anvil by default, a testnet when the
// canonical venue contracts are supplied. One attestor and one sanctions oracle serve both
// policies; everything policy-bound is deployed once per compiled profile.
import { readFile } from 'node:fs/promises';
import { AbiCoder, Contract, ContractFactory, id, keccak256 } from 'ethers';
import { mineHookAddress, deploymentCalldata, DETERMINISTIC_DEPLOYER, CASHIER_HOOK_FLAGS } from './hookAddress.js';
import { cashierConstructorConfig, emitCashierTerms } from './cashier.js';
import { UNISWAP } from './uniswap-config.js';
import { sharedMockUsd } from './mock-usd.js';

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
  const sharedAsset = await sharedMockUsd(provider, chainId);
  if (chainId === 11155111n) canonical = { ...canonical, poolManager: UNISWAP.poolManager };
  const deployer = await signer.getAddress();
  borrower ??= deployer;
  const rwa = await loadArtifacts('rwa-secondary', ['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MockERC20', 'CompiledMirrorToken', 'MirrorPolicyHook', 'MirrorUniswapHook', 'MirrorLiquidityRouter', 'PoolManager']);
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
  const usdc = sharedAsset ? at(sharedAsset, rwa.artifacts.MockERC20) : await deploy(rwa.artifacts.MockERC20, 'mUSDC', 'Mock USD Coin', 'mUSDC');

  // Act 1: the fund agreement → token + the hook that is its only door into Uniswap.
  const rwaOracle = await deploy(rwa.artifacts.PolicyOracle, 'PolicyOracle (fund)', await attestor.getAddress(), await sanctions.getAddress());
  const token = await deploy(rwa.artifacts.CompiledMirrorToken, 'CompiledMirrorToken', deployer, deployer);
  const poolManager = canonical.poolManager ? at(canonical.poolManager, rwa.artifacts.PoolManager) : await deploy(rwa.artifacts.PoolManager, 'PoolManager', deployer);
  // Public deployments use the canonical periphery; the local demonstration has an isolated fixture.
  const standard = chainId === 11155111n;
  if (standard && (await poolManager.getAddress()).toLowerCase() !== UNISWAP.poolManager.toLowerCase()) throw new Error('Sepolia requires the canonical PoolManager');
  const v4Router = standard ? new Contract(UNISWAP.router, ['function execute(bytes,bytes[],uint256)'], signer)
    : await deploy(rwa.artifacts.MirrorLiquidityRouter, 'MirrorLiquidityRouter (local fixture)', await poolManager.getAddress());
  const hookArtifact = standard ? rwa.artifacts.MirrorUniswapHook : rwa.artifacts.MirrorPolicyHook;
  const initCode = (await new ContractFactory(hookArtifact.abi, hookArtifact.bytecode, signer).getDeployTransaction(
    await poolManager.getAddress(), await rwaOracle.getAddress(), await v4Router.getAddress(), await token.getAddress(),
    ...(standard ? [UNISWAP.positionManager, UNISWAP.quoter] : []))).data;
  const mined = mineHookAddress(initCode);
  if (await provider.getCode(mined.address) === '0x') {
    await (await signer.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(mined.salt, initCode) })).wait();
  }
  const hook = at(mined.address, hookArtifact);
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
    uniswap: standard ? UNISWAP : { poolManager: await poolManager.getAddress(), router: await v4Router.getAddress(), positionManager: await v4Router.getAddress(), quoter: await usdc.getAddress() },
    chainId: Number(chainId), deployer, borrower, deterministicDeployer: DETERMINISTIC_DEPLOYER,
    attestor: await attestor.getAddress(), sanctions: await sanctions.getAddress(), usdc: await usdc.getAddress(),
    rwa: {
      policyHash: rwa.policy.hash, clauseTableHash: rwa.clauseTable.clauseTableHash,
      oracle: await rwaOracle.getAddress(), token: await token.getAddress(), poolManager: await poolManager.getAddress(),
      ...(standard ? { routing: 'uniswap-api', positionManager: UNISWAP.positionManager, permit2: UNISWAP.permit2, quoter: UNISWAP.quoter } : {}),
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

const POOL_MANAGER_ABI = ['function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)'];
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

// Integer Q96 initialization at the document NAV; actual routing still compares executed fills.
export function cashierInitialSqrtPrice(navMicroUsd, tokenIsCurrency0) {
  const nav = BigInt(navMicroUsd);
  if (nav <= 0n || nav >= 2n ** 128n) throw new Error('Invalid cashier NAV');
  const ratioX192 = tokenIsCurrency0 ? (nav << 192n) / 1_000_000n : (1_000_000n << 192n) / nav;
  let root = ratioX192;
  let next = (root + 1n) / 2n;
  while (next < root) { root = next; next = (root + ratioX192 / root) / 2n; }
  return root;
}

/// Act 1 for one more agreement on a running stack: its own oracle, token and hook (compiled now,
/// from the generated Solidity), and a policy-managed pool against the stack's mock USD on the shared
/// PoolManager. Facts and sanctions stay on the stack's attestor and oracle.
export async function deployFund(signer, { record, sources, log = () => {} }) {
  const { compileBundle } = await import('./solc.js');
  const cashier = Boolean(sources.cashierTerms || sources.cashier);
  if (cashier && (!sources.cashier || !sources.cashierTerms || sources.cashierTerms.trim() !== emitCashierTerms(sources.cashier).trim())) {
    throw new Error('Cashier deployment requires compiler-authorized sources.cashier metadata and matching sources.cashierTerms');
  }
  const sharedAsset = await sharedMockUsd(signer.provider, record.chainId);
  const parameters = cashier ? cashierConstructorConfig(sources.cashier) : null;
  const overrides = { 'generated/CompiledPolicy.sol': sources.compiledPolicy, 'generated/CompiledMirrorToken.sol': sources.token,
    ...(cashier ? { 'generated/CompiledCashierTerms.sol': sources.cashierTerms } : {}) };
  const core = await compileBundle('core', [['contracts/PolicyOracle.sol', 'PolicyOracle'], ['generated/CompiledMirrorToken.sol', 'CompiledMirrorToken'],
    ...(cashier && !sharedAsset ? [['contracts/test/MockUSD.sol', 'MockUSD']] : [])], { overrides });
  const hookName = cashier ? 'MirrorCashierHook' : 'MirrorUniswapHook';
  const periphery = Number(record.chainId) === 11155111 ? UNISWAP : record.uniswap ?? UNISWAP;
  if (!cashier && record.rwa.poolManager.toLowerCase() !== periphery.poolManager.toLowerCase()) throw new Error('Configure canonical Uniswap periphery for this chain before deploying a fund.');
  const v4 = await compileBundle('uniswap-v4', [[`contracts/${hookName}.sol`, hookName],
    ...(cashier ? [['contracts/MirrorCashierRouter.sol', 'MirrorCashierRouter']] : [])], { overrides });
  const deployer = await signer.getAddress();
  const txs = {};
  const deploy = async (artifact, label, ...args) => {
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
    await contract.waitForDeployment();
    txs[label] = contract.deploymentTransaction().hash;
    log(`${label.padEnd(24)} ${await contract.getAddress()}`);
    return contract;
  };
  const oracle = await deploy(core.PolicyOracle, 'oracle', record.attestor, record.sanctions);
  const token = await deploy(core.CompiledMirrorToken, 'token', deployer, deployer);
  const [oracleAddress, tokenAddress] = await Promise.all([oracle.getAddress(), token.getAddress()]);
  // Sepolia pools share the Settings faucet; local fixtures preserve their isolated test assets.
  const asset = sharedAsset ?? (cashier ? await (await deploy(core.MockUSD, 'mockUSD')).getAddress() : record.usdc);
  const router = cashier ? await (await deploy(v4.MirrorCashierRouter, 'router', record.rwa.poolManager, parameters)).getAddress() : periphery.router;
  const args = [record.rwa.poolManager, oracleAddress, router, tokenAddress, ...(cashier ? [asset, parameters] : [periphery.positionManager, periphery.quoter])];
  const initCode = (await new ContractFactory(v4[hookName].abi, v4[hookName].bytecode, signer).getDeployTransaction(...args)).data;
  const mined = mineHookAddress(initCode, cashier ? CASHIER_HOOK_FLAGS : undefined);
  txs.hook = (await (await signer.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(mined.salt, initCode) })).wait()).hash;
  log(`${'hook'.padEnd(24)} ${mined.address} (${mined.attempts} tries)`);
  txs.configure = (await (await token.configureSecondary(oracleAddress, mined.address)).wait()).hash;
  const [currency0, currency1] = BigInt(tokenAddress) < BigInt(asset) ? [tokenAddress, asset] : [asset, tokenAddress];
  const poolSettings = cashier ? parameters.pool : { fee: 3000, tickSpacing: 60 };
  const poolKey = { currency0, currency1, ...poolSettings, hooks: mined.address };
  const initialSqrtPriceX96 = cashier ? cashierInitialSqrtPrice(parameters.navMicroUsd, currency0 === tokenAddress) : SQRT_PRICE_1_1;
  const poolManager = new Contract(record.rwa.poolManager, POOL_MANAGER_ABI, signer);
  txs.pool = (await (await poolManager.initialize(poolKey, initialSqrtPriceX96)).wait()).hash;
  const poolId = keccak256(AbiCoder.defaultAbiCoder().encode(['tuple(address,address,uint24,int24,address)'], [[currency0, currency1, poolSettings.fee, poolSettings.tickSpacing, mined.address]]));
  return { chainId: record.chainId, policyHash: await token.policyHash(), oracle: oracleAddress, token: tokenAddress, asset, router,
    ...(!cashier ? { routing: 'uniswap-api', positionManager: periphery.positionManager, permit2: periphery.permit2, quoter: periphery.quoter } : {}),
    ...(cashier ? { cashier: { ...sources.cashier, enabled: true, asset, initialSqrtPriceX96: initialSqrtPriceX96.toString(),
      hookAbi: v4[hookName].abi, routerAbi: v4.MirrorCashierRouter.abi } } : {}), hook: mined.address, hookSalt: mined.salt, poolManager: record.rwa.poolManager, poolKey, poolId, txs, deployedAt: new Date().toISOString() };
}

/// A separate MVP credit market per uploaded, explicitly mapped bundle. Reuses only shared
/// testnet infrastructure; its policy oracle, role provider and SwapVM guard bind the new hash.
export async function deployCredit(signer, { record, sources, log = () => {} }) {
  const sharedAsset = await sharedMockUsd(signer.provider, record.chainId);
  const { compileBundle } = await import('./solc.js');
  const { verifyPolicy } = await import('../policy/compile.js');
  const { buildOnchainPolicy, emitCompiledPolicy } = await import('./policy.js');
  const { buybackTermsFrom, buildBuybackProgram, buildAquaOrder, loadOpcodes } = await import('./programs.js');
  const policy = verifyPolicy(sources.policy);
  if (policy.profile !== 'wildcat-credit' || !policy.demo) throw new Error('Credit deployment requires an explicit MVP credit policy');
  if (sources.compiledPolicy !== emitCompiledPolicy(buildOnchainPolicy(policy.ast), policy.hash)) {
    throw new Error('Generated Solidity does not match the credit policy');
  }
  const terms = buybackTermsFrom(policy);
  if (terms.deadlineTimestamp <= Math.floor(Date.now() / 1000)) throw new Error('The source buyback offer has expired');
  const overrides = { 'generated/CompiledPolicy.sol': sources.compiledPolicy };
  const core = await compileBundle('core', [
    ['contracts/PolicyOracle.sol', 'PolicyOracle'], ['contracts/MirrortechRoleProvider.sol', 'MirrortechRoleProvider'],
    ['contracts/MockWildcatMarket.sol', 'MockWildcatMarket'], ['contracts/test/MockUSD.sol', 'MockUSD'],
  ], { overrides });
  const swap = await compileBundle('swapvm', [['contracts/swapvm/MirrortechRouter.sol', 'MirrortechRouter']], { overrides });
  const borrower = await signer.getAddress();
  const txs = {};
  const deploy = async (artifact, label, ...args) => {
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
    await contract.waitForDeployment();
    txs[label] = contract.deploymentTransaction().hash;
    log(`${label} ${await contract.getAddress()}`);
    return contract;
  };
  const oracle = await deploy(core.PolicyOracle, 'oracle', record.attestor, record.sanctions);
  if (await oracle.policyHash() !== policy.hash) throw new Error('Generated Solidity does not match the credit policy');
  const roleProvider = await deploy(core.MirrortechRoleProvider, 'roleProvider', await oracle.getAddress());
  const assetAddress = sharedAsset ?? await (await deploy(core.MockUSD, 'mockUSD')).getAddress();
  const market = await deploy(core.MockWildcatMarket, 'market', assetAddress, await roleProvider.getAddress(), borrower);
  txs.bindMarket = (await (await oracle.bindMarket(await market.getAddress())).wait()).hash;
  const router = await deploy(swap.MirrortechRouter, 'router', record.credit.aqua, record.credit.weth, borrower, await oracle.getAddress());
  txs.configureVenue = (await (await market.setVenue(await router.getAddress(), true)).wait()).hash;
  const program = buildBuybackProgram({ opcodes: loadOpcodes(),
    policyGuardOpcode: Number(await router.policyGuardOpcode()), fixedRateBalancesOpcode: Number(await router.fixedRateBalancesOpcode()),
    policyHash: policy.hash, action: policy.actionOrder.indexOf('transfer'), deadline: terms.deadlineTimestamp,
    positionToken: await market.getAddress(), asset: assetAddress, capPosition: terms.capPosition, capAsset: terms.capAsset });
  return { chainId: record.chainId, policyHash: policy.hash, clauseTableHash: policy.clauseTableHash,
    oracle: await oracle.getAddress(), roleProvider: await roleProvider.getAddress(), token: await market.getAddress(),
    market: await market.getAddress(), asset: assetAddress, router: await router.getAddress(), aqua: record.credit.aqua,
    mockMarket: true, buyback: { status: 'prepared', order: buildAquaOrder(borrower, program),
      terms: JSON.parse(JSON.stringify(terms, (_key, value) => typeof value === 'bigint' ? value.toString() : value)) },
    txs, deployedAt: new Date().toISOString() };
}
