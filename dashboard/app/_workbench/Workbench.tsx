"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { canRegenerate, deployBlocked, inFlight, type Constraints } from "@/lib/agreements";
import { getServerSession, getSession, subscribeSession, type GatewaySession } from "@/lib/session";
import { verificationLabel } from "@/lib/workbench";
import { short } from "@/lib/format";
import { ConnectionDialog, UploadDialog } from "./Forms";
import { Evidence, GraphPane, HumanView, SourceCards } from "./PolicyPanes";
import { ApiView, DeployView } from "./ServiceViews";
import { IdentityView } from "./IdentityView";
import { AnalysisView } from "./AnalysisView";
import { useWorkbench } from "./useWorkbench";
import { Brand, Icon, Modal, Notice } from "./ui";

type View = "human" | "analysis" | "ast" | "identity" | "api" | "deploy";
const views = [
  { id: "human", label: "Human Language", icon: "file" },
  { id: "analysis", label: "Analysis", icon: "search" },
  { id: "ast", label: "Contract-AST", icon: "tree" },
  { id: "identity", label: "World ID", icon: "shield" },
  { id: "api", label: "API", icon: "code" },
  { id: "deploy", label: "Deploy", icon: "rocket" },
] as const;
type Confirmation = { kind: "regenerate" } | { kind: "deploy" } | { kind: "constraints"; body: Constraints };

export function Workbench() {
  const session = useSyncExternalStore(subscribeSession, getSession, getServerSession);
  return <SessionWorkbench key={session.revision} session={session} />;
}

