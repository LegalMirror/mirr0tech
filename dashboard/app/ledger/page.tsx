"use client";

import { fetchLedger, shares, type Ledger } from "@/lib/ledger";
import { short } from "@/lib/format";
import { useResource } from "@/lib/hooks";
import { Failed, Glyph, Loading, PageHead } from "../_components/common";

const ETHERSCAN = "https://sepolia.etherscan.io";
const CALLBACK_LABEL: Record<string, string> = {
  beforeAddLiquidity: "Add liquidity",
  beforeRemoveLiquidity: "Remove liquidity",
  beforeSwap: "Swap",
};

function Boundaries({ ledger }: { ledger: Ledger }) {
  const { boundaries: b } = ledger;
  return (
    <section className="card">
      <h2>What the hook guards</h2>
      <p className="meta">
        Pool <code>{short(b.poolId, 10, 6)}</code> · fee {b.poolKey.fee / 10000}% · tick spacing {b.poolKey.tickSpacing} · hook{" "}
        <a href={`${ETHERSCAN}/address/${b.hook}`} target="_blank" rel="noreferrer">
          {short(b.hook)} ↗
        </a>
      </p>
      <p className="actions-line">
        {Object.entries(b.callbacks).map(([name, on]) => (
          <span key={name}>
            <Glyph state={on ? "true" : "unknown"} /> {CALLBACK_LABEL[name] ?? name}
          </span>
        ))}
      </p>
      <p className="small">Every one of these asks the agreement first. A wallet enters the pool only if these clauses allow it:</p>
      <ul className="plain-list">
        {b.transferClauses.map((clause) => (
          <li key={clause.clauseId}>
            <strong>
              §{clause.clauseId} {clause.effect}
            </strong>{" "}
            <span className="meta">{clause.clause}</span>
            <div className="small">“{clause.quote}”</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Decisions({ ledger }: { ledger: Ledger }) {
  return (
    <section className="card">
      <h2>Decisions indexed on chain</h2>
      <p className="meta">
        {ledger.byClause.map((entry) => (
          <span key={String(entry.clauseId)} style={{ marginRight: 12 }}>
            {entry.ruleId ?? "admitted"}: {entry.allowed} allowed · {entry.refused} refused
          </span>
        ))}
      </p>
      {ledger.decisions.length === 0 ? (
        <p className="small">No hook decisions indexed yet. Indexing starts when a contract is linked.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Wallet</th>
                <th>Action</th>
                <th>Decision</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {ledger.decisions.map((d) => (
                <tr key={d.tx + d.subject}>
                  <td className="small">{d.at}</td>
                  <td className="small">{short(d.subject)}</td>
                  <td className="small">{d.action}</td>
                  <td className="small">
                    <Glyph state={d.allowed ? "true" : "false"} /> {d.allowed ? "allowed" : `refused · ${d.clause?.ruleId ?? `§${d.clauseId}`}`}
                  </td>
                  <td className="small">
                    <a href={`${ETHERSCAN}/tx/${d.tx}`} target="_blank" rel="noreferrer">
                      {short(d.tx)} ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="meta">A refused swap reverts before a transaction exists, so refusals appear here only when a decision is recorded; the gateway's history has the rest.</p>
    </section>
  );
}

function Supply({ ledger }: { ledger: Ledger }) {
  return (
    <section className="card">
      <h2>Supply and attestations</h2>
      <p>
        <strong>{shares(ledger.supply.minted)}</strong> shares minted · <strong>{shares(ledger.supply.burned)}</strong> redeemed{" "}
        <span className="meta">(summed by the MultiBaas query language)</span>
      </p>
      <ul className="plain-list">
        {ledger.attestations.slice(0, 8).map((a) => (
          <li key={a.tx + a.subject} className="small">
            {a.at} · facts attested for {short(a.subject)} · valid until {new Date(a.expiresAt * 1000).toISOString().slice(0, 10)} ·{" "}
            <a href={`${ETHERSCAN}/tx/${a.tx}`} target="_blank" rel="noreferrer">
              tx ↗
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The agreement's policy as the chain recorded it, indexed by Curvegrid MultiBaas. */
export default function LedgerPage() {
  const ledger = useResource(() => fetchLedger(), []);
  return (
    <>
      <PageHead title="Policy ledger">
        What the agreement allowed and refused, read from chain events that Curvegrid MultiBaas indexes: the hook&apos;s decisions,
        the attestations behind them, and the shares issued.
      </PageHead>
      {ledger.error && <Failed error={ledger.error} />}
      {!ledger.data && !ledger.error && <Loading what="the indexed ledger" />}
      {ledger.data && (
        <>
          <p className="meta">
            Agreement {ledger.data.agreement} · policy {short(ledger.data.policyHash, 10, 6)} · indexed{" "}
            {ledger.data.contracts.map((c) => c.alias).join(", ")} · {ledger.data.cached ? "cached" : "fresh"} at {ledger.data.fetchedAt}
          </p>
          <Boundaries ledger={ledger.data} />
          <Decisions ledger={ledger.data} />
          <Supply ledger={ledger.data} />
        </>
      )}
    </>
  );
}
