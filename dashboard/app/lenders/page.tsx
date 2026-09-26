"use client";

import { useState } from "react";
import { source } from "@/lib/adapter";
import { explain } from "@/lib/evaluate";
import { factKind, FACT_KIND_LABEL, OBSERVABLE_SOURCE } from "@/lib/facts";
import { actionLabel, factLabel, VERDICT_LABEL } from "@/lib/labels";
import { fmtTime, short } from "@/lib/format";
import { credentialExpiry, effectiveFacts, relevantFacts, statusAction } from "@/lib/parties";
import type { Party, PolicyData } from "@/lib/types";
import { Failed, Glyph, Loading, PageHead, Refusal, triState } from "../_components/common";
import { HumanCheck } from "../_components/HumanCheck";
import { usePolicyAndParties } from "../_components/usePageData";

const unix = (seconds: number) => fmtTime(new Date(seconds * 1000).toISOString());

function PartyCard({ policy, party, others }: { policy: PolicyData; party: Party; others: Party[] }) {
  const [busy, setBusy] = useState(false);
  const facts = effectiveFacts(policy, party);
  const status = explain(policy, statusAction(policy), facts);
  const actions = [...new Set(policy.rules.map((rule) => rule.action))];
  const expiry = credentialExpiry(policy, party);
  const credit = policy.profile === "wildcat-credit";
  const shown = relevantFacts(policy)
    .map((name) => [name, facts[name]] as const)
    .sort((a, b) => Number(typeof b[1] === "boolean") - Number(typeof a[1] === "boolean"));
  const label = VERDICT_LABEL[status.verdict];
  return (
    <section className={`card status-${status.verdict}`}>
      <div className="party-head">
        <div>
          <h2>{party.name}</h2>
          <code className="meta" title={party.address}>
            {short(party.address, 8, 6)}
          </code>
        </div>
        <span
          className={`chip chip-${status.verdict}`}
          title={
            credit
              ? `getCredential → ${status.onchain.allowed && party.screenedAt ? party.screenedAt : 0}`
              : undefined
          }
        >
          {label}
          {party.resolution ? ` · ${party.resolution}` : ""}
        </span>
      </div>

      <p className="actions-line">
        {actions.map((action) => {
          const verdict = explain(policy, action, facts).verdict;
          return (
            <span key={action}>
              {actionLabel(action)}{" "}
              <Glyph state={verdict} title={`${actionLabel(action)}: ${VERDICT_LABEL[verdict]}`} />
            </span>
          );
        })}
      </p>

      {!status.onchain.allowed && (
        <blockquote className="why">
          <Refusal policy={policy} action={statusAction(policy)} clauseId={status.onchain.clauseId} />
        </blockquote>
      )}

      <ul className="facts-list" aria-label={credit ? "Facts the contract reads" : "Onboarding facts"}>
        {shown.map(([name, value]) => (
          <li key={name} title={`${name} · ${FACT_KIND_LABEL[factKind(policy.profile, name)]}`}>
            <Glyph state={triState(value)} />
            <span>{factLabel(name)}</span>
          </li>
        ))}
      </ul>

      {credit && (
        <>
          <p className="meta" style={{ marginTop: 8 }} title={OBSERVABLE_SOURCE.sanctionsClear}>
            Sanctions screening: {party.sanctions}
          </p>
          <p className="meta">
            {party.screenedAt
              ? `Screened ${unix(party.screenedAt)}${expiry ? ` · credential expires ${unix(expiry)}` : ""}`
              : "Never screened: every attested fact is unknown"}
          </p>
        </>
      )}

      {!credit && party.role !== "borrower" && (
        <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
          <HumanCheck profile={policy.profile} party={party} />
          {party.facts.identityVerified !== true &&
            others
              .filter((other) => other.facts.identityVerified === true && other.id !== party.id)
              .slice(0, 1)
              .map((other) => (
                <HumanCheck key={other.id} profile={policy.profile} party={party} asParty={other} />
              ))}
        </div>
      )}
      {credit && party.screenedAt !== null && party.role !== "borrower" && (
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn-sm"
            disabled={busy}
            title="PolicyAttestor.revokeFacts — no reason string on chain"
            onClick={async () => {
              setBusy(true);
              await source.revoke(policy.profile, party.id).finally(() => setBusy(false));
            }}
          >
            Revoke attestation
          </button>
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
      <PageHead title={credit ? "Who may lend" : "Who may hold"}>
        Each wallet's standing under the contract, decided the same way the chain decides it.
      </PageHead>
      {error && <Failed error={error} />}
      {(!policy.data || !parties.data) && !error && <Loading what="parties" />}
      {policy.data && parties.data && (
        <div className="parties">
          {parties.data.map((party) => (
            <PartyCard key={party.id} policy={policy.data!} party={party} others={parties.data!} />
          ))}
        </div>
      )}
    </>
  );
}
