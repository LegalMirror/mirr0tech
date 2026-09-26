"use client";

import { fetchLedger } from "@/lib/ledger";
import { short } from "@/lib/format";
import { useResource } from "@/lib/hooks";
import { Failed, Loading, PageHead } from "../_components/common";
import { Boundaries, Decisions, Supply } from "./LedgerCards";

/** The agreement's policy as the chain recorded it, indexed by Curvegrid MultiBaas. */
export default function LedgerPage() {
  const ledger = useResource(() => fetchLedger(), []);
  return (
    <>
      <PageHead title="Policy ledger">
        What the agreement allowed and refused, read from chain events that Curvegrid MultiBaas indexes: the hook&apos;s decisions,
        the attestations behind them, and the shares issued.
      </PageHead>
      {ledger.error && <Failed error={ledger.error} />}
      {!ledger.data && !ledger.error && <Loading what="the indexed ledger" />}
      {ledger.data && (
        <>
          <p className="meta">
            Agreement {ledger.data.agreement} · policy {short(ledger.data.policyHash, 10, 6)} · indexed{" "}
            {ledger.data.contracts.map((c) => c.alias).join(", ")} · {ledger.data.cached ? "cached" : "fresh"} at {ledger.data.fetchedAt}
          </p>
          <Boundaries ledger={ledger.data} />
          <Decisions ledger={ledger.data} />
          <Supply ledger={ledger.data} />
        </>
      )}
    </>
  );
}
