"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserProvider, formatUnits, getAddress, isAddress, parseUnits } from "ethers";
import type { AgreementDetail, AgreementsClient, IdentityReceipt } from "@/lib/agreements";
import type { PolicyData, WorldIdContext } from "@/lib/types";
import {
  CREDENTIAL_COPY,
  IDENTITY_PRIVACY,
  contextIssue,
  identityFailure,
  readAccess,
  sampleIdentity,
  verifierLabel,
  type AccessSnapshot,
} from "@/lib/identity";
import { sharedPoolMismatch, swapBlocked, type SwapQuote, type SwapTransaction } from "@/lib/swap";
import { MOCK_USD } from "@/lib/mock-usd";
import { mockProof } from "@/lib/worldid";
import { WorldIdWidget } from "../_components/WorldIdWidget";
import {
  assertWallet,
  connectWallet,
  injectedWallet,
  observeWallet,
  sendWalletTransaction,
  switchToSepolia,
  walletIdentity,
  WalletChanged,
  type Eip1193Provider,
  type WalletIdentity,
} from "@/lib/investor/wallet";
import { actionError, addressError, amountError } from "@/lib/validate";
import { Busy, FieldError, Icon, Notice } from "./ui";

type Token = { address: string; symbol: string; decimals: number; balance: string };
type Task = "world" | "access" | "quote" | "refresh" | "approve" | "swap";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const explorer = "https://sepolia.etherscan.io";
function Address({ address }: { address: string }) {
  return (
    <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
      <code>{address}</code> ↗
    </a>
  );
}
function normalizeWallet(value: string) {
  return isAddress(value.trim()) ? getAddress(value.trim()) : null;
}

