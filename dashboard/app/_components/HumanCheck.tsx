"use client";

import { useRef, useState } from "react";
import { source } from "@/lib/adapter";
import { mockProof } from "@/lib/worldid";
import {
  CREDENTIAL_COPY,
  IDENTITY_PRIVACY,
  contextIssue,
  identityFailure,
  verifierLabel,
} from "@/lib/identity";
import type { Party, ProfileId, WorldIdContext } from "@/lib/types";
import { WorldIdWidget } from "./WorldIdWidget";

/** Classic profile screens share IDKit, but never treat its completion callback as authorization. */
export function HumanCheck({
  profile,
  party,
  asParty,
  service = source,
}: {
  profile: ProfileId;
  party: Party;
  asParty?: Party;
  service?: Pick<typeof source, "worldIdContext" | "verifyHuman">;
}) {
  const [context, setContext] = useState<WorldIdContext | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const submitted = useRef(false);
  if (party.facts.identityVerified === true && !asParty && !result) return null;
  async function prepare() {
    setBusy(true);
    setMessage("");
    setConsent(false);
    setResult("");
    try {
      const ctx = await service.worldIdContext();
      const issue = contextIssue(ctx, ctx.credential);
      if (issue) throw new Error(issue);
      if (asParty && !ctx.mock)
        throw new Error(
          "Another wallet's proof can only be simulated in demo mode. A live proof must come from the required credential holder and be bound to this wallet."
        );
      setContext(ctx);
    } catch (error) {
      setMessage(identityFailure(error).detail);
    } finally {
      setBusy(false);
    }
  }
  async function submit(proof: unknown) {
    setBusy(true);
    submitted.current = true;
    try {
      const updated = await service.verifyHuman(profile, party.id, proof);
      if (
        updated.address.toLowerCase() !== party.address.toLowerCase() ||
        updated.facts.identityVerified !== true
      )
        throw new Error(
          "The gateway has not returned an identity fact for this wallet. Refresh access before retrying."
        );
      setResult(
        context?.mock
          ? "Demo identity fact recorded—not real credential verification."
          : "The gateway returned the identity fact. Other policy requirements still apply; inspect refreshed access."
      );
      setContext(null);
    } catch (error) {
      setMessage(identityFailure(error).detail);
      throw error;
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }
  async function start() {
    if (!context || !consent) return;
    const issue = contextIssue(context, context.credential);
    if (issue) {
      setMessage(issue);
      return;
    }
    submitted.current = false;
    setMessage("");
    if (context.mock) {
      try {
        await submit(
          await mockProof(party.address, context.action, (asParty ?? party).address, context.credential)
        );
      } catch {
        /* error is displayed; no false success */
      }
    } else setOpen(true);
  }
  function close() {
    setOpen(false);
    if (!submitted.current)
      setMessage("Request cancelled. No new access was granted by this browser. You can retry.");
  }
  return (
    <span className="human-check">
      <button className="btn-sm" disabled={busy || open} onClick={prepare}>
        {asParty ? `Demo: use ${asParty.name.split(" — ")[0]}'s proof` : "Review World ID check"}
      </button>
      {message && (
        <span className="meta error" role="alert">
          {" "}
          {message}
        </span>
      )}
      {result && (
        <span className="meta" role="status">
          {" "}
          {result}
        </span>
      )}
      {context && (
        <span className="human-check-review">
          <strong>
            {verifierLabel(context)} · {CREDENTIAL_COPY[context.credential].label}
          </strong>
          <code>{party.address}</code>
          <span>{CREDENTIAL_COPY[context.credential].limit}</span>
          <span>{IDENTITY_PRIVACY}</span>
          <label>
            <input
              type="checkbox"
              checked={consent}
              disabled={busy || open}
              onChange={(event) => setConsent(event.target.checked)}
            />{" "}
            I confirm this wallet and credential.
          </label>
          <button disabled={!consent || busy || open} onClick={start}>
            {busy ? "Waiting for gateway…" : context.mock ? "Run demo proof" : "Continue with World ID"}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              close();
              setContext(null);
            }}
          >
            Cancel
          </button>
        </span>
      )}
      {context && open && !context.mock && (
        <WorldIdWidget
          context={context}
          wallet={party.address}
          onProof={submit}
          onClose={close}
          onError={(code) => {
            if (!submitted.current) setMessage(identityFailure(code).detail);
            setOpen(false);
          }}
        />
      )}
    </span>
  );
}
