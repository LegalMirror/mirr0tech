"use client";

import type { CSSProperties, ReactNode } from "react";
import { venuesFor, renderRefusal } from "@/lib/enforcement";
import { factsOfCondition } from "@/lib/evaluate";
import { factKind, FACT_KIND_LABEL } from "@/lib/facts";
import { short } from "@/lib/format";
import { actionLabel, EFFECT_LABEL, EFFECT_SENTENCE, factLabel, termLabel } from "@/lib/labels";
import type { Condition, PolicyData, Rule, Term } from "@/lib/types";
import { ClauseTableBadge, EffectChip, HexCopy, toneOf } from "../_components/common";
import { Evaluator, type EvaluatorProps } from "./Evaluator";

/** A pipeline step. With `folded`, it renders closed with that one-line summary and opens on click. */
function Step({
  n,
  title,
  hint,
  tone,
  folded,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  tone?: string;
  folded?: string;
  children: ReactNode;
}) {
  return (
    <li className="step" style={{ "--tone": tone } as CSSProperties}>
      <span className="step-n" aria-hidden>
        {n}
      </span>
      <div className="step-body">
        {folded ? (
          <details>
            <summary>
              <h3>{title}</h3>
              <small className="meta">{folded}</small>
            </summary>
            <div className="step-detail">
              {hint && <p className="meta">{hint}</p>}
              {children}
            </div>
          </details>
        ) : (
          <>
            <div className="step-title">
              <h3>{title}</h3>
              {hint && <small>{hint}</small>}
            </div>
            {children}
          </>
        )}
      </div>
    </li>
  );
}

function QuoteStep({
  policy,
  quote,
  clause,
  locations,
  tone,
}: {
  policy: PolicyData;
  quote: string;
  clause: string;
  locations: Rule["quotes"];
  tone: string;
}) {
  const first = locations[0];
  const verbatim = first && policy.text.slice(first.start, first.end) === quote;
  const paragraph =
    first &&
    policy.coverage.paragraphs.find(
      (p) => p.part === first.part && first.displayStart < p.displayEnd && first.displayEnd > p.displayStart
    );
  return (
    <Step n={1} title="The sentence" hint="verbatim from the agreement" tone={tone}>
      <blockquote className="quote">“{quote}”</blockquote>
      <div className="quote-meta">
        <span className="chip chip-action">{clause}</span>
        {paragraph?.label && (
          <span className="chip" title="the paragraph this sentence sits in">
            ¶ {paragraph.label}
          </span>
        )}
        <span
          className={`chip ${verbatim ? "chip-ok" : "chip-bad"}`}
          title={
            first
              ? `${policy.documents[first.part]?.name} · chars [${first.start}, ${first.end}) of the hashed text${locations.length > 1 ? ` · ${locations.length} occurrences` : ""}`
              : undefined
          }
        >
          {verbatim ? "✓ verbatim" : "✗ not found in the text"}
        </span>
      </div>
    </Step>
  );
}

/** The condition in words: facts by their plain names, "all of" / "any of" / "not". */
function Plain({ node }: { node: Condition }) {
  if (node.type === "fact") return <span className="plain-fact">{factLabel(node.name)}</span>;
  if (node.type === "not")
    return (
      <span>
        not <Plain node={node.child} />
      </span>
    );
  return (
    <span>
      {node.type === "all" ? "all of" : "any of"}
      <ul className="plain-list">
        {node.children.map((child, index) => (
          <li key={index}>
            <Plain node={child} />
          </li>
        ))}
      </ul>
    </span>
  );
}

/** The condition as the compiler sees it: identifiers, bit positions, fact kinds. */
function Tree({ node, policy }: { node: Condition; policy: PolicyData }) {
  if (node.type === "fact") {
    return (
      <span>
        <span className="fact">{node.name}</span>{" "}
        <span className="fact-bit" title={FACT_KIND_LABEL[factKind(policy.profile, node.name)]}>
          bit {policy.factOrder.indexOf(node.name)} · {factKind(policy.profile, node.name)}
        </span>
      </span>
    );
  }
  if (node.type === "not") {
    return (
      <span>
        <span className="op">NOT</span>
        <ul>
          <li>
            <Tree node={node.child} policy={policy} />
          </li>
        </ul>
      </span>
    );
  }
  return (
    <span>
      <span className="op">{node.type === "all" ? "ALL OF" : "ANY OF"}</span>
      <ul>
        {node.children.map((child, index) => (
          <li key={index}>
            <Tree node={child} policy={policy} />
          </li>
        ))}
      </ul>
    </span>
  );
}

function BitStrip({ policy, pos, neg }: { policy: PolicyData; pos: number[]; neg: number[] }) {
  return (
    <div className="bitrow" aria-label="fact bits">
      {policy.factOrder.map((name, bit) => (
        <span
          key={name}
          className={`bit ${pos.includes(bit) ? "bit-pos" : neg.includes(bit) ? "bit-neg" : ""}`}
          title={`bit ${bit} · ${name}`}
        >
          {bit}
        </span>
      ))}
    </div>
  );
}

