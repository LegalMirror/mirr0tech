import { Interface, MaxUint256, getAddress, parseUnits } from "ethers";
import deployment from "../../deployments/sepolia-mockusd.json";
import type { WalletIdentity } from "./investor/wallet";

export const MOCK_USD = deployment;
export const MOCK_USD_ABI = [
  "function mint(address to,uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const token = new Interface(MOCK_USD_ABI);
export function mockUsdMintTransaction(wallet: WalletIdentity, amount: string) {
  if (wallet.chainId !== MOCK_USD.chainId) throw new Error("Switch your wallet to Sepolia to mint mUSDC.");
  const value = amount.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(value))
    throw new Error("Enter a positive amount with up to six decimal places.");
  const units = parseUnits(value, MOCK_USD.decimals);
  if (units <= 0n || units > MaxUint256)
    throw new Error("Enter a positive amount that fits in the token’s uint256 amount field.");
  const recipient = getAddress(wallet.address);
  return {
    from: recipient,
    to: MOCK_USD.address,
    value: "0x0",
    data: token.encodeFunctionData("mint", [recipient, units]),
  };
}
