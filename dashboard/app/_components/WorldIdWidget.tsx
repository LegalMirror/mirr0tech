"use client";

import dynamic from "next/dynamic";
import { passport, proofOfHuman, selfieCheck } from "@worldcoin/idkit";
import type { WorldIdContext } from "@/lib/types";

const IDKitRequestWidget = dynamic(
  () => import("@worldcoin/idkit").then((module) => module.IDKitRequestWidget),
  { ssr: false }
);

/** IDKit collects the proof; only the caller's server response can establish an attestation. */
export function WorldIdWidget({
  context,
  wallet,
  onProof,
  onClose,
  onError,
}: {
  context: WorldIdContext;
  wallet: string;
  onProof: (proof: unknown) => Promise<void>;
  onClose: () => void;
  onError: (code: string) => void;
}) {
  return (
    <IDKitRequestWidget
      app_id={context.app_id as `app_${string}`}
      action={context.action}
      rp_context={context.rp_context}
      allow_legacy_proofs={false}
      preset={
        context.credential === "document"
          ? passport({ signal: wallet.toLowerCase() })
          : context.credential === "proof_of_human"
            ? proofOfHuman({ signal: wallet.toLowerCase() })
            : selfieCheck({ signal: wallet.toLowerCase() })
      }
      environment={context.environment as "production" | "staging"}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      handleVerify={onProof}
      onSuccess={onClose}
      onError={(code) => onError(code)}
    />
  );
}
