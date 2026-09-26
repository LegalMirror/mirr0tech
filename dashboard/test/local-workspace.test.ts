import { afterEach, describe, expect, it, vi } from "vitest";
import { startDemoWorkspace } from "@/lib/demo-session";
import {
  canMutateAgreements,
  gatewayRequest,
  getSession,
  hasGatewaySession,
  setSession,
} from "@/lib/session";

afterEach(() => {
  setSession({ url: "", viewerKey: "", operatorKey: "", autoDemo: false });
  vi.unstubAllGlobals();
});
describe("persistent local workspace connection", () => {
  it("connects once, uses a workspace token, and sends selected generation mode", async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/config")
          ? { mode: "local", files: true, demo: true }
          : url.endsWith("/session")
            ? { role: "workspace", accessToken: "local-token" }
            : { id: "agr_test" }
      )
    );
    vi.stubGlobal("fetch", fetch);
    await Promise.all([
      startDemoWorkspace("http://localhost:3000", true),
      startDemoWorkspace("http://localhost:3000"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const session = getSession();
    expect(session.workspaceToken).toBe("local-token");
    expect(session.demoToken).toBeUndefined();
    expect(session.operatorKey).toBe("");
    expect(hasGatewaySession(session)).toBe(true);
    expect(canMutateAgreements(session)).toBe(true);
    const body = JSON.stringify({
      generation: "openai",
      documents: [{ name: "contract.txt", text: "Contract" }],
    });
    await gatewayRequest(session, "/v1/agreements", { method: "POST", body });
    const options = (fetch.mock.calls[2] as unknown as [string, RequestInit])[1];
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer local-token");
    expect(options.body).toBe(body);
  });
  it("explains an old server instead of leaving an unexplained disabled upload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 }))
    );
    await startDemoWorkspace("http://localhost:3000", true);
    expect(getSession().demoNotice).toContain("pnpm start");
    expect(canMutateAgreements(getSession())).toBe(false);
  });
});
