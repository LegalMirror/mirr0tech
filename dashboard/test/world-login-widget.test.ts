import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const widget = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => {
    widget.props = props;
    return null;
  },
}));
vi.mock("@worldcoin/idkit", () => ({
  orbLegacy: (options: object) => ({ credential: "orb", ...options }),
  selfieCheck: (options: object) => ({ credential: "selfie", ...options }),
}));
import { WorldLoginWidget, type LoginChallenge } from "@/app/_components/WorldLoginWidget";
const base = {
  challengeToken: "token",
  app_id: "app_test" as const,
  signal: "fresh-server-signal",
  rp_context: { rp_id: "rp_test", nonce: "nonce", signature: "sig", created_at: 1, expires_at: 2 },
};
describe("login widget mode", () => {
  it.each(["staging", "sandbox"] as const)(
    "selects the %s flow and forwards proofs to the backend",
    async (environment) => {
      const challenge: LoginChallenge = { ...base, environment, action: "registered-login" };
      const onProof = vi.fn(async (_proof: unknown) => {});
      const onClose = vi.fn();
      renderToStaticMarkup(
        createElement(WorldLoginWidget, { challenge, onProof, onClose, onError: vi.fn() })
      );
      expect(widget.props.environment).toBe(environment);
      expect(widget.props.rp_context).toBe(challenge.rp_context);
      if (environment === "staging") {
        expect(widget.props.action).toBe("registered-login");
        expect(widget.props.preset).toEqual({ credential: "orb", signal: challenge.signal });
        expect(widget.props.allow_legacy_proofs).toBe(true);
        expect(widget.props).not.toHaveProperty("existing_session_id");
      } else {
        expect(widget.props.constraints).toEqual({ type: "selfie", signal: challenge.signal });
        expect(widget.props).not.toHaveProperty("action");
        expect(widget.props).not.toHaveProperty("allow_legacy_proofs");
      }
      (widget.props.onSuccess as () => void)();
      expect(onProof).not.toHaveBeenCalled();
      const proof = { protocol_version: "3.0", integrity_bundle: { exact: true } };
      await (widget.props.handleVerify as (proof: unknown) => Promise<void>)(proof);
      expect(onProof).toHaveBeenCalledWith(proof);
      onProof.mockRejectedValueOnce(new Error("Rejected"));
      await expect((widget.props.handleVerify as (proof: unknown) => Promise<void>)(proof)).rejects.toThrow(
        "Rejected"
      );
    }
  );
});
