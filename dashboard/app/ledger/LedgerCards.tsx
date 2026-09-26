import { shares, type Ledger } from "@/lib/ledger";
import { fmtTime, short } from "@/lib/format";
import { BoundaryDiagram, ClauseBars, DecisionTimeline } from "./LedgerVisuals";
import { Glyph } from "../_components/common";

const ETHERSCAN = "https://sepolia.etherscan.io";
const CALLBACK_LABEL: Record<string, string> = {
  beforeAddLiquidity: "Add liquidity",
  beforeRemoveLiquidity: "Remove liquidity",
  beforeSwap: "Swap",
};

export function Boundaries({ ledger }: { ledger: Ledger }) {
  const { boundaries: b } = ledger;
  return (
    <section className="card">
      <h2>What the hook guards</h2>
      <BoundaryDiagram ledger={ledger} />
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

export function Decisions({ ledger }: { ledger: Ledger }) {
  return (
    <section className="card">
      <h2>Decisions</h2>
      <ClauseBars ledger={ledger} />
      <DecisionTimeline ledger={ledger} />
      {ledger.decisions.length === 0 ? (
        <p className="small">No hook decisions indexed yet. Indexing starts when a contract is linked.</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Wallet</th>
                <th>Venue</th>
                <th>Decision</th>
                <th>Where recorded</th>
              </tr>
            </thead>
            <tbody>
              {ledger.decisions.map((d, index) => (
                <tr key={`${d.at}-${d.subject}-${index}`}>
                  <td className="small">{fmtTime(d.at)}</td>
                  <td className="small">{d.subject.startsWith("0x") ? short(d.subject) : d.subject}</td>
                  <td className="small">{d.venue ?? d.action}</td>
                  <td className="small">
                    <Glyph state={d.allowed ? "true" : "false"} /> {d.allowed ? "allowed" : `refused · ${d.clause?.ruleId ?? `§${d.clauseId}`}`}
                  </td>
                  <td className="small">
                    {d.tx ? (
                      <a href={`${ETHERSCAN}/tx/${d.tx}`} target="_blank" rel="noreferrer">
                        on chain · {short(d.tx)} ↗
                      </a>
                    ) : (
                      <span className="meta">no transaction · gateway audit</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Supply({ ledger }: { ledger: Ledger }) {
  return (
    <section className="card">
      <h2>Supply and attestations</h2>
      <p>
        <strong>{shares(ledger.supply.minted)}</strong> shares minted · <strong>{shares(ledger.supply.burned)}</strong> redeemed
      </p>
      <ul className="plain-list">
        {ledger.attestations.slice(0, 8).map((a) => (
          <li key={a.tx + a.subject} className="small">
            {fmtTime(a.at)} · facts attested for {short(a.subject)} · valid until {new Date(a.expiresAt * 1000).toISOString().slice(0, 10)} ·{" "}
            <a href={`${ETHERSCAN}/tx/${a.tx}`} target="_blank" rel="noreferrer">
              tx ↗
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

