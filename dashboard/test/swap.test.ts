import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agreementsClient, type AgreementDetail } from "@/lib/agreements";
import { sharedPoolMismatch, swapBlocked } from "@/lib/swap";
import { MOCK_USD } from "@/lib/mock-usd";
import { demoPathAllowed } from "@/lib/session";
import { SwapView } from "@/app/_workbench/SwapView";

const address = `0x${"1".repeat(40)}`;
const other = `0x${"2".repeat(40)}`;
const record = {
  id: "agr_swap",
  status: "deployed",
  policyHash: "policy",
  deployment: {
    routing: "uniswap-api",
    chainId: 11155111,
    policyHash: "policy",
    token: address,
    hook: address,
    poolManager: address,
    poolId: "pool",
    poolKey: { currency0: address, currency1: other, fee: 3000, tickSpacing: 60, hooks: address },
  },
} as AgreementDetail;
const session = { url: "https://gateway.test", viewerKey: "viewer", operatorKey: "", revision: 0 };
afterEach(() => vi.unstubAllGlobals());

describe("agreement swaps", () => {
  it("distinguishes same-symbol legacy assets from the shared mUSDC contract", () => {
    expect(sharedPoolMismatch(record)).toContain("legacy token");
    expect(sharedPoolMismatch(record)).toContain(MOCK_USD.address);
    const shared = {
      ...record,
      deployment: {
        ...record.deployment!,
        poolKey: { ...record.deployment!.poolKey!, currency1: MOCK_USD.address },
      },
    };
    expect(sharedPoolMismatch(shared)).toBeNull();
  });
  it("gates samples, missing pools, stale policies and wrong chains", () => {
    expect(swapBlocked(record, false)).toBeNull();
    expect(swapBlocked(record, true)).toContain("Samples are read-only");
    expect(swapBlocked({ ...record, status: "compiled" }, false)).toContain("Deploy this agreement");
    expect(swapBlocked({ ...record, policyHash: "new" }, false)).toContain("earlier policy");
    expect(
      swapBlocked({ ...record, deployment: { ...record.deployment!, chainId: 31337 } }, false)
    ).toContain("Sepolia only");
    expect(
      swapBlocked({ ...record, deployment: { ...record.deployment!, poolKey: undefined } }, false)
    ).toContain("no deployed Uniswap");
  });
  it("renders the actual token pair, pool and prerequisites without pretending a quote exists", () => {
    const html = renderToStaticMarkup(
      createElement(SwapView, { record, sample: false, client: agreementsClient(session) })
    );
    expect(html).toContain("Connect wallet");
    expect(html).toContain(`https://sepolia.etherscan.io/address/${other}`);
    expect(html).toContain("Liquidity must be added");
    expect(html).toContain("this exact pool");
    expect(html).not.toContain("Review quote");
    const sample = renderToStaticMarkup(
      createElement(SwapView, { record, sample: true, client: agreementsClient(session) })
    );
    expect(sample).toContain("Samples are read-only");
    expect(sample).not.toContain("Connect wallet</button>");
  });
  it("uses viewer credentials for unsigned preparation and scopes the API calls to the agreement", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}");
      })
    );
    const client = agreementsClient(session);
    await client.swapQuote("agr_swap", {
      wallet: address,
      direction: "buy",
      amount: "1000000",
      slippageBps: 50,
    });
    await client.swapApproval("agr_swap", { wallet: address, quoteId: "q" });
    await client.swapTransaction("agr_swap", { wallet: address, quoteId: "q" });
    expect(calls.map((call) => call.url)).toEqual(
      ["quote", "approval", "transaction"].map(
        (step) => `https://gateway.test/v1/agreements/agr_swap/swap/${step}`
      )
    );
    for (const call of calls) {
      expect(call.init.method).toBe("POST");
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer viewer");
      expect(call.init.body).not.toContain("UNISWAP_API_KEY");
    }
    expect(JSON.parse(calls[0].init.body as string).amount).toBe("1000000");
  });
  it("allows owned demo swap preparation without opening arbitrary transaction or stack routes", () => {
    for (const step of ["quote", "approval", "transaction"])
      expect(demoPathAllowed("POST", `/v1/agreements/agr_swap/swap/${step}`)).toBe(true);
    expect(demoPathAllowed("POST", "/v1/agreements/agr_swap/swap/broadcast")).toBe(false);
    expect(demoPathAllowed("POST", "/v1/agreements/agr_swap/stack/rwa/swap")).toBe(false);
  });
});
