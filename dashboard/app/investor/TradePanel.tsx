"use client";

import { useState } from "react";
import { investorSession, sessionAlive } from "@/lib/investor/session";
import { assertWallet, sendWalletTransaction, WalletChanged } from "@/lib/investor/wallet";
import {
  blockingReasons,
  exactUnits,
  pollConfirmation,
  tradingBlocked,
  transactionUrl,
  validateConfirmation,
  validatePrepared,
  validateQuote,
} from "@/lib/investor/transactions";
import type {
  InvestorQuote,
  PendingTransaction,
  PreparedIntent,
  Snapshot,
  TransactionRequest,
  TradeInput,
} from "@/lib/investor/types";
import type { InvestorState } from "./useInvestor";

export function TradePanel({
  state,
  snapshot,
  onRefresh,
  onBroadcast,
}: {
  state: InvestorState;
  snapshot: Snapshot | null;
  onRefresh: () => Promise<void>;
  onBroadcast: (hash: string) => void;
}) {
  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("");
  const [route, setRoute] = useState<TradeInput["route"]>("auto");
  const [minOut, setMinOut] = useState("");
  const [quote, setQuote] = useState<InvestorQuote | null>(null);
  const [review, setReview] = useState<{ intent: PreparedIntent; request: TransactionRequest } | null>(null);
  const [pending, setPending] = useState<PendingTransaction | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { session, fund, provider, wallet } = state;
  if (!session || !fund || !wallet || !provider) return null;
  const blocked = tradingBlocked(fund, snapshot);
  const unresolved = !!pending && (!pending.result || pending.result.status === "pending");
  const locked = !!busy || unresolved;
  const discard = () => {
    setQuote(null);
    setReview(null);
    setError("");
  };
  const inputName = snapshot
    ? buy
      ? snapshot.balances.asset.symbol
      : snapshot.balances.token.symbol
    : "input token";
  const outputName = snapshot
    ? buy
      ? snapshot.balances.token.symbol
      : snapshot.balances.asset.symbol
    : "output token";

  async function getQuote() {
    if (!session || !fund || blocked || locked) return;
    const op = state.begin();
    setBusy("quote");
    setError("");
    setReview(null);
    try {
      exactUnits(amount);
      const result = await state.client.quote(session, { buy, amount, route }, op.signal);
      if (op.current()) setQuote(validateQuote(result, session, fund, { buy, amount, route }));
    } catch (error) {
      if (op.current()) {
        setError((error as Error).message);
        state.report(error);
      }
    } finally {
      if (op.current()) setBusy("");
      op.finish();
    }
  }
  async function prepare(kind: "approval" | "swap") {
    if (!session || !fund || !snapshot || !provider || !wallet || !quote || blocked || locked) return;
    const op = state.begin();
    setBusy("prepare");
    setError("");
    try {
      await assertWallet(provider, wallet, op.current);
      const request: TransactionRequest = {
        kind,
        buy,
        amount,
        route,
        ...(kind === "swap"
          ? { minOut, deadline: Math.min(Math.floor(Date.now() / 1000) + 120, session.expiresAt - 1) }
          : {}),
      };
      if (kind === "swap") exactUnits(minOut);
      const intent = await state.client.prepare(session, request, op.signal);
      if (!op.current()) return;
      validatePrepared(intent, request, session, fund, snapshot);
      setReview({ intent, request });
    } catch (error) {
      if (op.current()) {
        setError((error as Error).message);
        state.report(error);
      }
    } finally {
      if (op.current()) setBusy("");
      op.finish();
    }
  }
  async function send() {
    if (!session || !fund || !snapshot || !provider || !wallet || !review || blocked || locked) return;
    const op = state.begin();
    setBusy("wallet");
    setError("");
    const current = () =>
      op.current() &&
      investorSession.get() === session &&
      sessionAlive(session) &&
      review.intent.expiresAt * 1000 > Date.now();
    let broadcast: string | null = null;
    try {
      const transaction = validatePrepared(review.intent, review.request, session, fund, snapshot);
      const txHash = await sendWalletTransaction(provider, wallet, transaction, current);
      broadcast = txHash;
      onBroadcast(txHash);
      if (!op.current()) return;
      setPending({
        intentId: review.intent.intentId,
        txHash,
        kind: review.request.kind,
        result: null,
        outputSymbol: outputName,
      });
      setReview(null);
      setBusy("confirm");
      await pollConfirmation(
        async () =>
          validateConfirmation(
            await state.client.confirm(session, review.intent.intentId, txHash, op.signal),
            review.intent.intentId,
            txHash
          ),
        (result) => {
          setPending({
            intentId: review.intent.intentId,
            txHash,
            kind: review.request.kind,
            result,
            outputSymbol: outputName,
          });
        },
        op.signal
      );
      if (op.current()) {
        setQuote(null);
        await onRefresh();
      }
    } catch (error) {
      if (error instanceof WalletChanged && error.txHash) onBroadcast(error.txHash);
      if (op.current()) {
        const message = `${(error as Error).message}${broadcast ? " The transaction was already broadcast. Do not send it again." : ""}`;
        setError(message);
        state.report(error);
      }
    } finally {
      if (op.current()) setBusy("");
      op.finish();
    }
  }
  async function checkReceipt() {
    if (!pending || !session || busy) return;
    const op = state.begin();
    setBusy("confirm");
    setError("");
    try {
      const result = validateConfirmation(
        await state.client.confirm(session, pending.intentId, pending.txHash, op.signal),
        pending.intentId,
        pending.txHash
      );
      if (op.current()) {
        setPending({ ...pending, result });
        await onRefresh();
      }
    } catch (error) {
      if (op.current()) {
        setError(`${(error as Error).message} Inspect the wallet/chain receipt; this button never resends.`);
        state.report(error);
      }
    } finally {
      if (op.current()) setBusy("");
      op.finish();
    }
  }
  const approvalNeeded = quote ? BigInt(quote.inputToken.allowanceRaw) < BigInt(quote.amountRaw) : false;
  return (
    <section className="iv-card iv-trade" aria-labelledby="investor-trade">
      <div className="iv-card-heading">
        <span className="iv-kicker">04 / WALLET-SIGNED EXECUTION</span>
        <h2 id="investor-trade">Swap test assets</h2>
        <p>
          The gateway prepares bounded calldata. Your Sepolia wallet approves and sends it; the server never
          trades on your behalf.
        </p>
      </div>
      {blocked && <div className="iv-notice">{blocked}</div>}
      <fieldset disabled={!!blocked || locked || !!review}>
        <legend className="iv-sr-only">Exact-input order</legend>
        <div className="iv-form-grid">
          <label>
            Direction
            <select
              value={buy ? "buy" : "sell"}
              onChange={(event) => {
                setBuy(event.target.value === "buy");
                setMinOut("");
                discard();
              }}
            >
              <option value="buy">Buy shares with mockUSD</option>
              <option value="sell">Sell shares for mockUSD</option>
            </select>
          </label>
          <label>
            Execution route
            <select
              value={route}
              onChange={(event) => {
                setRoute(event.target.value as TradeInput["route"]);
                discard();
              }}
            >
              <option value="auto">Auto · bounded AMM / cashier</option>
              <option value="amm">AMM only</option>
              <option value="cashier">Cashier only</option>
            </select>
          </label>
          <label>
            Exact input · {inputName}
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                discard();
              }}
            />
          </label>
          <label>
            Minimum received · {outputName}
            <input
              inputMode="decimal"
              placeholder="Set your own minimum"
              value={minOut}
              onChange={(event) => {
                setMinOut(event.target.value);
                setReview(null);
              }}
            />
          </label>
        </div>
      </fieldset>
      <div className="iv-actions">
        <button onClick={getQuote} disabled={!!blocked || locked || !!review || !amount}>
          {busy === "quote" ? "Reading NAV indication…" : "Get NAV indication"}
        </button>
        <span className="iv-note">
          Six-decimal exact input · 2-minute swap deadline at preparation · own Sepolia ETH required
        </span>
      </div>
      {quote && (
        <div className="iv-quote">
          <div>
            <span>NAV indication—not an execution price</span>
            <strong>
              {quote.amountOut ?? "Unavailable"} {quote.outputToken.symbol}
            </strong>
          </div>
          <p>{quote.notice}</p>
          <p className="iv-note">
            Read at block {quote.blockNumber}. AMM fees, price impact, eligibility and reserves can change
            before mining. Auto routing may spend extra gas before falling back.
          </p>
          {quote.blockers.length > 0 && (
            <ul className="iv-blockers">
              {quote.blockers.map((blocker, index) => (
                <li key={index}>
                  <strong>
                    {blocker.scope === "cashier" ? "Cashier" : "All routes"}: {blocker.message}
                  </strong>
                  {blocker.clause && (
                    <blockquote>
                      {blocker.clause.clause} — {blocker.clause.quote}
                    </blockquote>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!approvalNeeded && (
            <p className="iv-note">
              Reported router allowance covers this amount. A fresh on-chain preflight is still required.
            </p>
          )}
          <div className="iv-actions">
            <button
              onClick={() => prepare("approval")}
              disabled={
                locked ||
                !!review ||
                !!blocked ||
                !approvalNeeded ||
                !!blockingReasons(quote, "approval").length
              }
            >
              Review exact-amount approval
            </button>
            <button
              className="iv-primary"
              onClick={() => prepare("swap")}
              disabled={locked || !!review || !!blocked || !minOut || !!blockingReasons(quote, "swap").length}
            >
              Review swap
            </button>
          </div>
        </div>
      )}
      {review && (
        <section className="iv-review" aria-label="Review wallet transaction">
          <h3>
            {review.request.kind === "approval"
              ? "Approve only this exact input amount"
              : "Review your bounded swap"}
          </h3>
          <dl>
            <dt>Wallet / chain</dt>
            <dd>
              <code>{wallet.address}</code> · Sepolia
            </dd>
            <dt>{review.request.kind === "approval" ? "Token / spender" : "Router"}</dt>
            <dd>
              <code>{review.intent.transaction.to}</code>
              {review.intent.spender && <code>Spender: {review.intent.spender}</code>}
            </dd>
            <dt>Exact input</dt>
            <dd>
              {review.intent.amount} {inputName}
            </dd>
            {review.request.kind === "swap" && (
              <>
                <dt>Minimum output / route</dt>
                <dd>
                  {review.intent.minOut} {outputName} · {review.intent.route}
                </dd>
                <dt>Preflight simulation</dt>
                <dd>
                  {review.intent.simulatedAmountOut ?? "Not returned"} {outputName} · not a mining guarantee
                </dd>
              </>
            )}
            <dt>Intent expires</dt>
            <dd>{new Date(review.intent.expiresAt * 1000).toLocaleTimeString()}</dd>
            <dt>Native value</dt>
            <dd>0 ETH sent to contract; wallet gas is separate</dd>
          </dl>
          <p className="iv-note">
            The browser decoded and checked the exact target, spender/pool, input, route and limits against
            this session. An approval is a separate transaction and does not execute a swap.
          </p>
          <details>
            <summary>Exact calldata</summary>
            <code>{review.intent.transaction.data}</code>
          </details>
          <div className="iv-actions">
            <button className="iv-primary" disabled={locked} onClick={send}>
              {busy === "wallet"
                ? "Confirm in your wallet…"
                : review.request.kind === "approval"
                  ? "Sign & send exact approval"
                  : "Sign & send swap"}
            </button>
            <button disabled={locked} onClick={() => setReview(null)}>
              Cancel review
            </button>
          </div>
        </section>
      )}
      {pending && (
        <section className="iv-receipt" aria-live="polite">
          <h3>
            {pending.result?.status === "confirmed"
              ? `${pending.kind === "approval" ? "Approval" : "Swap"} confirmed by RPC receipt`
              : pending.result?.status === "reverted"
                ? "Transaction reverted"
                : "Broadcast · awaiting verified receipt"}
          </h3>
          <a href={transactionUrl(pending.txHash)!} target="_blank" rel="noreferrer">
            View transaction on Sepolia ↗
          </a>
          <code>{pending.txHash}</code>
          {pending.result?.receipt && (
            <p>
              Block {pending.result.receipt.blockNumber} · receipt status {pending.result.receipt.status}
            </p>
          )}
          {pending.result?.actualRoute && (
            <p>
              Executed route: {pending.result.actualRoute} · received {pending.result.amountOut}{" "}
              {pending.outputSymbol}
            </p>
          )}
          <p>
            {pending.result?.reason ??
              (pending.result?.status === "confirmed"
                ? "Mined, not finalized. The backend checked the exact prepared transaction and expected contract event. Indexing may lag."
                : "A transaction hash is not proof of execution. No automatic resend; bounded polling stops and you can check manually.")}
          </p>
          <button disabled={!!busy} onClick={checkReceipt}>
            {busy === "confirm" ? "Checking receipt…" : "Check transaction receipt"}
          </button>
        </section>
      )}
      {error && (
        <p className="iv-notice iv-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
