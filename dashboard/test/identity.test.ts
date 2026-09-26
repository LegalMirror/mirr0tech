import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CREDENTIAL_COPY,
  IDENTITY_PRIVACY,
  attestationConfirmed,
  attestationReceipt,
  contextIssue,
  identityFailure,
  readAccess,
  remainingRules,
  sampleIdentity,
  verifierLabel,
  type AccessSnapshot,
} from "@/lib/identity";
import { mockProof } from "@/lib/worldid";
import type { AccessDecision, AgreementsClient, AgreementWallet, IdentityReceipt } from "@/lib/agreements";
import type { WorldIdContext } from "@/lib/types";
import { IdentityAccess, IdentityPolicy } from "@/app/_workbench/IdentityView";
import { compiled } from "./fixtures";

const wallet: AgreementWallet = {
  name: "Investor",
  address: `0x${"a".repeat(40)}`,
  rwa: { facts: { identityVerified: false, kycApproved: false, amlApproved: null } },
};
const receipt: IdentityReceipt = {
  type: "worldid.verify",
  status: "ok",
  txHash: `0x${"b".repeat(64)}`,
  wallet: "Investor",
  facts: { identityVerified: true },
};
const context: WorldIdContext = {
  app_id: "app_test",
  rp_id: "rp_test",
  action: "onboard-investor",
  credential: "document",
  environment: "production",
  mock: false,
  rp_context: {
    rp_id: "rp_test",
    nonce: "nonce",
    created_at: 1,
    expires_at: 9999999999,
    signature: "0x1234",
  },
};
const decision: AccessDecision = {
  wallet: wallet.name,
  address: wallet.address,
  action: "transfer",
  allowed: false,
  clauseId: 1,
  clause: { clause: "Onboarding", quote: "KYC and AML remain required" },
  facts: wallet.rwa.facts,
  sanctioned: false,
  screeningCurrent: true,
};

