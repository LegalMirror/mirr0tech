"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { canRegenerate, deployBlocked, inFlight, type Constraints } from "@/lib/agreements";
import {
  getServerSession,
  getSession,
  hasGatewaySession,
  canMutateAgreements,
  expireDemoSession,
  subscribeSession,
  type GatewaySession,
} from "@/lib/session";
import { startDemoWorkspace } from "@/lib/demo-session";
import { short } from "@/lib/format";
import { SettingsDialog, UploadDialog } from "./Forms";
import { isLegalAst } from "@/lib/legal-ast";
import { LegalAstView } from "./LegalAstView";
import { GraphPane, HumanView, SourceCards } from "./PolicyPanes";
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
  useEffect(() => {
    if (session.autoDemo && session.url && !hasGatewaySession(session)) void startDemoWorkspace(session.url);
  }, [session.url, session.autoDemo]);
  useEffect(() => {
    if (!session.demoToken || !session.demoExpiresAt) return;
    const token = session.demoToken;
    const wait = session.demoExpiresAt * 1000 - Date.now();
    if (wait <= 0) {
      expireDemoSession(token);
      return;
    }
    const timer = setTimeout(() => expireDemoSession(token), Math.min(wait, 2147483647));
    return () => clearTimeout(timer);
  }, [session.demoToken, session.demoExpiresAt]);
  return <SessionWorkbench key={session.revision} session={session} />;
}

function SessionWorkbench({ session }: { session: GatewaySession }) {
  const [sample, setSample] = useState(false);
  const state = useWorkbench(session, sample);
  const { data, client, status } = state;
  const [view, setView] = useState<View>("ast");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<{ id: string; node: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<
    (Confirmation & { recordId: string; policyHash: string | null }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const record = data?.record ?? null;
  const policy = record?.export ?? null;
  const writable = !sample && canMutateAgreements(session) && !state.detailError;
  const selected =
    selection?.id === record?.id
      ? (selection?.node ?? "agreement")
      : isLegalAst(record?.ast)
        ? (record.ast.nodes.find((node) => node.kind === "clause") ?? record.ast.nodes[0]).id
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
          "The contract changed while this dialog was open. Cancel and review the current policy before confirming again."
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
          <button className="wb-icon-button" aria-label="Refresh contracts" onClick={state.refresh}>
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
        <nav className="wb-agreement-list" aria-label="Contract selection">
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
                  ? "Unable to load contracts."
                  : "Your workspace is empty. Upload your first contract."}
            </p>
          )}
        </nav>
        <div className="wb-contracts-bottom">
          {/* Investor dashboard temporarily disabled.
          <Link href="/investor" className="wb-primary wb-upload">
            <Icon name="shield" />
            <span>
              Investor dashboard
              <br />
              <small>Sign in with World ID</small>
            </span>
          </Link> */}
          <button className="wb-primary wb-upload" onClick={() => setUploadOpen(true)}>
            <Icon name="plus" />
            Upload Contracts
          </button>
          {/* <Link href="/overview" className="wb-legacy-link">
            Open classic dashboard <span>↗</span>
          </Link> */}
        </div>
      </aside>
      <aside className="wb-views" aria-label="Workbench views">
        <div>
          <span className="wb-eyebrow">WORKSPACE</span>
        </div>
        <nav aria-label="Contract views">
          {views.map((item) => (
            <button
              key={item.id}
              disabled={item.id === "identity" && isLegalAst(record?.ast)}
              title={
                item.id === "identity" && isLegalAst(record?.ast)
                  ? "Identity constraints require a compiled policy"
                  : undefined
              }
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {view === item.id && <span className="wb-active-mark" />}
            </button>
          ))}
        </nav>
      </aside>
      <main id="workbench-main" className="wb-main" tabIndex={-1}>
        <header className="wb-topbar">
          <div className="wb-breadcrumb">
            <Icon name="file" size={17} />
            <h1 title={record?.name}>
              {record?.name ?? (sample ? "Sample workspace" : "Contracts workspace")}
            </h1>
            {!sample && record?.status === "deployed" && record.deployment && (
              <>
                <span>/</span>
                <span>Chain {record.deployment.chainId}</span>
              </>
            )}
          </div>
          <div className="wb-top-actions">
            <button
              aria-label="Regenerate contract"
              title={!writable ? "Connect to the workspace first" : "Regenerate from the original documents"}
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
        {sample && (
          <div className="wb-mode-banner">
            <span>
              <strong>Sample workspace.</strong> Real compiler export; not a live upload, model run, or
              deployment.
            </span>
            <button onClick={() => (hasGatewaySession(session) ? setSample(false) : setSettingsOpen(true))}>
              {hasGatewaySession(session) ? "Return to gateway" : "Connect gateway"}
              <Icon name="arrow" size={14} />
            </button>
          </div>
        )}
        {session.demoNotice && (
          <Notice>
            {session.demoNotice}
            {["unavailable", "expired"].includes(session.demoState ?? "") && (
              <button onClick={() => setSettingsOpen(true)}>Reconnect workspace</button>
            )}
          </Notice>
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
                ? "Opening your contract…"
                : state.listLoading
                  ? "Loading workspace…"
                  : "Start with the contract."}
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
              demoWorkspace={!!session.demoToken}
              writable={writable && !session.demoToken}
              client={client}
              onConfigure={() => setView("deploy")}
              onConnect={() => setSettingsOpen(true)}
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
          ) : isLegalAst(record.ast) ? (
            <LegalAstView
              key={record.id}
              ast={record.ast}
              selected={selected}
              onSelect={onSelect}
              human={view === "human"}
            />
          ) : policy ? (
            view === "human" ? (
              <HumanView key={record.id} policy={policy} selected={selected} onSelect={onSelect} />
            ) : (
              <div className="wb-split">
                <SourceCards policy={policy} selected={selected} onSelect={onSelect} />
                {data?.graph ? (
                  <GraphPane
                    key={record.id}
                    graph={data.graph}
                    ast={record.ast ?? policy}
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
                  ? "This contract needs attention."
                  : "Your contract is becoming a policy."}
              </h2>
              <p>
                {record.status === "failed"
                  ? "Review the gateway error above, then regenerate when its cause is resolved."
                  : "The gateway is extracting, checking and compiling your source. This view polls automatically; you can keep working."}
              </p>
              <button onClick={state.refresh}>Refresh status</button>
            </div>
          ))}
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
            {!sample && inFlight(record?.status) ? "Polling every 2s" : sample ? "Read only" : null}
          </span>
          <button
            className="wb-icon-button wb-settings-button"
            aria-label="Settings"
            title="Settings"
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={18} />
          </button>
        </footer>
      </main>
      {settingsOpen && (
        <SettingsDialog
          session={session}
          sample={sample}
          status={status}
          statusError={state.statusError}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {uploadOpen && (
        <UploadDialog
          localWorkspace={!!session.workspaceToken}
          onClose={() => setUploadOpen(false)}
          writable={!sample && canMutateAgreements(session)}
          demoWorkspace={!!session.demoToken}
          status={status}
          onUpload={async (upload) => {
            const result = await client.upload(upload);
            state.acceptMutation(result);
            setView("analysis");
          }}
        />
      )}
      {confirmation && record && (
        <Modal
          title={
            confirmation.kind === "deploy"
              ? "Deploy this policy?"
              : confirmation.kind === "regenerate"
                ? "Regenerate this contract?"
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
