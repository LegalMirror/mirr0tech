"use client";

import { useState } from "react";
import { explain } from "@/lib/evaluate";
import { fromMicro, short } from "@/lib/format";
import { effectiveFacts } from "@/lib/parties";
import type { Party, PolicyData } from "@/lib/types";
import { ClauseTableBadge, Failed, Hash, Loading, PageHead } from "../_components/common";
import { usePolicyAndParties } from "../_components/usePageData";
import { useProfile } from "../providers";

type QuoteResult =
  | { ok: true; amountOut: string }
  | { ok: false; subject: Party; clauseId: number }
  | { ok: false; deadline: true };

const MICRO = 1_000_000n;

/** PolicyGuard evaluates the maker, then the taker, against the transfer program; then the rate applies. */
function quote(policy: PolicyData, maker: Party, taker: Party, amountIn: bigint): QuoteResult {
  const buyback = policy.buyback;
  if (!buyback?.available) throw new Error("No buyback strategy in this policy");
  if (Date.now() / 1000 > buyback.terms.deadlineTimestamp) return { ok: false, deadline: true };
  for (const subject of [maker, taker]) {
    const decision = explain(policy, "transfer", effectiveFacts(policy, subject)).onchain;
    if (!decision.allowed) return { ok: false, subject, clauseId: decision.clauseId };
  }
  const priceMicro = BigInt(Math.round(Number(buyback.terms.price) * 1_000_000));
  return { ok: true, amountOut: String((amountIn * priceMicro) / MICRO) };
}

function Buyback({ policy, parties }: { policy: PolicyData; parties: Party[] }) {
  const buyback = policy.buyback;
  const maker = parties.find((party) => party.role === "borrower");
  const takers = parties.filter((party) => party.role !== "borrower");
  const [takerId, setTakerId] = useState(takers[0]?.id ?? "");
  const [amount, setAmount] = useState("10000");
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [fills, setFills] = useState<{ taker: string; amountIn: string; amountOut: string }[]>([]);
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
  const refused = result && !result.ok && "subject" in result ? result : null;
  const refusedClause = refused
    ? policy.clauseTable.find((entry) => entry.clauseId === refused.clauseId)
    : null;

  return (
    <>
      <section className="card">
        <div className="eyebrow">Standing buyback · Aqua strategy · maker {maker?.name ?? "borrower"}</div>
        <h2 style={{ marginTop: 4 }}>
          Buy position tokens at {buyback.terms.price}, up to {Number(buyback.terms.cap).toLocaleString()},
          until {buyback.terms.deadline}
        </h2>
        <div className="grid-2" style={{ marginTop: 12 }}>
          {["buybackPrice", "buybackCap", "buybackDeadline"].map((name) => {
            const term = termOf(name);
            return term ? (
              <div key={name} className="venue">
                <span className="small muted">
                  {term.source.clause} · <code>{name}</code>
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
          <h2>Program</h2>
          <p className="small muted">
            Decoded instruction by instruction; opcodes from the vendored LimitOpcodes set.
          </p>
          <ol className="program">
            {buyback.instructions.map((ins) => (
              <li key={ins.name} className={ins.name.startsWith("PolicyGuard") ? "guard" : ""}>
                <span>
                  <span className="ins-name">{ins.name}</span>{" "}
                  <span className="chip">opcode {ins.opcode}</span>{" "}
                  <span className="chip chip-term">{ins.source}</span>
                </span>
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
                <code className="small muted" style={{ gridColumn: 2, overflowWrap: "anywhere" }}>
                  {short(ins.bytes, 18, 8)}
                </code>
              </li>
            ))}
          </ol>
          <h3>Hash chain</h3>
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
        </section>

        <section className="card">
          <h2>Quote as any wallet</h2>
          <p className="small muted">
            <code>quote()</code> runs the program in a static call: a wallet the agreement refuses is refused
            before any transaction is sent.
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
          <label>
            Position tokens in
            <br />
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <div className="row">
            <button
              className="primary"
              disabled={!taker || !maker || amountIn === null}
              onClick={() => setResult(quote(policy, maker!, taker!, amountIn!))}
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
                PolicyGuard passed for maker and taker · FixedRateBalances at {buyback.terms.price}
              </span>
            </div>
          )}
          {result && !result.ok && "deadline" in result && (
            <div className="verdict verdict-deny">
              <code className="revert">revert Deadline — the addendum's offer has expired</code>
            </div>
          )}
          {refused && (
            <div className="verdict verdict-deny">
              <span className="verdict-head">✕ quote reverted</span>
              <code className="revert">
                CounterpartyRefused({short(refused.subject.address, 8, 6)}, {refused.clauseId},{" "}
                {short(policy.policyHash, 8, 4)})
              </code>
              <span className="small">
                {refused.subject.role === "borrower" ? "The maker" : "The taker"} was refused by{" "}
                {refusedClause ? (
                  <>
                    <strong>{refusedClause.clause}</strong> — “{refusedClause.quote}”
                  </>
                ) : (
                  <>clause 0 — no transfer permit holds</>
                )}
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
      <h2>Uniswap v4 — MirrorPolicyHook</h2>
      <p className="small muted">
        <code>beforeAddLiquidity · beforeRemoveLiquidity · beforeSwap</code> run the agreement&apos;s{" "}
        <code>transfer</code> program for the subject the router names. A pool created without the hook is
        inert: the first settlement reverts at the token.
      </p>
      {transferRules.length === 0 && (
        <p className="small">
          <span className="chip chip-warn">no transfer permit</span> This custodial agreement compiles no
          transfer rule yet, so every pool operation is refused with <code>clauseId 0</code> until a
          secondary-trading profile adds one.
        </p>
      )}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Wallet</th>
              <th>hook.explain(subject)</th>
              <th>Pool operation</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((party) => {
              const decision = explain(policy, "transfer", effectiveFacts(policy, party)).onchain;
              const clause = policy.clauseTable.find((entry) => entry.clauseId === decision.clauseId);
              return (
                <tr key={party.id}>
                  <td>{party.name}</td>
                  <td>
                    <code>
                      ({String(decision.allowed)}, {decision.clauseId})
                    </code>
                  </td>
                  <td>
                    {decision.allowed ? (
                      <span className="chip chip-ok">ok</span>
                    ) : (
                      <>
                        <code className="revert">
                          LegalClauseViolation({decision.clauseId}, {short(policy.policyHash, 8, 4)})
                        </code>
                        <span className="small muted">
                          {clause ? `${clause.clause} — “${clause.quote}”` : "no matching permission"}
                        </span>
                      </>
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

export default function ExitPage() {
  const { profile, policy, parties } = usePolicyAndParties();
  const { setProfile } = useProfile();
  const error = policy.error ?? parties.error;
  const credit = profile === "wildcat-credit";
  return (
    <>
      <PageHead
        eyebrow={credit ? "Exit" : "Trade"}
        title={credit ? "A compliant exit on 1inch Aqua" : "The token's only door into Uniswap"}
      >
        {credit
          ? "The borrower ships a buyback whose program carries the compiled agreement as an instruction."
          : "The same agreement, enforced at the pool by a hook whose address is part of every PoolKey."}{" "}
        <span className="mock-note">mock wallets · static adapter</span>
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
            Switch to the Wildcat MLA
          </button>
        </p>
      )}
    </>
  );
}
