import { afterEach, describe, expect, it, vi } from "vitest";
import { selectSource } from "@/lib/adapter";
import { gatewaySource } from "@/lib/adapter/gateway";
import { staticSource } from "@/lib/adapter/static";

afterEach(() => vi.unstubAllGlobals());

describe("selectSource", () => {
  it("serves static data unless a gateway is configured", () => {
    expect(selectSource({}).kind).toBe("static");
    expect(selectSource({ gatewayUrl: "http://localhost:3000" }).kind).toBe("gateway");
  });
});

describe("staticSource", () => {
  it("reads exported JSON and says how to produce it when it is missing", async () => {
    const fetch = vi.fn(async (path: string) =>
      path === "/data/index.json"
        ? new Response(JSON.stringify({ profiles: [{ profile: "wildcat-credit" }] }))
        : new Response("", { status: 404 })
    );
    vi.stubGlobal("fetch", fetch);
    expect(await staticSource.profiles()).toEqual([{ profile: "wildcat-credit" }]);
    await expect(staticSource.policy("custodial-rwa")).rejects.toThrow(/ui:export/);
  });

  it("attests, resolves and revokes in memory and tells subscribers", async () => {
    const heard = vi.fn();
    const stop = staticSource.subscribe(heard);
    const attested = await staticSource.attest("wildcat-credit", "lender-b", { mlaCountersigned: true });
    expect(attested.facts.mlaCountersigned).toBe(true);
    const resolved = await staticSource.resolve("wildcat-credit", "lender-b", "approve");
    expect(resolved.resolution).toBe("approved");
    const revoked = await staticSource.revoke("wildcat-credit", "lender-b");
    expect(revoked.screenedAt).toBeNull();
    expect(revoked.resolution).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
    await staticSource.revoke("wildcat-credit", "lender-a");
    expect(heard).toHaveBeenCalledTimes(3);
    await expect(staticSource.attest("wildcat-credit", "nobody", {})).rejects.toThrow(/Unknown party/);
  });

  it("serves mock parties and audit events per profile", async () => {
    expect((await staticSource.parties("custodial-rwa")).every((party) => party.role !== "lender")).toBe(
      true
    );
    expect((await staticSource.audit("wildcat-credit")).length).toBeGreaterThan(0);
  });
});

describe("gatewaySource", () => {
  it("maps each call onto the operator API with an idempotency key on writes", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }));
      })
    );
    const gateway = gatewaySource("http://gw.test/");
    const heard = vi.fn();
    gateway.subscribe(heard);
    await gateway.policy("wildcat-credit");
    await gateway.parties("wildcat-credit");
    await gateway.audit("wildcat-credit");
    await gateway.attest("wildcat-credit", "lender-b", { mlaCountersigned: true });
    await gateway.resolve("wildcat-credit", "lender-b", "reject");
    await gateway.revoke("wildcat-credit", "lender-a");
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      "GET http://gw.test/v1/policy?profile=wildcat-credit",
      "GET http://gw.test/v1/lenders?profile=wildcat-credit",
      "GET http://gw.test/v1/audit?profile=wildcat-credit",
      "PATCH http://gw.test/v1/lenders/lender-b/attestations?profile=wildcat-credit",
      "POST http://gw.test/v1/lenders/lender-b/reject?profile=wildcat-credit",
      "POST http://gw.test/v1/lenders/lender-a/revoke?profile=wildcat-credit",
    ]);
    const headers = calls[3].init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ facts: { mlaCountersigned: true } });
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("surfaces a failed call with its status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    await expect(gatewaySource("http://gw.test").policy("custodial-rwa")).rejects.toThrow(
      "GET /v1/policy?profile=custodial-rwa: 503"
    );
  });
});
