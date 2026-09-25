import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { ContractFactory, JsonRpcProvider, Wallet, id, ZeroAddress } from 'ethers';
import { EvmChain } from '../../src/chain.js';
import { compiled, setup, funded } from '../helpers.js';

// Public Anvil development key, never use for assets or a public chain.
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const artifact = JSON.parse(await readFile('artifacts/CompiledMirrorToken.json', 'utf8'));
const baseArtifact = JSON.parse(await readFile('artifacts/MirrorToken.json', 'utf8'));

test('Solidity guards and backend signer integration on a real local EVM', { timeout: 120_000 }, async (t) => {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let startupError;
  anvil.on('error', (error) => { startupError = error; });
  let stderr = '';
  anvil.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => { if (anvil.exitCode === null && !startupError) { const exited = once(anvil, 'exit'); anvil.kill('SIGTERM'); await exited; } });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw new Error(`Install Foundry/Anvil to run chain tests: ${startupError.message}`);
    if (anvil.exitCode !== null) throw new Error(`Anvil exited: ${stderr}`);
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if ((await response.json()).result === '0x7a69') { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, `Anvil did not start: ${stderr}`);
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 50;
  t.after(() => provider.destroy());
  const owner = new Wallet(DEV_KEY, provider);
  const stranger = await provider.getSigner(1);
  const deploy = async () => {
    const token = await new ContractFactory(artifact.abi, artifact.bytecode, owner).deploy(owner.address, owner.address);
    await token.waitForDeployment(); return token;
  };
  const transact = async (transaction) => (await transaction).wait();

  await t.test('only minter can mint/burn; transfers, duplicate operations and zero amounts fail', async () => {
    const token = await deploy();
    assert.equal(await token.policyHash(), compiled.policy.hash);
    assert.equal(await token.decimals(), 6n);
    await assert.rejects(token.connect(stranger).mint(id('unauthorized'), 1n));
    await transact(token.mint(id('mint'), 100000000n));
    assert.equal(await token.balanceOf(owner.address), 100000000n);
    await assert.rejects(token.mint(id('mint'), 100000000n));
    await assert.rejects(token.mint(id('zero'), 0n));
    await assert.rejects(token.mint(`0x${'0'.repeat(64)}`, 1n));
    await assert.rejects(token.connect(stranger).burn(id('unauthorized-burn'), 1n));
    await assert.rejects(token.transfer(await stranger.getAddress(), 1n));
    await transact(token.approve(await stranger.getAddress(), 1n));
    await assert.rejects(token.connect(stranger).transferFrom(owner.address, await stranger.getAddress(), 1n));
    await assert.rejects(token.burn(id('overdraw'), 100000001n));
    await transact(token.burn(id('burn'), 25000000n));
    assert.equal(await token.totalSupply(), 75000000n);
    await assert.rejects(token.burn(id('mint'), 1n));
  });
  await t.test('supply cap, admin pause and minter role revocation apply on chain', async () => {
    const token = await deploy();
    await transact(token.mint(id('cap'), BigInt(compiled.policy.config.maxSupply)));
    await assert.rejects(token.mint(id('over-cap'), 1n));
    assert.equal(await token.processed(id('over-cap')), false);
    await assert.rejects(token.connect(stranger).pause());
    await transact(token.pause());
    await assert.rejects(token.burn(id('paused'), 1n));
    await transact(token.unpause());
    await transact(token.burn(id('unpaused'), 1n));
    await transact(token.revokeRole(await token.MINTER_ROLE(), owner.address));
    await assert.rejects(token.mint(id('revoked'), 1n));
    await assert.rejects(token.burn(id('revoked-burn'), 1n));
  });
  await t.test('compiled action switches and constructor validation cannot be bypassed', async () => {
    const factory = new ContractFactory(baseArtifact.abi, baseArtifact.bytecode, owner);
    await assert.rejects(factory.deploy('Test', 'TEST', ZeroAddress, owner.address, compiled.policy.hash, 100n, true, true));
    const token = await factory.deploy('Test', 'TEST', owner.address, owner.address, compiled.policy.hash, 100n, false, false);
    await token.waitForDeployment();
    await assert.rejects(token.mint(id('disabled-mint'), 1n));
    await assert.rejects(token.burn(id('disabled-burn'), 1n));
  });
  await t.test('backend signs a funded mint and a burn, and reconciles a mined retry', async (subtest) => {
    const token = await deploy();
    const chain = new EvmChain({ rpcUrl, privateKey: DEV_KEY, tokenAddress: await token.getAddress(), policy: compiled.policy });
    const { service } = await setup(subtest, { chain });
    const { investor, body } = await funded(service);
    const execute = chain.execute.bind(chain);
    let loseReply = true;
    chain.execute = async (operation) => { const result = await execute(operation); if (loseReply) { loseReply = false; throw new Error('Simulated connection loss after mining'); } return result; };
    await assert.rejects(service.operate('mint', body, 'evm-mint'), { code: 'CHAIN_CONFIRMATION_PENDING' });
    const minted = await service.operate('mint', body, 'evm-mint');
    assert.equal(minted.status, 'confirmed');
    assert.equal(minted.recovered, true);
    assert.equal(await token.totalSupply(), 100000000n);
    assert.equal(minted.simulated, false);
    assert.ok(minted.transactionHash);
    const burn = await service.operate('burn', { investorId: investor.id, amount: '40' }, 'evm-burn');
    assert.equal(burn.status, 'confirmed');
    assert.equal(await token.totalSupply(), 60000000n);
    assert.equal(await token.balanceOf(owner.address), 60000000n);
    assert.equal(service.investor(investor.id).balanceUnits, '60000000');
    assert.equal(service.snapshot().withdrawals[burn.id].status, 'pending');
  });
  await t.test('backend refuses a policy hash that differs from its deployed contract', async () => {
    const token = await deploy();
    const chain = new EvmChain({ rpcUrl, privateKey: DEV_KEY, tokenAddress: await token.getAddress(), policy: { ...compiled.policy, hash: id('different') } });
    try { await assert.rejects(chain.validate(), { code: 'POLICY_MISMATCH' }); } finally { chain.close(); }
  });
  await t.test('recovery waits for an existing pending transaction without sending another', async () => {
    const token = await deploy();
    const chain = new EvmChain({ rpcUrl, privateKey: DEV_KEY, tokenAddress: await token.getAddress(), policy: compiled.policy });
    try {
      await provider.send('evm_setAutomine', [false]);
      const transaction = await token.mint(id('pending-recovery'), 100n);
      const nonce = await provider.getTransactionCount(owner.address, 'pending');
      const recovered = chain.execute({ id: id('pending-recovery'), action: 'mint', units: '100', transactionHash: transaction.hash, onBroadcast: () => assert.fail('must not rebroadcast') });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await provider.getTransactionCount(owner.address, 'pending'), nonce);
      await provider.send('evm_mine', []);
      assert.equal((await recovered).transactionHash, transaction.hash);
      assert.equal(await token.totalSupply(), 100n);
    } finally { await provider.send('evm_setAutomine', [true]); chain.close(); }
  });
});
