import { readFile } from 'node:fs/promises';
import { Contract, isAddress } from 'ethers';

// One shared faucet for all future Sepolia deployments. Existing records keep their original assets.
export async function sharedMockUsd(provider, chainId) {
  if (Number(chainId) !== 11155111) return null;
  const deployment = JSON.parse(await readFile(new URL('../../deployments/sepolia-mockusd.json', import.meta.url), 'utf8'));
  if (deployment.chainId !== 11155111 || deployment.decimals !== 6 || !isAddress(deployment.address))
    throw new Error('Invalid shared mUSDC deployment record. Run pnpm deploy:mockusd.');
  if (BigInt(await provider.send('eth_chainId', [])) !== 11155111n)
    throw new Error('Shared mUSDC is deployed on Sepolia only.');
  const token = new Contract(deployment.address, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'], provider);
  const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
  if (decimals !== 6n || symbol !== 'mUSDC') throw new Error('The shared mUSDC contract metadata does not match its deployment.');
  return deployment.address;
}
