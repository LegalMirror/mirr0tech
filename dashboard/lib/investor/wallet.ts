import { getAddress, hexlify, toUtf8Bytes, verifyMessage } from "ethers";
import { SEPOLIA } from "./types";

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};
export type WalletIdentity = { address: string; chainId: number };
export class WalletChanged extends Error {
  constructor(public txHash?: string) {
    super(
      "The wallet account or chain changed. Sign in again. A wallet prompt already open may still complete; check wallet history before retrying."
    );
  }
}
export function injectedWallet(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const provider = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  return typeof provider?.request === "function" ? provider : null;
}
export function walletError(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 4001 || code === 4100)
    return "Wallet request rejected or not authorized. Nothing will be retried automatically; review the request and try again when ready.";
  if (code === 4902)
    return "This wallet does not have Sepolia configured. Add Sepolia in the wallet, then reconnect. World MiniKit cannot sign this Sepolia transaction.";
  if (code === 4900 || code === 4901)
    return "The wallet is disconnected from the requested chain. Reconnect on Sepolia and sign in again.";
  if (code === -32002)
    return "A wallet request is already open. Finish or cancel it in the wallet before trying again.";
  return error instanceof Error ? error.message : "The wallet could not complete this request.";
}
export async function walletIdentity(provider: Eip1193Provider): Promise<WalletIdentity> {
  const [accounts, chain] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
    throw new Error("No wallet account is connected. Connect a Sepolia-capable browser wallet.");
  if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain))
    throw new Error("The wallet returned an invalid chain ID.");
  return { address: getAddress(accounts[0]), chainId: Number(BigInt(chain)) };
}
export async function connectWallet(provider: Eip1193Provider) {
  await provider.request({ method: "eth_requestAccounts" });
  return walletIdentity(provider);
}
export async function switchToSepolia(provider: Eip1193Provider) {
  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: `0x${SEPOLIA.toString(16)}` }],
  });
  const current = await walletIdentity(provider);
  if (current.chainId !== SEPOLIA)
    throw new Error("The wallet did not switch to Sepolia. No sign-in or transaction request was queued.");
  return current;
}
export function observeWallet(provider: Eip1193Provider, invalidate: (reason: string) => void) {
  const accounts = () => invalidate("Wallet account changed. Investor session cleared.");
  const chain = () =>
    invalidate("Wallet chain changed. Investor session cleared; no transaction will be queued.");
  const disconnect = () => invalidate("Wallet disconnected. Investor session cleared.");
  provider.on?.("accountsChanged", accounts);
  provider.on?.("chainChanged", chain);
  provider.on?.("disconnect", disconnect);
  return () => {
    provider.removeListener?.("accountsChanged", accounts);
    provider.removeListener?.("chainChanged", chain);
    provider.removeListener?.("disconnect", disconnect);
  };
}
export async function assertWallet(
  provider: Eip1193Provider,
  expected: WalletIdentity,
  current: () => boolean
) {
  if (!current()) throw new WalletChanged();
  const actual = await walletIdentity(provider);
  if (
    !current() ||
    actual.address !== getAddress(expected.address) ||
    actual.chainId !== SEPOLIA ||
    expected.chainId !== SEPOLIA
  )
    throw new WalletChanged();
}
export async function signChallenge(
  provider: Eip1193Provider,
  expected: WalletIdentity,
  message: string,
  current: () => boolean
) {
  await assertWallet(provider, expected, current);
  const signature = await provider.request({
    method: "personal_sign",
    params: [hexlify(toUtf8Bytes(message)), expected.address],
  });
  await assertWallet(provider, expected, current);
  if (typeof signature !== "string" || !/^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i.test(signature))
    throw new Error("The wallet did not return a valid personal-sign signature.");
  if (getAddress(verifyMessage(message, signature)) !== getAddress(expected.address))
    throw new Error("The signature does not belong to the confirmed wallet.");
  return signature;
}
export async function sendWalletTransaction(
  provider: Eip1193Provider,
  expected: WalletIdentity,
  transaction: { from: string; to: string; data: string; value: string },
  current: () => boolean
) {
  await assertWallet(provider, expected, current);
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ ...transaction, chainId: `0x${SEPOLIA.toString(16)}` }],
  });
  if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash))
    throw new Error("The wallet did not return a transaction hash. Check its history before retrying.");
  try {
    await assertWallet(provider, expected, current);
  } catch {
    throw new WalletChanged(hash);
  }
  return hash;
}
