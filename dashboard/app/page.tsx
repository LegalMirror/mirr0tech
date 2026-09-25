"use client";

import { useRouter } from "next/navigation";
import { source } from "@/lib/adapter";
import { KIND_LABEL, VERDICT_LABEL } from "@/lib/labels";
import { proofLinks, standings } from "@/lib/overview";
import type { AuditEvent, Party, PolicyData, ProfileId, ProfileSummary } from "@/lib/types";
import { useResource } from "@/lib/hooks";
import { Failed, Glyph, Loading, PageHead } from "./_components/common";
import { useProfile } from "./providers";

type ActData = { summary: ProfileSummary; policy: PolicyData; parties: Party[]; events: AuditEvent[] };

async function loadActs(): Promise<ActData[]> {
  const summaries = await source.profiles();
  return Promise.all(
    summaries.map(async (summary) => {
      const [policy, parties, events] = await Promise.all([
        source.policy(summary.profile),
        source.parties(summary.profile),
        source.audit(summary.profile),
      ]);
      return { summary, policy, parties, events };
    })
  );
}

function ActCard({ act }: { act: ActData }) {
  const router = useRouter();
  const { setProfile } = useProfile();
  const { summary, policy, parties, events } = act;
  const coverage = summary.coverage ?? policy.coverage;
  const open = (profile: ProfileId) => {
    setProfile(profile);
    router.push("/agreement");
  };
  return (
    <section className="card act-card">
      <div className="eyebrow">
        Act {summary.act} · {summary.label}
      </div>
      <h2>{policy.title.replace(" — executable subset", "")}</h2>
      <p className="meta">{summary.venue}</p>
      <p className="small">
        <strong>{coverage.counts.compiled}</strong> of {coverage.total} paragraphs are enforced on-chain as{" "}
        {coverage.rules} rules
        {coverage.terms ? ` and ${coverage.terms} values` : ""} · {coverage.counts.unresolved} open items
      </p>
      <ul className="standings">
        {standings(policy, parties).map(({ party, verdict }) => (
          <li key={party.id}>
            <Glyph state={verdict} /> {party.name.split(" — ")[0]}{" "}
            <span className="meta">{VERDICT_LABEL[verdict]}</span>
          </li>
        ))}
      </ul>
      {proofLinks(events).length > 0 && (
        <p className="meta">
          On Sepolia:{" "}
          {proofLinks(events).map((event, index) => (
            <span key={event.id}>
              {index > 0 && " · "}
              <a href={event.explorer!} target="_blank" rel="noreferrer">
                {KIND_LABEL[event.kind] ?? event.kind} ↗
              </a>
            </span>
          ))}
        </p>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => open(summary.profile)}>
          Open the agreement
        </button>
      </div>
    </section>
  );
}

/** The story in one screen: one asset, both acts, who stands where, and the transactions that prove it. */
export default function OverviewPage() {
  const acts = useResource(() => loadActs(), []);
  return (
    <>
      <PageHead title="One asset, its whole legal life">
        A legal agreement goes in. Out comes the code that admits, refuses and pays under it, with every
        refusal naming its sentence. Act 1 tokenizes and trades a fund; Act 2 lends it out.
      </PageHead>
      {acts.error && <Failed error={acts.error} />}
      {!acts.data && !acts.error && <Loading what="the story" />}
      {acts.data && (
        <div className="overview-grid">
          {acts.data.map((act) => (
            <ActCard key={act.summary.profile} act={act} />
          ))}
        </div>
      )}
    </>
  );
}
