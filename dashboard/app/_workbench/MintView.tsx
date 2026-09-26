"use client";

import { useEffect, useRef, useState } from "react";
import { getAddress, parseUnits } from "ethers";
import {
  operationLabel,
  operationSettled,
  poll,
  type AgreementDetail,
  type AgreementsClient,
  type MintOperation,
  type StackStatus,
} from "@/lib/agreements";
import testFlags from "../../../shared/mint-test-flags.json";
import { actionError, addressError, amountError } from "@/lib/validate";
import { SeedPoolCard } from "./SeedPoolCard";
import { Busy, FieldError, Modal, Notice } from "./ui";

export function MintView({
  record,
  client,
  sample,
  writable,
  status,
}: {
  record: AgreementDetail;
  client: AgreementsClient;
  sample: boolean;
  writable: boolean;
  status: StackStatus | null;
}) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [bypassSubscription, setBypassSubscription] = useState(false);
  const [simulateDeposit, setSimulateDeposit] = useState(false);
  const [testAttestations, setTestAttestations] = useState<Record<string, boolean>>({});
  const [operation, setOperation] = useState<MintOperation | null>(
    () => record.mintOperations?.at(-1) ?? null
  );
  const [review, setReview] = useState<{
    recipient: string;
    amount: string;
    requestId: string;
    bypassSubscription?: boolean;
    simulateDeposit?: boolean;
    testAttestations?: Record<string, boolean>;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const lock = useRef(false);
  const storageKey = `mirr0:mint:${record.id}:${record.deployment?.token}`;
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) setOperation(JSON.parse(saved));
    } catch {
      /* Storage may be unavailable. The gateway also persists accepted requests. */
    }
    setRestored(true);
  }, [storageKey]);
  useEffect(() => {
    if (!restored || !operation) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(operation));
    } catch {
      /* Gateway remains authoritative. */
    }
  }, [restored, storageKey, operation]);
  const pending = sending || operation?.status === "pending";
  const recipientIssue = addressError(recipient);
  const amountIssue = amountError(amount);
  const backend = status?.chain?.deployer ?? operation?.backend;
  const blocked = sample
    ? "Deploy your own agreement before minting. Samples are read-only."
    : !writable
      ? "Minting requires an authorized local workspace or operator session."
      : record.status !== "deployed" || !record.deployment
        ? "Deploy this agreement before minting its RWA token."
        : record.policyHash !== record.deployment.policyHash
          ? "The deployed policy differs from the current agreement."
          : record.profile === "wildcat-credit" || record.deployment?.cashier
            ? "This token uses a separate settlement flow and cannot be issued from this tab."
            : !status?.chain?.deployer
              ? "Configure the backend deployment signer before minting."
              : null;
  useEffect(() => {
    if (!operation || operation.status !== "pending") return;
    return poll(
      (signal) => client.mintOperation(record.id, operation.requestId, signal),
      (next) => {
        if (operationSettled(operation, next)) setRefresh((value) => value + 1);
        setOperation(next);
        setPollError("");
      },
      (failure) => setPollError(`${actionError(failure)} The backend may still be processing this request.`),
      () => 2000
    );
  }, [client, record.id, operation?.requestId, operation?.status]);
  function prepare() {
    setError("");
    try {
      const issue = recipientIssue ?? amountIssue;
      if (issue) throw new Error(issue);
      setReview({
        recipient: getAddress(recipient.trim()),
        amount: amount.trim(),
        requestId: crypto.randomUUID(),
        bypassSubscription,
        simulateDeposit,
        testAttestations,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Invalid mint request.");
    }
  }
  async function submit(body: {
    recipient: string;
    amount: string;
    requestId: string;
    bypassSubscription?: boolean;
    simulateDeposit?: boolean;
    testAttestations?: Record<string, boolean>;
  }) {
    if (lock.current || blocked) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      // Retain this ID on an uncertain response; repeating it cannot issue a second mint.
      const attempt: MintOperation = {
        ...(operation?.requestId === body.requestId ? operation : {}),
        ...body,
        token: record.deployment!.token,
        chainId: record.deployment!.chainId,
        units: parseUnits(body.amount, 6).toString(),
        status: "failed",
        stage: operation?.requestId === body.requestId ? operation.stage : "mint",
        error: "Submission interrupted. Retry the same request to check its status.",
      };
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(attempt));
      } catch {
        /* Gateway persists accepted requests. */
      }
      const next = await client.mint(record.id, body);
      if (operationSettled(operation, next)) setRefresh((value) => value + 1);
      setOperation(next);
      setReview(null);
    } catch (failure) {
      const message = actionError(failure);
      setError(message);
      setOperation((current) => ({
        ...(current?.requestId === body.requestId ? current : {}),
        ...body,
        token: record.deployment!.token,
        chainId: record.deployment!.chainId,
        units: parseUnits(body.amount, 6).toString(),
        status: "failed",
        stage: current?.requestId === body.requestId ? current.stage : "mint",
        error: `${message} Retry this same request to reconcile its status.`,
      }));
      setReview(null);
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  const link = (address: string) => (
    <a href={`https://sepolia.etherscan.io/address/${address}`} target="_blank" rel="noreferrer">
      <code>{address}</code> ↗
    </a>
  );
  return (
    <div className="wb-scroll-page">
      <div className="wb-section-heading">
        <h2>Liquidity management</h2>
        <p>Choose the recipient and amount. The backend signs and pays gas for minting and release.</p>
      </div>
      <section className="wb-surface wb-swap-form">
        <h3>Mint RWA tokens</h3>
        <dl className="wb-dl">
          <dt>RWA token</dt>
          <dd>{record.deployment?.token ? link(record.deployment.token) : "Not deployed"}</dd>
          <dt>Backend minter</dt>
          <dd>{backend ? link(backend) : "No backend signer reported"}</dd>
        </dl>
        <p className="wb-muted">
          Tokens are minted into backend custody, then released to the chosen address. Recipient eligibility
          and the token’s supply limit still apply.
        </p>
        {blocked && <Notice>{blocked}</Notice>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            prepare();
          }}
          className="wb-form"
        >
          <label>
            Recipient address
            <input
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="0x…"
              disabled={!!blocked || !!pending}
              required
            />
            <FieldError error={recipient && recipientIssue} />
          </label>
          <label>
            Amount of RWA tokens
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              disabled={!!blocked || !!pending}
              required
            />
            <FieldError error={amount && amountIssue} />
          </label>
          <button
            className="wb-primary"
            disabled={!!blocked || !!pending || !!recipientIssue || !!amountIssue}
          >
            {pending ? (
              <Busy label={operation && !sending ? operationLabel(operation.stage) : "Submitting…"} />
            ) : (
              "Review mint"
            )}
          </button>
        </form>
        {error && <Notice error>{error}</Notice>}
      </section>
      <details className="wb-surface">
        <summary>Advanced settings</summary>
        <label>
          <input
            type="checkbox"
            checked={bypassSubscription}
            disabled={!!blocked || !!pending}
            onChange={(event) => setBypassSubscription(event.target.checked)}
          />{" "}
          Bypass subscription acceptance (testnet only)
        </label>
        <p className="wb-muted">
          Sepolia testing only. On the next mint, the backend records subscriptionAccepted=true for this
          recipient and policy, valid for up to 24 hours. Other requirements, including payment, KYC/AML and
          World ID, still apply. Unchecking does not revoke an existing attestation.
        </p>
        <label>
          <input
            type="checkbox"
            checked={simulateDeposit}
            disabled={!!blocked || !!pending}
            onChange={(event) => setSimulateDeposit(event.target.checked)}
          />{" "}
          Simulate bank deposit (testnet only)
        </label>
        <p className="wb-muted">
          Off by default. When enabled, the backend records depositConfirmed=true for this recipient and
          policy. No bank payment or mUSDC transfer occurs. Normal issuance requires confirmation of funds
          received in the actual bank account. Unchecking does not revoke an existing attestation.
        </p>
        <p className="wb-muted">
          All simulations are off by default and available only on test networks. Facts persist on chain for
          up to 24 hours; disabling a checkbox does not revoke a prior attestation. Sanctions clearance
          persists on the mock oracle until changed.
        </p>
        {testFlags.map((flag) => (
          <div key={flag.fact}>
            <label>
              <input
                type="checkbox"
                checked={testAttestations[flag.fact] === true}
                disabled={!!blocked || !!pending}
                onChange={(event) =>
                  setTestAttestations((current) => ({ ...current, [flag.fact]: event.target.checked }))
                }
              />{" "}
              {flag.label} (testnet only)
            </label>
            <p className="wb-muted">
              {flag.clauses}. {flag.description}
            </p>
          </div>
        ))}
      </details>
      {operation && (
        <section className="wb-surface" aria-label="Mint operation">
          <h3>
            {operation.status === "confirmed"
              ? "Mint confirmed"
              : operation.status === "failed"
                ? "Mint needs attention"
                : "Mint in progress"}
          </h3>
          <p>
            {operation.amount} RWA → {link(operation.recipient)}
          </p>
          <p>
            Stage: {operation.stage} · Request: <code>{operation.requestId}</code>
          </p>
          {operation.error && <Notice error>{operation.error}</Notice>}
          {operation.status === "failed" && operation.minted && (
            <Notice>
              Minting completed into backend custody. Retry this request to finish the release without minting
              again.
            </Notice>
          )}
          {(
            [
              ["Subscription acceptance", operation.subscriptionTxHash],
              ["Test deposit confirmation", operation.depositTxHash],
              ["Test issuer authorization", operation.issuerAuthorizedTxHash],
              ["Test offering compliance", operation.offeringCompliantTxHash],
              ["Test identity verification", operation.identityVerifiedTxHash],
              ["Test KYC", operation.kycApprovedTxHash],
              ["Test AML", operation.amlApprovedTxHash],
              ["Mock sanctions clearance", operation.sanctionsClearTxHash],
              ["Mint", operation.mintTxHash],
              ["Release", operation.releaseTxHash],
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
          {pollError && <Notice error>{pollError}</Notice>}
          {operation.status === "failed" && (
            <button disabled={!!blocked || !!pending} onClick={() => submit(operation)}>
              {sending ? <Busy label="Retrying…" /> : "Retry same request"}
            </button>
          )}
        </section>
      )}
      <SeedPoolCard record={record} client={client} blocked={blocked} refresh={refresh} />
      {review && (
        <Modal
          title="Confirm backend mint"
          onClose={() => {
            if (!sending) setReview(null);
          }}
          busy={sending}
        >
          <div className="wb-form">
            <p>
              Mint <strong>{review.amount} RWA tokens</strong> to {link(review.recipient)}.
            </p>
            <p>Signer: {backend ? link(backend) : "Backend deployment address"}</p>
            {testFlags.some((flag) => review.testAttestations?.[flag.fact]) && (
              <Notice>
                Selected simulations:{" "}
                {testFlags
                  .filter((flag) => review.testAttestations?.[flag.fact])
                  .map((flag) => flag.label)
                  .join(", ")}
                . These record test state and do not verify identity or compliance.
              </Notice>
            )}
            {review.simulateDeposit && (
              <Notice>
                This mint will simulate bank receipt by recording depositConfirmed=true for the recipient on
                the test network. No actual bank payment is verified.
              </Notice>
            )}
            {review.bypassSubscription && (
              <Notice>
                The backend will record test subscription acceptance for this recipient before checking the
                remaining mint requirements.
              </Notice>
            )}
            {error && <Notice error>{error}</Notice>}
            <button className="wb-primary" disabled={sending || !!blocked} onClick={() => submit(review)}>
              {sending ? <Busy label="Minting…" /> : "Mint from backend"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
