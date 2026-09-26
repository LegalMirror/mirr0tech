"use client";

import type { CSSProperties } from "react";
import { source } from "@/lib/adapter";
import { explain } from "@/lib/evaluate";
import { fmtTime, short } from "@/lib/format";
import { actionLabel, KIND_LABEL, plainSummary, VERDICT_LABEL } from "@/lib/labels";
import { useResource } from "@/lib/hooks";
import type { AuditEvent, PolicyData } from "@/lib/types";
import { EffectChip, Failed, Loading, PageHead, Refusal, TriChip } from "../_components/common";
import { useProfile, usePolicy } from "../providers";

const TONE: Record<string, string> = {
  approve: "var(--permit)",
  review: "var(--unresolved)",
  deny: "var(--forbid)",
};

function Row({ policy, event }: { policy: PolicyData; event: AuditEvent }) {
  // The live gateway reports what the chain decided; the static build replays the mock facts.
  const replay = event.outcome === undefined ? explain(policy, event.action, event.facts) : null;
  const allowed = replay ? replay.onchain.allowed : event.outcome === "ok";
  const clauseId = replay ? replay.onchain.clauseId : (event.clauseId ?? 0);
  const verdict = replay ? replay.verdict : allowed ? "approve" : "deny";
  // Attestations and designations change facts; they are not decisions under an action.
  const decided = policy.actionOrder.includes(event.action);
  return (
    <li style={{ "--tone": decided ? TONE[verdict] : "var(--border)" } as CSSProperties}>
      <details>
        <summary>
          <span className="when">{fmtTime(event.at)}</span>
          <span className="chip chip-action">{KIND_LABEL[event.kind] ?? event.kind}</span>
          <strong>{event.subject}</strong>
          <span className="muted small">{plainSummary(event.summary)}</span>
          {decided ? (
            <span className={`chip chip-${verdict}`}>
              {actionLabel(event.action)}: {VERDICT_LABEL[verdict]}
            </span>
          ) : (
            <span className="meta">facts</span>
          )}
        </summary>
        <div className="detail">
          <dl className="kv small">
            <dt>Venue</dt>
            <dd>{event.venue}</dd>
            <dt>Decision</dt>
            <dd>
              {allowed ? "Allowed" : "Refused"}
              {replay ? " (replayed from the facts)" : " on-chain"}
              {!allowed && clauseId > 0 ? `, clause ${clauseId}` : ""}
            </dd>
            {!allowed && clauseId > 0 && (
              <>
                <dt>Clause</dt>
                <dd>
                  <Refusal policy={policy} action={event.action} clauseId={clauseId} />
                </dd>
              </>
            )}
            <dt>Transaction</dt>
            <dd>
              {event.txHash && event.explorer ? (
                <a href={event.explorer} target="_blank" rel="noreferrer">
                  View on Etherscan ↗
                </a>
              ) : event.txHash ? (
                <code title={event.txHash}>{short(event.txHash, 10, 6)}</code>
              ) : (
                "none — refused before signing"
              )}
            </dd>
          </dl>
          {replay && (
            <>
              <h3>Rule trace</h3>
              <ul className="trace">
                {replay.interpretation.trace.map((entry) => (
                  <li key={entry.id}>
                    <EffectChip effect={entry.effect} />
                    <code>{entry.id}</code>
                    <TriChip value={entry.result} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </details>
    </li>
  );
}

export default function AuditPage() {
  const { profile } = useProfile();
  const policy = usePolicy();
  const events = useResource(() => source.audit(profile), [profile]);
  const error = policy.error ?? events.error;
  const sorted = [...(events.data ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <>
      <PageHead title="What happened">
        Every decision, newest first, with the sentence of the contract behind it.
      </PageHead>
      {error && <Failed error={error} />}
      {(!policy.data || !events.data) && !error && <Loading what="audit stream" />}
      {policy.data && events.data && (
        <section className="card">
          <ol className="timeline">
            {sorted.map((event) => (
              <Row key={event.id} policy={policy.data!} event={event} />
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
