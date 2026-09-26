import type {
  AccessDecision,
  AgreementsClient,
  AgreementWallet,
  IdentityConstraint,
  IdentityReceipt,
} from "./agreements";
import type { PolicyData, WorldIdContext } from "./types";
import { evaluatePolicy } from "./evaluate";

export type Credential = WorldIdContext["credential"];
export const CREDENTIAL_COPY: Record<Credential, { label: string; purpose: string; limit: string }> = {
  document: {
    label: "Document · Passport / NFC",
    purpose:
      "A passport-backed credential check when the issuer needs documentary assurance. No name or passport image is requested by this dashboard.",
    limit:
      "This does not identify who the person is to the issuer, complete KYC/AML, clear sanctions, or establish accreditation.",
  },
  proof_of_human: {
    label: "Proof of Human",
    purpose:
      "A personhood / uniqueness credential when a person behind the wallet is sufficient, without requesting documentary identity attributes.",
    limit:
      "Not proof of legal identity or eligibility. It does not prevent all bots or abuse; server verification, scoped nullifier binding and access policy still matter.",
  },
  selfie: {
    label: "Selfie Check",
    purpose:
      "A lower-friction liveness / continuity credential when that assurance is sufficient. It does not request a passport credential.",
    limit:
      "Not documentary identity, full KYC or a strict one-person-one-account guarantee. This UI does not invent a sybil-score policy.",
  },
};
export const IDENTITY_PRIVACY =
  "Your wallet address, policy hash and attested facts are public on-chain. This dashboard sends the complete proof to the gateway for server verification; it does not upload a raw passport or selfie. The gateway keeps a nullifier-to-wallet binding, so this is not anonymous to the operator. World App handles its own credential data.";

export function sampleIdentity(policy: PolicyData): IdentityConstraint | null {
  const rules = policy.rules.filter((rule) => rule.id.endsWith("-identity-verified"));
  if (!rules.length) return null;
  const config = policy.config.worldId as { credential?: Credential } | undefined;
  return {
    credential: config?.credential ?? "document",
    actions: [...new Set(rules.map((rule) => rule.action))],
    clause: rules[0].source.clause,
    quote: rules[0].source.quote,
  };
}
export function verifierLabel(context: WorldIdContext | null): string {
  if (!context) return "Verifier not checked";
  if (context.mock === true) return "Demo verifier";
  if (context.mock !== false) return "Verifier mode unknown";
  return context.environment === "production"
    ? "Production verifier configured"
    : `${context.environment} verifier · test environment`;
}
export function contextIssue(context: WorldIdContext, expected: Credential, now = Date.now()): string | null {
  if (context.credential !== expected)
    return "The gateway requests a different credential than this policy. Refresh the agreement; do not substitute a weaker credential.";
  if (context.mock === true) return null;
  if (context.mock !== false || !["staging", "production"].includes(context.environment))
    return "The verifier mode or environment is not supported by this installed IDKit. Ask the operator to check the World configuration.";
  if (
    !context.app_id?.startsWith("app_") ||
    context.app_id === "app_mock" ||
    !context.rp_id?.startsWith("rp_") ||
    context.rp_id === "rp_mock" ||
    !context.action ||
    context.rp_context?.rp_id !== context.rp_id ||
    !/^0x[0-9a-f]+$/i.test(context.rp_context?.signature ?? "")
  )
    return "Live World ID setup is incomplete. The gateway must provide a registered app, RP and signed request. No demo fallback will be used.";
  if (context.rp_context.expires_at * 1000 <= now)
    return "The signed request expired. Retry to obtain a fresh request from the gateway.";
  return null;
}
export function identityFailure(error: unknown): { title: string; detail: string; cancelled: boolean } {
  const raw = typeof error === "string" ? error : ((error as { code?: string })?.code ?? "");
  const code = raw.toUpperCase();
  if (["USER_REJECTED", "CANCELLED"].includes(code))
    return {
      title: "Request cancelled",
      detail: "No new access was granted by this browser. You can review the wallet and try again.",
      cancelled: true,
    };
  if (code === "WRONG_CREDENTIAL")
    return {
      title: "Credential not accepted",
      detail:
        "This agreement requires the selected credential. Another credential cannot replace it. Use the required credential, or ask the issuer to review the policy—not bypass it.",
      cancelled: false,
    };
  if (code === "CREDENTIAL_UNAVAILABLE")
    return {
      title: "Required credential unavailable",
      detail:
        "This World App does not have the required credential. Obtain it through World App if eligible, or contact the issuer. The protected actions remain subject to the same policy.",
      cancelled: false,
    };
  if (code === "HUMAN_ALREADY_BOUND" || code === "NULLIFIER_REPLAYED")
    return {
      title: "Proof already associated or used",
      detail:
        "Use the previously bound wallet or ask the operator to review the binding. Refresh current access before requesting another proof.",
      cancelled: false,
    };
  if (["CONFIG", "APP_NOT_MIGRATED", "INVALID_RP_SIGNATURE", "UNKNOWN_RP", "INACTIVE_RP"].includes(code))
    return {
      title: "Live verifier needs configuration",
      detail:
        "Ask the operator to check the World app, RP registration, signing key and environment. No client-side bypass or silent demo fallback is available.",
      cancelled: false,
    };
  if (code === "VERIFICATION_REJECTED" || code === "INVALID_PROOF")
    return {
      title: "Proof was not accepted",
      detail:
        "No access is granted by a rejected proof. Confirm the wallet and required credential, then retry with a fresh request.",
      cancelled: false,
    };
  return {
    title: "Verification could not finish",
    detail:
      error instanceof Error
        ? error.message
        : `World ID returned ${raw || "an unknown error"}. Retry with a fresh request, or ask the operator for help.`,
    cancelled: false,
  };
}

