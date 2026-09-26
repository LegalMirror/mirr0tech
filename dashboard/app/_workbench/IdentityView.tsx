"use client";

import { useEffect, useRef, useState } from "react";
// import Link from "next/link"; // Restore with the investor dashboard link.
import type {
  AgreementDetail,
  AgreementsClient,
  AgreementWallet,
  Constraints,
  IdentityConstraint,
  IdentityReceipt,
} from "@/lib/agreements";
import type { PolicyData, WorldIdContext } from "@/lib/types";
import {
  CREDENTIAL_COPY,
  IDENTITY_PRIVACY,
  attestationConfirmed,
  attestationReceipt,
  contextIssue,
  identityFailure,
  readAccess,
  remainingRules,
  sampleIdentity,
  verifierLabel,
  type AccessSnapshot,
} from "@/lib/identity";
import { actionLabel } from "@/lib/labels";
import { mockProof } from "@/lib/worldid";
import { WorldIdWidget } from "../_components/WorldIdWidget";
import { Icon, Notice } from "./ui";

export function IdentityPolicy({
  identity,
  sample,
  onTrace,
}: {
  identity: IdentityConstraint;
  sample: boolean;
  onTrace?: () => void;
}) {
  const copy = CREDENTIAL_COPY[identity.credential];
  return (
    <section className="wb-identity-policy wb-surface">
      <span className="wb-eyebrow">{sample ? "EXPORTED POLICY" : "ISSUER'S TRUST DECISION"}</span>
      <h3>{copy.label}</h3>
      <p>{copy.purpose}</p>
      <p className="wb-identity-limits">{copy.limit}</p>
      <div className="wb-protected-actions">
        <span>Required for</span>
        {identity.actions.map((action) => (
          <span key={action}>{actionLabel(action)}</span>
        ))}
      </div>
      <figure>
        <figcaption>Verbatim clause · {identity.clause}</figcaption>
        <blockquote>{identity.quote}</blockquote>
      </figure>
      <p className="wb-muted">
        Minimum sufficient for the credential condition—not the whole contract. The issuer must justify this
        choice against the quoted clause.
      </p>
      {onTrace && (
        <button onClick={onTrace}>
          Trace this clause in the AST <Icon name="arrow" size={14} />
        </button>
      )}
    </section>
  );
}

