import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gatewayRequest,
  gatewayUrl,
  getSession,
  setSession,
  subscribeSession,
  type GatewaySession,
} from "@/lib/session";
import { source } from "@/lib/adapter";

const session: GatewaySession = {
  url: "https://gateway.example",
  viewerKey: "viewer-test",
  operatorKey: "operator-test",
  revision: 0,
};
afterEach(() => {
  setSession({ url: "", viewerKey: "", operatorKey: "" });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("session-only gateway authentication", () => {
  it("never writes credentials to storage, and disconnect clears them", () => {
    const write = vi.fn(() => {
      throw new Error("Do not persist credentials");
    });
    vi.stubGlobal("localStorage", { setItem: write });
    vi.stubGlobal("sessionStorage", { setItem: write });
    const heard = vi.fn();
    const stop = subscribeSession(heard);
    setSession(session);
    expect(getSession().operatorKey).toBe("operator-test");
    expect(source.kind).toBe("gateway");
    setSession({ url: "", viewerKey: "", operatorKey: "" });
    expect(getSession().operatorKey).toBe("");
    expect(source.kind).toBe("static");
    expect(write).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
  it("uses the viewer key for GET and the operator key only for writes", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await gatewayRequest(session, "/v1/agreements");
    await gatewayRequest(session, "/v1/agreements", { method: "POST", body: "{}" });
    const read = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const write = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(read[1].headers).get("authorization")).toBe("Bearer viewer-test");
    expect(new Headers(read[1].headers).has("idempotency-key")).toBe(false);
    expect(new Headers(write[1].headers).get("authorization")).toBe("Bearer operator-test");
    expect(new Headers(write[1].headers).get("idempotency-key")).toMatch(/^[a-f0-9-]{36}$/);
    expect(write[1]).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
    expect(write[0]).not.toContain("operator-test");
  });
  it("blocks writes before a request in viewer or sample mode", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      gatewayRequest({ ...session, operatorKey: "" }, "/v1/agreements", { method: "POST" })
    ).rejects.toThrow(/operator key/);
    await expect(gatewayRequest({ ...session, url: "" }, "/v1/agreements")).rejects.toThrow(
      /Samples are read-only/
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows operator-only reads and shares the session with classic routes", async () => {
    const fetch = vi.fn(async () => new Response("[]"));
    vi.stubGlobal("fetch", fetch);
    setSession({ ...session, viewerKey: "" });
    await source.profiles();
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://gateway.example/v1/policy/profiles");
    expect(new Headers(call[1].headers).get("authorization")).toBe("Bearer operator-test");
  });
  it("preserves gateway error codes and explains network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "QUOTE_NOT_FOUND", message: "Not verbatim" } }), {
            status: 400,
          })
      )
    );
    await expect(gatewayRequest(session, "/v1/agreements/a/constraints")).rejects.toMatchObject({
      message: "Not verbatim",
      status: 400,
      code: "QUOTE_NOT_FOUND",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(gatewayRequest(session, "/v1/status")).rejects.toThrow(/CORS/);
  });
  it("aborts slow requests with an actionable timeout instead of hanging", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
          )
      )
    );
    const request = gatewayRequest(session, "/v1/status");
    const assertion = expect(request).rejects.toThrow(/30 seconds.*still be running/);
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
  });
  it("honors cancellation of an obsolete agreement request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
          )
      )
    );
    const controller = new AbortController();
    const request = gatewayRequest(session, "/v1/agreements/old", { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects credential-bearing or insecure remote URLs", () => {
    for (const value of [
      "https://user:secret@gateway.example",
      "https://gateway.example?key=secret",
      "https://gateway.example#secret",
      "http://gateway.example",
      "file:///tmp/api",
    ])
      expect(() => gatewayUrl(value)).toThrow();
    expect(gatewayUrl(" http://localhost:3000/ ")).toBe("http://localhost:3000");
    expect(gatewayUrl("http://127.0.0.1:3200")).toBe("http://127.0.0.1:3200");
    expect(gatewayUrl("https://gateway.example/prefix/")).toBe("https://gateway.example/prefix");
  });
});