export function SwapView({
  record,
  sample,
  client,
  policy = record.export ?? null,
}: {
  record: AgreementDetail;
  sample: boolean;
  client: AgreementsClient;
  policy?: PolicyData | null;
}) {
  const blocked = swapBlocked(record, sample);
  const poolMismatch = sharedPoolMismatch(record);
  const deployment = record.deployment;
  const identity = policy ? sampleIdentity(policy) : null;
  const [walletAddress, setWalletAddress] = useState("");
  const [wallet, setWallet] = useState<WalletIdentity | null>(null);
  const [context, setContext] = useState<WorldIdContext | null>(null);
  const [access, setAccess] = useState<AccessSnapshot | null>(null);
  const [receipt, setReceipt] = useState<IdentityReceipt | null>(null);
  const [worldFailure, setWorldFailure] = useState<ReturnType<typeof identityFailure> | null>(null);
  const [worldWidget, setWorldWidget] = useState(false);
  const [tokens, setTokens] = useState<{ rwa: Token; asset: Token } | null>(null);
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [transactions, setTransactions] = useState<{ label: string; hash: string; status: string }[]>([]);
  const [now, setNow] = useState(Date.now());
  const version = useRef(0);
  const running = useRef(false);
  const live = useRef(true);
  const activeWorldWallet = useRef("");
  const walletIssue = walletAddress
    ? addressError(walletAddress)
    : "Enter the EOA wallet address to bind with World ID.";
  const transferDecision = access?.decisions.find((item) => item.action === "transfer")?.decision ?? null;
  const transferAllowed = transferDecision?.allowed === true;
  const identityVerified = access?.wallet.rwa.facts.identityVerified === true;
  const worldReady = !!wallet && transferAllowed && identityVerified;
  const verifierIssue = context && identity ? contextIssue(context, identity.credential) : null;
  const invalidate = () => {
    version.current++;
    setQuote(null);
    setApproved(false);
  };
  const resetVerifiedWallet = () => {
    invalidate();
    setWallet(null);
    setTokens(null);
    setAccess(null);
    setReceipt(null);
    setWorldFailure(null);
  };
  useEffect(() => {
    live.current = true;
    const provider = injectedWallet();
    void (async () => {
      if (provider && !walletAddress) {
        try {
          const current = await walletIdentity(provider);
          if (live.current) setWalletAddress(current.address);
        } catch {
          // Do not request wallet access on this screen. World ID starts from an explicit EOA address.
        }
      }
    })();
    const stop = provider
      ? observeWallet(provider, () => {
          setQuote(null);
          setApproved(false);
          setError(
            "Browser signer changed. Quotes stay bound to the World-ID-verified EOA; approvals must be signed by that same address."
          );
        })
      : () => {};
    return () => {
      live.current = false;
      version.current++;
      stop();
    };
    // Read eth_accounts once without prompting; edits to the field are user-controlled after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  useEffect(() => {
    if (blocked) return;
    const controller = new AbortController();
    client
      .worldIdContext(record.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setContext(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError((failure as Error).message);
      });
    return () => controller.abort();
  }, [blocked, client, record.id]);
  const input = direction === "buy" ? tokens?.asset : tokens?.rwa;
  const output = direction === "buy" ? tokens?.rwa : tokens?.asset;
  const expired = !!quote && now >= quote.expiresAt;
  const amountIssue =
    amountError(amount) ??
    (input && parseUnits(amount.trim(), input.decimals) > BigInt(input.balance)
      ? `Exceeds your ${input.symbol} balance.`
      : null);

  async function run(next: Task, label: string, action: (current: () => boolean) => Promise<void>) {
    if (running.current || blocked) return;
    running.current = true;
    const revision = version.current;
    const current = () => live.current && revision === version.current;
    setBusy(label);
    setTask(next);
    setError("");
    try {
      await action(current);
    } catch (failure) {
      if (live.current) setError(actionError(failure));
    } finally {
      running.current = false;
      if (live.current) {
        setBusy("");
        setTask(null);
      }
    }
  }
  async function loadTokens(address: string, current: () => boolean) {
    if (!deployment?.poolKey) throw new Error("No deployed pool.");
    const state = await client.swapState(record.id, address);
    if (
      state.chainId !== 11155111 ||
      !same(state.wallet, address) ||
      state.poolId !== deployment.poolId ||
      !same(state.rwa.address, deployment.token) ||
      !same(state.asset.address, MOCK_USD.address)
    )
      throw new Error("Token state does not match this pool and wallet.");
    if (current()) setTokens({ rwa: state.rwa, asset: state.asset });
    return state;
  }
  async function refreshAccessAndBalances(address: string, current: () => boolean) {
    const snapshot = await readAccess(client, record.id, address, ["transfer"]);
    if (!current()) return null;
    setAccess(snapshot);
    if (snapshot.wallet.address.toLowerCase() !== address.toLowerCase())
      throw new Error("Gateway returned another wallet. No quote will be prepared.");
    const transfer = snapshot.decisions.find((item) => item.action === "transfer")?.decision;
    if (snapshot.wallet.rwa.facts.identityVerified !== true)
      throw new Error("World ID has not attested this EOA yet. Verify before quoting or signing.");
    if (!transfer?.allowed) {
      const clause = transfer?.clause;
      throw new Error(
        clause
          ? `Wallet is still blocked by ${clause.clause} — “${clause.quote}”`
          : "Wallet is still blocked by the transfer policy. Complete the remaining attestations."
      );
    }
    await loadTokens(address, current);
    if (current()) setWallet({ address, chainId: 11155111 });
    return snapshot;
  }
  async function startWorldId() {
    const address = normalizeWallet(walletAddress);
    if (!address) {
      setError("Enter a valid EOA wallet address before verifying.");
      return;
    }
    if (!identity) {
      setError("This policy does not expose a World ID identity rule for swaps.");
      return;
    }
    activeWorldWallet.current = address;
    await run("world", "Preparing World ID request…", async (current) => {
      setWorldFailure(null);
      let fresh = context;
      if (!fresh) fresh = await client.worldIdContext(record.id);
      if (!current()) return;
      setContext(fresh);
      const problem = contextIssue(fresh, identity.credential);
      if (problem) throw new Error(problem);
      if (fresh.mock)
        await submitWorldProof(
          await mockProof(address, fresh.action, address, fresh.credential),
          current,
          address
        );
      else setWorldWidget(true);
    });
  }
  async function submitWorldProof(
    proof: unknown,
    current?: () => boolean,
    address = activeWorldWallet.current
  ) {
    const target = normalizeWallet(address);
    if (!target) throw new Error("World ID proof is not bound to a valid wallet address.");
    const liveCurrent = current ?? (() => live.current);
    setBusy("Verifying World ID and attesting wallet…");
    setTask("world");
    setError("");
    setWorldFailure(null);
    try {
      const accepted = await client.verifyHuman(record.id, target, proof);
      if (!liveCurrent()) return;
      setReceipt(accepted);
      await refreshAccessAndBalances(target, liveCurrent);
      if (liveCurrent()) setWalletAddress(target);
    } catch (failure) {
      if (live.current) {
        setWorldFailure(identityFailure(failure));
        setError(actionError(failure));
      }
      throw failure;
    } finally {
      if (live.current) {
        setWorldWidget(false);
        setBusy("");
        setTask(null);
      }
    }
  }
  async function refreshEligibility() {
    const address = normalizeWallet(walletAddress);
    if (!address) return;
    await run("access", "Reading World ID attestation and policy access…", async (current) => {
      await refreshAccessAndBalances(address, current);
    });
  }
  async function signingProvider(current: () => boolean): Promise<Eip1193Provider> {
    if (!wallet) throw new Error("Verify a trading EOA with World ID before signing.");
    const provider = injectedWallet();
    if (!provider) throw new Error("Install a Sepolia-capable browser wallet to sign this transaction.");
    let identity: WalletIdentity;
    try {
      identity = await walletIdentity(provider);
    } catch {
      identity = await connectWallet(provider);
    }
    if (identity.chainId !== 11155111) identity = await switchToSepolia(provider);
    if (!same(identity.address, wallet.address)) {
      throw new Error(`Switch your browser wallet to the World-ID-verified EOA ${wallet.address}.`);
    }
    await assertWallet(provider, wallet, current);
    return provider;
  }
  async function getQuote() {
    if (!wallet || !input || !output || poolMismatch || !worldReady) return;
    setQuote(null);
    setApproved(false);
    await run("quote", "Finding a quote…", async (current) => {
      const fresh = await loadTokens(wallet.address, current);
      await refreshAccessAndBalances(wallet.address, current);
      const freshInput = direction === "buy" ? fresh.asset : fresh.rwa;
      const issue = amountError(amount);
      if (issue) throw new Error(issue);
      const units = parseUnits(amount.trim(), freshInput.decimals);
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
    await run("refresh", "Refreshing balances…", async (current) => {
      await loadTokens(wallet.address, current);
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
    const provider = await signingProvider(current);
    if (!wallet || tx.chainId !== 11155111 || !same(tx.from, wallet.address))
      throw new Error("Transaction wallet or network mismatch.");
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
    if (live.current) {
      setTransactions((items) => [...items, { label, hash, status: "Pending" }]);
      setBusy(`Waiting for ${label.toLowerCase()} confirmation…`);
    }
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
    await run("approve", "Checking approval…", async (current) => {
      await refreshAccessAndBalances(wallet.address, current);
      await signingProvider(current);
      const result = await client.swapApproval(record.id, { wallet: wallet.address, quoteId: quote.id });
      if (!current()) return;
      for (const [label, tx] of [
        ["Reset approval", result.cancel],
        ["Approve token", result.approval],
      ] as const) {
        if (!tx) continue;
        if (Date.now() >= quote.expiresAt) throw new Error("Quote expired. Request a new quote.");
        if (!same(tx.to, quote.tokenIn)) throw new Error("Unexpected approval token.");
        setBusy(`${label} in your verified wallet…`);
        await send(tx, label, current);
      }
      if (current()) setApproved(true);
    });
  }
  async function swap() {
    if (!quote || !wallet || !approved) return;
    await run("swap", "Preparing swap…", async (current) => {
      const provider = await signingProvider(current);
      await refreshAccessAndBalances(wallet.address, current);
      let signature: string | undefined;
      if (quote.permitData) {
        setBusy("Sign Permit2 authorization with your verified wallet…");
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
      setBusy("Confirm swap with your verified wallet…");
      await send(result.transaction, "Swap", current);
      if (current()) {
        setQuote(null);
        setApproved(false);
        await loadTokens(wallet.address, current);
      }
    });
  }
  return (
    <div className="wb-scroll-page">
      <div className="wb-section-heading">
        <h2>Uniswap V4 (Sepolia)</h2>
        <p>
          Trade through this agreement’s deployed pool. Verify the trading EOA with World ID first, then
          review a quote and sign approvals, Permit2 and the swap with that same EOA.
        </p>
      </div>
      {blocked ? (
        <Notice>{blocked}</Notice>
      ) : (
        <>
          <div className="wb-deploy-grid">
            <section className="wb-surface wb-swap-form">
              <h3>World ID verified swap</h3>
              {poolMismatch && <Notice>{poolMismatch}</Notice>}
              <label>
                Trading wallet EOA
                <input
                  value={walletAddress}
                  placeholder="0x…"
                  disabled={!!busy}
                  onChange={(event) => {
                    setWalletAddress(event.target.value);
                    resetVerifiedWallet();
                  }}
                />
                <FieldError error={!worldReady ? walletIssue : null} />
              </label>
              <dl className="wb-dl">
                <dt>Verifier</dt>
                <dd>{verifierLabel(context)}</dd>
                {identity && (
                  <>
                    <dt>Required credential</dt>
                    <dd>{CREDENTIAL_COPY[identity.credential].label}</dd>
                  </>
                )}
                <dt>World ID signal</dt>
                <dd>
                  <code>{normalizeWallet(walletAddress)?.toLowerCase() ?? "Enter wallet address"}</code>
                </dd>
                {wallet && (
                  <>
                    <dt>Verified EOA</dt>
                    <dd>
                      <Address address={wallet.address} />
                    </dd>
                  </>
                )}
              </dl>
              {context?.mock && (
                <Notice>
                  Demo proof only. No World App or real credential is checked; the gateway still records a
                  wallet-bound attestation before quotes are enabled.
                </Notice>
              )}
              {verifierIssue && <Notice error>{verifierIssue}</Notice>}
              {!identity && (
                <Notice error>
                  This policy does not expose a World ID identity rule for swaps. Configure the policy before
                  trading a permissioned token.
                </Notice>
              )}
              {!worldReady ? (
                <div className="wb-actions">
                  <button
                    className="wb-primary"
                    onClick={startWorldId}
                    disabled={!!busy || !!walletIssue || !!verifierIssue || !identity}
                  >
                    {task === "world" ? (
                      <Busy label="Verifying…" />
                    ) : context?.mock ? (
                      "Run demo World ID check"
                    ) : (
                      "Verify wallet with World ID"
                    )}
                    <Icon name="shield" size={15} />
                  </button>
                  <button disabled={!!busy || !!walletIssue} onClick={refreshEligibility}>
                    {task === "access" ? <Busy label="Reading…" /> : "Refresh verified access"}
                  </button>
                </div>
              ) : (
                <Notice>
                  World ID fact is present and the agreement’s transfer policy currently allows this EOA.
                </Notice>
              )}
              {access && (
                <dl className="wb-dl">
                  <dt>Identity fact</dt>
                  <dd>{identityVerified ? "attested" : "not established"}</dd>
                  <dt>Transfer policy</dt>
                  <dd>{transferAllowed ? "allowed" : "blocked"}</dd>
                  {transferDecision?.clause && !transferAllowed && (
                    <>
                      <dt>Blocking clause</dt>
                      <dd>
                        {transferDecision.clause.clause} — “{transferDecision.clause.quote}”
                      </dd>
                    </>
                  )}
                </dl>
              )}
              {worldFailure && (
                <Notice error={!worldFailure.cancelled}>
                  <strong>{worldFailure.title}</strong> {worldFailure.detail}
                </Notice>
              )}
              {receipt?.txHash && (
                <p className="wb-muted">
                  World ID attestation tx: <code>{receipt.txHash}</code>
                </p>
              )}
              <p className="wb-privacy">{IDENTITY_PRIVACY}</p>
              <label>
                Direction
                <select
                  value={direction}
                  disabled={!!busy || !worldReady}
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
                  disabled={!!busy || !worldReady}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    invalidate();
                  }}
                />
                <FieldError error={amount && amountIssue} />
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
                  {task === "refresh" ? <Busy label="Refreshing…" /> : "Refresh balances"}
                </button>
              )}
              <label>
                Slippage tolerance (%)
                <input
                  inputMode="decimal"
                  value={slippage}
                  disabled={!!busy || !worldReady}
                  onChange={(event) => {
                    setSlippage(event.target.value);
                    invalidate();
                  }}
                />
              </label>
              <button
                className="wb-primary"
                disabled={!worldReady || !tokens || !!amountIssue || !!busy || !!poolMismatch}
                onClick={getQuote}
              >
                {task === "quote" ? (
                  <Busy label="Quoting…" />
                ) : (
                  <>
                    <Icon name="refresh" />
                    Get quote
                  </>
                )}
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
                    Approval is limited to the input amount. Each transaction requires Sepolia ETH for gas and
                    must be signed by the verified EOA above.
                  </p>
                  {!approved ? (
                    <button onClick={approve} disabled={!!busy || expired}>
                      {task === "approve" ? <Busy label="Approving…" /> : "Check / approve token"}
                    </button>
                  ) : (
                    <button className="wb-primary" onClick={swap} disabled={!!busy || expired}>
                      {task === "swap" ? <Busy label="Swapping…" /> : "Confirm swap"}
                    </button>
                  )}
                </section>
              )}
              {busy && (
                <p role="status">
                  <Busy label={busy} />
                </p>
              )}
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
                Pool deployment initializes its price. Liquidity must be added before trading. The trading EOA
                must carry the agreement’s World ID and transfer-policy facts.
              </Notice>
              <Notice>
                Quotes must route through this exact pool. Uniswap may need time to index a newly deployed
                pool and its hook before swaps become available.
              </Notice>
            </section>
          </div>
        </>
      )}
      {worldWidget && context && !context.mock && (
        <WorldIdWidget
          context={context}
          wallet={activeWorldWallet.current}
          onProof={(proof) => submitWorldProof(proof)}
          onClose={() => setWorldWidget(false)}
          onError={(code) => {
            setWorldWidget(false);
            setWorldFailure(identityFailure(code));
          }}
        />
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
