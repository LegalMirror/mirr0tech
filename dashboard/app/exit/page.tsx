"use client";

import { useState } from "react";
import { explain } from "@/lib/evaluate";
import { fromMicro, short } from "@/lib/format";
import { effectiveFacts } from "@/lib/parties";
import type { Party, PolicyData } from "@/lib/types";
import { auctionCurve, auctionPrice } from "@/lib/auction";
import { instructionLabel, termLabel } from "@/lib/labels";
import {
  ClauseTableBadge,
  Disclosure,
  Failed,
  Hash,
  Loading,
  PageHead,
  Refusal,
  Glyph,
} from "../_components/common";
import { usePolicyAndParties } from "../_components/usePageData";
import { useProfile } from "../providers";

type QuoteResult =
  | { ok: true; amountOut: string }
  | { ok: false; subject: Party; clauseId: number }
  | { ok: false; deadline: true };

const MICRO = 1_000_000n;

/** PolicyGuard evaluates the maker, then the taker, against the transfer program; then the rate applies. */
function quote(policy: PolicyData, maker: Party, taker: Party, amountIn: bigint, price: string): QuoteResult {
  const buyback = policy.buyback;
  if (!buyback?.available) throw new Error("No buyback strategy in this policy");
  if (Date.now() / 1000 > buyback.terms.deadlineTimestamp) return { ok: false, deadline: true };
  for (const subject of [maker, taker]) {
    const decision = explain(policy, "transfer", effectiveFacts(policy, subject)).onchain;
    if (!decision.allowed) return { ok: false, subject, clauseId: decision.clauseId };
  }
  const priceMicro = BigInt(Math.round(Number(price) * 1_000_000));
  return { ok: true, amountOut: String((amountIn * priceMicro) / MICRO) };
}

/** The tender offer's price path over the window, with the moment the reader picked. */
function PriceCurve({
  floor,
  ceiling,
  windowHours,
  at,
}: {
  floor: number;
  ceiling: number;
  windowHours: number;
  at: number;
}) {
  const W = 320;
  const H = 72;
  const pad = 6;
  const y = (p: number) => H - pad - ((p - floor) / (ceiling - floor)) * (H - 2 * pad);
  const x = (h: number) => pad + (h / windowHours) * (W - 2 * pad);
  const points = auctionCurve(floor, ceiling, windowHours)
    .map(([h, p]) => `${x(h).toFixed(1)},${y(p).toFixed(1)}`)
    .join(" ");
  const now = auctionPrice(floor, ceiling, windowHours, at);
  return (
    <figure className="curve" aria-label={`price from ${floor} to ${ceiling} over ${windowHours} hours`}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
        <polyline points={points} fill="none" stroke="var(--permit)" strokeWidth={2} />
        <circle cx={x(at)} cy={y(now)} r={4} fill="var(--flame)" />
      </svg>
      <figcaption className="meta">
        {floor.toFixed(2)} at open → {ceiling.toFixed(2)} at hour {windowHours} · now {now.toFixed(4)} after{" "}
        {at} h
      </figcaption>
    </figure>
  );
}

