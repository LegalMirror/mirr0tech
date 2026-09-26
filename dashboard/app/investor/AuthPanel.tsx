"use client";

import { useRef, useState } from "react";
import { WorldIdWidget } from "../_components/WorldIdWidget";
import { identityFailure } from "@/lib/identity";
import { investorSession, validateChallenge, validateInvestorSession } from "@/lib/investor/session";
import { signChallenge, assertWallet } from "@/lib/investor/wallet";
import { SEPOLIA, type InvestorChallenge } from "@/lib/investor/types";
import type { InvestorState } from "./useInvestor";

export function AuthPanel({ state }: { state: InvestorState }) {
  const [challenge, setChallenge] = useState<InvestorChallenge | null>(null);
  const signature = useRef<string | null>(null);
  const [stage, setStageState] = useState("idle");
  const stageRef = useRef("idle");
  const stageTo = (value: string) => {
    stageRef.current = value;
    setStageState(value);
  };
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const operation = useRef<ReturnType<InvestorState["begin"]> | null>(null);
  const { fund, config, wallet, provider } = state;
  const busy = ["challenge", "signing", "world", "verifying"].includes(stage);
  const unavailable = !fund
    ? "Choose a published fund."
    : !config?.chainId
      ? "The gateway has no configured investor chain yet."
      : fund.chainId !== SEPOLIA || config.chainId !== SEPOLIA
        ? "This investor dashboard signs on Sepolia only. Local Anvil funds can be inspected in the issuer workbench."
        : config.mock
          ? "Synthetic investor login is not permitted on Sepolia. The gateway must be configured for World Sandbox Passport verification."
          : config.credential !== "document"
            ? "This investor login requires the Passport credential. Ask the issuer to publish the appropriate configuration."
            : !provider?.on || !provider?.removeListener
              ? "Connect a Sepolia-capable EIP-1193 wallet with account/chain change events."
              : !wallet
                ? "Connect a Sepolia-capable wallet first."
                : wallet.chainId !== SEPOLIA
                  ? "Switch your wallet to Sepolia first."
                  : state.publicError || null;
  async function prepare() {
    if (unavailable || !fund || !config || !wallet || !provider) return;
    const op = state.begin();
    operation.current = op;
    signature.current = null;
    setChallenge(null);
    setConsent(false);
    setMessage("");
    stageTo("challenge");
    try {
      await assertWallet(provider, wallet, op.current);
      const next = await state.client.challenge(wallet.address, fund.id, op.signal);
      if (!op.current()) return;
      validateChallenge(next, wallet.address, fund, config, Date.now(), window.location.origin);
      setChallenge(next);
      stageTo("review");
    } catch (error) {
      if (op.current()) {
        setMessage((error as Error).message);
        stageTo("error");
      }
    } finally {
      op.finish();
    }
  }
  async function sign() {
    if (!challenge || !fund || !config || !wallet || !provider || !consent || busy) return;
    const op = state.begin();
    operation.current = op;
    setMessage("");
    stageTo("signing");
    try {
      validateChallenge(challenge, wallet.address, fund, config, Date.now(), window.location.origin);
      const signed = await signChallenge(provider, wallet, challenge.message, op.current);
      if (!op.current()) return;
      validateChallenge(challenge, wallet.address, fund, config, Date.now(), window.location.origin);
      signature.current = signed;
      stageTo("world");
    } catch (error) {
      if (op.current()) {
        state.report(error);
        setMessage("The wallet signature was not accepted. Request a fresh sign-in challenge when ready.");
        setChallenge(null);
        stageTo("error");
      }
      op.finish();
    }
  }
  async function proofReceived(proof: unknown) {
    const op = operation.current;
    if (
      !op?.current() ||
      stageRef.current !== "world" ||
      !signature.current ||
      !challenge ||
      !fund ||
      !config ||
      !wallet ||
      !provider
    )
      throw new Error("This sign-in request is no longer active.");
    stageTo("verifying");
    try {
      validateChallenge(challenge, wallet.address, fund, config, Date.now(), window.location.origin);
      await assertWallet(provider, wallet, op.current);
      const result = await state.client.verify(challenge.challengeId, signature.current, proof, op.signal);
      await assertWallet(provider, wallet, op.current);
      if (!op.current()) return;
      investorSession.set(validateInvestorSession(result, challenge, fund));
      stageTo("authenticated");
    } catch (error) {
      if (op.current()) {
        setMessage(identityFailure(error).detail);
        setChallenge(null);
        stageTo("error");
      }
      throw error;
    } finally {
      signature.current = null;
      op.finish();
    }
  }
  function cancel() {
    if (stageRef.current !== "world") return;
    signature.current = null;
    operation.current?.finish();
    setChallenge(null);
    stageTo("cancelled");
    setMessage(
      "World request cancelled. No investor session or on-chain admission was granted. Request a fresh challenge to retry."
    );
  }
  return (
    <section className="iv-card iv-auth" aria-labelledby="investor-signin">
      <div className="iv-card-heading">
        <span className="iv-kicker">02 / WORLD PASSPORT</span>
        <h2 id="investor-signin">Sign in with World ID</h2>
      </div>
      <p>
        Use your Passport credential in the configured World environment. No second Orb check is required. The
        server verifies the proof and binds this session to your wallet and this fund.
      </p>
      <p className="iv-note">
        Sign-in is not on-chain admission, KYC/AML approval, sanctions clearance or accreditation. Identity
        attestation is a separate step below.
      </p>
      {wallet && (
        <div className="iv-wallet-confirm">
          <span>Confirmed wallet · Sepolia required</span>
          <code>{wallet.address}</code>
        </div>
      )}
      {unavailable && <p className="iv-notice">{unavailable}</p>}
      {message && (
        <p className="iv-notice iv-error" role="alert">
          {message}
        </p>
      )}
      {challenge && stage === "review" ? (
        <>
          <details>
            <summary>Review the exact wallet sign-in message</summary>
            <pre>{challenge.message}</pre>
          </details>
          <p className="iv-note">
            Expires {new Date(challenge.expiresAt * 1000).toLocaleTimeString()}. This signature authenticates
            your wallet; it does not send a transaction.
          </p>
          <label className="iv-check">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            I confirm the wallet, fund and sign-in message.
          </label>
          <div className="iv-actions">
            <button className="iv-primary" onClick={sign} disabled={!consent || !!unavailable}>
              Sign message & open World ID
            </button>
            <button
              onClick={() => {
                setChallenge(null);
                signature.current = null;
                stageTo("idle");
              }}
            >
              Cancel sign-in
            </button>
          </div>
        </>
      ) : (
        <button className="iv-primary" onClick={prepare} disabled={!!unavailable || busy}>
          {stage === "challenge"
            ? "Requesting sign-in challenge…"
            : stage === "signing"
              ? "Confirm the message in your wallet…"
              : stage === "world"
                ? "Waiting for World Passport…"
                : stage === "verifying"
                  ? "Waiting for server verification…"
                  : stage === "error" || stage === "cancelled"
                    ? "Retry with a fresh challenge"
                    : "Sign in with World ID"}
        </button>
      )}
      <p className="iv-privacy">
        This app sends your wallet signature and the complete World proof to the gateway—not a raw passport
        image. The opaque investor token stays in memory only. World handles its credential data; the gateway
        retains its wallet/nullifier binding. No operator key is requested.
      </p>
      {stage === "world" && challenge && wallet && (
        <WorldIdWidget
          context={challenge.world}
          wallet={wallet.address}
          onProof={proofReceived}
          onClose={cancel}
          onError={(code) => {
            if (stageRef.current !== "world") return;
            signature.current = null;
            operation.current?.finish();
            setMessage(identityFailure(code).detail);
            setChallenge(null);
            stageTo("error");
          }}
        />
      )}
    </section>
  );
}
