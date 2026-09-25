"use client";

import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { source } from "@/lib/adapter";
import type { Facts } from "@/lib/evaluate";
import { useResource } from "@/lib/hooks";
import { effectiveFacts } from "@/lib/parties";
import { ruleRef, termRef } from "@/lib/segments";
import type { PolicyData } from "@/lib/types";
import { ClauseTableBadge, Hash, toneOf } from "../_components/common";
import { DocumentPane } from "./DocumentPane";
import { Pipeline } from "./Pipeline";

function Header({ policy }: { policy: PolicyData }) {
  return (
    <section className="card">
      <div className="eyebrow">
        Act {policy.act} · {policy.label} · {policy.profile}
      </div>
      <h2 style={{ marginTop: 4 }}>{policy.title}</h2>
      <p className="small muted" style={{ margin: 0 }}>
        {policy.parties.map((party) => `${party.name} (${party.role})`).join(" · ")} → {policy.venue}
      </p>
      <div className="hashes">
        <Hash label="document sha256" value={policy.source.sha256} />
        <span className="hash-arrow">→</span>
        <Hash label="normalized text sha256" value={policy.source.textSha256} />
        <span className="hash-arrow">→</span>
        <Hash label="policyHash" value={policy.policyHash} />
        <span className="hash-arrow">⊃</span>
        <Hash label="clauseTableHash" value={policy.clauseTableHash} />
      </div>
      <div className="stat-row">
        <span className="chip chip-ok">✓ equivalence proved · {policy.equivalenceChecks.toLocaleString()} assignments</span>
        <ClauseTableBadge policy={policy} />
        <span className="chip">{policy.rules.length} rules</span>
        <span className="chip chip-term">{policy.terms.length} terms</span>
        <span className="chip chip-review">{policy.unresolved.length} not compiled</span>
        <span className="chip">
          {policy.factOrder.length} facts · {policy.actionOrder.length} actions
        </span>
        {policy.demo && <span className="chip chip-warn">demo build · unresolved terms allowed</span>}
        <span className="chip">extraction: {policy.extraction.provider}</span>
      </div>
    </section>
  );
}

function RulePicker({
  policy,
  selected,
  hot,
  onHover,
  onSelect,
}: {
  policy: PolicyData;
  selected: string | null;
  hot: Set<string>;
  onHover: (refs: string[]) => void;
  onSelect: (ref: string) => void;
}) {
  // In the order the agreement introduces them, not bit order.
  const actions = [...new Set(policy.rules.map((rule) => rule.action))];
  const button = (ref: string, label: string, tone: string) => (
    <button
      key={ref}
      type="button"
      className={`rule-btn ${selected === ref ? "on" : ""} ${hot.has(ref) ? "q-hotBtn" : ""}`}
      style={{ "--tone": tone } as CSSProperties}
      onMouseEnter={() => onHover([ref])}
      onMouseLeave={() => onHover([])}
      onClick={() => onSelect(ref)}
    >
      {label}
    </button>
  );
  return (
    <div className="rule-groups">
      {actions.map((action) => (
        <div className="rule-group" key={action}>
          <h3>{action}</h3>
          <div className="rule-list">
            {policy.rules
              .filter((rule) => rule.action === action)
              .map((rule) => button(ruleRef(rule.id), rule.id, toneOf(rule.effect)))}
          </div>
        </div>
      ))}
      {policy.terms.length > 0 && (
        <div className="rule-group">
          <h3>terms</h3>
          <div className="rule-list">{policy.terms.map((term) => button(termRef(term.name), term.name, toneOf("term")))}</div>
        </div>
      )}
    </div>
  );
}

function TermsPanel({ policy, onSelect }: { policy: PolicyData; onSelect: (ref: string) => void }) {
  if (!policy.terms.length)
    return (
      <section className="card">
        <h2>Terms</h2>
        <p className="muted small">This agreement compiles to rules only; it carries no numeric or dated terms.</p>
      </section>
    );
  return (
    <section className="card">
      <h2>Terms</h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Term</th>
              <th>Value</th>
              <th>Clause</th>
              <th>Quote</th>
            </tr>
          </thead>
          <tbody>
            {policy.terms.map((term) => (
              <tr key={term.name} className="clickable" onClick={() => onSelect(termRef(term.name))}>
                <td>
                  <code>{term.name}</code>
                </td>
                <td>
                  <span className="term-val">{term.value}</span> <span className="small muted">{term.unit}</span>
                </td>
                <td className="small">{term.source.clause}</td>
                <td className="small muted">“{term.source.quote}”</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UnresolvedPanel({ policy }: { policy: PolicyData }) {
  return (
    <section className="card">
      <h2>Not compiled</h2>
      <p className="small muted">
        What the compiler could not quote into a rule. Execution is refused while this list is non-empty unless the
        build passes <code>--demo</code>.
      </p>
      <ul className="checks">
        {policy.unresolved.map((entry) => (
          <li key={entry.clause} className="no">
            <span className="check-mark">⚠</span>
            <strong>{entry.clause}</strong>
            <span className="check-detail muted">{entry.description}</span>
          </li>
        ))}
      </ul>
      <h3>Deployment assumptions</h3>
      <ul className="small muted">
        {policy.config.assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
    </section>
  );
}

export function Workspace({ policy }: { policy: PolicyData }) {
  const [selected, setSelected] = useState<string | null>(policy.rules[0] ? ruleRef(policy.rules[0].id) : null);
  const [hot, setHot] = useState<Set<string>>(new Set());
  const [scrollKey, setScrollKey] = useState(1);
  const parties = useResource(() => source.parties(policy.profile), [policy.profile]);
  const presets = useMemo(
    () => (parties.data ?? []).map((party) => ({ name: party.name.split(" — ")[0], facts: effectiveFacts(policy, party) })),
    [parties.data, policy]
  );
  const [facts, setFacts] = useState<Facts | null>(null);
  const activeFacts = facts ?? presets[0]?.facts ?? {};

  const onHover = useCallback((refs: string[]) => setHot(new Set(refs)), []);
  const onSelect = useCallback((ref: string, fromDocument = false) => {
    setSelected(ref);
    if (!fromDocument) setScrollKey((k) => k + 1);
  }, []);
  const selectFromPanel = useCallback((ref: string) => onSelect(ref, false), [onSelect]);

  return (
    <>
      <Header policy={policy} />
      <div className="pol-grid">
        <DocumentPane
          policy={policy}
          selected={selected}
          hot={hot}
          scrollKey={scrollKey}
          onHover={onHover}
          onSelect={onSelect}
        />
        <section className="card" aria-label="Compilation pipeline">
          <h2>Clause → contract</h2>
          <RulePicker policy={policy} selected={selected} hot={hot} onHover={onHover} onSelect={selectFromPanel} />
          <Pipeline
            policy={policy}
            selected={selected}
            evaluator={{ policy, facts: activeFacts, setFacts, presets }}
          />
        </section>
      </div>
      <div className="grid-2" style={{ marginTop: "var(--sp-md)" }}>
        <TermsPanel policy={policy} onSelect={selectFromPanel} />
        <UnresolvedPanel policy={policy} />
      </div>
    </>
  );
}
