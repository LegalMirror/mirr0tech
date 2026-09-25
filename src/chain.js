import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { ensure, AppError } from './errors.js';

export const TOKEN_ABI = [
  'function policyHash() view returns (bytes32)', 'function custodian() view returns (address)',
  'function maxSupply() view returns (uint256)', 'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)',
  'function processed(bytes32) view returns (bool)', 'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function mint(bytes32,uint256)', 'function burn(bytes32,uint256)',
];

export class MockChain {
  constructor(store, policy) { this.store = store; this.policy = policy; this.mode = 'mock'; this.identity = `mock:${policy.hash}`; }
  async validate() {}
  async totalSupply() { return BigInt(this.store.state.chain.supply); }
  async execute(operation) {
    const { id, action, units } = operation;
    const result = this.store.update((state) => {
      if (state.chain.processed[id]) return { transactionHash: null, simulated: true };
      let supply = BigInt(state.chain.supply);
      const amount = BigInt(units);
      ensure(action === 'mint' ? supply + amount <= BigInt(this.policy.config.maxSupply) : supply >= amount, 409, 'CHAIN_REJECTED', 'Mock chain rejected supply change');
      supply = action === 'mint' ? supply + amount : supply - amount;
      state.chain.supply = supply.toString();
      state.chain.processed[id] = true;
      return { transactionHash: null, simulated: true };
    });
    return result;
  }
  close() {}
}

export class EvmChain {
  constructor({ rpcUrl, privateKey, tokenAddress, policy }) {
    ensure(privateKey && tokenAddress, 500, 'EVM_CONFIG', 'Set MINTER_PRIVATE_KEY and TOKEN_ADDRESS');
    this.provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
    this.provider.pollingInterval = 200;
    this.wallet = new Wallet(privateKey, this.provider);
    this.contract = new Contract(tokenAddress, TOKEN_ABI, this.wallet);
    this.policy = policy;
    this.mode = 'evm';
    this.identity = `evm:31337:${tokenAddress.toLowerCase()}:${policy.hash}`;
  }
  async validate() {
    const network = await this.provider.getNetwork();
    ensure(network.chainId === 31337n, 500, 'LOCAL_CHAIN_ONLY', 'This mock-settlement MVP supports development chain 31337 only');
    const [hash, custodian, cap, decimals, role] = await Promise.all([
      this.contract.policyHash(), this.contract.custodian(), this.contract.maxSupply(), this.contract.decimals(), this.contract.MINTER_ROLE(),
    ]);
    ensure(hash === this.policy.hash && cap === BigInt(this.policy.config.maxSupply) && decimals === 6n, 500, 'POLICY_MISMATCH', 'Deployed contract does not match the compiled policy');
    ensure(custodian.toLowerCase() === this.wallet.address.toLowerCase(), 500, 'CUSTODIAN_MISMATCH', 'Backend signer must be the custodial wallet');
    ensure(await this.contract.hasRole(role, this.wallet.address), 500, 'MINTER_ROLE_MISSING', 'Backend signer lacks MINTER_ROLE');
  }
  async totalSupply() { return this.contract.totalSupply(); }
  async execute(operation) {
    // An intent is persisted before this call. A retry after a crash checks the on-chain replay guard.
    if (await this.contract.processed(operation.id)) return { transactionHash: operation.transactionHash ?? null, simulated: false, recovered: true };
    try {
      let hash = operation.transactionHash;
      if (!hash) {
        const transaction = await this.contract[operation.action](operation.id, BigInt(operation.units));
        hash = transaction.hash;
        // Persist the tx hash before waiting. The operation ID also covers the pre-callback crash window.
        operation.onBroadcast(hash);
        operation.transactionHash = hash;
      }
      // A pending transaction is polled on retry, never blindly submitted again.
      const receipt = await this.provider.waitForTransaction(hash, 1, 30_000);
      if (!receipt) throw new Error('Transaction confirmation timed out');
      if (receipt.status !== 1) throw new AppError(409, 'CHAIN_REJECTED', 'On-chain transaction reverted');
      return { transactionHash: receipt.hash, simulated: false };
    } catch (error) {
      // A previous timed-out attempt may have won the race; never mark it failed without checking.
      if (await this.contract.processed(operation.id)) return { transactionHash: operation.transactionHash ?? null, simulated: false, recovered: true };
      if (error.code === 'CHAIN_REJECTED') throw error;
      if (error.code === 'CALL_EXCEPTION' && !operation.transactionHash) throw new AppError(409, 'CHAIN_REJECTED', 'Contract rejected this operation');
      throw error;
    }
  }
  close() { this.provider.destroy(); }
}
