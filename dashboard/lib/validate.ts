import { isAddress, ZeroAddress } from "ethers";
import { GatewayError } from "./session";
import { walletError } from "./investor/wallet";

/** What is wrong with a six-decimal token amount typed by the user, or null when it can be submitted. */
export function amountError(value: string): string | null {
  const amount = value.trim();
  if (!amount) return "Enter an amount.";
  if (!/^\d+(?:\.\d+)?$/.test(amount)) return "Enter a number such as 100 or 12.5.";
  if ((amount.split(".")[1] ?? "").length > 6) return "Use at most 6 decimal places.";
  if (!/[1-9]/.test(amount)) return "Enter an amount greater than 0.";
  return null;
}

/** What is wrong with a recipient address typed by the user, or null when it can be submitted. */
export function addressError(value: string): string | null {
  const address = value.trim();
  if (!address) return "Enter a recipient address.";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return "Enter a 0x address with 40 hex characters.";
  if (!isAddress(address)) return "Address checksum is invalid. Check for a typo or paste it in lowercase.";
  if (address === ZeroAddress) return "The zero address cannot receive tokens.";
  return null;
}

/** A failed request or wallet operation as one line for an error notice, keeping the gateway's error code. */
export function actionError(failure: unknown): string {
  if (failure instanceof GatewayError)
    return failure.code === "HTTP_ERROR" ? failure.message : `${failure.message} (${failure.code})`;
  return walletError(failure);
}