function SessionWorkbench({ session }: { session: GatewaySession }) {
  const [sample, setSample] = useState(!session.url);
  const state = useWorkbench(session, sample);
  const { data, client, status } = state;
  const [view, setView] = useState<View>("ast");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<{ id: string; node: string } | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<
    (Confirmation & { recordId: string; policyHash: string | null }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [split, setSplit] = useState(44);
  const record = data?.record ?? null;
  const policy = record?.export ?? null;
  const writable = !sample && !!session.operatorKey && !state.detailError;
  const selected =
    selection?.id === record?.id
      ? (selection?.node ?? "agreement")
      : policy?.rules[0]
        ? `rule:${policy.rules[0].id}`
        : "agreement";
  const onSelect = (node: string) => record && setSelection({ id: record.id, node });
  const blocked = deployBlocked(record, status, writable);
  const filtered = state.agreements.filter((entry) =>
    `${entry.name} ${entry.source.name} ${entry.profile}`.toLowerCase().includes(search.toLowerCase())
  );
  const selectAgreement = (id: string) => {
    state.setId(id);
    setNavOpen(false);
    setMutationError("");
  };
  const requestConfirmation = (next: Confirmation) => {
    if (!record) return;
    setMutationError("");
    setConfirmation({ ...next, recordId: record.id, policyHash: record.policyHash });
  };
  async function mutate() {
    if (!record || !confirmation || !writable) return;
    setBusy(true);
    setMutationError("");
    try {
      if (confirmation.recordId !== record.id || confirmation.policyHash !== record.policyHash)
        throw new Error(
          "The agreement changed while this dialog was open. Cancel and review the current policy before confirming again."
        );
      const result =
        confirmation.kind === "deploy"
          ? await client.deploy(record.id)
          : confirmation.kind === "regenerate"
            ? await client.regenerate(record.id)
            : await client.constrain(record.id, confirmation.body);
      state.acceptMutation(result);
      setConfirmation(null);
    } catch (error) {
      setMutationError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wb-root">
      <a className="wb-skip" href="#workbench-main">
        Skip to contract
      </a>
      <header className="wb-mobile-head">
        <Link href="/" aria-label="Mirr0rtech home">
          <Brand />
        </Link>
        <button
          aria-expanded={navOpen}
          aria-controls="contracts-sidebar"
          onClick={() => setNavOpen((value) => !value)}
        >
          <Icon name={navOpen ? "close" : "menu"} />
          Contracts
        </button>
      </header>
      <aside
        id="contracts-sidebar"
        className={`wb-contracts ${navOpen ? "is-open" : ""}`}
        aria-label="Contracts"
      >
        <Link href="/" className="wb-desktop-brand" aria-label="Mirr0rtech home">
          <Brand />
        </Link>
        <div className="wb-sidebar-title">
          <h2>Contracts</h2>
          <span>{state.agreements.length.toString().padStart(2, "0")}</span>
          <button className="wb-icon-button" aria-label="Refresh agreements" onClick={state.refresh}>
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <label className="wb-search">
          <Icon name="search" size={15} />
          <input
            type="search"
            value={search}
            placeholder="Search contracts…"
            aria-label="Search contracts"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="wb-library-label">
          {sample ? "SAMPLE LIBRARY" : "YOUR AGREEMENTS"}
          <span>{sample ? "READ ONLY" : session.operatorKey ? "OPERATOR" : "VIEWER"}</span>
        </div>
        <nav className="wb-agreement-list" aria-label="Agreement selection">
          {state.listLoading && (
            <p className="wb-muted" role="status">
              Loading contracts…
            </p>
          )}
          {filtered.map((entry) => (
            <button
              key={entry.id}
              aria-current={state.id === entry.id ? "true" : undefined}
              onClick={() => selectAgreement(entry.id)}
            >
              <Icon name="file" size={17} />
              <span>
                <strong>{entry.name}</strong>
                <small>
                  <i className={`wb-state-dot wb-state-${sample ? "sample" : entry.status}`} />
                  {sample ? "Sample" : entry.status}
                  <span>
                    {" "}
                    ·{" "}
                    {entry.profile === "wildcat-credit"
                      ? "Credit"
                      : entry.profile === "custodial-rwa"
                        ? "Tokenize"
                        : "Trade"}
                  </span>
                </small>
              </span>
            </button>
          ))}
          {!state.listLoading && !filtered.length && (
            <p className="wb-empty-list">
              {search
                ? "No matching contracts."
                : state.listError
                  ? "Unable to load agreements."
                  : "Your workspace is empty. Upload your first agreement."}
            </p>
          )}
        </nav>
        <div className="wb-contracts-bottom">
          <button className="wb-primary wb-upload" onClick={() => setUploadOpen(true)}>
            <Icon name="plus" />
            Upload Contracts
          </button>
          <button className="wb-connection-button" onClick={() => setConnectionOpen(true)}>
            <Icon name="settings" size={16} />
            <span>
              Connection
              <small>
                {session.url
                  ? sample
                    ? "Gateway set · viewing samples"
                    : session.operatorKey
                      ? "Operator · session only"
                      : "Viewer · read only"
                  : "No gateway · sample mode"}
              </small>
            </span>
            <span>↗</span>
          </button>
          <Link href="/overview" className="wb-legacy-link">
            Open classic dashboard <span>↗</span>
          </Link>
        </div>
      </aside>
      <aside className="wb-views" aria-label="Workbench views">
        <div>
          <span className="wb-eyebrow">WORKSPACE</span>
          <h2>Views</h2>
        </div>
        <nav aria-label="Contract views">
          {views.map((item) => (
            <button
              key={item.id}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {view === item.id && <span className="wb-active-mark" />}
            </button>
          ))}
        </nav>
        <div className="wb-view-note">
          <span className="wb-eyebrow">TRACEABLE BY DESIGN</span>
          <p>
            From the words you sign
            <br />
            to the rules that run.
          </p>
          <span className="wb-note-diagram" aria-hidden="true">
            ≡ <span>────</span> ⌘ <span>────</span> ◇
          </span>
        </div>
        <section className="wb-services" aria-label="Actual gateway status">
          <span className="wb-eyebrow">ENVIRONMENT</span>
          <div>
            <i
              className={`wb-state-dot ${!sample && status?.model.mode === "live" ? "wb-state-compiled" : "wb-state-sample"}`}
            />
            <span>
              Model
              <small>
                {sample
                  ? "Offline · export only"
                  : status
                    ? `${status.model.provider} · ${status.model.mode}`
                    : "Not available"}
              </small>
              {!sample && status && <code>{status.model.model}</code>}
            </span>
          </div>
          <div>
            <i className={`wb-state-dot ${!sample && status ? "wb-state-compiled" : "wb-state-sample"}`} />
            <span>
              Compiler
              <small>
                {sample
                  ? "Exported artifact"
                  : status
                    ? `Solidity ${status.compiler.solidity.core ?? "not reported"}`
                    : "Not available"}
              </small>
              {!sample && status && (
                <details>
                  <summary>All compiler versions</summary>
                  {Object.entries(status.compiler.solidity).map(([name, version]) => (
                    <small key={name}>
                      {name}: {version}
                    </small>
                  ))}
                </details>
              )}
            </span>
          </div>
          <div>
            <i
              className={`wb-state-dot ${!sample && status?.chain ? "wb-state-compiled" : "wb-state-sample"}`}
            />
            <span>
              Chain
              <small>
                {sample
                  ? "Not connected"
                  : status?.chain
                    ? `Chain ${status.chain.chainId} · signer configured`
                    : "No signer reported"}
              </small>
            </span>
          </div>
          {state.statusError && !sample && (
            <p className="wb-service-error" role="status">
              Status unavailable: {state.statusError}
            </p>
          )}
        </section>
      </aside>
      <main id="workbench-main" className="wb-main" tabIndex={-1}>
        <header className="wb-topbar">
          <div className="wb-breadcrumb">
            <Icon name="file" size={17} />
            <h1 title={record?.name}>
              {record?.name ?? (sample ? "Sample workspace" : "Contracts workspace")}
            </h1>
            <span>/</span>
            <span>
              {!sample && record?.status === "deployed" && record.deployment
                ? `Chain ${record.deployment.chainId}`
                : "Offchain"}
            </span>
          </div>
          <div className="wb-top-actions">
            <button
              aria-label="Regenerate agreement"
              title={!writable ? "An operator session is required" : "Regenerate from the original documents"}
              disabled={!writable || busy || !canRegenerate(record?.status)}
              onClick={() => requestConfirmation({ kind: "regenerate" })}
            >
              <Icon name="refresh" size={15} />
              <span>Regenerate</span>
            </button>
            <button
              className="wb-primary"
              disabled={!!blocked || busy}
              title={blocked ?? "Review deployment before sending"}
              onClick={() => requestConfirmation({ kind: "deploy" })}
            >
              <Icon name="rocket" size={16} />
              {record?.status === "deploying" ? "Deploying…" : "Deploy"}
            </button>
          </div>
        </header>
        <div className="wb-contextbar">
          <div>
            <button className="wb-evidence-badge" disabled={!policy} onClick={() => setEvidenceOpen(true)}>
              <span className="wb-dot" />
              {verificationLabel(policy, sample)}
              {policy && <span>↗</span>}
            </button>
            {record && (
              <span className="wb-record-state">{sample ? "Not a live agreement" : record.status}</span>
            )}
          </div>
          <div>
            {view === "ast" && (
              <label className="wb-split-control">
                Split
                <input
                  type="range"
                  min="32"
                  max="62"
                  value={split}
                  onChange={(e) => setSplit(Number(e.target.value))}
                  aria-label="Source pane width"
                />
              </label>
            )}
            <span className="wb-mode-label">{sample ? "SAMPLE" : "API"}</span>
          </div>
        </div>
        {sample && (
          <div className="wb-mode-banner">
            <span>
              <strong>Sample workspace.</strong> Real compiler export; not a live upload, model run, or
              deployment.
            </span>
            <button onClick={() => (session.url ? setSample(false) : setConnectionOpen(true))}>
              {session.url ? "Return to gateway" : "Connect gateway"}
              <Icon name="arrow" size={14} />
            </button>
          </div>
        )}
        {state.listError && (
          <Notice error>
            {state.listError} <button onClick={state.refresh}>Retry</button>
            {!sample && <button onClick={() => setSample(true)}>Browse samples instead</button>}
          </Notice>
        )}
        {state.detailError && (
          <Notice error>
            Refresh failed; any displayed data is the last successful response. {state.detailError}{" "}
            <button onClick={state.refresh}>Retry</button>
          </Notice>
        )}
        {record?.error && <Notice error>{record.error}</Notice>}
        {policy && view !== "identity" && (
          <button className="wb-trust-launch" onClick={() => setView("identity")}>
            <Icon name="shield" />
            <strong>World ID</strong>
            <span>From a source clause to wallet access—not automatic compliance.</span>
            <span className="wb-trust-cta">
              Review identity & access <Icon name="arrow" size={14} />
            </span>
          </button>
        )}
        {!record && (
          <div className="wb-empty">
            <Icon name="tree" size={40} />
            <h2>
              {state.id
                ? "Opening your agreement…"
                : state.listLoading
                  ? "Loading workspace…"
                  : "Start with the agreement."}
            </h2>
            <p>
              {state.id
                ? "Fetching the source, compiled policy and AST."
                : "Upload text, Markdown or HTML. Trace each clause through generation, verification, compilation and deployment."}
            </p>
            {!state.listLoading && !state.id && (
              <div className="wb-actions">
                <button className="wb-primary" onClick={() => setUploadOpen(true)}>
                  Upload a contract
                </button>
                {!sample && <button onClick={() => setSample(true)}>Explore sample exports</button>}
                <button onClick={() => setConnectionOpen(true)}>Connection</button>
              </div>
            )}
          </div>
        )}
        {record &&
          (view === "analysis" ? (
            <AnalysisView
              key={record.id}
              record={record}
              sample={sample}
              onAst={(node) => {
                if (node) onSelect(node);
                setView("ast");
              }}
              onIdentity={() => setView("identity")}
            />
          ) : view === "identity" && policy ? (
            <IdentityView
              key={`${record.id}:${record.policyHash}`}
              record={record}
              policy={policy}
              constraints={data!.constraints}
              constraintError={data!.constraintError}
              sample={sample}
              writable={writable}
              client={client}
              onConfigure={() => setView("deploy")}
              onConnect={() => setConnectionOpen(true)}
              onTrace={() => {
                const rule = policy.rules.find((rule) => rule.id.endsWith("-identity-verified"));
                if (rule) onSelect(`rule:${rule.id}`);
                setView("ast");
              }}
            />
          ) : view === "api" ? (
            <ApiView
              record={record}
              policy={policy}
              sample={sample}
              baseUrl={session.url}
              refresh={state.refresh}
            />
          ) : view === "deploy" ? (
            <DeployView
              key={record.id}
              record={record}
              policy={policy}
              constraints={data!.constraints}
              constraintError={data!.constraintError}
              sample={sample}
              writable={writable}
              busy={busy || inFlight(record.status)}
              status={status}
              client={client}
              blocked={blocked}
              onDeploy={() => requestConfirmation({ kind: "deploy" })}
              onConstrain={(body) => requestConfirmation({ kind: "constraints", body })}
            />
          ) : policy ? (
            view === "human" ? (
              <HumanView key={record.id} policy={policy} selected={selected} onSelect={onSelect} />
            ) : (
              <div className="wb-split" style={{ "--source-width": `${split}%` } as CSSProperties}>
                <SourceCards policy={policy} selected={selected} onSelect={onSelect} />
                {data?.graph ? (
                  <GraphPane
                    key={record.id}
                    graph={data.graph}
                    policy={policy}
                    selected={selected}
                    onSelect={onSelect}
                    sample={sample}
                  />
                ) : (
                  <div className="wb-empty">
                    <Icon name="tree" size={30} />
                    <h2>AST not available</h2>
                    <p>{data?.graphError || "The gateway serves the AST after compilation."}</p>
                    <button onClick={state.refresh}>Refresh graph</button>
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="wb-empty" role="status">
              <Icon name={record.status === "failed" ? "file" : "tree"} size={40} />
              <span className="wb-eyebrow">{record.status}</span>
              <h2>
                {record.status === "failed"
                  ? "This agreement needs attention."
                  : "Your agreement is becoming a policy."}
              </h2>
              <p>
                {record.status === "failed"
                  ? "Review the gateway error above, then regenerate when its cause is resolved."
                  : "The gateway is extracting, checking and compiling your source. This view polls automatically; you can keep working."}
              </p>
              <button onClick={state.refresh}>Refresh status</button>
            </div>
          ))}
        <details className="wb-mobile-services">
          <summary>
            Environment ·{" "}
            {sample
              ? "offline sample"
              : status
                ? `${status.model.mode} model · chain ${status.chain?.chainId ?? "not configured"}`
                : "status unavailable"}
          </summary>
          <p>
            {sample
              ? "No live model, compiler version or chain status is asserted for sample exports."
              : status
                ? `Model: ${status.model.provider} / ${status.model.model} (${status.model.mode}). Solidity: ${Object.entries(
                    status.compiler.solidity
                  )
                    .map(([name, version]) => `${name} ${version}`)
                    .join(", ")}. Chain: ${status.chain?.chainId ?? "no signer"}.`
                : state.statusError || "Waiting for /v1/status."}
          </p>
        </details>
        <footer className="wb-statusbar">
          <span>
            <i
              className={`wb-state-dot ${sample ? "wb-state-sample" : state.detailError || state.listError ? "wb-state-failed" : "wb-state-compiled"}`}
            />
            {sample
              ? "Offline sample"
              : state.detailError || state.listError
                ? "Connection needs attention"
                : state.syncedAt
                  ? `Last sync ${state.syncedAt}`
                  : "Connecting…"}
          </span>
          <span>
            {record?.policyHash ? `policy ${short(record.policyHash, 8, 6)}` : "No compiled policy"}
          </span>
          <span>
            {!sample && inFlight(record?.status)
              ? "Polling every 2s"
              : sample
                ? "Read only"
                : session.operatorKey
                  ? "Operator session"
                  : "Viewer session"}
          </span>
        </footer>
      </main>
      {connectionOpen && <ConnectionDialog session={session} onClose={() => setConnectionOpen(false)} />}
      {uploadOpen && (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          writable={writable}
          status={status}
          onUpload={async (upload) => {
            const result = await client.upload(upload);
            state.acceptMutation(result);
            setView("analysis");
          }}
        />
      )}
      {evidenceOpen && policy && (
        <Modal title="Verification & provenance" onClose={() => setEvidenceOpen(false)}>
          <Evidence policy={policy} sample={sample} />
        </Modal>
      )}
      {confirmation && record && (
        <Modal
          title={
            confirmation.kind === "deploy"
              ? "Deploy this policy?"
              : confirmation.kind === "regenerate"
                ? "Regenerate this agreement?"
                : "Recompile identity policy?"
          }
          busy={busy}
          onClose={() => setConfirmation(null)}
        >
          <div className="wb-form">
            <p>
              <strong>{record.name}</strong>
            </p>
            {confirmation.kind === "deploy" ? (
              <>
                <p>
                  This asks the gateway’s signer to deploy a token, oracle and hook and initialize a pool on
                  chain <strong>{status?.chain?.chainId}</strong>. It spends the signer’s gas and may create
                  irreversible on-chain state.
                </p>
                <code>{record.policyHash}</code>
                <p className="wb-muted">
                  Deployment is not a claim of legal completeness, NAV backing, or production readiness.
                </p>
              </>
            ) : confirmation.kind === "regenerate" ? (
              <p>
                This re-reads the original documents using the configured extraction provider. It clears the
                current export and deployment record and may incur model costs. Existing on-chain contracts
                remain. Issuer constraints may need to be applied again.
              </p>
            ) : (
              <>
                <p>
                  This changes the policy hash and clears its deployment record. Existing contracts are not
                  updated. Review and deploy the new policy separately.
                </p>
                <pre className="wb-json">{JSON.stringify(confirmation.body, null, 2)}</pre>
              </>
            )}
            {mutationError && <Notice error>{mutationError}</Notice>}
            <footer>
              <button disabled={busy} onClick={() => setConfirmation(null)}>
                Cancel
              </button>
              <button className="wb-primary" disabled={busy || !writable} onClick={mutate}>
                {busy
                  ? "Submitting…"
                  : confirmation.kind === "deploy"
                    ? "Confirm deployment"
                    : confirmation.kind === "regenerate"
                      ? "Regenerate"
                      : "Save & recompile"}
                <Icon name="arrow" />
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}