describe("World ID trust boundaries", () => {
  it.each(["document", "proof_of_human", "selfie"] as const)(
    "uses the required mock credential schema for %s",
    async (credential) => {
      const proof = await mockProof(wallet.address, "onboard", wallet.address, credential);
      expect(proof.responses[0]).toMatchObject({
        issuer_schema_id: { document: 9303, proof_of_human: 1, selfie: 11 }[credential],
      });
      expect(proof.action).toBe("onboard");
    }
  );
  it("keeps cancellation, unavailable and wrong-credential refusal actionable", () => {
    expect(identityFailure("user_rejected")).toMatchObject({ cancelled: true, title: "Request cancelled" });
    expect(identityFailure("credential_unavailable").detail).toMatch(/does not have the required credential/);
    expect(identityFailure({ code: "WRONG_CREDENTIAL" }).detail).toMatch(/cannot replace it/);
    expect(identityFailure({ code: "HUMAN_ALREADY_BOUND" }).detail).toMatch(/previously bound wallet/);
    expect(identityFailure({ code: "APP_NOT_MIGRATED" }).detail).toMatch(/No client-side bypass/);
    expect(identityFailure({ code: "INVALID_PROOF" }).title).toBe("Proof was not accepted");
  });
  it("refuses incomplete live setup, expired requests and mismatched policy credentials", () => {
    expect(contextIssue(context, "document")).toBeNull();
    expect(contextIssue({ ...context, environment: "sandbox", action: "humanity" }, "document")).toBeNull();
    expect(contextIssue(context, "proof_of_human")).toMatch(/different credential/);
    expect(
      contextIssue({ ...context, rp_context: { ...context.rp_context, signature: "0xmock" } }, "document")
    ).toMatch(/incomplete/);
    expect(
      contextIssue({ ...context, rp_context: { ...context.rp_context, expires_at: 0 } }, "document")
    ).toMatch(/expired/);
    expect(contextIssue({ ...context, environment: "unknown" }, "document")).toMatch(/not supported/);
    expect(contextIssue({ ...context, mock: true, environment: "mock" }, "document")).toBeNull();
  });
  it("never infers real identity verification from a demo, staging or sandbox context", () => {
    expect(verifierLabel({ ...context, mock: true })).toBe("Demo verifier");
    expect(verifierLabel({ ...context, environment: "staging" })).toContain("test environment");
    expect(verifierLabel({ ...context, environment: "sandbox" })).toContain("test environment");
    expect(verifierLabel(context)).toBe("Production verifier configured");
    expect(verifierLabel(null)).toBe("Verifier not checked");
    expect(CREDENTIAL_COPY.document.limit).toMatch(
      /does not identify who.*KYC\/AML.*sanctions.*accreditation/
    );
    expect(CREDENTIAL_COPY.proof_of_human.limit).toMatch(/does not prevent all bots/);
    expect(CREDENTIAL_COPY.selfie.limit).toMatch(/not.*strict one-person-one-account/i);
    expect(IDENTITY_PRIVACY).toMatch(/public on-chain/);
    expect(IDENTITY_PRIVACY).toMatch(/not upload a raw passport or selfie/);
  });
  it("requires the backend receipt AND a fresh identity fact, not a client callback", () => {
    const before: AccessSnapshot = { wallet, decisions: [] };
    const after: AccessSnapshot = {
      wallet: { ...wallet, rwa: { facts: { identityVerified: true } } },
      decisions: [],
    };
    expect(attestationConfirmed(null, after)).toBe(false);
    expect(attestationConfirmed(receipt, before)).toBe(false);
    expect(attestationConfirmed(receipt, after)).toBe(true);
    for (const bad of [
      { ...receipt, status: "refused" },
      { ...receipt, txHash: null },
      { ...receipt, wallet: "Other investor" },
      { ...receipt, facts: {} },
      { ...receipt, type: "attest" },
    ])
      expect(attestationReceipt(bad, wallet)).toBe(false);
  });
  it("reads each actual protected action and surfaces partial read errors without declaring access", async () => {
    const client = {
      wallet: vi.fn().mockResolvedValue(wallet),
      explain: vi.fn().mockResolvedValueOnce(decision).mockRejectedValueOnce(new Error("RPC unavailable")),
    } as unknown as AgreementsClient;
    const result = await readAccess(client, "agr_a", wallet.address, ["transfer", "mint"]);
    expect(client.explain).toHaveBeenNthCalledWith(1, "agr_a", wallet.address, "transfer", undefined);
    expect(result.decisions[1]).toMatchObject({ action: "mint", decision: null, error: "RPC unavailable" });
    expect(result.decisions[0].decision?.allowed).toBe(false);
  });
  it("rejects a read for another wallet", async () => {
    const client = {
      wallet: vi.fn().mockResolvedValue(wallet),
      explain: vi.fn().mockResolvedValue({ ...decision, address: `0x${"c".repeat(40)}` }),
    } as unknown as AgreementsClient;
    expect(
      (await readAccess(client, "agr_a", wallet.address, ["transfer"])).decisions[0].decision
    ).toBeNull();
  });
  it("still shows blocked access and remaining requirements after the identity condition is met", async () => {
    const policy = await compiled("rwa-secondary");
    const fresh = { ...decision, facts: { ...decision.facts, identityVerified: true } };
    const remaining = remainingRules(policy, fresh);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.every((entry) => !entry.id.endsWith("-identity-verified"))).toBe(true);
    const html = renderToStaticMarkup(
      createElement(IdentityAccess, {
        policy,
        snapshot: { wallet, decisions: [{ action: "transfer", decision: fresh, error: null }] },
      })
    );
    expect(html).toContain("Blocked");
    expect(html).toContain("fact present");
    expect(html).toContain("Remaining policy requirements");
    const identity = sampleIdentity(policy)!;
    const card = renderToStaticMarkup(createElement(IdentityPolicy, { identity, sample: true }));
    expect(card).toContain("Verbatim clause");
    expect(card).toContain("Passport / NFC");
    expect(card).not.toContain("Verified");
  });
});
