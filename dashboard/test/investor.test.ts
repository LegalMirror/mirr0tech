import { afterEach, describe, expect, it, vi } from "vitest";
import { getBytes, MaxUint256 } from "ethers";
import { investorClient } from "@/lib/investor/api";
import {
  createInvestorSessionStore,
  sessionAlive,
  validateChallenge,
  validateInvestorSession,
} from "@/lib/investor/session";
import {
  connectWallet,
  observeWallet,
  signChallenge,
  sendWalletTransaction,
  switchToSepolia,
  walletError,
  type Eip1193Provider,
} from "@/lib/investor/wallet";
import {
  approvalAbi,
  blockingReasons,
  exactUnits,
  pollConfirmation,
  swapAbi,
  tradingBlocked,
  validateConfirmation,
  validatePrepared,
  validateQuote,
  validateSnapshot,
} from "@/lib/investor/transactions";
import { getSession, setSession } from "@/lib/session";
import {
  address,
  approval,
  challenge,
  config,
  confirmation,
  fund,
  hash,
  intent,
  quote,
  session,
  signer,
  snapshot,
  swap,
} from "./investor-fixtures";
import { SEPOLIA } from "@/lib/investor/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setSession({ url: "", viewerKey: "", operatorKey: "" });
});
function provider() {
  let chain = `0x${SEPOLIA.toString(16)}`;
  let accounts = [signer.address];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const request = vi.fn(
    async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return accounts;
      if (method === "eth_chainId") return chain;
      if (method === "personal_sign") return signer.signMessage(getBytes(String(params![0])));
      if (method === "eth_sendTransaction") return hash(9);
      if (method === "wallet_switchEthereumChain") {
        chain = (params![0] as { chainId: string }).chainId;
        listeners.get("chainChanged")?.(chain);
        return null;
      }
      throw new Error(method);
    }
  );
  return {
    request,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    },
    removeListener: (event: string) => {
      listeners.delete(event);
    },
    change: (event: string) => {
      if (event === "accountsChanged") accounts = [address(999)];
      if (event === "chainChanged") chain = "0x1";
      listeners.get(event)?.(event === "accountsChanged" ? accounts : chain);
    },
    listeners,
  };
}

