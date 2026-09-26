// Uniswap v4 reads a hook's permissions from the low bits of its address, so the deployment address
// has to be searched for. The Arachnid deterministic deployer is present on Anvil and on every
// chain v4 is deployed to, which makes the search a pure off-chain loop over salts.
import { getCreate2Address, keccak256, concat, zeroPadValue, toBeHex } from 'ethers';

export const DETERMINISTIC_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

export const ALL_HOOK_MASK = (1n << 14n) - 1n;
export const FLAGS = {
  beforeInitialize: 1n << 13n, afterInitialize: 1n << 12n,
  beforeAddLiquidity: 1n << 11n, afterAddLiquidity: 1n << 10n,
  beforeRemoveLiquidity: 1n << 9n, afterRemoveLiquidity: 1n << 8n,
  beforeSwap: 1n << 7n, afterSwap: 1n << 6n,
  beforeSwapReturnsDelta: 1n << 3n,
};

export const MIRROR_HOOK_FLAGS = FLAGS.beforeAddLiquidity | FLAGS.beforeRemoveLiquidity | FLAGS.beforeSwap;
export const CASHIER_HOOK_FLAGS = MIRROR_HOOK_FLAGS | FLAGS.beforeSwapReturnsDelta;

/// Finds a salt whose CREATE2 address carries exactly the permission bits the hook declares.
export function mineHookAddress(initCode, flags = MIRROR_HOOK_FLAGS, { deployer = DETERMINISTIC_DEPLOYER, limit = 500_000 } = {}) {
  const initCodeHash = keccak256(initCode);
  for (let salt = 0; salt < limit; salt++) {
    const saltHex = zeroPadValue(toBeHex(salt), 32);
    const address = getCreate2Address(deployer, saltHex, initCodeHash);
    if ((BigInt(address) & ALL_HOOK_MASK) === flags) return { salt: saltHex, address, attempts: salt + 1 };
  }
  throw new Error(`No hook address with flags ${flags} found within ${limit} salts`);
}

export const deploymentCalldata = (salt, initCode) => concat([salt, initCode]);
