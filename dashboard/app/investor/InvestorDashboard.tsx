"use client";

import Link from "next/link";
import { useState } from "react";
import { INVESTOR_API, SEPOLIA } from "@/lib/investor/types";
import { transactionUrl } from "@/lib/investor/transactions";
import { useInvestor } from "./useInvestor";
import { AuthPanel } from "./AuthPanel";
import { AccountPanel } from "./AccountPanel";

export function InvestorDashboard() {
  const state = useInvestor();
  const [lastBroadcast, setLastBroadcast] = useState<string | null>(null);
  const world = state.config?.mock
    ? "Mock verifier · not for Sepolia login"
    : state.config?.environment === "sandbox"
      ? "World Sandbox"
      : state.config?.environment
        ? `World ${state.config.environment}`
        : "World configuration pending";
  return (
    <div className="iv-root">
      <a className="iv-skip" href="#investor-main">
        Skip to investor dashboard
      </a>
      <header className="iv-header">
        <Link href="/" className="iv-brand" aria-label="Mirr0rtech issuer workbench">
          <svg width="29" height="29" viewBox="0 0 30 30" fill="none" aria-hidden="true">
            <path
              d="M3 24V6l12 12L27 6v18M9 24V15l6 6 6-6v9"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinejoin="round"
            />
          </svg>
          <strong>
            Mirr0rtech<span> / Investor</span>
          </strong>
        </Link>
        <nav aria-label="Investor navigation">
          <Link href="/">Issuer workbench ↗</Link>
          <button onClick={state.refreshPublic} disabled={state.loading}>
            {state.loading ? "Loading public funds…" : "Refresh public funds"}
          </button>
        </nav>
      </header>
      <main id="investor-main">
        <div className="iv-hero">
          <div>
            <div className="iv-environment">
              <span>{world}</span>
              <span>Sepolia · test assets only</span>
            </div>
            <h1>
              Your identity opens a session.
              <br />
              The agreement governs access.
            </h1>
            <p>
              Use World Passport, inspect your eligibility, then sign an exact-amount approval and bounded
              swap with your own Sepolia wallet.
            </p>
          </div>
          <aside>
            <span className="iv-kicker">NO OPERATOR KEY REQUIRED</span>
            <p>
              Investor sessions are wallet- and fund-scoped. They do not unlock private agreements or issuer
              controls.
            </p>
            <code>{INVESTOR_API}</code>
          </aside>
        </div>
        <ol className="iv-trust-steps" aria-label="Investor trust flow">
          <li>
            <span>01</span>
            <div>
              <strong>Wallet</strong>
              <small>Connect an injected Sepolia wallet</small>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>World proof</strong>
              <small>Server-verified Passport sign-in</small>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Eligibility</strong>
              <small>Separate on-chain policy gates</small>
            </div>
          </li>
          <li>
            <span>04</span>
            <div>
              <strong>Wallet-signed swap</strong>
              <small>RPC receipt, then indexed activity</small>
            </div>
          </li>
        </ol>
        {state.notice && (
          <div className="iv-notice iv-error" role="alert">
            <span>{state.notice}</span>
            <button aria-label="Dismiss investor message" onClick={state.clearNotice}>
              Dismiss
            </button>
          </div>
        )}
        {state.publicError && (
          <div className="iv-notice iv-error" role="alert">
            <strong>Investor gateway unavailable</strong>
            <p>{state.publicError}</p>
            <button onClick={state.refreshPublic}>Retry public investor API</button>
          </div>
        )}
        {lastBroadcast && !state.ready && (
          <div className="iv-notice">
            <strong>A wallet transaction was broadcast in this tab.</strong>
            <p>
              Signing out or changing wallets does not cancel it. Check its chain receipt before submitting
              anything again.
            </p>
            <a href={transactionUrl(lastBroadcast)!} target="_blank" rel="noreferrer">
              Inspect last broadcast on Sepolia ↗
            </a>
          </div>
        )}
        <section className="iv-selection">
          <div>
            <span className="iv-kicker">PUBLIC FUNDS</span>
            <label htmlFor="investor-fund">Choose an agreement-backed fund</label>
            <select
              id="investor-fund"
              value={state.fund?.id ?? ""}
              disabled={state.loading || !state.funds.length}
              onChange={(event) => state.selectFund(event.target.value)}
            >
              {!state.funds.length && (
                <option value="">{state.loading ? "Loading funds…" : "No published funds"}</option>
              )}
              {state.funds.map((fund) => (
                <option key={fund.id} value={fund.id}>
                  {fund.name}
                  {fund.cashier ? "" : " · read-only legacy fund"}
                </option>
              ))}
            </select>
            {state.fund && (
              <p className="iv-note">
                {state.fund.symbol ?? "Fund shares"} · chain {state.fund.chainId} · policy{" "}
                <code>{state.fund.policyHash}</code>
              </p>
            )}
          </div>
          <div className="iv-wallet">
            <span className="iv-kicker">01 / YOUR BROWSER WALLET</span>
            {state.wallet ? (
              <>
                <code>{state.wallet.address}</code>
                <span>
                  {state.wallet.chainId === SEPOLIA
                    ? "Connected to Sepolia"
                    : `Wrong chain: ${state.wallet.chainId}`}
                </span>
                {state.wallet.chainId !== SEPOLIA && (
                  <button
                    className="iv-primary"
                    disabled={state.connecting}
                    onClick={() => state.connect(true)}
                  >
                    Switch wallet to Sepolia
                  </button>
                )}
              </>
            ) : (
              <>
                <p>World Passport is a credential—not a Sepolia transaction signer.</p>
                <button className="iv-primary" disabled={state.connecting} onClick={() => state.connect()}>
                  {state.connecting ? "Waiting for wallet…" : "Connect Sepolia wallet"}
                </button>
              </>
            )}
            <small>
              Use an EIP-1193 browser wallet. World MiniKit sendTransaction does not support this Sepolia
              flow.
            </small>
          </div>
        </section>
        {!state.loading && !state.publicError && !state.funds.length && (
          <section className="iv-card iv-empty">
            <h2>No public investor fund is published yet</h2>
            <p>
              The API can be healthy before a cashier-enabled agreement is published. Ask the issuer to
              publish the bounded cashier deployment; no operator key or arbitrary contract address is
              accepted on this page.
            </p>
          </section>
        )}
        {state.fund &&
          (state.ready ? (
            <AccountPanel
              key={`${state.revision}:${state.session!.expiresAt}:${state.fund.id}`}
              state={state}
              onBroadcast={setLastBroadcast}
            />
          ) : (
            <AuthPanel key={`${state.revision}:${state.fund.id}`} state={state} />
          ))}
        <section className="iv-disclosure">
          <h2>Testnet boundaries</h2>
          <p>
            mockUSD and these shares are test assets, not real fiat or a claim on production reserves. The
            Passport credential does not complete KYC/AML, sanctions checks or accreditation. Login and
            identity attestation never guarantee permission to trade.
          </p>
          <p>
            World Sandbox requires an eligible Passport credential in the correct World environment. This
            frontend does not claim that a live Passport simulator test has been completed, require an
            additional Orb credential, or fabricate a signing wallet.
          </p>
        </section>
      </main>
      <footer className="iv-footer">
        <span>Session tokens stay in memory only · reload or sign out to clear</span>
        <span>Execution receipts: RPC · activity indexing: Curvegrid when configured</span>
      </footer>
    </div>
  );
}