export type AccessSnapshot = {
  wallet: AgreementWallet;
  decisions: { action: string; decision: AccessDecision | null; error: string | null }[];
};
export async function readAccess(
  client: AgreementsClient,
  id: string,
  wallet: string,
  actions: string[],
  signal?: AbortSignal
): Promise<AccessSnapshot> {
  const person = await client.wallet(id, wallet, signal);
  if (/^0x[0-9a-f]{40}$/i.test(wallet) && person.address.toLowerCase() !== wallet.toLowerCase())
    throw new Error("Gateway returned another wallet. No access change is confirmed.");
  const decisions = await Promise.all(
    actions.map(async (action) => {
      try {
        const decision = await client.explain(id, wallet, action, signal);
        if (decision.address.toLowerCase() !== person.address.toLowerCase() || decision.action !== action)
          throw new Error("Gateway returned a decision for another wallet or action.");
        return { action, decision, error: null };
      } catch (error) {
        return { action, decision: null, error: (error as Error).message };
      }
    })
  );
  return { wallet: person, decisions };
}
export function attestationReceipt(receipt: IdentityReceipt, wallet: AgreementWallet): boolean {
  return (
    receipt?.type === "worldid.verify" &&
    receipt.status === "ok" &&
    receipt.facts?.identityVerified === true &&
    /^0x[0-9a-f]{64}$/i.test(receipt.txHash ?? "") &&
    [wallet.name.toLowerCase(), wallet.address.toLowerCase()].includes(receipt.wallet?.toLowerCase())
  );
}
export function attestationConfirmed(
  receipt: IdentityReceipt | null,
  snapshot: AccessSnapshot | null
): boolean {
  return (
    !!receipt &&
    !!snapshot &&
    attestationReceipt(receipt, snapshot.wallet) &&
    snapshot.wallet.rwa.facts.identityVerified === true
  );
}
export function remainingRules(policy: PolicyData, decision: AccessDecision) {
  const result = evaluatePolicy(policy.rules, decision.action, decision.facts);
  return result.reasons
    .filter((id) => !id.endsWith("-identity-verified"))
    .map((id) => {
      const rule = policy.rules.find((rule) => rule.id === id);
      return {
        id,
        clause: rule?.source.clause ?? "No matching permission",
        quote:
          rule?.source.quote ??
          "An applicable permission must also hold; identity alone is not authorization.",
      };
    });
}
