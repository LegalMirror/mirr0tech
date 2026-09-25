"use client";

import type { CSSProperties } from "react";
import { renderRefusal, venuesFor } from "@/lib/enforcement";
import { explain, factsForAction, factsOfCondition, hex, type Facts } from "@/lib/evaluate";
import { factKind } from "@/lib/facts";
import { short } from "@/lib/format";
import type { PolicyData, Tri } from "@/lib/types";
import { EffectChip, TriChip } from "../_components/common";

export type Preset = { name: string; facts: Facts };
export type EvaluatorProps = {
  policy: PolicyData;
  facts: Facts;
  setFacts: (facts: Facts) => void;
  presets: Preset[];
};

const VERDICT_TEXT = {
  approve: "✓ approve — the policy allows it",
  review: "… review — refused until an unknown fact is established",
  deny: "✕ deny — refused; no reviewer can override a prohibition",
};

function TriToggle({
  value,
  onChange,
  label,
}: {
  value: Tri | undefined;
  onChange: (v: Tri) => void;
  label: string;
}) {
  const options: { v: Tri; text: string; cls: string }[] = [
    { v: true, text: "T", cls: "on-true" },
    { v: false, text: "F", cls: "on-false" },
    { v: null, text: "?", cls: "on-null" },
  ];
  const current = typeof value === "boolean" ? value : null;
  return (
    <span className="tri" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.text}
          type="button"
          role="radio"
          aria-checked={current === o.v}
          className={current === o.v ? o.cls : ""}
          onClick={() => onChange(o.v)}
          title={o.v === null ? "unknown" : String(o.v)}
        >
          {o.text}
        </button>
      ))}
    </span>
  );
}

export function Evaluator({
  policy,
  facts,
  setFacts,
  presets,
  action,
  focus,
}: EvaluatorProps & { action: string; focus?: string }) {
  const names = factsForAction(policy, action);
  const focusRule = policy.rules.find((rule) => rule.id === focus);
  const focusFacts = focusRule ? factsOfCondition(focusRule.condition) : new Set<string>();
  const result = explain(policy, action, facts);
  const failing = policy.clauseTable.find((entry) => entry.clauseId === result.onchain.clauseId);
  const venues = venuesFor(policy.profile, action);

  return (
    <div>
      <div className="presets" aria-label="Presets">
        {presets.map((preset) => (
          <button key={preset.name} type="button" onClick={() => setFacts({ ...preset.facts })}>
            {preset.name}
          </button>
        ))}
        <button type="button" onClick={() => setFacts({})}>
          all unknown
        </button>
      </div>
      <div className="tri-grid">
        {names.map((name) => (
          <div
            key={name}
            className={`tri-row ${focusFacts.has(name) ? "hl" : ""}`}
            style={focusRule ? ({ "--tone": `var(--${focusRule.effect})` } as CSSProperties) : undefined}
          >
            <span className="tri-name">
              <span className="fact">{name}</span>
              <small>
                bit {policy.factOrder.indexOf(name)} · {factKind(policy.profile, name)}
              </small>
            </span>
            <TriToggle label={name} value={facts[name]} onChange={(v) => setFacts({ ...facts, [name]: v })} />
          </div>
        ))}
      </div>

      <div className={`verdict verdict-${result.verdict}`} aria-live="polite">
        <div className="verdict-head">
          <span className="chip chip-action">{action}</span>
          <span>{VERDICT_TEXT[result.verdict]}</span>
        </div>
        <div className="row small">
          <span>
            interpreter <code>evaluatePolicy</code>:{" "}
            <strong>{result.interpretation.allowed ? "allowed" : "refused"}</strong>
            {result.interpretation.reasons.length > 0 && (
              <span className="muted"> ({result.interpretation.reasons.join(", ")})</span>
            )}
          </span>
        </div>
        <div className="row small">
          <span>
            on chain <code>PolicyEval.decide(program, known, value)</code> →{" "}
            <code>
              ({String(result.onchain.allowed)}, {result.onchain.clauseId})
            </code>
          </span>
          <span className={`chip ${result.agree ? "chip-ok" : "chip-bad"}`}>
            {result.agree ? "✓ agree" : "✗ disagree"}
          </span>
        </div>
        <div className="row small mono muted">
          known {hex(result.known)} · value {hex(result.value)}
        </div>
        {!result.onchain.allowed && (
          <>
            {failing ? (
              <div className="small">
                failing clause <code>{failing.clauseId}</code> <strong>{failing.clause}</strong> (
                {failing.ruleId}) — “{failing.quote}”
              </div>
            ) : (
              <div className="small">
                clause <code>0</code> — no permit of <code>{action}</code> holds (NO_MATCHING_PERMISSION)
              </div>
            )}
            {venues
              .filter((venue) => venue.refusal)
              .map((venue) => (
                <code className="revert" key={`${venue.contract}${venue.calls[0]}`}>
                  {venue.contract.split(" ")[0]}: revert{" "}
                  {renderRefusal(venue.refusal!, {
                    clauseId: result.onchain.clauseId,
                    policyHash: short(policy.policyHash, 8, 4),
                    subject: "0xSubject…",
                  })}
                </code>
              ))}
            {venues
              .filter((venue) => !venue.refusal)
              .map((venue) => (
                <code className="revert" key={venue.contract}>
                  {venue.contract}: {venue.note}
                </code>
              ))}
          </>
        )}
        <ul className="trace">
          {result.interpretation.trace.map((entry) => {
            const fails =
              (entry.effect === "require" && entry.result !== true) ||
              (entry.effect === "forbid" && entry.result !== false);
            return (
              <li key={entry.id} className={`${fails ? "fail" : ""} ${entry.id === focus ? "sel" : ""}`}>
                <span aria-hidden>
                  {fails ? "✕" : entry.effect === "permit" && entry.result !== true ? "·" : "✓"}
                </span>
                <EffectChip effect={entry.effect} />
                <code>{entry.id}</code>
                <TriChip value={entry.result} />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
