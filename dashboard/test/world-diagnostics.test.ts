import { afterEach, expect, it, vi } from "vitest";
import { observeWorldTransport, worldDebugSummary } from "@/lib/world-diagnostics";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps diagnostic metadata and excludes raw proofs and signed requests", () => {
  const summary = worldDebugSummary({
    version: 1,
    package_version: "4.3.0",
    transport: "bridge",
    generated_at: "2026-09-26T12:00:00Z",
    request_id: "request-123",
    request_payload: { signature: "secret-signature", nonce: "secret-nonce" },
    response_payload: JSON.stringify({ proof: "secret-proof", session_id: "secret-session" }),
  });
  expect(summary).toMatchObject({
    sdkVersion: "4.3.0",
    transport: "bridge",
    requestId: "request-123",
    responseReceived: true,
  });
  expect(JSON.stringify(summary)).not.toContain("secret");
  expect(worldDebugSummary().available).toBe(false);
});

it("records transport status and failures without URLs containing keys, headers or payloads", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const original = vi
    .fn()
    .mockResolvedValueOnce(new Response("private-body", { status: 503 }))
    .mockRejectedValueOnce(new TypeError("secret-key in an upstream error"));
  const browser = { fetch: original, location: { href: "http://localhost:3100/" } };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("navigator", { onLine: true });
  const observer = observeWorldTransport();
  try {
    const response = await browser.fetch("https://bridge.world.org/secret-request?key=secret-key", {
      method: "POST",
      headers: { authorization: "secret-token" },
      body: "secret-proof",
    });
    expect(await response.text()).toBe("private-body");
    await expect(browser.fetch("http://localhost:3100/sdk.wasm?key=secret-key")).rejects.toThrow(TypeError);
    expect(observer.events[0]).toMatchObject({ target: "https://bridge.world.org", status: 503, ok: false });
    expect(observer.events[1]).toMatchObject({ kind: "wasm", errorName: "TypeError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-body");
  } finally {
    observer.stop();
  }
  expect(browser.fetch).toBe(original);
});
