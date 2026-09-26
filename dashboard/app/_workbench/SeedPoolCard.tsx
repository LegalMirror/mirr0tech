"use client";

import { useEffect, useRef, useState } from "react";
import { parseUnits } from "ethers";
import {
  operationLabel,
  operationSettled,
  poll,
  type AgreementDetail,
  type AgreementsClient,
  type LiquidityState,
  type SeedOperation,
} from "@/lib/agreements";
import { sharedPoolMismatch } from "@/lib/swap";
import { actionError, amountError } from "@/lib/validate";
import { Busy, FieldError, Modal, Notice } from "./ui";

const budgetError = (amount: string, balance: string | undefined) =>
  amountError(amount) ??
  (balance !== undefined && parseUnits(amount.trim(), 6) > parseUnits(balance, 6)
    ? "Exceeds the backend wallet balance."
    : null);

export function SeedPoolCard({
  record,
  client,
  blocked,
  refresh = 0,
}: {
  record: AgreementDetail;
  client: AgreementsClient;
  blocked: string | null;
  /** Changes when another view confirms an operation that moves the backend's balances. */
  refresh?: number;
}) {
  const [state, setState] = useState<LiquidityState | null>(null);
  const [stateError, setStateError] = useState("");
  const [error, setError] = useState("");
  const [rwaAmount, setRwaAmount] = useState("");
  const [usdAmount, setUsdAmount] = useState("");
  const [operation, setOperation] = useState<SeedOperation | null>(
    () => record.seedOperations?.at(-1) ?? null
  );
  const [review, setReview] = useState<{ rwaAmount: string; usdAmount: string; requestId: string } | null>(
    null
  );
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const storageKey = `mirr0:seed:${record.id}:${record.deployment?.poolId}`;
  const disabled =
    blocked ||
    (sharedPoolMismatch(record)
      ? "Seeding is disabled for this deprecated pool. It uses the old mUSDC deployment."
      : null) ||
    (record.deployment?.routing !== "uniswap-api"
      ? "Redeploy this agreement to seed through Uniswap’s PositionManager. Custom-router pools are retired."
      : null) ||
    (!record.deployment?.poolId ? "This agreement has no deployed Uniswap pool." : null);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) setOperation(JSON.parse(saved));
    } catch {
      /* Gateway also persists operations. */
    }
  }, [storageKey]);
  useEffect(() => {
    if (disabled) return;
    return poll(
      (signal) => client.liquidity(record.id, signal),
      (next) => {
        setState(next);
        setStateError("");
      },
      (failure) => setStateError(actionError(failure)),
      () => 10000
    );
  }, [client, record.id, disabled, revision, refresh]);
  useEffect(() => {
    if (!operation || operation.status !== "pending") return;
    return poll(
      (signal) => client.seedOperation(record.id, operation.requestId, signal),
      (next) => {
        setOperation(next);
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* Gateway remains authoritative. */
        }
        if (operationSettled(operation, next)) setRevision((value) => value + 1);
      },
      (failure) => setError(`${actionError(failure)} The backend may still be processing this request.`),
      () => 2000
    );
  }, [client, record.id, operation?.requestId, operation?.status, storageKey]);
  const pending = sending || operation?.status === "pending";
  const rwaIssue = budgetError(rwaAmount, state?.rwaBalance);
  const usdIssue = budgetError(usdAmount, state?.usdBalance);
  function prepare() {
    setError("");
    try {
      if (!state) throw new Error("Refresh backend balances first.");
      const issue = rwaIssue ?? usdIssue;
      if (issue) throw new Error(issue);
      setReview({ rwaAmount: rwaAmount.trim(), usdAmount: usdAmount.trim(), requestId: crypto.randomUUID() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Invalid amounts.");
    }
  }
  async function submit(body: { rwaAmount: string; usdAmount: string; requestId: string }) {
    if (lock.current || disabled) return;
    lock.current = true;
    setSending(true);
    setError("");
    const attempt: SeedOperation = {
      ...(operation?.requestId === body.requestId ? operation : {}),
      ...body,
      poolId: record.deployment!.poolId!,
      status: "failed",
      stage: "approval",
      error: "Submission interrupted. Retry this same request to check its status.",
    };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(attempt));
    } catch {
      /* Gateway persists accepted requests. */
    }
    try {
      const next = await client.seed(record.id, body);
      if (operationSettled(operation, next)) setRevision((value) => value + 1);
      setOperation(next);
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* Optional storage. */
      }
    } catch (failure) {
      const message = actionError(failure);
      setOperation({ ...attempt, error: `${message} Retry this same request to check its status.` });
    } finally {
      setReview(null);
      setSending(false);
      lock.current = false;
    }
  }
  const address = (value: string) => (
    <a href={`https://sepolia.etherscan.io/address/${value}`} target="_blank" rel="noreferrer">
      <code>{value}</code> ↗
    </a>
  );
  return (
    <section className="wb-surface wb-swap-form">
      <h3>Seed Uniswap pool</h3>
      <p>
        Add RWA and shared mUSDC from the backend wallet to the deployed pool. Swaps require liquidity in the
        pool.
      </p>
      {disabled && <Notice>{disabled}</Notice>}
      {state && (
        <>
          <dl className="wb-dl">
            <dt>Liquidity provider</dt>
            <dd>{address(state.backend)}</dd>
            <dt>RWA balance</dt>
            <dd>{state.rwaBalance}</dd>
            <dt>mUSDC balance</dt>
            <dd>{state.usdBalance}</dd>
            <dt>mUSDC contract</dt>
            <dd>{address(state.asset)}</dd>
            <dt>Pool liquidity</dt>
            <dd>{state.liquidity === "0" ? "Empty — seed before swapping" : "Active liquidity available"}</dd>
          </dl>
          <p className="wb-muted">
            To fund this wallet, mint RWA to the backend address above and send shared mUSDC to it. Backend
            transfer eligibility is required.
          </p>
        </>
      )}
      <form
        className="wb-form"
        onSubmit={(event) => {
          event.preventDefault();
          prepare();
        }}
      >
        <label>
          Maximum RWA to deposit
          <input
            inputMode="decimal"
            value={rwaAmount}
            onChange={(event) => setRwaAmount(event.target.value)}
            disabled={!!disabled || !!pending}
            required
          />
          <FieldError error={rwaAmount && rwaIssue} />
        </label>
        <label>
          Maximum mUSDC to deposit
          <input
            inputMode="decimal"
            value={usdAmount}
            onChange={(event) => setUsdAmount(event.target.value)}
            disabled={!!disabled || !!pending}
            required
          />
          <FieldError error={usdAmount && usdIssue} />
        </label>
        <p className="wb-muted">
          The backend approves these maximum amounts and adds a full-range position at the current pool price.
          Actual deposits may be smaller; unused tokens stay in the backend wallet.
        </p>
        <div className="wb-actions">
          <button
            className="wb-primary"
            disabled={!!disabled || !!pending || !state || !!rwaIssue || !!usdIssue}
          >
            {pending ? (
              <Busy label={operation && !sending ? operationLabel(operation.stage) : "Submitting…"} />
            ) : (
              "Review seed"
            )}
          </button>
          <button
            type="button"
            disabled={!!disabled || !!pending}
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh balances
          </button>
        </div>
      </form>
      {stateError && <Notice error>{stateError}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {operation && (
        <div aria-label="Pool seed operation">
          <h4>
            {operation.status === "confirmed"
              ? "Pool seeded"
              : operation.status === "failed"
                ? "Seeding needs attention"
                : "Seeding in progress"}
          </h4>
          <p>
            Request: <code>{operation.requestId}</code> · {operation.stage}
          </p>
          {operation.error && <Notice error>{operation.error}</Notice>}
          {(
            [
              ...(operation.approvalTxHashes ?? [operation.approvalTxHash]).map(
                (hash, index) => [`Approval ${index + 1}`, hash] as const
              ),
              ["Seed pool", operation.seedTxHash],
            ] as const
          ).map(
            ([label, hash]) =>
              hash && (
                <p key={label}>
                  {label}:{" "}
                  <a href={`https://sepolia.etherscan.io/tx/${hash}`} target="_blank" rel="noreferrer">
                    <code>{hash}</code> ↗
                  </a>
                </p>
              )
          )}
          {operation.status === "failed" && (
            <button disabled={!!disabled || !!pending} onClick={() => submit(operation)}>
              {sending ? <Busy label="Retrying…" /> : "Retry same seed request"}
            </button>
          )}
        </div>
      )}
      {review && (
        <Modal
          title="Confirm pool seeding"
          busy={sending}
          onClose={() => {
            if (!sending) setReview(null);
          }}
        >
          <p>
            Deposit up to {review.rwaAmount} RWA and {review.usdAmount} mUSDC from the backend wallet. The
            backend signs approvals and the liquidity transaction, and pays gas.
          </p>
          <button className="wb-primary" disabled={sending || !!disabled} onClick={() => submit(review)}>
            {sending ? <Busy label="Seeding…" /> : "Seed pool from backend"}
          </button>
        </Modal>
      )}
    </section>
  );
}
