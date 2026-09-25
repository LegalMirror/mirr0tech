"use client";

import { useState } from "react";
import { source } from "@/lib/adapter";
import { explain, factsForAction, factsOfCondition } from "@/lib/evaluate";
import { factKind, FACT_KIND_LABEL } from "@/lib/facts";
import { short } from "@/lib/format";
import { effectiveFacts, statusAction } from "@/lib/parties";
import type { Party, PolicyData } from "@/lib/types";
import { Failed, Glyph, Loading, PageHead, triState } from "../_components/common";
import { usePolicyAndParties } from "../_components/usePageData";

/** Only facts a person attests can be ticked; the oracle, the market and expiry are read. */
const ATTESTABLE = new Set(["attested", "operator", "screening", "ledger"]);

function ReviewItem({ policy, party }: { policy: PolicyData; party: Party }) {
  const action = statusAction(policy);
  const facts = effectiveFacts(policy, party);
  const unknown = factsForAction(policy, action).filter(
    (name) => typeof facts[name] !== "boolean" && ATTESTABLE.has(factKind(policy.profile, name))
  );
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const attestation = Object.fromEntries(unknown.filter((name) => ticked[name]).map((name) => [name, true]));
  const preview = explain(
    policy,
    action,
    policy.profile === "wildcat-credit"
      ? effectiveFacts(policy, {
          ...party,
          facts: { ...party.facts, ...attestation },
          screenedAt: party.screenedAt ?? 1,
        })
      : { ...facts, ...attestation }
  );
  const now = explain(policy, action, facts);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card status-review">
      <div className="party-head">
        <div>
          <h2>{party.name}</h2>
          <code className="small muted">{short(party.address, 8, 6)}</code>
        </div>
        <span className="chip chip-review">review · {action}</span>
      </div>

      <h3>Trace</h3>
      <ul className="trace-line">
        {now.interpretation.trace.map((entry) => (
          <li key={entry.id}>
            <span className="eff">{entry.effect}</span>
            <span>{entry.id}</span>
            <Glyph state={triState(entry.result)} />
          </li>
        ))}
      </ul>

      <h3>Attest</h3>
      {unknown.length === 0 && (
        <p className="small muted">Nothing here can be attested; the unknown facts are read on chain.</p>
      )}
      {unknown.map((name) => {
        // Cite the requirement the fact satisfies, not the permit that also mentions it.
        const mentions = policy.rules.filter(
          (entry) => entry.action === action && factsOfCondition(entry.condition).has(name)
        );
        const rule = mentions.find((entry) => entry.effect !== "permit") ?? mentions[0];
        return (
          <label key={name} className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={!!ticked[name]}
              onChange={(e) => setTicked({ ...ticked, [name]: e.target.checked })}
            />
            <span className="switch-track" aria-hidden>
              <span className="switch-dot" />
            </span>
            <span
              className="switch-text"
              title={rule ? `${rule.source.clause}: “${rule.source.quote}”` : undefined}
            >
              <strong className="mono">{name}</strong>
              <small className="muted">
                {FACT_KIND_LABEL[factKind(policy.profile, name)]}
                {rule ? ` · ${rule.source.clause}` : ""}
              </small>
            </span>
          </label>
        );
      })}

      <p className="meta" style={{ marginTop: 8 }}>
        After attesting: <Glyph state={preview.verdict} /> {preview.verdict}
        {preview.interpretation.reasons.length > 0 && ` · ${preview.interpretation.reasons.join(", ")}`}
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="primary"
          disabled={busy || preview.verdict !== "approve"}
          onClick={() =>
            run(async () => {
              await source.attest(policy.profile, party.id, attestation);
              await source.resolve(policy.profile, party.id, "approve");
            })
          }
        >
          Attest &amp; approve
        </button>
        <button disabled={busy} onClick={() => run(() => source.resolve(policy.profile, party.id, "reject"))}>
          Reject
        </button>
      </div>
    </section>
  );
}

export default function QueuePage() {
  const { policy, parties } = usePolicyAndParties();
  const error = policy.error ?? parties.error;
  const items =
    policy.data && parties.data
      ? parties.data.filter(
          (party) =>
            !party.resolution &&
            explain(policy.data!, statusAction(policy.data!), effectiveFacts(policy.data!, party)).verdict ===
              "review"
        )
      : [];
  const resolved = parties.data?.filter((party) => party.resolution) ?? [];
  return (
    <>
      <PageHead title="Review items">
        A refusal an unknown fact could still change waits here. A prohibition that holds never does: no one
        can approve a sanctioned wallet.
      </PageHead>
      {error && <Failed error={error} />}
      {(!policy.data || !parties.data) && !error && <Loading what="queue" />}
      {policy.data && parties.data && items.length === 0 && (
        <section className="card">
          <h2>Queue is empty</h2>
          <p className="muted">Every party is approved or denied outright.</p>
        </section>
      )}
      <div className="parties">
        {items.map((party) => (
          <ReviewItem key={party.id} policy={policy.data!} party={party} />
        ))}
      </div>
      {resolved.length > 0 && (
        <section className="card">
          <h2>Resolved this session</h2>
          <ul className="checks">
            {resolved.map((party) => (
              <li key={party.id} className={party.resolution === "approved" ? "ok" : "no"}>
                <span className="check-mark">{party.resolution === "approved" ? "✓" : "✕"}</span>
                <span>
                  {party.name} — {party.resolution}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
