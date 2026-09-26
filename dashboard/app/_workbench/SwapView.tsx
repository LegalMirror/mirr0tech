"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserProvider, formatUnits, parseUnits } from "ethers";
import type { AgreementDetail, AgreementsClient } from "@/lib/agreements";
import { sharedPoolMismatch, swapBlocked, type SwapQuote, type SwapTransaction } from "@/lib/swap";
import { MOCK_USD } from "@/lib/mock-usd";
import {
  assertWallet,
  connectWallet,
  injectedWallet,
  observeWallet,
  sendWalletTransaction,
  switchToSepolia,
  walletError,
  WalletChanged,
  type WalletIdentity,
} from "@/lib/investor/wallet";
import { Icon, Notice } from "./ui";

type Token = { address: string; symbol: string; decimals: number; balance: string };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const explorer = "https://sepolia.etherscan.io";
function Address({ address }: { address: string }) {
  return (
    <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
      <code>{address}</code> ↗
    </a>
  );
}

export function SwapView({
  record,
  sample,
  client,
}: {
  record: AgreementDetail;
  sample: boolean;
  client: AgreementsClient;
}) {
  const blocked = swapBlocked(record, sample);
  const poolMismatch = sharedPoolMismatch(record);
  const deployment = record.deployment;
  const [wallet, setWallet] = useState<WalletIdentity | null>(null);
  const [tokens, setTokens] = useState<{ rwa: Token; asset: Token } | null>(null);
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [transactions, setTransactions] = useState<{ label: string; hash: string; status: string }[]>([]);
  const [now, setNow] = useState(Date.now());
  const version = useRef(0);
  const running = useRef(false);
  const live = useRef(true);
  const invalidate = () => {
    version.current++;
    setQuote(null);
    setApproved(false);
  };
  useEffect(() => {
    live.current = true;
    const provider = injectedWallet();
    const stop = provider
      ? observeWallet(provider, () => {
          version.current++;
          setWallet(null);
          setTokens(null);
          setQuote(null);
          setApproved(false);
          setError("Wallet account or network changed. Reconnect and request a new quote.");
        })
      : () => {};
    return () => {
      live.current = false;
      version.current++;
      stop();
    };
  }, []);
  useEffect(() => {
    invalidate();
  }, [record.status, record.deployment?.poolId, record.policyHash]);
  useEffect(() => {
    if (!quote) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote]);
  const input = direction === "buy" ? tokens?.asset : tokens?.rwa;
  const output = direction === "buy" ? tokens?.rwa : tokens?.asset;
  const expired = !!quote && now >= quote.expiresAt;

  async function run(label: string, action: (current: () => boolean) => Promise<void>) {
    if (running.current || blocked) return;
    running.current = true;
    const revision = version.current;
    const current = () => live.current && revision === version.current;
    setBusy(label);
    setError("");
    try {
      await action(current);
    } catch (failure) {
      if (current()) setError(walletError(failure));
    } finally {
      running.current = false;
      if (live.current) setBusy("");
    }
  }
  async function loadTokens(identity: WalletIdentity, current: () => boolean) {
    const provider = injectedWallet();
    if (!provider || !deployment?.poolKey) throw new Error("No deployed pool or browser wallet.");
    await assertWallet(provider, identity, current);
    const state = await client.swapState(record.id, identity.address);
    await assertWallet(provider, identity, current);
    if (
      state.chainId !== 11155111 ||
      !same(state.wallet, identity.address) ||
      state.poolId !== deployment.poolId ||
      !same(state.rwa.address, deployment.token) ||
      !same(state.asset.address, MOCK_USD.address)
    )
      throw new Error("Token state does not match this pool and wallet.");
    if (current()) setTokens({ rwa: state.rwa, asset: state.asset });
    return state;
  }

  async function connect() {
    await run("Connecting wallet…", async (current) => {
      const provider = injectedWallet();
      if (!provider) throw new Error("Install a Sepolia-capable browser wallet to swap.");
      let identity = await connectWallet(provider);
      if (!current()) return;
      if (identity.chainId !== 11155111) identity = await switchToSepolia(provider);
      // A network switch invalidates existing quotes; reconnect after the wallet's change event.
      if (!current()) return;
      await loadTokens(identity, current);
      if (current()) setWallet(identity);
    });
  }
  async function getQuote() {
    if (!wallet || !input || !output || poolMismatch) return;
    setQuote(null);
    setApproved(false);
    await run("Finding a quote…", async (current) => {
      const provider = injectedWallet();
      if (!provider) throw new Error("Reconnect your wallet.");
      await assertWallet(provider, wallet, current);
      const fresh = await loadTokens(wallet, current);
      const freshInput = direction === "buy" ? fresh.asset : fresh.rwa;
      if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new Error("Enter a positive token amount.");
      const units = parseUnits(amount, freshInput.decimals);
      const bps = Number(slippage) * 100;
      if (units <= 0n || units > BigInt(freshInput.balance))
        throw new Error("Enter an amount within your token balance.");
      if (!Number.isInteger(bps) || bps < 1 || bps > 500)
        throw new Error("Slippage must be between 0.01% and 5%, with at most two decimal places.");
      if (BigInt(fresh.liquidity) === 0n)
        throw new Error("This pool has no active liquidity. Seed it under Liquidity management first.");
      const next = await client.swapQuote(record.id, {
        wallet: wallet.address,
        direction,
        amount: units.toString(),
        slippageBps: bps,
      });
      await assertWallet(provider, wallet, current);
      if (
        !same(next.wallet, wallet.address) ||
        !same(next.tokenIn, input.address) ||
        !same(next.tokenOut, output.address) ||
        next.amountIn !== units.toString() ||
        next.poolId !== deployment?.poolId ||
        next.chainId !== 11155111 ||
        next.slippageBps !== bps
      )
        throw new Error("The quote does not match this swap.");
      if (current()) setQuote(next);
    });
  }
  async function refreshBalances() {
    if (!wallet) return;
    await run("Refreshing balances…", async (current) => {
      await loadTokens(wallet, current);
    });
  }
  useEffect(() => {
    const refresh = () => {
      void refreshBalances();
    };
    window.addEventListener("mirr0:mock-usd-minted", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("mirr0:mock-usd-minted", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [wallet, record.deployment?.poolId]);
  async function send(tx: SwapTransaction, label: string, current: () => boolean) {
    const provider = injectedWallet();
    if (!provider || !wallet || tx.chainId !== 11155111 || !same(tx.from, wallet.address))
      throw new Error("Transaction wallet or network mismatch.");
    await assertWallet(provider, wallet, current);
    let hash: string;
    try {
      hash = await sendWalletTransaction(provider, wallet, tx, current);
    } catch (failure) {
      if (failure instanceof WalletChanged && failure.txHash && live.current) {
        setTransactions((items) => [
          ...items,
          { label, hash: failure.txHash!, status: "Submitted — check Etherscan" },
        ]);
        if (label === "Swap") {
          setQuote(null);
          setApproved(false);
        }
      }
      throw failure;
    }
    // A submitted swap must not be sent again if confirmation polling times out.
    if (label === "Swap" && live.current) {
      setQuote(null);
      setApproved(false);
    }
    if (live.current) setTransactions((items) => [...items, { label, hash, status: "Pending" }]);
    const until = Date.now() + 180000;
    while (live.current && Date.now() < until) {
      const receipt = await client.swapReceipt(record.id, hash);
      if (receipt) {
        if (live.current)
          setTransactions((items) =>
            items.map((item) =>
              item.hash === hash ? { ...item, status: receipt.status === 1 ? "Confirmed" : "Failed" } : item
            )
          );
        if (receipt.status !== 1) throw new Error(`${label} failed. Check Etherscan.`);
        await assertWallet(provider, wallet, current);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Transaction is still pending. Check Etherscan before submitting again.");
  }

  async function approve() {
    if (!quote || !wallet) return;
    await run("Checking approval…", async (current) => {
      const result = await client.swapApproval(record.id, { wallet: wallet.address, quoteId: quote.id });
      if (!current()) return;
      for (const [label, tx] of [
        ["Reset approval", result.cancel],
        ["Approve token", result.approval],
      ] as const) {
        if (!tx) continue;
        if (Date.now() >= quote.expiresAt) throw new Error("Quote expired. Request a new quote.");
        if (!same(tx.to, quote.tokenIn)) throw new Error("Unexpected approval token.");
        setBusy(`${label} in your wallet…`);
        await send(tx, label, current);
      }
      if (current()) setApproved(true);
    });
  }
  async function swap() {
    if (!quote || !wallet || !approved) return;
    await run("Preparing swap…", async (current) => {
      const provider = injectedWallet();
      if (!provider) throw new Error("Reconnect your wallet.");
      await assertWallet(provider, wallet, current);
      let signature: string | undefined;
      if (quote.permitData) {
        setBusy("Sign Permit2 authorization in your wallet…");
        const rpc = new BrowserProvider(provider);
        try {
          const signer = await rpc.getSigner(wallet.address);
          signature = await signer.signTypedData(
            quote.permitData.domain,
            quote.permitData.types,
            quote.permitData.values
          );
        } finally {
          rpc.destroy();
        }
        await assertWallet(provider, wallet, current);
      }
      const result = await client.swapTransaction(record.id, {
        wallet: wallet.address,
        quoteId: quote.id,
        signature,
      });
      if (!current()) return;
      if (Date.now() >= Math.min(result.expiresAt, quote.expiresAt))
        throw new Error("Quote expired. Request a new quote.");
      if (!same(result.transaction.to, quote.router)) throw new Error("Unexpected swap destination.");
      setBusy("Confirm swap in your wallet…");
      await send(result.transaction, "Swap", current);
      if (current()) {
        setQuote(null);
        setApproved(false);
        await loadTokens(wallet, current);
      }
    });
  }
  return (
    <div className="wb-scroll-page">
      <div className="wb-section-heading">
        <h2>Uniswap V4 (Sepolia)</h2>
        <p>
          Trade through this agreement’s deployed pool. Review a quote, approve the input token, sign its
          Permit2 authorization, then confirm the swap in your wallet.
        </p>
      </div>
      {blocked ? (
        <Notice>{blocked}</Notice>
      ) : (
        <>
          <div className="wb-deploy-grid">
            <section className="wb-surface wb-swap-form">
              <h3>Swap</h3>
              {poolMismatch && <Notice>{poolMismatch}</Notice>}
              {wallet ? (
                <p>
                  Connected: <Address address={wallet.address} />
                </p>
              ) : (
                <button className="wb-primary" onClick={connect} disabled={!!busy}>
                  Connect wallet
                </button>
              )}
              <label>
                Direction
                <select
                  value={direction}
                  disabled={!!busy}
                  onChange={(event) => {
                    setDirection(event.target.value as "buy" | "sell");
                    invalidate();
                  }}
                >
                  <option value="buy">Buy RWA token</option>
                  <option value="sell">Sell RWA token</option>
                </select>
              </label>
              <label>
                You pay {input?.symbol}
                <input
                  inputMode="decimal"
                  value={amount}
                  placeholder="0.00"
                  disabled={!!busy}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    invalidate();
                  }}
                />
              </label>
              {input && (
                <p className="wb-muted">
                  Balance: {formatUnits(input.balance, input.decimals)} {input.symbol}
                  <br />
                  <Address address={input.address} />
                </p>
              )}
              {wallet && (
                <button disabled={!!busy} onClick={refreshBalances}>
                  Refresh balances
                </button>
              )}
              <label>
                Slippage tolerance (%)
                <input
                  inputMode="decimal"
                  value={slippage}
                  disabled={!!busy}
                  onChange={(event) => {
                    setSlippage(event.target.value);
                    invalidate();
                  }}
                />
              </label>
              <button
                className="wb-primary"
                disabled={!wallet || !tokens || !amount || !!busy || !!poolMismatch}
                onClick={getQuote}
              >
                <Icon name="refresh" />
                Get quote
              </button>
              {quote && output && (
                <section aria-label="Swap quote" className="wb-swap-quote">
                  <h4>Review quote</h4>
                  <dl className="wb-dl">
                    <dt>Expected receive</dt>
                    <dd>
                      {formatUnits(quote.amountOut, output.decimals)} {output.symbol}
                    </dd>
                    <dt>Minimum received</dt>
                    <dd>
                      {formatUnits(quote.minAmountOut, output.decimals)} {output.symbol}
                    </dd>
                    <dt>Route</dt>
                    <dd>This agreement’s Uniswap v4 pool</dd>
                    <dt>Approval spender</dt>
                    <dd>
                      <Address address={quote.spender} />
                    </dd>
                    <dt>Quote validity</dt>
                    <dd>
                      {expired
                        ? "Expired — request a new quote"
                        : `${Math.max(0, Math.ceil((quote.expiresAt - now) / 1000))} seconds`}
                    </dd>
                  </dl>
                  <p className="wb-muted">
                    Approval is limited to the input amount. Each transaction requires Sepolia ETH for gas.
                  </p>
                  {!approved ? (
                    <button onClick={approve} disabled={!!busy || expired}>
                      Check / approve token
                    </button>
                  ) : (
                    <button className="wb-primary" onClick={swap} disabled={!!busy || expired}>
                      Confirm swap
                    </button>
                  )}
                </section>
              )}
              {busy && <p role="status">{busy}</p>}
              {error && <Notice error>{error}</Notice>}
            </section>
            <section className="wb-surface">
              <h3>Deployed pool</h3>
              <dl className="wb-dl">
                <dt>RWA token</dt>
                <dd>
                  <Address address={deployment!.token} />
                </dd>
                <dt>Paired token</dt>
                <dd>
                  <Address
                    address={
                      same(deployment!.poolKey!.currency0, deployment!.token)
                        ? deployment!.poolKey!.currency1
                        : deployment!.poolKey!.currency0
                    }
                  />
                </dd>
                <dt>Pool ID</dt>
                <dd>
                  <code>{deployment!.poolId}</code>
                </dd>
                <dt>Pool manager</dt>
                <dd>
                  <Address address={deployment!.poolManager!} />
                </dd>
                <dt>Policy hook</dt>
                <dd>
                  <Address address={deployment!.hook!} />
                </dd>
              </dl>
              <Notice>
                Pool deployment initializes its price. Liquidity must be added before trading. Your wallet
                must satisfy the agreement’s transfer policy.
              </Notice>
              <Notice>
                Quotes must route through this exact pool. Uniswap may need time to index a newly deployed
                pool and its hook before swaps become available.
              </Notice>
            </section>
          </div>
        </>
      )}
      {!!transactions.length && (
        <section className="wb-surface" aria-label="Swap transactions">
          <h3>Transactions</h3>
          {transactions.map((tx) => (
            <p key={tx.hash}>
              {tx.label} · {tx.status}{" "}
              <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">
                <code>{tx.hash}</code> ↗
              </a>
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
