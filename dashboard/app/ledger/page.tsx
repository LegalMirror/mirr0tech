"use client";

import { fetchLedger } from "@/lib/ledger";
import { fmtTime, short } from "@/lib/format";
import { useResource } from "@/lib/hooks";
import { Failed, Loading, PageHead } from "../_components/common";
import { Boundaries, Decisions, Supply } from "./LedgerCards";

/** The agreement's policy as the chain recorded it, indexed by Curvegrid MultiBaas. */
export default function LedgerPage() {
  const ledger = useResource(() => fetchLedger(), []);
  return (
    <>
      <PageHead title="Policy ledger">
        What the hook allowed and refused, indexed by Curvegrid MultiBaas.
      </PageHead>
      {ledger.error && <Failed error={ledger.error} />}
      {!ledger.data && !ledger.error && <Loading what="the indexed ledger" />}
      {ledger.data && (
        <>
          <p className="meta">
            {ledger.data.agreement} · policy {short(ledger.data.policyHash, 10, 6)} · {ledger.data.contracts.length} contracts ·{" "}
            {ledger.data.snapshot ? "snapshot" : ledger.data.cached ? "cached" : "fresh"} {fmtTime(ledger.data.fetchedAt)}
            {ledger.data.quota && ` · ${ledger.data.quota.calls} MultiBaas calls, ${ledger.data.quota.cacheHits} cache hits`}
          </p>
          <Boundaries ledger={ledger.data} />
          <Decisions ledger={ledger.data} />
          <Supply ledger={ledger.data} />
        </>
      )}
    </>
  );
}
