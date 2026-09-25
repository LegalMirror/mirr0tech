// Which deployed contract enforces each action of each profile, and what a refusal looks like there.
// Mirrors contracts/*.sol; the error names and argument orders are the Solidity ones.
import type { ProfileId } from "./types";

type Param = "clauseId" | "policyHash" | "subject";

export type Venue = {
  /** Contract and entry point that runs the program */
  contract: string;
  file: string;
  calls: string[];
  /** When the check runs */
  when: string;
  /** What the caller sees on a refusal */
  refusal: { name: string; params: Param[] } | null;
  /** A refusal that is not a revert (a zero credential, a false flag, an HTTP error) */
  note?: string;
};

const ROLE_PROVIDER = "contracts/MirrortechRoleProvider.sol";
const MARKET = "contracts/MockWildcatMarket.sol";
const HOOK = "contracts/MirrorPolicyHook.sol";
const TOKEN = "contracts/MirrorToken.sol";

const GATEWAY_MINT: Venue = {
  contract: "Gateway → MirrorToken.mint",
  file: "src/service.js",
  calls: ["evaluatePolicy(ast, 'mint', facts)", "MirrorToken.mint(operationId, amount)"],
  when: "before the custodial mint is signed",
  refusal: null,
  note: "HTTP 403 POLICY_DENIED with the failing rule ids; nothing reaches the chain",
};

const GATEWAY_BURN: Venue = {
  ...GATEWAY_MINT,
  contract: "Gateway → MirrorToken.burn",
  calls: ["evaluatePolicy(ast, 'burn', facts)", "MirrorToken.burn(operationId, amount)"],
  when: "before the redemption burn is signed",
};

const HOOK_VENUE: Venue = {
  contract: "MirrorPolicyHook (Uniswap v4)",
  file: HOOK,
  calls: ["beforeAddLiquidity", "beforeRemoveLiquidity", "beforeSwap"],
  when: "every pool operation, subject from hookData set by the trusted router",
  refusal: { name: "LegalClauseViolation", params: ["clauseId", "policyHash"] },
};

const VENUES: Record<ProfileId, Record<string, Venue[]>> = {
  "wildcat-credit": {
    deposit: [
      {
        contract: "MirrortechRoleProvider (Wildcat IRoleProvider)",
        file: ROLE_PROVIDER,
        calls: ["getCredential(account) → uint32"],
        when: "Wildcat's hooks ask for a credential at deposit",
        refusal: { name: "NoDepositCredential", params: ["subject"] },
        note: "getCredential returns 0; MockWildcatMarket.deposit reverts",
      },
      {
        contract: "MirrortechRoleProvider",
        file: ROLE_PROVIDER,
        calls: ["validateCredential(account, data)"],
        when: "a lender presents a signed screening certificate",
        refusal: { name: "PolicyDenied", params: ["clauseId", "policyHash"] },
      },
    ],
    withdraw: [
      {
        contract: "MirrortechRoleProvider",
        file: ROLE_PROVIDER,
        calls: ["mayWithdraw(account) → (bool, uint16)"],
        when: "at the moment of payment, not at onboarding",
        refusal: { name: "WithdrawalRefused", params: ["subject", "clauseId"] },
        note: "mayWithdraw returns (false, clauseId); MockWildcatMarket.withdraw reverts",
      },
    ],
    transfer: [
      {
        contract: "PolicyGuard (1inch SwapVM on Aqua)",
        file: "contracts/swapvm/PolicyGuard.sol",
        calls: ["_policyGuard(ctx, policyHash ‖ action)", "quote() and swap() — maker and taker"],
        when: "static quote and every fill of the buyback strategy",
        refusal: { name: "CounterpartyRefused", params: ["subject", "clauseId", "policyHash"] },
      },
      {
        contract: "MirrortechRoleProvider",
        file: ROLE_PROVIDER,
        calls: ["mayTransfer(to) → (bool, uint16)"],
        when: "every market-token transfer to a non-venue wallet",
        refusal: { name: "TransferRefused", params: ["subject", "clauseId"] },
        note: "MockWildcatMarket._update reverts",
      },
      HOOK_VENUE,
    ],
  },
  "custodial-rwa": {
    mint: [GATEWAY_MINT],
    burn: [GATEWAY_BURN],
    transfer: [
      {
        contract: "MirrorToken",
        file: TOKEN,
        calls: ["_update(from, to, value)"],
        when: "every peer transfer; this agreement compiles no transfer permit",
        refusal: { name: "TransfersDisabled", params: [] },
      },
    ],
  },
  "rwa-secondary": {
    mint: [GATEWAY_MINT],
    burn: [GATEWAY_BURN],
    transfer: [
      HOOK_VENUE,
      {
        contract: "MirrorToken (transfer gate)",
        file: TOKEN,
        calls: ["_update → policyOracle.mayTransfer(to)"],
        when: "a transfer out of custody to a wallet",
        refusal: { name: "TransferRefused", params: ["subject", "clauseId"] },
      },
      {
        contract: "MirrorToken (the only door into Uniswap)",
        file: TOKEN,
        calls: ["_update → venueHook.approvedSubject()"],
        when: "any settlement with PoolManager from a pool that did not run the hook",
        refusal: { name: "NoPolicyDoor", params: ["subject"] },
        note: "a hookless pool initializes, then its first settlement reverts at the token",
      },
    ],
  },
};

export function venuesFor(profile: ProfileId, action: string): Venue[] {
  return VENUES[profile][action] ?? [];
}

export function renderRefusal(
  refusal: NonNullable<Venue["refusal"]>,
  values: { clauseId: number; policyHash: string; subject: string }
): string {
  return `${refusal.name}(${refusal.params.map((param) => String(values[param])).join(", ")})`;
}