export function IdentityAccess({
  snapshot,
  policy,
}: {
  snapshot: AccessSnapshot | null;
  policy: PolicyData;
}) {
  return (
    <section className="wb-access" aria-label="Actual protected action access">
      <h3>What can this wallet do?</h3>
      <p className="wb-muted">
        Current gateway /explain reads—not an optimistic client unlock. Policy permission alone does not
        guarantee execution, balances or settlement.
      </p>
      {!snapshot ? (
        <p role="status">No current access read yet.</p>
      ) : (
        snapshot.decisions.map(({ action, decision, error }) => (
          <article key={action} className="wb-access-action">
            <div>
              <strong>{actionLabel(action)}</strong>
              <span className={`wb-access-state ${decision?.allowed === false ? "is-blocked" : ""}`}>
                {!decision ? "Unknown" : decision.allowed ? "Policy allows" : "Blocked"}
              </span>
            </div>
            {error && <p role="alert">Access read failed: {error}</p>}
            {decision && (
              <>
                <p>
                  Identity condition:{" "}
                  {decision.facts.identityVerified === true ? "fact present" : "not established"}
                  {decision.sanctioned ? " · sanctions flag reported" : ""}
                  {!decision.screeningCurrent ? " · screening not current" : ""}
                </p>
                <dl className="wb-access-facts" aria-label="Compliance facts returned by the gateway">
                  {Object.entries({
                    kycApproved: "KYC approval",
                    amlApproved: "AML approval",
                    sanctionsClear: "Sanctions clearance",
                  })
                    .filter(([name]) => name in decision.facts)
                    .map(([name, label]) => (
                      <div key={name}>
                        <dt>{label}</dt>
                        <dd>
                          {decision.facts[name] === true
                            ? "attested"
                            : decision.facts[name] === false
                              ? "not satisfied"
                              : "not established"}
                        </dd>
                      </div>
                    ))}
                </dl>
                {!decision.allowed && (
                  <p className="wb-access-reason">
                    {decision.clause
                      ? `${decision.clause.clause} — “${decision.clause.quote}”`
                      : "No matching permission / no source clause returned."}
                  </p>
                )}
                {!!remainingRules(policy, decision).length && (
                  <details>
                    <summary>
                      Remaining policy requirements ({remainingRules(policy, decision).length})
                    </summary>
                    <p className="wb-muted">
                      Local interpretation of the returned facts; the gateway decision above is authoritative.
                    </p>
                    <ul>
                      {remainingRules(policy, decision).map((rule) => (
                        <li key={rule.id}>
                          <strong>{rule.clause}</strong>
                          <p>{rule.quote}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </article>
        ))
      )}
    </section>
  );
}

type Phase =
  | "idle"
  | "preparing"
  | "request"
  | "submitting"
  | "refreshing"
  | "confirmed"
  | "pending"
  | "denied"
  | "cancelled";
function WalletTrustFlow({
  client,
  record,
  policy,
  identity,
  wallet,
  initialContext,
  writable,
}: {
  client: AgreementsClient;
  record: AgreementDetail;
  policy: PolicyData;
  identity: IdentityConstraint;
  wallet: AgreementWallet;
  initialContext: WorldIdContext;
  writable: boolean;
}) {
  const [context, setContext] = useState(initialContext);
  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null);
  const [receipt, setReceipt] = useState<IdentityReceipt | null>(null);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const setPhase = (value: Phase) => {
    phaseRef.current = value;
    setPhaseState(value);
  };
  const [failure, setFailure] = useState<ReturnType<typeof identityFailure> | null>(null);
  const [readError, setReadError] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [consent, setConsent] = useState(false);
  const [widget, setWidget] = useState(false);
  const active = useRef(true);
  const reads = useRef<AbortController | null>(null);
  const busy = ["preparing", "request", "submitting", "refreshing"].includes(phase);
  const issue = contextIssue(context, identity.credential);
  const confirmed = attestationConfirmed(receipt, snapshot);
  async function refresh(accepted = receipt) {
    reads.current?.abort();
    const controller = new AbortController();
    reads.current = controller;
    setReadError("");
    try {
      const value = await readAccess(client, record.id, wallet.address, identity.actions, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      setSnapshot(value);
      setCheckedAt(new Date().toLocaleTimeString());
      if (accepted) setPhase(attestationConfirmed(accepted, value) ? "confirmed" : "pending");
    } catch (error) {
      if (!active.current || controller.signal.aborted) return;
      setReadError((error as Error).message);
      if (accepted) setPhase("pending");
    }
  }
  useEffect(() => {
    active.current = true;
    void refresh(null);
    return () => {
      active.current = false;
      reads.current?.abort();
    };
    // Mounted afresh for each agreement policy and wallet; proof state must never follow another wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(proof: unknown) {
    if (["submitting", "refreshing", "confirmed"].includes(phaseRef.current))
      throw new Error("This request has already been submitted.");
    setPhase("submitting");
    setFailure(null);
    try {
      // Forward the complete IDKit payload unchanged. No remapped action, signal, schema or integrity bundle.
      const accepted = await client.verifyHuman(record.id, wallet.address, proof);
      if (!active.current) return;
      if (!attestationReceipt(accepted, wallet))
        throw new Error(
          "The gateway did not return a confirmed identity attestation receipt. Refresh access before retrying."
        );
      setReceipt(accepted);
      setPhase("refreshing");
      await refresh(accepted);
    } catch (error) {
      if (active.current) {
        setFailure(identityFailure(error));
        setPhase("denied");
      }
      throw error;
    } finally {
      if (active.current) setWidget(false);
    }
  }
  async function start() {
    if (!writable || !consent || busy) return;
    setPhase("preparing");
    setFailure(null);
    try {
      const fresh = await client.worldIdContext(record.id);
      if (!active.current) return;
      setContext(fresh);
      const problem = contextIssue(fresh, identity.credential);
      if (problem) throw new Error(problem);
      if (
        ["mock", "environment", "action", "app_id", "rp_id"].some(
          (key) => fresh[key as keyof WorldIdContext] !== context[key as keyof WorldIdContext]
        )
      ) {
        setConsent(false);
        throw new Error("Verifier settings changed. Review the new mode and confirm this wallet again.");
      }
      if (fresh.mock)
        await submit(await mockProof(wallet.address, fresh.action, wallet.address, fresh.credential));
      else {
        setPhase("request");
        setWidget(true);
      }
    } catch (error) {
      if (active.current) {
        setFailure(identityFailure(error));
        setPhase("denied");
      }
    }
  }
  async function refreshContext() {
    setPhase("preparing");
    setFailure(null);
    try {
      const fresh = await client.worldIdContext(record.id);
      if (!active.current) return;
      setContext(fresh);
      setConsent(false);
      setPhase("idle");
    } catch (error) {
      if (active.current) {
        setFailure(identityFailure(error));
        setPhase("denied");
      }
    }
  }
  const closeWidget = () => {
    setWidget(false);
    if (phaseRef.current === "request") {
      setFailure(identityFailure("cancelled"));
      setPhase("cancelled");
    }
  };
  const handleWidgetError = (code: string) => {
    setWidget(false);
    if (["submitting", "refreshing", "confirmed", "pending", "denied"].includes(phaseRef.current)) return;
    const reason = identityFailure(code);
    setFailure(reason);
    setPhase(reason.cancelled ? "cancelled" : "denied");
  };
  return (
    <div className="wb-identity-live-grid">
      <section className="wb-identity-confirm wb-surface">
        <span className="wb-eyebrow">WALLET-BOUND REQUEST</span>
        <h3>One credential. One policy fact.</h3>
        <span className={`wb-verifier-mode ${context.mock ? "is-demo" : ""}`}>{verifierLabel(context)}</span>
        <dl className="wb-dl">
          <dt>Receiving wallet · confirm carefully</dt>
          <dd>
            <strong>{wallet.name}</strong>
            <code className="wb-wallet-address">{wallet.address}</code>
          </dd>
          <dt>Required credential</dt>
          <dd>{CREDENTIAL_COPY[identity.credential].label}</dd>
          <dt>World action / signal</dt>
          <dd>
            <code>{context.action}</code> / the exact wallet address above
          </dd>
        </dl>
        <p className="wb-muted">
          Selecting a gateway wallet does not prove you own its keys. The proof is bound to this address; the
          gateway must validate that binding.
        </p>
        {context.mock && (
          <Notice>
            Demo proof only. No World App or real credential is checked. The gateway may still send an
            attestation transaction using its configured signer.
          </Notice>
        )}
        {issue && (
          <Notice error>
            {issue}{" "}
            {!receipt && (
              <button disabled={busy} onClick={refreshContext}>
                Refresh verifier request
              </button>
            )}
          </Notice>
        )}
        {!confirmed && snapshot?.wallet.rwa.facts.identityVerified === true && (
          <Notice>
            An identity fact is already present. The read API does not identify which verifier originally
            produced it; this is not a new verification success.
          </Notice>
        )}
        {!receipt && (
          <>
            <label className="wb-check wb-identity-consent">
              <input
                type="checkbox"
                checked={consent}
                disabled={busy}
                onChange={(event) => setConsent(event.target.checked)}
              />
              I confirm this wallet, the required credential and the disclosure below.
            </label>
            <div className="wb-actions">
              <button
                className="wb-primary"
                onClick={start}
                disabled={!writable || !consent || busy || !!issue}
              >
                {phase === "preparing"
                  ? "Preparing request…"
                  : phase === "request"
                    ? "Waiting for World App…"
                    : phase === "submitting"
                      ? "Waiting for server attestation…"
                      : context.mock
                        ? phase === "denied" || phase === "cancelled"
                          ? "Retry demo attestation"
                          : "Run demo attestation"
                        : phase === "denied" || phase === "cancelled"
                          ? "Retry with World ID"
                          : "Continue with World ID"}
                <Icon name="arrow" size={15} />
              </button>
              {phase === "request" && <button onClick={closeWidget}>Cancel request</button>}
            </div>
          </>
        )}
        {!writable && (
          <p className="wb-muted">
            Viewer mode: inspect access freely. An operator session is required to submit to this gateway.
          </p>
        )}
        {failure && (
          <div
            className={`wb-identity-result ${failure.cancelled ? "" : "is-denied"}`}
            role={failure.cancelled ? "status" : "alert"}
          >
            <strong>{failure.title}</strong>
            <p>{failure.detail}</p>
            <p>
              Existing access is not changed by this message. Refresh the gateway read below before retrying.
            </p>
          </div>
        )}
        {receipt && (
          <div
            className={`wb-identity-result ${context.mock || context.environment !== "production" ? "is-demo" : ""}`}
            role="status"
          >
            <strong>
              {confirmed
                ? context.mock
                  ? "Demo attestation recorded"
                  : context.environment !== "production"
                    ? "Test-environment attestation confirmed"
                    : "Server attestation confirmed"
                : "Attestation returned · access confirmation pending"}
            </strong>
            <p>
              {confirmed
                ? "The gateway returned a transaction receipt and a fresh read contains the identity fact. The action decisions beside it may still be blocked."
                : "No successful access change is claimed. Refresh the reads; do not resubmit the proof just because a read failed."}
            </p>
            <code>{receipt.txHash}</code>
          </div>
        )}
        {phase === "submitting" && (
          <p role="status">
            World App completion is not authorization. Waiting for the gateway to verify and attest…
          </p>
        )}
        {phase === "refreshing" && (
          <p role="status">Attestation returned. Re-reading the wallet and each protected action…</p>
        )}
        <p className="wb-privacy">{IDENTITY_PRIVACY}</p>
      </section>
      <section className="wb-surface">
        <div className="wb-access-refresh">
          <span>{checkedAt ? `Read at ${checkedAt}` : "Gateway access"}</span>
          <button disabled={busy} onClick={() => refresh()}>
            <Icon name="refresh" size={14} />
            Refresh actual access
          </button>
        </div>
        {readError && (
          <Notice error>
            Access refresh failed: {readError}. Any displayed decisions are the last successful read.
          </Notice>
        )}
        <IdentityAccess snapshot={snapshot} policy={policy} />
      </section>
      {widget && !context.mock && (
        <WorldIdWidget
          context={context}
          wallet={wallet.address}
          onProof={submit}
          onClose={closeWidget}
          onError={handleWidgetError}
        />
      )}
    </div>
  );
}

function DeploymentIdentity({
  client,
  record,
  policy,
  identity,
  writable,
}: {
  client: AgreementsClient;
  record: AgreementDetail;
  policy: PolicyData;
  identity: IdentityConstraint;
  writable: boolean;
}) {
  const [wallets, setWallets] = useState<AgreementWallet[]>([]);
  const [walletAddress, setWalletAddress] = useState("");
  const [context, setContext] = useState<WorldIdContext | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setContext(null);
    Promise.all([
      client.wallets(record.id, controller.signal),
      client.worldIdContext(record.id, controller.signal),
    ])
      .then(([people, ctx]) => {
        if (controller.signal.aborted) return;
        setWallets(people);
        setContext(ctx);
        setWalletAddress((current) =>
          people.some((person) => person.address === current) ? current : (people[0]?.address ?? "")
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [client, record.id, revision]);
  const wallet = wallets.find((wallet) => wallet.address === walletAddress);
  return (
    <section className="wb-identity-operation" aria-label="World ID verification and access">
      <div className="wb-section-heading">
        <span className="wb-eyebrow">TRY THE TRUST BOUNDARY</span>
        <h2>Prove the credential. Recheck the policy.</h2>
      </div>
      {error ? (
        <Notice error>
          {error} <button onClick={() => setRevision((n) => n + 1)}>Retry verifier connection</button>
        </Notice>
      ) : !context ? (
        <p role="status">Loading the contract’s verifier and gateway wallets…</p>
      ) : !wallets.length ? (
        <Notice>
          The gateway returned no wallets. Configure a wallet on the gateway before demonstrating the proof
          flow.
        </Notice>
      ) : (
        <>
          <label className="wb-wallet-picker">
            Gateway wallet
            <select value={walletAddress} onChange={(event) => setWalletAddress(event.target.value)}>
              {wallets.map((person) => (
                <option key={person.address} value={person.address}>
                  {person.name} · {person.address}
                </option>
              ))}
            </select>
          </label>
          {wallet && (
            <WalletTrustFlow
              key={`${record.id}:${record.policyHash}:${wallet.address}`}
              client={client}
              record={record}
              policy={policy}
              identity={identity}
              wallet={wallet}
              initialContext={context}
              writable={writable}
            />
          )}
        </>
      )}
    </section>
  );
}

export function IdentityView({
  record,
  policy,
  constraints,
  constraintError,
  sample,
  demoWorkspace = false,
  writable,
  client,
  onConfigure,
  onConnect,
  onTrace,
}: {
  record: AgreementDetail;
  policy: PolicyData;
  constraints: Constraints | null;
  constraintError: string;
  sample: boolean;
  demoWorkspace?: boolean;
  writable: boolean;
  client: AgreementsClient;
  onConfigure: () => void;
  onConnect: () => void;
  onTrace: () => void;
}) {
  const identity = sample ? sampleIdentity(policy) : (constraints?.identity ?? null);
  const deployed =
    !sample &&
    !demoWorkspace &&
    record.status === "deployed" &&
    !!record.deployment &&
    record.deployment.policyHash === record.policyHash;
  return (
    <div className="wb-scroll-page wb-identity-page">
      <div className="wb-section-heading">
        <span className="wb-eyebrow">WORLD ID / THE TRUST MOMENT</span>
        <h2>
          The clause decides.
          <br />
          World ID supplies one fact.
        </h2>
        <p>Bind the required credential to a wallet. Keep every other eligibility check in force.</p>
      </div>
      <div className="wb-identity-overview">
        {identity ? (
          <IdentityPolicy identity={identity} sample={sample} onTrace={onTrace} />
        ) : (
          <section className="wb-surface">
            <h3>{constraints ? "No identity constraint on this policy" : "Identity policy not available"}</h3>
            <p>
              World ID is not automatically required by every contract. The issuer must choose a credential,
              protected actions and a source clause first.
            </p>
            {constraintError && <Notice error>{constraintError}</Notice>}
            <button onClick={onConfigure}>Configure issuer policy</button>
          </section>
        )}
      </div>
      {demoWorkspace && (
        <Notice>
          Public demo scope covers your contracts only, not stack administration or wallet operations.
          {/* Investor dashboard temporarily disabled.
          <Link href="/investor">
            Open the investor dashboard for Passport login and wallet-signed swaps ↗
          </Link> */}
        </Notice>
      )}
      {identity && deployed ? (
        <DeploymentIdentity
          client={client}
          record={record}
          policy={policy}
          identity={identity}
          writable={writable}
        />
      ) : (
        <section className="wb-surface wb-demo-path">
          <h3>Ready-to-demo path</h3>
          <p>
            {demoWorkspace
              ? "A demo workspace token never grants issuer or investor wallet privileges."
              : sample
                ? "This is an exported policy, not a wallet verification session."
                : "Wallet proof and access checks become available after this policy is deployed. A stale deployment hash is not accepted."}
          </p>
          <ol>
            <li>Upload the bundled contract through the gateway; inspect Analysis and the AST.</li>
            <li>Review the credential and clause, then deploy on your configured demo chain.</li>
            <li>
              Select a wallet here. Show blocked actions, run the explicitly labeled demo verifier or a
              configured World App request, then re-read remaining requirements.
            </li>
          </ol>
          <div className="wb-actions">
            <button className="wb-primary" onClick={sample ? onConnect : onConfigure}>
              {sample ? "Connect gateway to run the demo" : "Review policy & deployment"}
              <Icon name="arrow" size={15} />
            </button>
          </div>
        </section>
      )}
      <details className="wb-live-checklist">
        <summary>Live World ID readiness</summary>
        <p>
          A live demonstration needs a registered World app/RP, a server signing key, a matching action and
          environment, an eligible credential in World App, an operator session, a funded chain signer and a
          deployed matching policy. This UI cannot provision those or claim they are ready from a mock result.
        </p>
        <p>
          One-time proofs and repeat verification have provider-specific replay rules. This flow does not
          invent a session-proof integration. If an attestation expires, ask the operator to review the
          supported re-verification path.
        </p>
        <a href="https://docs.world.org/world-id/idkit/integrate" target="_blank" rel="noreferrer">
          World ID integration documentation ↗
        </a>
      </details>
    </div>
  );
}
