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

  it("verifies a human in memory and serves a mock World ID context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    );
    expect((await staticSource.worldIdContext()).mock).toBe(true);
    const verified = await staticSource.verifyHuman("custodial-rwa", "investor-1", {
      protocol_version: "4.0",
    });
    expect(verified.facts.identityVerified).toBe(true);
  });

  it("serves the exported deployment and null when the build has none", async () => {
    const record = { chainId: 11155111, attestor: "0xa" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(record)))
    );
    expect(await staticSource.deployment()).toEqual(record);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    );
    expect(await staticSource.deployment()).toBeNull();
  });

  it("seeds parties from the exported snapshot when the build has one", async () => {
    const snapshot = [{ id: "lender-a", name: "Lender A", role: "lender", facts: {}, screenedAt: 1 }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(snapshot)))
    );
    expect((await staticSource.parties("rwa-secondary")).map((party) => party.id)).toEqual(["lender-a"]);
  });

  it("serves the exported timeline when the build has one and mock events otherwise", async () => {
    const exported = [{ id: "x", at: "2026-09-25T19:50:00Z", kind: "Fill", outcome: "ok" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(exported)))
    );
    expect(await staticSource.audit("wildcat-credit")).toEqual(exported);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    );
    expect((await staticSource.audit("wildcat-credit"))[0].outcome).toBeUndefined();
  });

  it("serves mock parties and audit events per profile", async () => {
    expect((await staticSource.parties("custodial-rwa")).every((party) => party.role !== "lender")).toBe(
      true
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
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
    expect(await gateway.deployment()).toBeNull();
    await gateway.worldIdContext();
    await gateway.verifyHuman("rwa-secondary", "investor", { protocol_version: "4.0" });
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      "GET http://gw.test/v1/policy?profile=wildcat-credit",
      "GET http://gw.test/v1/lenders?profile=wildcat-credit",
      "GET http://gw.test/v1/audit?profile=wildcat-credit",
      "PATCH http://gw.test/v1/lenders/lender-b/attestations?profile=wildcat-credit",
      "POST http://gw.test/v1/lenders/lender-b/reject?profile=wildcat-credit",
      "POST http://gw.test/v1/lenders/lender-a/revoke?profile=wildcat-credit",
      "GET http://gw.test/v1/stack",
      "GET http://gw.test/v1/worldid/context",
      "POST http://gw.test/v1/lenders/investor/worldid?profile=rwa-secondary",
    ]);
    const headers = calls[3].init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ facts: { mlaCountersigned: true } });
    expect(heard).toHaveBeenCalledTimes(4);
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

describe("enforcement map", () => {
  it("names a venue with a refusal for every action a profile compiles", async () => {
    const { venuesFor, renderRefusal } = await import("@/lib/enforcement");
    expect(venuesFor("rwa-secondary", "transfer").map((venue) => venue.refusal?.name)).toEqual([
      "LegalClauseViolation",
      "TransferRefused",
      "NoPolicyDoor",
    ]);
    expect(venuesFor("wildcat-credit", "transfer").map((venue) => venue.refusal?.name)).toContain(
      "CounterpartyRefused"
    );
    expect(venuesFor("custodial-rwa", "deposit")).toEqual([]);
    const [guard] = venuesFor("wildcat-credit", "transfer");
    expect(renderRefusal(guard.refusal!, { clauseId: 14, policyHash: "0xabc", subject: "0x57" })).toBe(
      "CounterpartyRefused(0x57, 14, 0xabc)"
    );
  });
});