describe("investor wallet and authentication boundary", () => {
  it("connects on Sepolia and signs the exact EIP-191 server message", async () => {
    const wallet = provider();
    const identity = await connectWallet(wallet);
    const request = challenge();
    validateChallenge(request, identity.address, fund, config, Date.now(), "https://dashboard.example");
    const signature = await signChallenge(wallet, identity, request.message, () => true);
    expect(signature).toBe(await signer.signMessage(request.message));
    const call = wallet.request.mock.calls.find(([arg]) => arg.method === "personal_sign")![0];
    expect(Buffer.from(getBytes(String(call.params![0]))).toString()).toBe(request.message);
    expect(call.params![1]).toBe(signer.address);
  });
  it("blocks wrong chains; switching does not queue a signature or transaction", async () => {
    const wallet = provider();
    wallet.change("chainChanged");
    await expect(
      signChallenge(wallet, { address: signer.address, chainId: SEPOLIA }, "message", () => true)
    ).rejects.toThrow(/wallet/i);
    await switchToSepolia(wallet);
    expect(
      wallet.request.mock.calls.some(([arg]) => ["personal_sign", "eth_sendTransaction"].includes(arg.method))
    ).toBe(false);
  });
  it.each(["accountsChanged", "chainChanged", "disconnect"])(
    "invalidates on %s and prevents a queued write",
    async (event) => {
      const wallet = provider();
      let active = true;
      const stop = observeWallet(wallet, () => {
        active = false;
      });
      wallet.change(event);
      await expect(
        sendWalletTransaction(
          wallet,
          { address: signer.address, chainId: SEPOLIA },
          intent(approval).transaction,
          () => active
        )
      ).rejects.toThrow(/changed/);
      expect(wallet.request.mock.calls.some(([arg]) => arg.method === "eth_sendTransaction")).toBe(false);
      stop();
      expect(wallet.listeners.size).toBe(0);
    }
  );
  it("rejects stale challenges, foreign origin/fund and simulated Sepolia credentials", () => {
    const request = challenge();
    expect(() => validateChallenge({ ...request, expiresAt: 1 }, signer.address, fund, config)).toThrow(
      /expired/
    );
    expect(() => validateChallenge(request, address(9), fund, config)).toThrow(/match/);
    expect(() =>
      validateChallenge(request, signer.address, fund, config, Date.now(), "https://other.example")
    ).toThrow(/bind/);
    expect(() =>
      validateChallenge({ ...request, world: { ...request.world, mock: true } }, signer.address, fund, {
        ...config,
        mock: true,
      })
    ).toThrow(/not permitted/);
    expect(() =>
      validateChallenge(
        { ...request, message: request.message.replace('"fundId": "agr_test"', '"fundId": "other"') },
        signer.address,
        fund,
        config
      )
    ).toThrow(/bind/);
  });
  it("holds opaque investor tokens only in an isolated memory store", () => {
    const write = vi.fn();
    vi.stubGlobal("localStorage", { setItem: write });
    vi.stubGlobal("sessionStorage", { setItem: write });
    const store = createInvestorSessionStore();
    const accepted = validateInvestorSession(session(), challenge(), fund);
    store.set(accepted);
    expect(store.get()?.accessToken).toBe(accepted.accessToken);
    expect(getSession().operatorKey).toBe("");
    expect(getSession().viewerKey).toBe("");
    expect(write).not.toHaveBeenCalled();
    expect(sessionAlive(accepted, accepted.expiresAt * 1000)).toBe(false);
    expect(() =>
      validateInvestorSession(
        { ...accepted, session: { ...accepted.session, fundId: "other" } },
        challenge(),
        fund
      )
    ).toThrow(/does not match/);
    store.set(null);
    expect(store.get()).toBeNull();
  });
  it("preserves rejected-wallet and unsupported-network alternatives", () => {
    expect(walletError({ code: 4001 })).toMatch(/rejected/);
    expect(walletError({ code: 4902 })).toMatch(/MiniKit/);
    expect(walletError({ code: -32002 })).toMatch(/already open/);
  });
});

describe("investor API uses no issuer credentials", () => {
  it("public calls are unauthenticated and all protected requests use only the investor token", async () => {
    setSession({ url: "https://api.example", operatorKey: "DO-NOT-SEND", viewerKey: "DO-NOT-SEND" });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify(url.endsWith("/config") ? config : url.endsWith("/funds") ? [fund] : {})
        );
      })
    );
    const api = investorClient("https://api.example");
    const access = session();
    await api.config();
    await api.funds();
    await api.challenge(signer.address, fund.id);
    await api.verify("c", "signature", { complete: "proof" });
    await api.me(access);
    await api.identity(access);
    await api.activity(access);
    await api.quote(access, { amount: "10", buy: true, route: "auto" });
    await api.prepare(access, approval);
    await api.confirm(access, "intent", hash(9));
    for (const [index, call] of calls.entries()) {
      expect(new Headers(call.init.headers).get("authorization")).toBe(
        index < 4 ? null : `Bearer ${access.accessToken}`
      );
      expect(call.url).toMatch(/^https:\/\/api.example\/v1\/investor\//);
      expect(call.init.credentials).toBe("omit");
      expect(call.init.redirect).toBe("error");
      expect(JSON.stringify(call)).not.toContain("DO-NOT-SEND");
    }
    expect(JSON.parse(String(calls[3].init.body))).toEqual({
      challengeId: "c",
      signature: "signature",
      proof: { complete: "proof" },
    });
    expect(JSON.parse(String(calls[8].init.body))).toEqual(approval);
  });
  it("blocks expired tokens before a request and identifies missing public routes", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const api = investorClient("https://api.example");
    await expect(api.me({ ...session(), expiresAt: 1 })).rejects.toThrow(/expired/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.config()).rejects.toThrow(/operator key is not required/);
  });
});

