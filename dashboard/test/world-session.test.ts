import { afterEach, expect, it, vi } from "vitest";
import {
  clearWorldToken,
  restoreWorldToken,
  saveWorldToken,
  worldRequest,
  worldSessionHeaders,
} from "@/lib/world-session";

afterEach(() => {
  clearWorldToken();
  vi.unstubAllGlobals();
});
it("restores a per-tab token only for its issuing gateway and never sends it to a different host", () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    setItem: (k: string, v: string) => storage.set(k, v),
    getItem: (k: string) => storage.get(k),
    removeItem: (k: string) => storage.delete(k),
  });
  const token = `world_${"ab".repeat(32)}`;
  saveWorldToken("https://api.example", token);
  expect(worldSessionHeaders("https://evil.example")).toEqual({});
  expect(restoreWorldToken("https://api.example")).toBe(true);
  expect(worldSessionHeaders("https://api.example")).toEqual({ "X-World-Session": token });
  expect(restoreWorldToken("https://evil.example")).toBe(false);
  expect(worldSessionHeaders("https://api.example")).toEqual({});
});
it("revokes browser authentication and notifies the gate after the backend rejects a session", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { message: "Session expired" } }, { status: 401 }))
  );
  saveWorldToken("https://api.example", `world_${"ab".repeat(32)}`);
  await expect(worldRequest("https://api.example", "session")).rejects.toThrow("Session expired");
  expect(dispatchEvent).toHaveBeenCalledOnce();
  expect(worldSessionHeaders("https://api.example")).toEqual({});
});