function Buyback({ policy, parties }: { policy: PolicyData; parties: Party[] }) {
  const buyback = policy.buyback;
  const maker = parties.find((party) => party.role === "borrower");
  const takers = parties.filter((party) => party.role !== "borrower");
  const [takerId, setTakerId] = useState(takers[0]?.id ?? "");
  const [amount, setAmount] = useState("10000");
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [fills, setFills] = useState<{ taker: string; amountIn: string; amountOut: string }[]>([]);
  const [mode, setMode] = useState<"bid" | "tender">("bid");
  const [hours, setHours] = useState(0);
  if (!buyback) return <p className="muted">This policy carries no buyback terms.</p>;
  if (!buyback.available)
    return (
      <section className="card">
        <h2>Buyback program unavailable</h2>
        <p className="muted">{buyback.reason}</p>
      </section>
    );
  const taker = takers.find((party) => party.id === takerId);
  const amountIn = /^\d{1,12}(\.\d{1,6})?$/.test(amount)
    ? BigInt(Math.round(Number(amount) * 1_000_000))
    : null;
  const termOf = (name: string) => policy.terms.find((term) => term.name === name);
  const tender = mode === "tender" && buyback.auction ? buyback.auction : null;
  const windowHours = tender ? Number(tender.windowHours) : 0;
  const price = tender
    ? auctionPrice(Number(buyback.terms.price), Number(tender.ceiling), windowHours, hours).toFixed(4)
    : buyback.terms.price;
  const shown = tender ?? buyback;
  const refused = result && !result.ok && "subject" in result ? result : null;

  return (
    <>
      <section className="card">
        <div className="eyebrow">
          {tender ? "Tender offer" : "Standing buyback"} · Aqua strategy · maker {maker?.name ?? "borrower"}
        </div>
        {buyback.auction && (
          <div
            className="cov-filters"
            role="radiogroup"
            aria-label="Buyback shape"
            style={{ margin: "6px 0" }}
          >
            {(["bid", "tender"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                className={`cov-filter ${mode === value ? "on" : ""}`}
                onClick={() => setMode(value)}
              >
                {value === "bid" ? "Standing bid" : "Tender offer"}
              </button>
            ))}
          </div>
        )}
        <h2 style={{ marginTop: 4 }}>
          {tender
            ? `Buy position tokens from ${buyback.terms.price} improving to ${tender.ceiling} over ${tender.windowHours} hours, up to ${Number(buyback.terms.cap).toLocaleString()}, until ${buyback.terms.deadline}`
            : `Buy position tokens at ${buyback.terms.price}, up to ${Number(buyback.terms.cap).toLocaleString()}, until ${buyback.terms.deadline}`}
        </h2>
        {tender && (
          <PriceCurve
            floor={Number(buyback.terms.price)}
            ceiling={Number(tender.ceiling)}
            windowHours={windowHours}
            at={hours}
          />
        )}
        <div className="grid-2" style={{ marginTop: 12 }}>
          {(tender
            ? ["buybackPrice", "buybackCeiling", "buybackWindowHours", "buybackCap", "buybackDeadline"]
            : ["buybackPrice", "buybackCap", "buybackDeadline"]
          ).map((name) => {
            const term = termOf(name);
            return term ? (
              <div key={name} className="venue">
                <span className="small muted">
                  {term.source.clause} · {termLabel(name)}
                </span>
                <span className="term-val">
                  {term.value} <small className="muted">{term.unit}</small>
                </span>
                <span className="small muted">“{term.source.quote}”</span>
              </div>
            ) : null;
          })}
        </div>
        <p className="small muted">
          Shipping records a virtual balance only: {fromMicro(buyback.terms.capAsset)} of the asset stays in
          the borrower wallet until a fill pulls it.
        </p>
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>What the venue checks on every trade</h2>
          <p className="small muted">The program the borrower posted, one instruction at a time.</p>
          <ol className="program">
            {shown.instructions.map((ins) => (
              <li key={ins.name} className={ins.name.startsWith("PolicyGuard") ? "guard" : ""}>
                <span title={`${ins.name} · opcode ${ins.opcode}`}>
                  <span className="ins-name">{instructionLabel(ins.name)}</span>
                  <span className="ins-plain">{plainInstruction(ins, buyback.terms, policy)}</span>
                </span>
                <details className="disc" style={{ gridColumn: 2 }}>
                  <summary>
                    <span className="meta">technical</span>
                  </summary>
                  <p className="meta">
                    {ins.name} · opcode {ins.opcode} · from {ins.source}
                  </p>
                  {Object.keys(ins.args).length > 0 && (
                    <dl className="ins-args">
                      {Object.entries(ins.args).map(([key, value]) => (
                        <div key={key} style={{ display: "contents" }}>
                          <dt>{key}</dt>
                          <dd>{value.startsWith("0x") ? short(value, 10, 6) : value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <code className="small muted" style={{ overflowWrap: "anywhere" }}>
                    {short(ins.bytes, 18, 8)}
                  </code>
                </details>
              </li>
            ))}
          </ol>
          <Disclosure title="Provenance" summary="document ⊂ policy ⊂ program ⊂ strategy">
            <div className="chain">
              <Hash label="document" value={policy.source.sha256} />
              <span className="hash-arrow">⊂</span>
              <Hash label="policyHash" value={policy.policyHash} />
              <span className="hash-arrow">⊂</span>
              <Hash label={`program · ${(buyback.program.length - 2) / 2} bytes`} value={buyback.program} />
              <span className="hash-arrow">⊂</span>
              <Hash label="strategyHash" value={buyback.strategyHash} />
            </div>
            <p className="small muted">
              Token and maker addresses are placeholders until deployment, so this strategy hash is
              illustrative; the policy hash inside the program is the real one.
            </p>
          </Disclosure>
        </section>

        <section className="card">
          <h2>Try a quote</h2>
          <p className="small muted">
            Ask for a price as any wallet. A wallet the contract refuses is refused before any transaction is
            sent.
          </p>
          <label>
            Taker
            <br />
            <select value={takerId} onChange={(e) => setTakerId(e.target.value)}>
              {takers.map((party) => (
                <option key={party.id} value={party.id}>
                  {party.name}
                </option>
              ))}
            </select>
          </label>
          {tender && (
            <label>
              Hours since the offer opened: {hours}
              <br />
              <input
                type="range"
                min={0}
                max={windowHours}
                step={0.5}
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              />
            </label>
          )}
          <label>
            Position tokens in
            <br />
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <div className="row">
            <button
              className="primary"
              disabled={!taker || !maker || amountIn === null}
              onClick={() => setResult(quote(policy, maker!, taker!, amountIn!, price))}
            >
              Quote
            </button>
            <button
              disabled={!result?.ok}
              onClick={() => {
                if (result?.ok && taker)
                  setFills([
                    { taker: taker.name, amountIn: amount, amountOut: fromMicro(result.amountOut) },
                    ...fills,
                  ]);
              }}
            >
              Fill
            </button>
          </div>
          {result?.ok && (
            <div className="verdict verdict-approve">
              <span className="verdict-head">
                ✓ {amount} position tokens → {fromMicro(result.amountOut)} asset
              </span>
              <span className="small muted">
                Both sides passed the contract · price {price}
                {tender ? ` after ${hours} h` : ""}
              </span>
            </div>
          )}
          {result && !result.ok && "deadline" in result && (
            <div className="verdict verdict-deny">
              <span className="verdict-head">✕ the addendum's offer has expired</span>
            </div>
          )}
          {refused && (
            <div className="verdict verdict-deny">
              <span
                className="verdict-head"
                title={`CounterpartyRefused(${refused.subject.address}, ${refused.clauseId}, ${policy.policyHash})`}
              >
                ✕ refused before any transaction
              </span>
              <span className="small">
                {refused.subject.role === "borrower" ? "The maker" : "The taker"} was refused by{" "}
                <Refusal policy={policy} action="transfer" clauseId={refused.clauseId} />
              </span>
              <ClauseTableBadge policy={policy} />
            </div>
          )}
          {fills.length > 0 && (
            <>
              <h3>Fills this session</h3>
              <ul className="trace">
                {fills.map((fill, index) => (
                  <li key={index}>
                    <span className="chip chip-ok">fill</span> {fill.taker}: {fill.amountIn} →{" "}
                    {fill.amountOut}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function HookCard({ policy, parties }: { policy: PolicyData; parties: Party[] }) {
  const transferRules = policy.rules.filter((rule) => rule.action === "transfer");
  return (
    <section className="card">
      <h2>The pool asks the contract first</h2>
      <p className="small muted">
        Every deposit into the pool, withdrawal from it and swap through it runs the contract for the wallet
        behind it. A pool opened without the hook is inert: its first settlement is refused by the token.
      </p>
      {transferRules.length === 0 && (
        <p className="small">
          This reading of the contract allows no transfers at all, so every pool operation is refused and the
          token itself refuses to move. The <strong>Trade on v4</strong> profile adds the transfer rules the
          hook enforces.
        </p>
      )}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Wallet</th>
              <th>Pool operation</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const decision = explain(policy, "transfer", effectiveFacts(policy, party)).onchain;
              return (
                <tr key={party.id}>
                  <td>{party.name}</td>
                  <td title={`hook.explain → (${String(decision.allowed)}, ${decision.clauseId})`}>
                    <Glyph state={decision.allowed ? "approve" : "deny"} />{" "}
                    {decision.allowed ? "Allowed" : "Blocked"}
                  </td>
                  <td>
                    {decision.allowed ? (
                      <span className="meta">passes the contract</span>
                    ) : (
                      <span
                        title={`revert LegalClauseViolation(${decision.clauseId}, ${short(policy.policyHash, 8, 4)})`}
                      >
                        <Refusal policy={policy} action="transfer" clauseId={decision.clauseId} />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** One line a reader can act on, per instruction of the buyback program. */
function plainInstruction(
  ins: { name: string; args: Record<string, string> },
  terms: { price: string; cap: string; deadline: string },
  policy: PolicyData
): string {
  if (ins.name.startsWith("Controls._deadline"))
    return `The offer closes on ${ins.args.date ?? terms.deadline}.`;
  if (ins.name.startsWith("PolicyGuard"))
    return `Maker and taker are both checked against this contract (policy ${short(policy.policyHash, 8, 4)}) on every quote and fill.`;
  if (ins.name.startsWith("FixedRateBalances"))
    return `${terms.price} per token, up to ${Number(terms.cap).toLocaleString()} tokens.`;
  if (ins.name.startsWith("DutchAuction"))
    return `The bid opens at ${ins.args.floor} and improves to ${ins.args.ceiling} over ${ins.args.windowHours} hours; the lender picks the moment.`;
  if (ins.name.startsWith("LimitSwap")) return "The taker's tokens are swapped at that price.";
  if (ins.name.startsWith("Invalidators")) return "Each fill counts against the cap; nothing beyond it.";
  return "";
}

export default function ExitPage() {
  const { profile, policy, parties } = usePolicyAndParties();
  const { setProfile } = useProfile();
  const error = policy.error ?? parties.error;
  const credit = profile === "wildcat-credit";
  return (
    <>
      <PageHead title={credit ? "How a lender exits" : "How the token trades"}>
        {credit
          ? "The borrower stands a bid for its own debt on 1inch Aqua; the contract is checked on every quote and fill."
          : "Anyone may open a pool, but only a pool that carries the contract's hook can take the token."}
      </PageHead>
      {error && <Failed error={error} />}
      {(!policy.data || !parties.data) && !error && <Loading what="venue" />}
      {policy.data &&
        parties.data &&
        (credit ? (
          <Buyback policy={policy.data} parties={parties.data} />
        ) : (
          <HookCard policy={policy.data} parties={parties.data} />
        ))}
      {!credit && (
        <p className="small muted">
          The lender exit lives in Act 2.{" "}
          <button className="linkish" onClick={() => setProfile("wildcat-credit")}>
            Switch to the loan
          </button>
        </p>
      )}
    </>
  );
}