describe("wallet transaction validation", () => {
  it("accepts exact approvals and the verified bounded router calldata", () => {
    for (const request of [approval, swap(), { ...swap(), buy: false }])
      expect(validatePrepared(intent(request), request, session(), fund, snapshot()).data).toBe(
        intent(request).transaction.data
      );
    expect(validateSnapshot(snapshot(), session(), fund).blockNumber).toBe(7000);
  });
  it("rejects unlimited approval, wrong spender, token, sender, chain, value and expired intent", () => {
    const good = intent(approval);
    const bad = [
      { ...good, expiresAt: 1 },
      { ...good, transaction: { ...good.transaction, chainId: 1 } },
      { ...good, transaction: { ...good.transaction, from: address(90) } },
      { ...good, transaction: { ...good.transaction, to: address(90) } },
      { ...good, transaction: { ...good.transaction, value: "0x1" } },
      {
        ...good,
        transaction: {
          ...good.transaction,
          data: approvalAbi.encodeFunctionData("approve", [fund.router, MaxUint256]),
        },
      },
      {
        ...good,
        transaction: {
          ...good.transaction,
          data: approvalAbi.encodeFunctionData("approve", [address(90), 10000000n]),
        },
      },
    ];
    for (const value of bad)
      expect(() => validatePrepared(value, approval, session(), fund, snapshot())).toThrow();
  });
  it("rejects changed swap minimum, route, pool hook and exact input", () => {
    const request = swap();
    const good = intent(request);
    const parsed = swapAbi.decodeFunctionData("swap", good.transaction.data);
    const values = [
      [parsed.key, parsed.params, 1n, parsed.deadline, parsed.route],
      [parsed.key, parsed.params, parsed.minOut, parsed.deadline, 2],
      [
        { ...snapshot().cashier!.poolKey, hooks: address(90) },
        parsed.params,
        parsed.minOut,
        parsed.deadline,
        parsed.route,
      ],
      [
        parsed.key,
        { zeroForOne: true, amountSpecified: -1n, sqrtPriceLimitX96: 4295128740n },
        parsed.minOut,
        parsed.deadline,
        parsed.route,
      ],
    ];
    for (const args of values)
      expect(() =>
        validatePrepared(
          { ...good, transaction: { ...good.transaction, data: swapAbi.encodeFunctionData("swap", args) } },
          request,
          session(),
          fund,
          snapshot()
        )
      ).toThrow();
    expect(() =>
      validatePrepared(good, request, session(), { ...fund, policyHash: hash(99) }, snapshot())
    ).toThrow();
  });
  it("keeps legacy funds read-only and treats NAV arithmetic as indicative", () => {
    expect(tradingBlocked({ ...fund, cashier: false }, snapshot())).toMatch(/cashier-enabled/);
    const indication = validateQuote(quote(), session(), fund, { buy: true, amount: "10", route: "auto" });
    expect(blockingReasons(indication, "approval")).toHaveLength(0);
    expect(blockingReasons(indication, "swap")).toHaveLength(1);
    expect(() =>
      validateQuote({ ...indication, executable: true } as unknown as typeof indication, session(), fund, {
        buy: true,
        amount: "10",
        route: "auto",
      })
    ).toThrow();
    for (const amount of ["0", "-1", "1e6", "1.0000001", "Infinity"])
      expect(() => exactUnits(amount)).toThrow();
  });
  it("requires a matching backend RPC receipt for completion", () => {
    expect(validateConfirmation(confirmation(), "test-intent", hash(9)).status).toBe("confirmed");
    expect(() =>
      validateConfirmation({ ...confirmation(), receipt: undefined }, "test-intent", hash(9))
    ).toThrow(/receipt/);
    expect(() => validateConfirmation(confirmation(), "other-intent", hash(9))).toThrow(/match/);
  });
  it("bounds confirmation polling without preparing or replaying a transaction", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(confirmation("pending"));
    const received = vi.fn();
    const controller = new AbortController();
    const job = pollConfirmation(read, received, controller.signal, 3, 10);
    await vi.runAllTimersAsync();
    await job;
    expect(read).toHaveBeenCalledTimes(3);
    const stop = pollConfirmation(read, received, controller.signal, 6, 1000);
    controller.abort();
    await stop;
    expect(read).toHaveBeenCalledTimes(4);
  });
});
