"use client";

import { useState } from "react";
import { source } from "@/lib/adapter";
import { explain } from "@/lib/evaluate";
import { factKind, OBSERVABLE_SOURCE } from "@/lib/facts";
import { fmtTime, short } from "@/lib/format";
import { credentialExpiry, effectiveFacts, statusAction } from "@/lib/parties";
import type { Party, PolicyData } from "@/lib/types";
import { Failed, Loading, PageHead, Refusal, TriChip } from "../_components/common";
import { usePolicyAndParties } from "../_components/usePageData";

const unix = (seconds: number) => fmtTime(new Date(seconds * 1000).toISOString());

function PartyCard({ policy, party }: { policy: PolicyData; party: Party }) {
  const [busy, setBusy] = useState(false);
  const facts = effectiveFacts(policy, party);
  const status = explain(policy, statusAction(policy), facts);
  const actions = [...new Set(policy.rules.map((rule) => rule.action))];
  const expiry = credentialExpiry(policy, party);
  const attested = Object.entries(party.facts);
  const credit = policy.profile === "wildcat-credit";
  return (
    <section className={`card status-${status.verdict}`}>
      <div className="party-head">
        <div>
          <h2>{party.name}</h2>
          <code className="small muted" title={party.address}>
            {short(party.address, 8, 6)}
          </code>
        </div>
        <span className={`chip chip-${status.verdict}`}>
          {status.verdict === "approve" ? "approved" : status.verdict === "review" ? "review" : "denied"}
          {party.resolution ? ` · ${party.resolution}` : ""}
        </span>
      </div>

      <div className="fact-chips">
        {actions.map((action) => {
          const verdict = explain(policy, action, facts).verdict;
          return (
            <span key={action} className={`chip chip-${verdict}`}>
              {action}: {verdict}
            </span>
          );
        })}
      </div>

      {!status.onchain.allowed && (
        <p>
          <Refusal policy={policy} action={statusAction(policy)} clauseId={status.onchain.clauseId} />
        </p>
      )}

      <h3>{credit ? "Attested facts" : "Onboarding facts"}</h3>
      <div className="fact-chips">
        {attested.length === 0 && <span className="small muted">none on file</span>}
        {attested.map(([name, value]) => (
          <span key={name} title={factKind(policy.profile, name)}>
            <TriChip value={party.screenedAt === null && credit ? null : value} label={name} />
          </span>
        ))}
      </div>

      {credit && (
        <dl className="kv small">
          <dt>Sanctions oracle</dt>
          <dd>
            <span className={`chip ${party.sanctions === "clear" ? "chip-ok" : "chip-bad"}`}>
              {party.sanctions}
            </span>{" "}
            <span className="muted">{OBSERVABLE_SOURCE.sanctionsClear}</span>
          </dd>
          <dt>Screened</dt>
          <dd>{party.screenedAt ? unix(party.screenedAt) : "never — every attested fact is unknown"}</dd>
          <dt>Credential expiry</dt>
          <dd>{expiry ? unix(expiry) : "—"}</dd>
          <dt>getCredential</dt>
          <dd>
            <code>{status.onchain.allowed && party.screenedAt ? party.screenedAt : 0}</code>
          </dd>
        </dl>
      )}

      {credit && party.screenedAt !== null && party.role !== "borrower" && (
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await source.revoke(policy.profile, party.id).finally(() => setBusy(false));
            }}
          >
            Revoke attestation
          </button>
          <span className="small muted">PolicyAttestor.revokeFacts — no reason string on chain</span>
        </div>
      )}
    </section>
  );
}

export default function LendersPage() {
  const { profile, policy, parties } = usePolicyAndParties();
  const credit = profile === "wildcat-credit";
  const error = policy.error ?? parties.error;
  return (
    <>
      <PageHead eyebrow={credit ? "Lenders" : "Investors"} title={credit ? "Who may lend" : "Who may hold"}>
        Status is the compiled policy run on each wallet's facts — the same decision the{" "}
        {credit ? "role provider" : "gateway"} makes.{" "}
        <span className="mock-note">mock parties · static adapter</span>
      </PageHead>
      {error && <Failed error={error} />}
      {(!policy.data || !parties.data) && !error && <Loading what="parties" />}
      {policy.data && parties.data && (
        <div className="parties">
          {parties.data.map((party) => (
            <PartyCard key={party.id} policy={policy.data!} party={party} />
          ))}
        </div>
      )}
    </>
  );
}