function HexWithRange({ hex, start, end }: { hex: string; start: number; end: number }) {
  const body = hex.slice(2);
  return (
    <div className="hexbox">
      0x{body.slice(0, start * 2)}
      <span className="hex-sel">{body.slice(start * 2, end * 2)}</span>
      {body.slice(end * 2)}
    </div>
  );
}

/** Everything an engineer would ask for: identifiers, logic, bytes, reverts. */
function Technical({ policy, rule }: { policy: PolicyData; rule: Rule }) {
  const program = policy.programs.find((entry) => entry.action === rule.action)!;
  const segment = program.rules.find((entry) => entry.clauseId === rule.clauseId);
  const venues = venuesFor(policy.profile, rule.action);
  const refusalClause = rule.effect === "permit" ? 0 : rule.clauseId;
  return (
    <div className="tech">
      <div className="row">
        <code className="mono">{rule.id}</code>
        <span className="chip chip-action">{rule.action}</span>
        <EffectChip effect={rule.effect} />
        <span className="chip">clauseId {rule.clauseId}</span>
      </div>
      <h4>Logic · NNF → DNF, one bitmask pair per term</h4>
      <div className="tree">
        <Tree node={rule.condition} policy={policy} />
      </div>
      <div className="dnf">
        {rule.dnf.map((term, index) => (
          <div key={index}>
            {index > 0 && <div className="dnf-or">OR</div>}
            <div className="dnf-term">
              <div className="dnf-lits">
                <span className="small muted">term {index + 1}</span>
                {term.pos.map((bit) => (
                  <span key={`p${bit}`} className="chip chip-true">
                    {policy.factOrder[bit]} · bit {bit}
                  </span>
                ))}
                {term.neg.map((bit) => (
                  <span key={`n${bit}`} className="chip chip-false">
                    ¬{policy.factOrder[bit]} · bit {bit}
                  </span>
                ))}
              </div>
              <BitStrip policy={policy} pos={term.pos} neg={term.neg} />
              <dl className="masks">
                <dt>pos</dt>
                <dd>{term.posMask}</dd>
                <dt>neg</dt>
                <dd>{term.negMask}</dd>
              </dl>
            </div>
          </div>
        ))}
      </div>
      <p className="small muted">
        ✓ Proved equal to the tree interpreter over {policy.equivalenceChecks.toLocaleString()} three-valued
        assignments at compile time.
      </p>
      <h4>Bytes · CompiledPolicy.program(ACTION_{rule.action.toUpperCase()})</h4>
      {segment ? (
        <>
          <p className="small muted">
            {program.byteLength} bytes · this rule is bytes [{segment.byteStart}, {segment.byteEnd}) · rule{" "}
            {program.rules.indexOf(segment) + 1} of {program.rules.length} <HexCopy value={program.hex} />
          </p>
          <details className="disc">
            <summary>
              <span className="disc-title">all bytes</span>
            </summary>
            <HexWithRange hex={program.hex} start={segment.byteStart} end={segment.byteEnd} />
          </details>
          <table className="words">
            <tbody>
              {segment.words.map((word) => (
                <tr
                  key={word.offset}
                  className={/^(effect|clauseId|pos\[|neg\[)/.test(word.label) ? "word-key" : ""}
                >
                  <td>+{word.offset}</td>
                  <td>{word.label}</td>
                  <td>{word.hex.replace(/^0x0+(?=.)/, "0x")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="error">No program segment found for clause {rule.clauseId}.</p>
      )}
      <h4>Reverts</h4>
      <div className="venues">
        {venues.map((venue) => (
          <div className="venue" key={`${venue.contract}${venue.calls[0]}`}>
            <span className="venue-name">{venue.contract}</span>
            <code className="small">{venue.calls.join(" · ")}</code>
            <span className="small muted">
              <code>{venue.file}</code>
            </span>
            {venue.refusal ? (
              <code className="revert">
                revert{" "}
                {renderRefusal(venue.refusal, {
                  clauseId: refusalClause,
                  policyHash: short(policy.policyHash, 8, 4),
                  subject: "0xSubject…",
                })}
              </code>
            ) : null}
            {venue.note && <span className="small muted">{venue.note}</span>}
          </div>
        ))}
      </div>
      <p className="small">
        {rule.effect === "permit" ? (
          <>
            A permit never names itself in a revert: when no permit of <code>{rule.action}</code> holds, the
            venue refuses with <code>clauseId 0</code>.
          </>
        ) : (
          <>
            <code>clauseId {rule.clauseId}</code> → <strong>{rule.source.clause}</strong>
          </>
        )}{" "}
        <ClauseTableBadge policy={policy} />
      </p>
    </div>
  );
}

function RuleSteps({
  policy,
  rule,
  evaluator,
}: {
  policy: PolicyData;
  rule: Rule;
  evaluator: EvaluatorProps;
}) {
  const tone = toneOf(rule.effect);
  const venues = venuesFor(policy.profile, rule.action);
  const components = (policy.enforcedBy.rules[rule.id] ?? [])
    .map((id) => policy.components.find((entry) => entry.id === id))
    .filter(Boolean);
  const factCount = factsOfCondition(rule.condition).size;
  return (
    <ol className="stepper">
      <QuoteStep
        policy={policy}
        quote={rule.source.quote}
        clause={rule.source.clause}
        locations={rule.quotes}
        tone={tone}
      />

      <Step n={2} title="What it means" tone={tone}>
        <p className="plain-head">
          <strong>{EFFECT_LABEL[rule.effect]}</strong> · applies to{" "}
          <strong>{actionLabel(rule.action)}</strong>
        </p>
        <div className="plain">
          <Plain node={rule.condition} />
        </div>
        <p className="small">{rule.rationale}</p>
        <p className="meta">{EFFECT_SENTENCE[rule.effect]}</p>
      </Step>

      <Step n={3} title="Where it runs" tone={tone}>
        {components.map((component) => (
          <p className="small" key={component!.id}>
            {component!.description}
          </p>
        ))}
        {venues.length === 0 ? (
          <p className="meta">No venue enforces {actionLabel(rule.action).toLowerCase()} in this profile.</p>
        ) : (
          <ul className="plain-list">
            {venues.map((venue) => (
              <li key={`${venue.contract}${venue.calls[0]}`}>
                <strong>{venue.contract.split(" (")[0]}</strong> — {venue.when}
                {venue.refusal && "; a failure refuses the action and names this clause on-chain"}
              </li>
            ))}
          </ul>
        )}
      </Step>

      <Step n={4} title="What if…" tone={tone} folded="try a wallet's facts">
        <Evaluator {...evaluator} action={rule.action} focus={rule.id} />
      </Step>

      <Step
        n={5}
        title="Technical details"
        tone={tone}
        folded={`${rule.id} · ${rule.dnf.length} term${rule.dnf.length === 1 ? "" : "s"} over ${factCount} facts · bytes and reverts`}
      >
        <Technical policy={policy} rule={rule} />
      </Step>
    </ol>
  );
}

function consumerOf(policy: PolicyData, term: Term): ReactNode {
  const buyback = policy.buyback;
  if (buyback?.available) {
    const used = buyback.instructions.filter((ins) => ins.source.includes(term.name));
    if (used.length) return <>Sets the buyback the borrower posts on 1inch Aqua — see the Exit screen.</>;
  }
  if (term.name === "rescreeningIntervalDays")
    return (
      <>
        Caps how long an attestation may live ({String(policy.config.attestationValiditySeconds)} s ≤{" "}
        {String(policy.config.rescreeningIntervalSeconds)} s); a deployment that would outlive the agreement
        is refused at compile time.
      </>
    );
  return <>Shown for reference; not wired to market parameters in this version.</>;
}

function TermSteps({ policy, term }: { policy: PolicyData; term: Term }) {
  const tone = toneOf("term");
  return (
    <ol className="stepper">
      <QuoteStep
        policy={policy}
        quote={term.source.quote}
        clause={term.source.clause}
        locations={term.quotes}
        tone={tone}
      />
      <Step n={2} title="The value" tone={tone}>
        <p className="plain-head">
          <strong>{termLabel(term.name)}</strong>:{" "}
          <span className="term-val">
            {term.value} <small className="muted">{term.unit}</small>
          </span>
        </p>
        <p className="small">{term.rationale}</p>
      </Step>
      <Step n={3} title="Where it is used" tone={tone}>
        <p className="small">{consumerOf(policy, term)}</p>
      </Step>
      <Step n={4} title="Technical details" tone={tone} folded={`${term.name} · fills a template slot`}>
        <p className="small">
          <code>{term.name}</code> is a value, never a boolean: it fills a program template slot and never
          enters the evaluator.
        </p>
      </Step>
    </ol>
  );
}

export function Pipeline({
  policy,
  selected,
  evaluator,
}: {
  policy: PolicyData;
  selected: string | null;
  evaluator: EvaluatorProps;
}) {
  const [kind, name] = (selected ?? "").split(":");
  const rule = kind === "rule" ? policy.rules.find((entry) => entry.id === name) : undefined;
  const term = kind === "term" ? policy.terms.find((entry) => entry.name === name) : undefined;
  if (rule) return <RuleSteps policy={policy} rule={rule} evaluator={evaluator} />;
  if (term) return <TermSteps policy={policy} term={term} />;
  return <p className="muted">Select a highlighted sentence in the agreement.</p>;
}
