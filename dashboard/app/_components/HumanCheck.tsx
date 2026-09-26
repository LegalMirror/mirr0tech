"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { passport, proofOfHuman, selfieCheck } from "@worldcoin/idkit";
import { source } from "@/lib/adapter";
import { mockProof } from "@/lib/worldid";
import type { Party, ProfileId, WorldIdContext } from "@/lib/types";

// The IDKit widget only when an app is registered; it is client-only.
const IDKitRequestWidget = dynamic(() => import("@worldcoin/idkit").then((m) => m.IDKitRequestWidget), {
  ssr: false,
});

/**
 * "Verify with World ID" for a wallet: the KYC identity step of Exhibit A. With a registered app the
 * World ID widget asks for the configured credential (a passport by default) and the proof goes to
 * the gateway; without one, a mock proof is submitted so the flow still runs.
 * `asParty` submits the proof of another wallet's human: the one-human-one-wallet refusal.
 */
export function HumanCheck({
  profile,
  party,
  asParty,
}: {
  profile: ProfileId;
  party: Party;
  asParty?: Party;
}) {
  const [context, setContext] = useState<WorldIdContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (party.facts.identityVerified === true && !asParty) return null;

  const submit = async (proof: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await source.verifyHuman(profile, party.id, proof);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const ctx = await source.worldIdContext();
      if (ctx.mock) await submit(await mockProof(party.address, ctx.action, (asParty ?? party).address));
      else setContext(ctx);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="human-check">
      <button
        className="btn-sm"
        disabled={busy}
        onClick={start}
        title="World ID document credential (Passport/NFC), bound to this wallet"
      >
        {asParty ? `Use ${asParty.name.split(" — ")[0]}'s proof` : "Verify with World ID"}
      </button>
      {error && <span className="meta error"> {error}</span>}
      {context && !context.mock && (
        <IDKitRequestWidget
          app_id={context.app_id as `app_${string}`}
          action={context.action}
          rp_context={context.rp_context}
          allow_legacy_proofs
          preset={
            context.credential === "proof_of_human"
              ? proofOfHuman({ signal: party.address })
              : context.credential === "selfie"
                ? selfieCheck({ signal: party.address })
                : passport({ signal: party.address })
          }
          environment={context.environment as "production" | "staging"}
          open
          onOpenChange={(open: boolean) => !open && setContext(null)}
          handleVerify={async (result: unknown) => {
            await submit({ ...(result as object), action: context.action });
          }}
          onSuccess={() => setContext(null)}
        />
      )}
    </span>
  );
}
