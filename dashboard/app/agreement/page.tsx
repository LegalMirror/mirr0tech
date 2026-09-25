"use client";

import { Failed, Loading, PageHead } from "../_components/common";
import { Workspace } from "../_policy/Workspace";
import { usePolicy } from "../providers";

/** Policy: the document, every quoted span, and what each one became on chain. */
export default function PolicyPage() {
  const { data: policy, error } = usePolicy();
  return (
    <>
      <PageHead title="Which sentences run on-chain?">
        The agreement, with every sentence that became an enforceable rule highlighted. Click one to see what
        it does and where it runs.
      </PageHead>
      {error && <Failed error={error} />}
      {!policy && !error && <Loading what="compiled policy" />}
      {policy && <Workspace key={policy.profile} policy={policy} />}
    </>
  );
}
