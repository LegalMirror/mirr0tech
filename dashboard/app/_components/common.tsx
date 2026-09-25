"use client";

import { useEffect, useState, type ReactNode } from "react";
import { decodeRefusal } from "@/lib/decode";
import { short } from "@/lib/format";
import type { Effect, PolicyData, Tri } from "@/lib/types";
import { clauseTableMatches } from "@/lib/verify";
import { CopyButton } from "./CopyButton";

export const toneOf = (effect: Effect | "term") => `var(--${effect})`;

export function EffectChip({ effect }: { effect: Effect }) {
  return <span className={`chip chip-${effect}`}>{effect}</span>;
}

export function TriChip({ value, label }: { value: Tri | undefined; label?: string }) {
  const state = value === true ? "true" : value === false ? "false" : "unknown";
  return (
    <span className={`chip chip-${state}`}>
      {label ? `${label} · ` : ""}
      {state}
    </span>
  );
}

export function Hash({ label, value, full = false }: { label: string; value: string; full?: boolean }) {
  return (
    <div className="hash" title={value}>
      <span className="hash-k">{label}</span>
      <span className="hash-v">{full ? value : short(value, 10, 8)}</span>
    </div>
  );
}

/** Title and a one-line lead. The nav already says where the reader is, so there is no eyebrow. */
export function PageHead({ title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
    </header>
  );
}

/** A closed-by-default section: the title, a one-line summary, and the detail on click. */
export function Disclosure({
  title,
  summary,
  open = false,
  card = false,
  children,
}: {
  title: string;
  summary?: ReactNode;
  open?: boolean;
  card?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={`disc ${card ? "card" : ""}`} open={open}>
      <summary>
        <span className="disc-title">{title}</span>
        {summary && <span className="meta">{summary}</span>}
      </summary>
      <div className="disc-body">{children}</div>
    </details>
  );
}

const GLYPH = { approve: "✓", true: "✓", review: "?", unknown: "?", deny: "✗", false: "✗" } as const;
/** One character for a verdict or a three-valued fact, coloured by its class. */
export function Glyph({ state, title }: { state: keyof typeof GLYPH; title?: string }) {
  return (
    <span className={`glyph g-${state}`} title={title} aria-label={state}>
      {GLYPH[state]}
    </span>
  );
}
export const triState = (value: Tri | undefined) =>
  value === true ? "true" : value === false ? "false" : "unknown";

export function Loading({ what }: { what: string }) {
  return <p className="loading">loading {what}…</p>;
}

export function Failed({ error }: { error: Error }) {
  return (
    <section className="card" role="alert">
      <h2>Could not load data</h2>
      <p className="error">{error.message}</p>
    </section>
  );
}

/** Recomputes the clause table hash in the browser and compares it with the committed one. */
export function ClauseTableBadge({ policy }: { policy: PolicyData }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    clauseTableMatches(policy.clauseTable, policy.clauseTableHash).then(
      (match) => live && setOk(match),
      () => live && setOk(false)
    );
    return () => {
      live = false;
    };
  }, [policy]);
  if (ok === null) return <span className="chip">clause table · checking</span>;
  return (
    <span
      className={`chip ${ok ? "chip-ok" : "chip-bad"}`}
      title="sha256(canonical(clauseTable)) recomputed in this browser"
    >
      {ok ? "✓ clause table matches CLAUSE_TABLE_HASH" : "✗ clause table does not match its hash"}
    </span>
  );
}

export function HexCopy({ value }: { value: string }) {
  return <CopyButton text={value} label="Copy hex" />;
}

/** A refusal rendered as the sentence behind it. */
export function Refusal({
  policy,
  action,
  clauseId,
}: {
  policy: PolicyData;
  action: string;
  clauseId: number;
}) {
  const decoded = decodeRefusal(policy, action, clauseId);
  return (
    <span className="small">
      {decoded.kind === "no-permit" && (
        <>
          <code>clauseId 0</code> — no permit of <code>{action}</code> held
          {decoded.clauses.length ? "; it is permitted only by " : ""}
        </>
      )}
      {decoded.clauses.map((entry, index) => (
        <span key={entry.clauseId}>
          {index > 0 && " · "}
          {decoded.kind === "clause" && (
            <>
              <code>clauseId {entry.clauseId}</code> →{" "}
            </>
          )}
          <strong>{entry.clause}</strong> — “{entry.quote}”
        </span>
      ))}
    </span>
  );
}
