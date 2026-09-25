"use client";

import type { CSSProperties } from "react";
import { source } from "@/lib/adapter";
import { explain } from "@/lib/evaluate";
import { fmtTime, short } from "@/lib/format";
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
  const result = explain(policy, event.action, event.facts);
  return (
    <li style={{ "--tone": TONE[result.verdict] } as CSSProperties}>
      <details>
        <summary>
          <span className="when">{fmtTime(event.at)}</span>
          <span className="chip chip-action">{event.kind}</span>
          <strong>{event.subject}</strong>
          <span className="muted small">{event.summary}</span>
          <span className={`chip chip-${result.verdict}`}>
            {event.action}: {result.verdict}
          </span>
        </summary>
        <div className="detail">
          <dl className="kv small">
            <dt>Venue</dt>
            <dd>{event.venue}</dd>
            <dt>Decision</dt>
            <dd>
              <code>
                PolicyEval.decide → ({String(result.onchain.allowed)}, {result.onchain.clauseId})
              </code>
            </dd>
            {!result.onchain.allowed && (
              <>
                <dt>Clause</dt>
                <dd>
                  <Refusal policy={policy} action={event.action} clauseId={result.onchain.clauseId} />
                </dd>
              </>
            )}
            <dt>Transaction</dt>
            <dd>
              {event.txHash ? (
                <code title={event.txHash}>{short(event.txHash, 10, 6)} (mock)</code>
              ) : (
                "none — refused before signing"
              )}
            </dd>
          </dl>
          <h3>Rule trace</h3>
          <ul className="trace">
            {result.interpretation.trace.map((entry) => (
              <li key={entry.id}>
                <EffectChip effect={entry.effect} />
                <code>{entry.id}</code>
                <TriChip value={entry.result} />
              </li>
            ))}
          </ul>
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
      <PageHead eyebrow="Audit" title="Every decision, traceable to a sentence">
        Newest first. Each row replays its decision through the compiled policy and names the clause.{" "}
        <span className="mock-note">mock events · MultiBaas event queries replace this</span>
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
