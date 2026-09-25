"use client";

import { useEffect, useState, type ReactNode } from "react";
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

export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
    </header>
  );
}

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
