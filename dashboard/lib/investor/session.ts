import { getAddress } from "ethers";
import type { InvestorSession, InvestorChallenge, PublicFund, InvestorConfig } from "./types";
import { SEPOLIA } from "./types";
import { contextIssue } from "../identity";

export function sessionAlive(value: InvestorSession | null, now = Date.now()): value is InvestorSession {
  return !!value && Number.isFinite(value.expiresAt) && value.expiresAt * 1000 > now;
}
export function validateChallenge(
  value: InvestorChallenge,
  wallet: string,
  fund: PublicFund,
  config: InvestorConfig,
  now = Date.now(),
  origin?: string
) {
  if (
    !value?.challengeId ||
    !value.message ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt * 1000 <= now
  )
    throw new Error("The sign-in challenge is missing or expired. Request a fresh challenge.");
  if (
    getAddress(value.wallet) !== getAddress(wallet) ||
    value.fundId !== fund.id ||
    value.chainId !== SEPOLIA ||
    config.chainId !== SEPOLIA ||
    fund.chainId !== SEPOLIA
  )
    throw new Error("The challenge does not match this wallet, fund and Sepolia chain.");
  if (
    !value.world ||
    value.world.mock !== config.mock ||
    (!config.mock && value.world.environment !== config.environment)
  )
    throw new Error("World verification mode changed. Refresh the public configuration before signing in.");
  if (value.world.mock || config.credential !== "document")
    throw new Error(
      "Sepolia investor login requires a real configured Passport proof. Local synthetic verification is not permitted on Sepolia; no Orb is additionally required."
    );
  const jsonStart = value.message.indexOf("\n\n{");
  let scope: Record<string, unknown>;
  try {
    scope = JSON.parse(value.message.slice(jsonStart + 2));
  } catch {
    throw new Error("The wallet challenge is not the expected EIP-191 investor sign-in message.");
  }
  if (
    !value.message.startsWith("mirr0tech investor login (EIP-191)\n") ||
    scope.wallet !== value.wallet.toLowerCase() ||
    scope.fundId !== fund.id ||
    scope.chainId !== SEPOLIA ||
    scope.policyHash !== fund.policyHash.toLowerCase() ||
    scope.nonce !== value.challengeId ||
    scope.worldNonce !== value.world.rp_context.nonce ||
    scope.expiresAt !== value.expiresAt ||
    scope.credential !== value.world.credential ||
    scope.environment !== value.world.environment ||
    scope.mock !== false ||
    scope.action !== value.world.action ||
    scope.rpId !== value.world.rp_id ||
    scope.appId !== value.world.app_id ||
    (origin && scope.origin !== origin)
  )
    throw new Error(
      "The signed message does not bind the expected wallet, fund, policy, origin and World nonce."
    );
  const issue = contextIssue(value.world, config.credential, now);
  if (issue) throw new Error(issue);
}
export function validateInvestorSession(
  value: InvestorSession,
  challenge: InvestorChallenge,
  fund: PublicFund,
  now = Date.now()
): InvestorSession {
  const identity = value?.session;
  if (!sessionAlive(value, now) || typeof value.accessToken !== "string" || !value.accessToken)
    throw new Error("The gateway did not return a usable investor session.");
  if (
    !identity ||
    getAddress(identity.wallet) !== getAddress(challenge.wallet) ||
    identity.fundId !== fund.id ||
    identity.policyHash.toLowerCase() !== fund.policyHash.toLowerCase() ||
    identity.chainId !== SEPOLIA ||
    identity.credential !== challenge.world.credential ||
    identity.environment !== challenge.world.environment ||
    identity.mock !== challenge.world.mock
  )
    throw new Error(
      "The investor session does not match the wallet, fund policy or World request. Sign-in was not accepted."
    );
  return value;
}

/** Deliberately separate from lib/session.ts. No operator key, cookie, storage, or role promotion. */
export function createInvestorSessionStore() {
  let value: InvestorSession | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: InvestorSession | null) => {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export const investorSession = createInvestorSessionStore();
export const serverInvestorSession = () => null;
