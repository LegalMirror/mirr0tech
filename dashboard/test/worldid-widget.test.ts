import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorldIdContext } from "@/lib/types";

const widget = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => {
    widget.props = props;
    return null;
  },
}));
vi.mock("@worldcoin/idkit", () => ({
  passport: (options: object) => ({ credential: "document", ...options }),
  proofOfHuman: (options: object) => ({ credential: "proof_of_human", ...options }),
  selfieCheck: (options: object) => ({ credential: "selfie", ...options }),
}));
import { WorldIdWidget } from "@/app/_components/WorldIdWidget";

const wallet = `0x${"aB".repeat(20)}`;
const context: WorldIdContext = {
  app_id: "app_test",
  rp_id: "rp_test",
  action: "policy-check",
  credential: "document",
  environment: "staging",
  mock: false,
  rp_context: { rp_id: "rp_test", nonce: "server-nonce", signature: "0x1234", created_at: 1, expires_at: 2 },
};

describe("IDKit boundary", () => {
  it.each(["document", "proof_of_human", "selfie"] as const)(
    "binds %s to the canonical confirmed wallet and server context",
    (credential) => {
      renderToStaticMarkup(
        createElement(WorldIdWidget, {
          context: { ...context, credential },
          wallet,
          onProof: vi.fn(),
          onClose: vi.fn(),
          onError: vi.fn(),
        })
      );
      expect(widget.props.preset).toEqual({ credential, signal: wallet.toLowerCase() });
      expect(widget.props.rp_context).toBe(context.rp_context);
      expect(widget.props.action).toBe(context.action);
      expect(widget.props.allow_legacy_proofs).toBe(false);
    }
  );
  it("forwards the full result unchanged and never treats onSuccess as an attestation", async () => {
    const onProof = vi.fn(async (_proof: unknown) => {});
    const onClose = vi.fn();
    renderToStaticMarkup(
      createElement(WorldIdWidget, { context, wallet, onProof, onClose, onError: vi.fn() })
    );
    (widget.props.onSuccess as () => void)();
    expect(onProof).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    const result = {
      action: "returned-action",
      environment: "staging",
      responses: [{ issuer_schema_id: 9303, signal_hash: "exact-hash" }],
      integrity_bundle: { version: 2, jwt: "unchanged-test-bundle" },
    };
    await (widget.props.handleVerify as (result: unknown) => Promise<void>)(result);
    expect(onProof.mock.calls[0][0]).toBe(result);
  });
  it("propagates server refusal to IDKit and exposes cancellation/provider errors", async () => {
    const onProof = vi.fn(async () => {
      throw new Error("Server rejected proof");
    });
    const onClose = vi.fn();
    const onError = vi.fn();
    renderToStaticMarkup(createElement(WorldIdWidget, { context, wallet, onProof, onClose, onError }));
    await expect((widget.props.handleVerify as (result: unknown) => Promise<void>)({})).rejects.toThrow(
      "Server rejected proof"
    );
    (widget.props.onOpenChange as (open: boolean) => void)(false);
    (widget.props.onError as (code: string) => void)("credential_unavailable");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("credential_unavailable");
  });
});
