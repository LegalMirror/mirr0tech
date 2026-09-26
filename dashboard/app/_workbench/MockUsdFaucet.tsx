"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserProvider, Contract, formatUnits } from "ethers";
import { MOCK_USD, MOCK_USD_ABI, mockUsdMintTransaction } from "@/lib/mock-usd";
import {
  assertWallet,
  connectWallet,
  injectedWallet,
  observeWallet,
  sendWalletTransaction,
  switchToSepolia,
  WalletChanged,
  type WalletIdentity,
} from "@/lib/investor/wallet";
import { actionError, amountError } from "@/lib/validate";
import { Busy, FieldError, Notice } from "./ui";

export function MockUsdFaucet({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [amount, setAmount] = useState("10000");
  const [wallet, setWallet] = useState<WalletIdentity | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<{ hash: string; status: string } | null>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const running = useRef(false);
  const amountIssue = amountError(amount);
  useEffect(() => {
    mounted.current = true;
    const provider = injectedWallet();
    const stop = provider
      ? observeWallet(provider, () => {
          epoch.current++;
          setWallet(null);
          setBalance(null);
        })
      : () => {};
    return () => {
      mounted.current = false;
      epoch.current++;
      stop();
    };
  }, []);
  async function run(message: string, work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(message);
    setError("");
    onBusyChange(true);
    try {
      await work();
    } catch (failure) {
      if (mounted.current) {
        if (failure instanceof WalletChanged && failure.txHash)
          setReceipt({ hash: failure.txHash, status: "Submitted — check Etherscan" });
        setError(actionError(failure));
      }
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy("");
        onBusyChange(false);
      }
    }
  }
  async function readBalance(rpc: BrowserProvider, identity: WalletIdentity) {
    const token = new Contract(MOCK_USD.address, MOCK_USD_ABI, rpc);
    const [decimals, symbol, value] = await Promise.all([
      token.decimals(),
      token.symbol(),
      token.balanceOf(identity.address),
    ]);
    if (Number(decimals) !== MOCK_USD.decimals || symbol !== MOCK_USD.symbol)
      throw new Error("The connected network did not return the shared mUSDC token.");
    return formatUnits(value, MOCK_USD.decimals);
  }
  async function connect() {
    await run("Connecting wallet…", async () => {
      const provider = injectedWallet();
      if (!provider) throw new Error("Install a Sepolia-capable browser wallet to mint mUSDC.");
      let identity = await connectWallet(provider);
      if (!mounted.current) return;
      if (identity.chainId !== MOCK_USD.chainId) identity = await switchToSepolia(provider);
      const revision = epoch.current;
      const current = () => mounted.current && epoch.current === revision;
      await assertWallet(provider, identity, current);
      const rpc = new BrowserProvider(provider);
      try {
        const value = await readBalance(rpc, identity);
        await assertWallet(provider, identity, current);
        if (current()) {
          setWallet(identity);
          setBalance(value);
        }
      } finally {
        rpc.destroy();
      }
    });
  }
  async function mint() {
    if (!wallet) return;
    await run("Confirm mint in your wallet…", async () => {
      const provider = injectedWallet();
      if (!provider) throw new Error("Reconnect your wallet.");
      const revision = epoch.current;
      const current = () => mounted.current && epoch.current === revision;
      const transaction = mockUsdMintTransaction(wallet, amount);
      await assertWallet(provider, wallet, current);
      const hash = await sendWalletTransaction(provider, wallet, transaction, current);
      if (mounted.current) {
        setReceipt({ hash, status: "Pending" });
        setBusy("Waiting for mint confirmation…");
      }
      const rpc = new BrowserProvider(provider);
      try {
        const mined = await rpc.waitForTransaction(hash, 1, 180000);
        if (!mined)
          throw new Error("Mint is still pending. Check the transaction on Etherscan before minting again.");
        if (mounted.current) setReceipt({ hash, status: mined.status === 1 ? "Confirmed" : "Failed" });
        if (mined.status !== 1) throw new Error("The mint transaction failed. See Etherscan for details.");
        window.dispatchEvent(new Event("mirr0:mock-usd-minted"));
        await assertWallet(provider, wallet, current);
        const value = await readBalance(rpc, wallet);
        if (current()) setBalance(value);
      } finally {
        rpc.destroy();
      }
    });
  }
  return (
    <section className="wb-form wb-faucet" aria-labelledby="mock-usd-title">
      <h3 id="mock-usd-title">Test-token faucet</h3>
      <p>Mint mUSDC for future RWA swaps on Sepolia. Anyone can mint any amount, with no cap or cooldown.</p>
      <p>
        <a href={`https://sepolia.etherscan.io/address/${MOCK_USD.address}`} target="_blank" rel="noreferrer">
          <code>{MOCK_USD.address}</code> ↗
        </a>
      </p>
      <p className="wb-muted">
        Test tokens only, with no USD backing. Your wallet needs Sepolia ETH for transaction gas.
      </p>
      {wallet ? (
        <>
          <p>
            Recipient: <code>{wallet.address}</code>
            <br />
            Balance: {balance ?? "…"} mUSDC
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mint();
            }}
          >
            <label htmlFor="mock-usd-amount">Amount of mUSDC</label>
            <input
              id="mock-usd-amount"
              inputMode="decimal"
              value={amount}
              disabled={!!busy}
              onChange={(event) => setAmount(event.target.value)}
            />
            <FieldError error={amountIssue} />
            <button type="submit" className="wb-primary" disabled={!!busy || !!amountIssue}>
              {busy ? <Busy label="Minting…" /> : "Mint mUSDC"}
            </button>
          </form>
        </>
      ) : (
        <button type="button" className="wb-primary" disabled={!!busy} onClick={connect}>
          {busy ? <Busy label="Connecting…" /> : "Connect wallet to mint"}
        </button>
      )}
      {busy && (
        <p role="status">
          <Busy label={busy} />
        </p>
      )}
      {error && <Notice error>{error}</Notice>}
      {receipt && (
        <p role="status">
          {receipt.status} ·{" "}
          <a href={`https://sepolia.etherscan.io/tx/${receipt.hash}`} target="_blank" rel="noreferrer">
            <code>{receipt.hash}</code> ↗
          </a>
        </p>
      )}
    </section>
  );
}
