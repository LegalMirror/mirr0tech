import 'dotenv/config';
import { Wallet, Interface } from 'ethers';
import { UNISWAP } from '../../src/onchain/uniswap-config.js';
import { UniswapLiquidity } from '../../src/uniswap-liquidity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, ContractFactory, Contract, id, keccak256, MaxUint256, parseUnits } from 'ethers';
import { exportProfile, PROFILES } from '../../scripts/export-ui.js';
import { startAnvil } from './anvil.js';
import { compileBundle } from '../../src/onchain/solc.js';
import { createPoolSeeder } from '../../src/onchain/liquidity.js';
import { mineHookAddress, DETERMINISTIC_DEPLOYER, deploymentCalldata } from '../../src/onchain/hookAddress.js';

test(
  'backend seeds the actual hooked pool within both budgets and retries without adding twice',
  { timeout: 300000, skip: process.env.TEST_UNISWAP_FORK !== '1' },
  async (t) => {
    const { provider } = await startAnvil(t);
    try {
      await provider.send('anvil_reset', [{ forking: { jsonRpcUrl: process.env.RPC_URL } }]);
    } catch {
      throw new Error('Could not fork the configured Sepolia RPC');
    }
    await provider.send('anvil_setChainId', [11155111]);
    const signer = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider),
      backend = await signer.getAddress();
    await provider.send('anvil_setBalance', [backend, '0x3635c9adc5dea00000']);
    const policy = await exportProfile(PROFILES.find((p) => p.profile === 'rwa-secondary'));
    const options = {
      overrides: { 'generated/CompiledPolicy.sol': policy.contractSources['generated/CompiledPolicy.sol'] },
    };
    const core = await compileBundle(
      'core',
      [
        ['contracts/MirrorToken.sol', 'MirrorToken'],
        ['contracts/test/MockUSD.sol', 'MockUSD'],
        ['contracts/PolicyOracle.sol', 'PolicyOracle'],
        ['contracts/PolicyAttestor.sol', 'PolicyAttestor'],
        ['contracts/MockSanctionsOracle.sol', 'MockSanctionsOracle'],
      ],
      options,
    );
    const v4 = await compileBundle(
      'uniswap-v4',
      [
        ['node_modules/@uniswap/v4-core/src/PoolManager.sol', 'PoolManager'],
        ['contracts/MirrorUniswapHook.sol', 'MirrorUniswapHook'],
      ],
      options,
    );
    const deploy = async (name, ...args) => {
      const a = core[name] ?? v4[name];
      const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
      await c.waitForDeployment();
      return c;
    };
    const attestor = await deploy('PolicyAttestor', backend);
    await (await attestor.grantRole(id('ATTESTOR_ROLE'), backend)).wait();
    const sanctions = await deploy('MockSanctionsOracle', backend);
    const oracle = await deploy('PolicyOracle', await attestor.getAddress(), await sanctions.getAddress());
    const policyHash = await oracle.policyHash();
    const token = await deploy(
      'MirrorToken',
      'RWA',
      'RWA',
      backend,
      backend,
      policyHash,
      parseUnits('1000000', 6),
      true,
      true,
    );
    const usd = new Contract('0xfa6738D1b4Cd4Cd212909B5c5C555F464219f0AB', core.MockUSD.abi, signer);
    const manager = new Contract(UNISWAP.poolManager, v4.PoolManager.abi, signer);
    const init = (
      await new ContractFactory(v4.MirrorUniswapHook.abi, v4.MirrorUniswapHook.bytecode, signer).getDeployTransaction(
        await manager.getAddress(),
        await oracle.getAddress(),
        UNISWAP.router,
        await token.getAddress(),
        UNISWAP.positionManager,
        UNISWAP.quoter,
      )
    ).data;
    const mined = mineHookAddress(init);
    await (
      await signer.sendTransaction({ to: DETERMINISTIC_DEPLOYER, data: deploymentCalldata(mined.salt, init) })
    ).wait();
    await (await token.configureSecondary(await oracle.getAddress(), mined.address)).wait();
    const currencies = [await token.getAddress(), await usd.getAddress()].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    );
    const poolKey = {
      currency0: currencies[0],
      currency1: currencies[1],
      fee: 3000,
      tickSpacing: 60,
      hooks: mined.address,
    };
    const poolId = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['tuple(address,address,uint24,int24,address)'],
        [[...currencies, 3000, 60, mined.address]],
      ),
    );
    await (await manager.initialize(poolKey, 1n << 96n)).wait();
    const record = {
      id: 'agr_seed',
      status: 'deployed',
      policyHash,
      deployment: {
        policyHash,
        routing: 'uniswap-api',
        positionManager: UNISWAP.positionManager,
        chainId: 11155111,
        token: await token.getAddress(),
        asset: await usd.getAddress(),
        oracle: await oracle.getAddress(),
        hook: mined.address,
        router: UNISWAP.router,
        poolManager: await manager.getAddress(),
        poolKey,
        poolId,
      },
    };
    const coder = AbiCoder.defaultAbiCoder();
    const keyType = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
    const pm = new Interface(['function modifyLiquidities(bytes,uint256)']);
    const permit = new Interface(['function approve(address,address,uint160,uint48)']);
    const erc20 = new Interface(['function approve(address,uint256)']);
    const tx = (to, data) => ({ to, from: backend, data, value: '0x00', chainId: 11155111 });
    // The public API cannot see a fork-only pool. Model its observed 0x020d calldata,
    // and execute against the actual deployed Uniswap contracts on the fork.
    const api = new UniswapLiquidity({
      apiKey: 'fixture',
      fetcher: async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith('/check_approval'))
          return {
            ok: true,
            json: async () => ({
              transactions: body.lpTokens.flatMap((t) => [
                {
                  transaction: tx(t.tokenAddress, erc20.encodeFunctionData('approve', [UNISWAP.permit2, MaxUint256])),
                  cancelApproval: false,
                },
                {
                  transaction: tx(
                    UNISWAP.permit2,
                    permit.encodeFunctionData('approve', [
                      t.tokenAddress,
                      UNISWAP.positionManager,
                      (1n << 160n) - 1n,
                      Math.floor(Date.now() / 1000) + 1800,
                    ]),
                  ),
                  cancelApproval: false,
                },
              ]),
            }),
          };
        const l = BigInt(body.independentToken.amount) - 1n;
        const mint = coder.encode(
          [keyType, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
          [poolKey, -887220, 887220, l, l + 1n, l + 1n, backend, '0x'],
        );
        const settle = coder.encode(['address', 'address'], currencies);
        return {
          ok: true,
          json: async () => ({
            create: tx(
              UNISWAP.positionManager,
              pm.encodeFunctionData('modifyLiquidities', [
                coder.encode(['bytes', 'bytes[]'], ['0x020d', [mint, settle]]),
                Math.floor(Date.now() / 1000) + 1200,
              ]),
            ),
          }),
        };
      },
    });
    const seeder = createPoolSeeder(signer, api);
    assert.equal((await seeder.state(record)).liquidity, '0');
    const operation = { requestId: 'test-seed-operation-0001', rwaAmount: '100', usdAmount: '200' };
    const progress = async (fields) => Object.assign(operation, fields);
    await assert.rejects(seeder.seed({ record, operation, progress }), { code: 'INSUFFICIENT_BALANCE' });
    await (await token.mint(id('seed-shares'), parseUnits('1000', 6))).wait();
    await (await usd.mint(backend, parseUnits('1000', 6))).wait();
    await assert.rejects(seeder.seed({ record, operation, progress }), { code: 'POLICY_REFUSED' });
    const now = (await provider.getBlock('latest')).timestamp;
    await (await attestor.attest(backend, policyHash, MaxUint256, MaxUint256, now, now + 3600)).wait();
    assert.equal((await seeder.seed({ record, operation, progress })).status, 'confirmed');
    assert.ok(operation.seedTxHash);
    const state = await seeder.state(record);
    assert.ok(BigInt(state.liquidity) > 0n);
    assert.ok((await token.balanceOf(backend)) >= parseUnits('900', 6));
    assert.ok((await usd.balanceOf(backend)) >= parseUnits('800', 6));
    // The signed transaction hash is saved before broadcast, so a retry reuses it.
    assert.ok(operation.seedRawTransaction);
    assert.equal((await seeder.seed({ record, operation, progress })).status, 'confirmed');
    assert.equal((await seeder.state(record)).liquidity, state.liquidity);
    const router = new Contract(UNISWAP.router, ['function execute(bytes,bytes[],uint256) payable'], signer);
    const p2 = new Contract(UNISWAP.permit2, ['function approve(address,address,uint160,uint48)'], signer);
    const stranger = await provider.getSigner(1);
    const strangerAddress = await stranger.getAddress();
    const quoter = new Contract(
      UNISWAP.quoter,
      [
        `function quoteExactInputSingle(tuple(${keyType} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns(uint256,uint256)`,
      ],
      stranger,
    );
    const quoted = await quoter.quoteExactInputSingle.staticCall([poolKey, true, 1000000n, '0x']);
    assert.ok(quoted[0] > 0n, 'canonical quoter can simulate without granting settlement permission');
    const hookContract = new Contract(mined.address, v4.MirrorUniswapHook.abi, provider);
    assert.equal(await hookContract.approvedSubject(), '0x0000000000000000000000000000000000000000');
    assert.equal((await hookContract.explain(strangerAddress))[0], false);
    const spoofedSwap = coder.encode(
      [
        `tuple(${keyType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`,
      ],
      [[poolKey, true, 1000000n, 1n, 0n, coder.encode(['address'], [backend])]],
    );
    const spoofedRoute = coder.encode(['bytes', 'bytes[]'], ['0x06', [spoofedSwap]]);
    const beforeRefusal = await token.balanceOf(strangerAddress);
    await assert.rejects(
      router.connect(stranger).execute.staticCall('0x10', [spoofedRoute], Math.floor(Date.now() / 1000) + 1200),
    );
    assert.equal(
      await token.balanceOf(strangerAddress),
      beforeRefusal,
      'hookData cannot impersonate an attested wallet',
    );

    for (const input of [usd, token]) {
      const output = input === usd ? token : usd;
      const before = await output.balanceOf(backend);
      const inputAddress = await input.getAddress(),
        outputAddress = await output.getAddress();
      await (await input.approve(UNISWAP.permit2, 1000000n)).wait();
      await (await p2.approve(inputAddress, UNISWAP.router, 1000000n, Math.floor(Date.now() / 1000) + 1200)).wait();
      const swap = coder.encode(
        [
          `tuple(${keyType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`,
        ],
        [[poolKey, inputAddress.toLowerCase() === currencies[0].toLowerCase(), 1000000n, 900000n, 0n, '0x']],
      );
      const settle = coder.encode(['address', 'uint256'], [inputAddress, 1000000n]);
      const viaRouter = input === usd;
      const take = viaRouter
        ? coder.encode(['address', 'address', 'uint256'], [outputAddress, UNISWAP.router, 0])
        : coder.encode(['address', 'uint256'], [outputAddress, 900000n]);
      const route = coder.encode(['bytes', 'bytes[]'], [viaRouter ? '0x060c0e' : '0x060c0f', [swap, settle, take]]);
      const inputs = viaRouter
        ? [route, coder.encode(['address', 'address', 'uint256'], [outputAddress, backend, 900000n])]
        : [route];
      await (await router.execute(viaRouter ? '0x1004' : '0x10', inputs, Math.floor(Date.now() / 1000) + 1200)).wait();
      assert.ok((await output.balanceOf(backend)) > before, 'Universal Router swaps both directions');
    }
  },
);
