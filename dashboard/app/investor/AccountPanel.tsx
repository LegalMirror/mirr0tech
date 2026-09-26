"use client";

import { useEffect, useState } from "react";
import type { IdentityResult, InvestorActivity, Snapshot } from "@/lib/investor/types";
import { assertScope, transactionUrl, validateSnapshot } from "@/lib/investor/transactions";
import type { InvestorState } from "./useInvestor";
import { TradePanel } from "./TradePanel";

export function AccountPanel({
  state,
  onBroadcast,
}: {
  state: InvestorState;
  onBroadcast: (hash: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activity, setActivity] = useState<InvestorActivity | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<IdentityResult | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityError, setIdentityError] = useState("");
  const { session, fund } = state;
  async function refresh() {
    if (!session || !fund) return;
    const op = state.begin();
    setBusy(true);
    setSnapshotError("");
    setActivityError("");
    const [account, history] = await Promise.allSettled([
      state.client.me(session, op.signal),
      state.client.activity(session, op.signal),
    ]);
    if (op.current()) {
      try {
        if (account.status === "rejected") throw account.reason;
        setSnapshot(validateSnapshot(account.value, session, fund));
      } catch (error) {
        setSnapshotError((error as Error).message);
        state.report(error);
      }
      try {
        if (history.status === "rejected") throw history.reason;
        assertScope(history.value, session, fund);
        if (!["rpc", "unavailable"].includes(history.value.source) || !Array.isArray(history.value.events))
          throw new Error("The activity endpoint returned an unsupported response.");
        for (const event of history.value.events) assertScope(event, session, fund);
        setActivity(history.value);
      } catch (error) {
        setActivityError((error as Error).message);
        state.report(error);
      }
      setBusy(false);
    }
    op.finish();
  }
  useEffect(() => {
    void refresh(); /* each accepted session mounts a new account view */
  }, []);
  async function attest() {
    if (!session || identityBusy || !snapshot?.capabilities.identityAttestation) return;
    const op = state.begin();
    setIdentityBusy(true);
    setIdentityError("");
    try {
      const result = await state.client.identity(session, op.signal);
      if (!op.current()) return;
      if (!["confirmed", "pending", "refused", "already-attested"].includes(result.status))
        throw new Error("The gateway has not returned a recognized identity attestation outcome.");
      if (
        result.status === "confirmed" &&
        (!result.identityVerified ||
          !result.txHash ||
          !transactionUrl(result.txHash) ||
          result.receipt?.transactionHash.toLowerCase() !== result.txHash.toLowerCase() ||
          result.receipt.status !== 1)
      )
        throw new Error(
          "A confirmed identity receipt was not returned. Refresh eligibility before retrying."
        );
      setIdentity(result);
      if (result.txHash) onBroadcast(result.txHash);
      await refresh();
    } catch (error) {
      if (op.current()) {
        setIdentityError((error as Error).message);
        state.report(error);
      }
    } finally {
      if (op.current()) setIdentityBusy(false);
      op.finish();
    }
  }
  const sourceLabel = activity?.source === "rpc" ? "RPC logs" : "Activity unavailable";
  return (
    <>
      <section className="iv-session">
        <div>
          <span className="iv-kicker">INVESTOR SESSION · {session?.session.environment}</span>
          <strong>Signed in—not automatically admitted</strong>
          <p>
            Only this wallet and fund policy are in scope. No issuer role, operator key, funding or deployment
            permission is granted.
          </p>
        </div>
        <div>
          <span>Session expires {session && new Date(session.expiresAt * 1000).toLocaleTimeString()}</span>
          <button disabled={busy} onClick={refresh}>
            {busy ? "Refreshing reads…" : "Refresh balances & eligibility"}
          </button>
          <button
            onClick={() =>
              state.invalidate(
                "Signed out. The investor token was cleared from memory; already-broadcast transactions are not cancelled."
              )
            }
          >
            Sign out
          </button>
        </div>
      </section>
      {snapshotError && (
        <p className="iv-notice iv-error" role="alert">
          {snapshotError} Any displayed values are from the last successful read. Transaction preparation is
          disabled until refresh succeeds.
        </p>
      )}
      {!snapshot && !snapshotError && (
        <p role="status">Reading this wallet’s balances and policy from the gateway…</p>
      )}
      {snapshot && (
        <>
          <section className="iv-balances" aria-label="Actual reported balances">
            {[snapshot.balances.asset, snapshot.balances.token, snapshot.balances.native].map(
              (asset, index) => (
                <article className="iv-card" key={index}>
                  <span>
                    {index === 2 ? "Gas balance" : index === 0 ? "Test settlement asset" : "Fund shares"}
                  </span>
                  <strong>
                    {asset.balance} <small>{asset.symbol}</small>
                  </strong>
                  <p>Read at block {snapshot.blockNumber}</p>
                  {"allowance" in asset && typeof asset.allowance === "string" && (
                    <p className="iv-note">
                      Router allowance: {asset.allowance} {asset.symbol}
                    </p>
                  )}
                </article>
              )
            )}
          </section>
          <div className="iv-columns">
            <section className="iv-card" aria-labelledby="investor-eligibility">
              <div className="iv-card-heading">
                <span className="iv-kicker">03 / ON-CHAIN ELIGIBILITY</span>
                <h2 id="investor-eligibility">The policy still decides</h2>
                <p>
                  Your Passport proof authenticates this session. Attesting it adds only the identity fact;
                  KYC, AML, sanctions and issuer authorization remain separate.
                </p>
              </div>
              <div className="iv-actions">
                <button
                  className="iv-primary"
                  disabled={
                    identityBusy || busy || !!snapshotError || !snapshot.capabilities.identityAttestation
                  }
                  onClick={attest}
                >
                  {identityBusy
                    ? "Waiting for identity receipt…"
                    : identity?.status === "pending"
                      ? "Check pending identity receipt"
                      : "Attest my verified identity fact"}
                </button>
              </div>
              <p className="iv-note">
                This explicit request uses the issuer’s bounded identity-attestation service. It does not sign
                or send a swap and cannot approve your KYC/AML.
              </p>
              {identity && (
                <div className={`iv-notice ${identity.status === "refused" ? "iv-error" : ""}`} role="status">
                  <strong>
                    {identity.status === "confirmed"
                      ? "Identity attestation confirmed by backend receipt"
                      : identity.status === "already-attested"
                        ? "Existing identity fact reported · no new transaction"
                        : identity.status === "pending"
                          ? "Identity attestation pending · no admission claimed"
                          : "Identity attestation refused"}
                  </strong>
                  <p>
                    {identity.reason ??
                      (identity.status === "confirmed"
                        ? "Mined, not finalized. Eligibility was re-read below; other requirements may still block you."
                        : "Review the refreshed policy decisions below.")}
                  </p>
                  {identity.expiresAt && (
                    <p>Fact expires {new Date(identity.expiresAt * 1000).toLocaleString()}</p>
                  )}
                  {identity.txHash && transactionUrl(identity.txHash) && (
                    <a href={transactionUrl(identity.txHash)!} target="_blank" rel="noreferrer">
                      Identity transaction ↗
                    </a>
                  )}
                </div>
              )}
              {identityError && (
                <p className="iv-notice iv-error" role="alert">
                  {identityError}
                </p>
              )}
              <div className="iv-policy-decisions">
                {Object.entries(snapshot.policy).map(([action, decision]) => (
                  <article key={action}>
                    <div>
                      <strong>
                        {action === "mint"
                          ? "Issue shares"
                          : action === "burn"
                            ? "Redeem shares"
                            : "Transfer"}
                      </strong>
                      <span className="iv-tag">{decision.allowed ? "Policy allows" : "Blocked"}</span>
                    </div>
                    {decision.clause ? (
                      <blockquote>
                        <strong>{decision.clause.clause}</strong>
                        {decision.clause.quote}
                      </blockquote>
                    ) : (
                      <p>
                        {decision.reason ??
                          (decision.allowed
                            ? "The current policy decision allows this action; execution has additional balance, gas and venue checks."
                            : "No matching permission or clause was returned.")}
                      </p>
                    )}
                  </article>
                ))}
              </div>
              <p className="iv-privacy">
                Wallet, policy hash and attested facts are public on-chain. Raw passport data is not uploaded
                by this dashboard. The gateway stores a nullifier binding; this is not anonymous to the
                operator.
              </p>
            </section>
            <section className="iv-card">
              <div className="iv-card-heading">
                <span className="iv-kicker">REPORTED VENUE STATE</span>
                <h2>Terms & reserves</h2>
              </div>
              {snapshot.cashier ? (
                <>
                  <dl>
                    <dt>Fixed demo NAV</dt>
                    <dd>
                      {snapshot.cashier.nav} {snapshot.balances.asset.symbol} / share
                    </dd>
                    <dt>Subscription / redemption fees</dt>
                    <dd>
                      {snapshot.cashier.subscriptionFeeBps} / {snapshot.cashier.redemptionFeeBps} bps
                    </dd>
                    <dt>Available reserve</dt>
                    <dd>
                      {snapshot.cashier.reserve} {snapshot.balances.asset.symbol}
                    </dd>
                    <dt>Supply / cap</dt>
                    <dd>
                      {snapshot.cashier.totalSupply} / {snapshot.cashier.maxSupply} shares
                    </dd>
                    <dt>Cashier state</dt>
                    <dd>
                      {snapshot.cashier.paused ? "Paused" : "Not paused"} · mint{" "}
                      {snapshot.cashier.mintEnabled ? "enabled" : "disabled"} · burn{" "}
                      {snapshot.cashier.burnEnabled ? "enabled" : "disabled"}
                    </dd>
                    <dt>Terms hash</dt>
                    <dd>
                      <code>{snapshot.cashier.termsHash}</code>
                    </dd>
                  </dl>
                  <p className="iv-notice">{snapshot.cashier.limitations}</p>
                </>
              ) : (
                <p className="iv-notice">
                  {snapshot.disabledReason ??
                    "No bounded cashier is reported. Ask the issuer to publish a cashier-enabled contract; this legacy fund is read-only."}
                </p>
              )}
              <details>
                <summary>Bound contracts · Sepolia</summary>
                <dl>
                  {Object.entries(snapshot.addresses).map(([name, address]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>
                        <code>{address}</code>
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </section>
          </div>
        </>
      )}
      <TradePanel
        state={state}
        snapshot={snapshotError ? null : snapshot}
        onRefresh={refresh}
        onBroadcast={onBroadcast}
      />
      <section className="iv-card iv-activity">
        <div className="iv-card-heading">
          <span className="iv-kicker">WALLET + FUND SCOPED ACTIVITY</span>
          <h2>{sourceLabel}</h2>
        </div>
        {activityError && (
          <p className="iv-notice iv-error" role="alert">
            {activityError}
          </p>
        )}
        {activity && (
          <>
            <p className="iv-note">
              {activity.source === "rpc"
                ? "Recent RPC logs are shown. This is not a full history."
                : "No activity source is currently available; no empty-history claim is made."}{" "}
              Indexer: {activity.indexer.status}. {activity.notice}
            </p>
            {activity.events.length ? (
              <ol>
                {activity.events.map((event) => (
                  <li key={`${event.txHash}:${event.logIndex}:${event.contract}`}>
                    <div>
                      <strong>{event.event}</strong>
                      <span>Block {event.blockNumber}</span>
                    </div>
                    <p>
                      {event.amount !== undefined
                        ? `Amount: ${event.amount}`
                        : event.amountOut !== undefined
                          ? `Input ${event.amountIn} → output ${event.amountOut}${event.route ? ` · ${event.route}` : ""}`
                          : "Scoped policy/contract event"}
                    </p>
                    {transactionUrl(event.txHash) && (
                      <a href={transactionUrl(event.txHash)!} target="_blank" rel="noreferrer">
                        {event.txHash} ↗
                      </a>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p>
                No events in this bounded response. Indexing may be empty or delayed; use the RPC receipt
                above to check a broadcast.
              </p>
            )}
          </>
        )}
        {!activity && !activityError && <p role="status">Loading scoped activity…</p>}
      </section>
    </>
  );
}
