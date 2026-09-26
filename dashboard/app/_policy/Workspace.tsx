"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import { source } from "@/lib/adapter";
import type { Facts } from "@/lib/evaluate";
import { useResource } from "@/lib/hooks";
import { effectiveFacts } from "@/lib/parties";
import { actionLabel, EFFECT_LABEL, termLabel } from "@/lib/labels";
import { verificationSentence } from "@/lib/verification";
import { pipelineRefs, ruleRef, termRef } from "@/lib/segments";
import type { PolicyData } from "@/lib/types";
import { short } from "@/lib/format";
import { ClauseTableBadge, Disclosure } from "../_components/common";
import { Deployed } from "../_components/Deployed";
import { DocumentPane } from "./DocumentPane";
import { Pipeline } from "./Pipeline";
import { Verification } from "./Verification";

function Intro({ policy }: { policy: PolicyData }) {
  return (
    <div className="intro">
      <h2>{policy.title}</h2>
      <div className="meta">
        Act {policy.act} · {policy.parties.map((party) => `${party.name} (${party.role})`).join(" · ")} →{" "}
        {policy.venue}
      </div>
      {policy.verification && (
        <div className="meta verified-line">
          <span className={`chip chip-${policy.verification.confidence.overall >= 0.9 ? "ok" : "review"}`}>
            ✓ checked
          </span>{" "}
          {verificationSentence(policy.verification)}
        </div>
      )}
    </div>
  );
}

function Provenance({ policy }: { policy: PolicyData }) {
  return (
    <Disclosure title="Provenance" summary={`policyHash ${short(policy.policyHash, 10, 6)}`} card>
      <dl className="prov">
        <dt>document sha256</dt>
        <dd>
          <code>{policy.source.sha256}</code>
        </dd>
        <dt>normalized text sha256</dt>
        <dd>
          <code>{policy.source.textSha256}</code>
        </dd>
        <dt>policyHash</dt>
        <dd>
          <code>{policy.policyHash}</code>
        </dd>
        <dt>clauseTableHash</dt>
        <dd>
          <code>{policy.clauseTableHash}</code> <ClauseTableBadge policy={policy} />
        </dd>
        {policy.documents.map((part) => (
          <Fragment key={part.name}>
            <dt>{part.name}</dt>
            <dd>
              <code>{part.sha256}</code> · chars {part.start.toLocaleString()}–{part.end.toLocaleString()}
            </dd>
          </Fragment>
        ))}
        <dt>build</dt>
        <dd>
          {policy.factOrder.length} facts · {policy.actionOrder.length} actions · extraction:{" "}
          {policy.extraction.provider}
          {policy.extraction.model ? ` (${policy.extraction.model})` : ""}
          {policy.demo && " · demo build, unresolved terms allowed"}
        </dd>
        {policy.verification && (
          <>
            <dt>deliberation</dt>
            <dd>
              Noolog job <code>{policy.verification.jobId}</code>
              {policy.verification.mock ? " (mock orchestrator, no model)" : ""} · agents{" "}
              {policy.verification.agents.join(", ")} · {policy.verification.rounds} rounds · winner{" "}
              {policy.verification.winner?.agent} (score {policy.verification.winner?.score?.toFixed(2)}) ·
              convergence {policy.verification.convergence?.toFixed(2)}
            </dd>
          </>
        )}
        <dt>deployed</dt>
        <dd>
          <Deployed profile={policy.profile} />
        </dd>
      </dl>
    </Disclosure>
  );
}

function RuleNav({
  policy,
  selected,
  onSelect,
}: {
  policy: PolicyData;
  selected: string | null;
  onSelect: (ref: string) => void;
}) {
  const refs = pipelineRefs(policy);
  const index = selected ? refs.indexOf(selected) : -1;
  const actions = [...new Set(policy.rules.map((rule) => rule.action))];
  const step = (delta: number) => onSelect(refs[(index + delta + refs.length) % refs.length]);
  return (
    <div className="rule-nav">
      <button type="button" onClick={() => step(-1)} aria-label="previous">
        ‹
      </button>
      <select aria-label="Rule or term" value={selected ?? ""} onChange={(e) => onSelect(e.target.value)}>
        {actions.map((action) => (
          <optgroup key={action} label={actionLabel(action)}>
            {policy.rules
              .filter((rule) => rule.action === action)
              .map((rule) => (
                <option key={rule.id} value={ruleRef(rule.id)}>
                  {EFFECT_LABEL[rule.effect]} · {rule.source.clause}
                </option>
              ))}
          </optgroup>
        ))}
        {policy.terms.length > 0 && (
          <optgroup label="Values">
            {policy.terms.map((term) => (
              <option key={term.name} value={termRef(term.name)}>
                {termLabel(term.name)} = {term.value}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <span className="meta">
        {index + 1} of {refs.length}
      </span>
      <button type="button" onClick={() => step(1)} aria-label="next">
        ›
      </button>
    </div>
  );
}

function TermsPanel({ policy, onSelect }: { policy: PolicyData; onSelect: (ref: string) => void }) {
  if (!policy.terms.length)
    return (
      <p className="muted small">
        This agreement compiles to rules only; it carries no numeric or dated terms.
      </p>
    );
  return (
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
                <span title={term.name}>{termLabel(term.name)}</span>
              </td>
              <td>
                <span className="term-val">{term.value}</span>{" "}
                <span className="small muted">{term.unit}</span>
              </td>
              <td className="small">{term.source.clause}</td>
              <td className="small muted">“{term.source.quote}”</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnresolvedPanel({ policy }: { policy: PolicyData }) {
  return (
    <>
      <p className="small muted">
        Clauses that need a person's judgement before they can run. A production build refuses to ship while
        this list is non-empty.
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
    </>
  );
}

export function Workspace({ policy }: { policy: PolicyData }) {
  const [selected, setSelected] = useState<string | null>(
    policy.rules[0] ? ruleRef(policy.rules[0].id) : null
  );
  const [hot, setHot] = useState<Set<string>>(new Set());
  const [scrollKey, setScrollKey] = useState(1);
  const parties = useResource(() => source.parties(policy.profile), [policy.profile]);
  const presets = useMemo(
    () =>
      (parties.data ?? []).map((party) => ({
        name: party.name.split(" — ")[0],
        facts: effectiveFacts(policy, party),
      })),
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
      <Intro policy={policy} />
      <Verification policy={policy} onSelect={selectFromPanel} />
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
          <h2>What this sentence does</h2>
          <RuleNav policy={policy} selected={selected} onSelect={selectFromPanel} />
          <Pipeline
            policy={policy}
            selected={selected}
            evaluator={{ policy, facts: activeFacts, setFacts, presets }}
          />
        </section>
      </div>
      <section className="card" style={{ marginTop: "var(--sp-md)" }} aria-label="More">
        <Disclosure title="Numbers in the agreement" summary={`${policy.terms.length} values the venues use`}>
          <TermsPanel policy={policy} onSelect={selectFromPanel} />
        </Disclosure>
        <Disclosure
          title="Open items"
          summary={`${policy.unresolved.length} clauses that still need a person`}
        >
          <UnresolvedPanel policy={policy} />
        </Disclosure>
        <Disclosure
          title="Assumptions"
          summary={`${policy.config.assumptions.length} stated for this deployment`}
        >
          <ul className="small muted">
            {policy.config.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </Disclosure>
      </section>
      <div style={{ marginTop: "var(--sp-md)" }}>
        <Provenance policy={policy} />
      </div>
    </>
  );
}
