import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { startDemoWorkspace } from "@/lib/demo-session";
import {
  demoPathAllowed,
  expireDemoSession,
  gatewayRequest,
  getSession,
  hasDemoSession,
  setSession,
  type GatewaySession,
} from "@/lib/session";
import { investorSession } from "@/lib/investor/session";
import { source } from "@/lib/adapter";
import { ConnectionDialog } from "@/app/_workbench/Forms";

const active = (): GatewaySession => ({
  url: "https://demo.example",
  operatorKey: "",
  viewerKey: "",
  revision: 0,
  demoToken: "demo_test_token",
  demoExpiresAt: Math.floor(Date.now() / 1000) + 600,
  demoChainId: 11155111,
  demoCapabilities: { agreements: true, mutateAgreements: true, deploy: true, stack: false, admin: false },
});
afterEach(() => {
  setSession({ url: "", viewerKey: "", operatorKey: "", autoDemo: false });
  investorSession.set(null);
  vi.unstubAllGlobals();
});
describe("anonymous scoped demo workspaces", () => {
  it("issues once under concurrent callers and keeps the token out of both operator and investor stores", async () => {
    const storage = vi.fn();
    vi.stubGlobal("localStorage", { setItem: storage });
    vi.stubGlobal("sessionStorage", { setItem: storage });
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/config")
              ? { enabled: true, chainId: 11155111, limits: { documents: 5 } }
              : {
                  accessToken: "demo_test_token",
                  expiresAt: active().demoExpiresAt,
                  role: "demo",
                  chainId: 11155111,
                }
          )
        )
    );
    vi.stubGlobal("fetch", fetch);
    await Promise.all([
      startDemoWorkspace("https://demo.example", true),
      startDemoWorkspace("https://demo.example"),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hasDemoSession(getSession())).toBe(true);
    expect(getSession().operatorKey).toBe("");
    expect(getSession().viewerKey).toBe("");
    expect(investorSession.get()).toBeNull();
    expect(storage).not.toHaveBeenCalled();
    for (const call of fetch.mock.calls as unknown as [string, RequestInit][])
      expect(new Headers(call[1].headers).has("authorization")).toBe(false);
  });
  it("stops after an unavailable backend and only retries deliberately", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await startDemoWorkspace("https://unavailable.example", true);
    await startDemoWorkspace("https://unavailable.example");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getSession().demoState).toBe("unavailable");
    expect(hasDemoSession(getSession())).toBe(false);
    await startDemoWorkspace("https://unavailable.example", true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("restricts demo tokens to agreed agreement/status methods before touching fetch", async () => {
    for (const [method, path] of [
      ["GET", "/v1/status"],
      ["GET", "/v1/agreements"],
      ["POST", "/v1/agreements"],
      ["GET", "/v1/agreements/agr_a/ast"],
      ["PUT", "/v1/agreements/agr_a/constraints"],
      ["POST", "/v1/agreements/agr_a/deploy"],
    ])
      expect(demoPathAllowed(method, path)).toBe(true);
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    for (const path of [
      "/v1/stack",
      "/v1/policy",
      "/v1/lenders",
      "/v1/investor/me",
      "/v1/agreements/agr_a/stack/wallets",
      "/v1/agreements/agr_a%2Fstack",
      "/v1/agreements/../stack",
    ])
      await expect(gatewayRequest(active(), path)).rejects.toMatchObject({ code: "DEMO_SCOPE" });
    expect(fetch).not.toHaveBeenCalled();
    await gatewayRequest(active(), "/v1/agreements", { method: "POST", body: "{}" });
    expect(
      new Headers((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].headers).get("authorization")
    ).toBe("Bearer demo_test_token");
  });
  it("clears an expired workspace and never replays its mutation", async () => {
    const state = { ...active(), demoExpiresAt: 1 };
    setSession(state);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      gatewayRequest(state, "/v1/agreements", { method: "POST", body: "{}" })
    ).rejects.toMatchObject({ code: "DEMO_EXPIRED" });
    expect(getSession().demoToken).toBeUndefined();
    expect(getSession().autoDemo).toBe(false);
    expect(getSession().demoState).toBe("expired");
    expect(fetch).not.toHaveBeenCalled();
    setSession(active());
    expireDemoSession("an-older-token");
    expect(hasDemoSession(getSession())).toBe(true);
  });
  it("keeps classic admin operations unavailable and removes visible secret inputs", async () => {
    setSession(active());
    expect(source.kind).toBe("static");
    await expect(source.attest("rwa-secondary", "wallet", { kycApproved: true })).rejects.toThrow(
      /admin mutations are unavailable/
    );
    const html = renderToStaticMarkup(
      createElement(ConnectionDialog, { session: active(), onClose: () => {} })
    );
    expect(html).toContain("Anyone can create demo contracts");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("Operator key");
    expect(html).not.toContain("Viewer key");
  });
});
