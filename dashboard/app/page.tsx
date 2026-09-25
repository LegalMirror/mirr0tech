"use client";

import { Failed, Loading, PageHead } from "./_components/common";
import { Workspace } from "./_policy/Workspace";
import { usePolicy } from "./providers";

/** Policy: the document, every quoted span, and what each one became on chain. */
export default function PolicyPage() {
  const { data: policy, error } = usePolicy();
  return (
    <>
      <PageHead eyebrow="Policy" title="Legal clause → smart contract">
        Hover a highlighted sentence to find the rule it became; click it to follow the quote through the rule, its
        logic, its bytes and the contract that enforces it.
      </PageHead>
      {error && <Failed error={error} />}
      {!policy && !error && <Loading what="compiled policy" />}
      {policy && <Workspace key={policy.profile} policy={policy} />}
    </>
  );
}
