"use client";

import dynamic from "next/dynamic";
import { orbLegacy, type RpContext, type IDKitDebugReport } from "@worldcoin/idkit";

const SessionWidget = dynamic(() => import("@worldcoin/idkit").then((m) => m.IDKitSessionWidget), {
  ssr: false,
});
const RequestWidget = dynamic(() => import("@worldcoin/idkit").then((m) => m.IDKitRequestWidget), {
  ssr: false,
});
export type LoginChallenge = {
  challengeToken: string;
  signal: string;
  app_id: `app_${string}`;
  rp_context: RpContext;
} & ({ environment: "staging" | "production"; action: string } | { environment: "sandbox" });

export function WorldLoginWidget({
  challenge,
  existingSession,
  onProof,
  onClose,
  onError,
}: {
  challenge: LoginChallenge;
  existingSession?: `session_${string}`;
  onProof: (proof: unknown) => Promise<void>;
  onClose: () => void;
  onError: (code: string, report?: IDKitDebugReport) => void;
}) {
  const shared = {
    app_id: challenge.app_id,
    rp_context: challenge.rp_context,
    open: true,
    onOpenChange: (open: boolean) => {
      if (!open) onClose();
    },
    handleVerify: onProof,
    onSuccess: onClose,
    onError,
  };
  // Staging is the simulator; production is a real World App. Both are legacy Orb requests under an action.
  return challenge.environment !== "sandbox" ? (
    <RequestWidget
      {...shared}
      environment={challenge.environment}
      action={challenge.action}
      allow_legacy_proofs={true}
      preset={orbLegacy({ signal: challenge.signal })}
    />
  ) : (
    <SessionWidget
      {...shared}
      environment="sandbox"
      // Selfie Check is the credential World documents for sandbox; the React session widget takes it as a constraint.
      constraints={{ type: "selfie", signal: challenge.signal }}
      existing_session_id={existingSession}
    />
  );
}
