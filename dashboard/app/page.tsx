"use client";

import { Failed, Loading, PageHead } from "./_components/common";
import { Workspace } from "./_policy/Workspace";
import { usePolicy } from "./providers";

/** Policy: the document, every quoted span, and what each one became on chain. */
export default function PolicyPage() {
  const { data: policy, error } = usePolicy();
  return (
    <>
      <PageHead title="Legal clause → smart contract">
        Click a highlighted sentence to follow it from quote to rule to the contract that enforces it.
      </PageHead>
      {error && <Failed error={error} />}
      {!policy && !error && <Loading what="compiled policy" />}
      {policy && <Workspace key={policy.profile} policy={policy} />}
    </>
  );
}
