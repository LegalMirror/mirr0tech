"use client";

import { useEffect, useState, type FormEvent } from "react";
import { demoUrl, loadDemoBundle } from "@/lib/demo";
import { CREDENTIAL_COPY } from "@/lib/identity";
import { gatewayUrl, hasGatewaySession, setSession, type GatewaySession } from "@/lib/session";
import { startDemoWorkspace } from "@/lib/demo-session";
import {
  generationFor,
  validateUpload,
  type Constraints,
  type IdentityConstraint,
  type StackStatus,
  type Upload,
} from "@/lib/agreements";
import type { PolicyData, ProfileId } from "@/lib/types";
import { Icon, Modal, Notice } from "./ui";
import { MockUsdFaucet } from "./MockUsdFaucet";

export function SettingsDialog({
  session,
  sample,
  status,
  statusError,
  onClose,
}: {
  session: GatewaySession;
  sample: boolean;
  status: StackStatus | null;
  statusError: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(session.url || "http://localhost:3000");
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [error, setError] = useState("");
  function connect(event: FormEvent) {
    event.preventDefault();
    if (faucetBusy) return;
    try {
      const next = gatewayUrl(url);
      if (!(hasGatewaySession(session) && next === session.url)) void startDemoWorkspace(next, true);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <Modal title="Settings" onClose={onClose} busy={faucetBusy}>
      <MockUsdFaucet onBusyChange={setFaucetBusy} />
      <form className="wb-form" onSubmit={connect}>
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
                    ? `Chain ${status.chain.chainId} · ${session.demoToken ? "demo gateway" : status.chain.deployer ? "signer configured" : "gateway target"}`
                    : "No signer reported"}
              </small>
            </span>
          </div>
          {statusError && !sample && (
            <p className="wb-service-error" role="status">
              Status unavailable: {statusError}
            </p>
          )}
        </section>
        <span className="wb-eyebrow">CONNECTION</span>
        <p>
          {session.demoToken
            ? "Anyone can create demo contracts in a hosted demo workspace. No operator key is needed."
            : "Connect to the local workspace started with pnpm start. OpenAI credentials stay on the server."}
        </p>
        <label>
          Gateway URL
          <input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} autoFocus />
        </label>
        <Notice>{session.demoNotice ?? "Connect to upload contracts or try the demo."}</Notice>
        <p className="wb-muted">
          {session.workspaceToken
            ? "Source files and contracts persist on this machine. Reloading reconnects to the same workspace."
            : "Connection tokens stay in memory. Hosted demo workspaces are temporary and separate from the local workspace."}
        </p>
        {session.demoExpiresAt && (
          <p>Workspace expires {new Date(session.demoExpiresAt * 1000).toLocaleString()}.</p>
        )}
        {session.demoLimits && (
          <details>
            <summary>Gateway demo limits</summary>
            <pre className="wb-json">{JSON.stringify(session.demoLimits, null, 2)}</pre>
          </details>
        )}
        {error && <Notice error>{error}</Notice>}
        <footer>
          <button
            type="button"
            disabled={faucetBusy}
            onClick={() => {
              setSession({ url: "", viewerKey: "", operatorKey: "", autoDemo: false });
              onClose();
            }}
          >
            Disconnect
          </button>
          <button
            className="wb-primary"
            type="submit"
            disabled={faucetBusy || session.demoState === "starting"}
          >
            {hasGatewaySession(session) && url === session.url ? "Keep this workspace" : "Connect workspace"}
            <Icon name="arrow" />
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function UploadDialog({
  onClose,
  onUpload,
  writable,
  status,
  demoWorkspace = false,
  localWorkspace = false,
}: {
  onClose: () => void;
  onUpload: (upload: Upload) => Promise<void>;
  writable: boolean;
  status: StackStatus | null;
  demoWorkspace?: boolean;
  localWorkspace?: boolean;
}) {
  const [name, setName] = useState("BUIDL demo");
  const [profile, setProfile] = useState<ProfileId>("rwa-secondary");
  const [mode, setMode] = useState<"demo" | "files">("demo");
  const [bundle, setBundle] = useState<Upload | null>(null);
  const [cashierDemo, setCashierDemo] = useState(false);
  const [demoError, setDemoError] = useState("");
  const [demoRetry, setDemoRetry] = useState(0);
  useEffect(() => {
    if (mode !== "demo") return;
    const controller = new AbortController();
    setDemoError("");
    loadDemoBundle(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setBundle(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDemoError(error.message);
      });
    return () => controller.abort();
  }, [mode, demoRetry]);
  const demoDocuments = bundle?.documents.filter((_, index) => cashierDemo || index === 0) ?? [];
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      for (const file of files)
        if (mode === "files" && (file.size > 2 * 1024 * 1024 || !/\.(txt|md|htm|html)$/i.test(file.name)))
          throw new Error("Use text, Markdown or HTML files up to 2 MB each. PDF is not supported.");
      const documents =
        mode === "demo"
          ? demoDocuments
          : await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
      const generation = generationFor({ provider: status?.model.provider, localWorkspace: Boolean(localWorkspace), mode });
      const upload: Upload = {
        name: name.trim(),
        ...(generation ? { generation } : {}),
        profile: mode === "demo" ? "rwa-secondary" : profile,
        documents,
        ...(mode === "demo" && cashierDemo ? { config: bundle?.config } : {}),
      };
      validateUpload(upload);
      await onUpload(upload);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Upload contracts" onClose={onClose} busy={busy}>
      <form className="wb-form" onSubmit={submit}>
        <p>
          Try the bundled demo, or upload your own contract to generate its AST with OpenAI. Source files and
          contract records are saved on the server.
        </p>
        {!writable && (
          <Notice>Connect to the workspace first. Run pnpm start, then open Settings to reconnect.</Notice>
        )}
        {demoWorkspace && (
          <Notice>
            Public workspaces accept only the bundled BUIDL document, optionally followed by its separately
            authored NAV demo addendum with the provided config. File mode can submit those same sources;
            arbitrary documents and credit profiles are not supported by the public mock reader.
          </Notice>
        )}
        {localWorkspace && mode === "files" && status?.model.mode !== "live" && (
          <Notice>
            Set OPENAI_API_KEY in the server’s .env and restart pnpm start to enable generation. You can still
            save your files now, or use Demo without an API key.
          </Notice>
        )}
        <label>
          Contract name
          <input
            required
            maxLength={demoWorkspace ? 120 : 200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Fund subscription contract"
            autoFocus
          />
        </label>
        <label>
          Policy profile
          <select
            disabled={mode === "demo"}
            value={mode === "demo" ? "rwa-secondary" : profile}
            onChange={(e) => setProfile(e.target.value as ProfileId)}
          >
            <option value="rwa-secondary">RWA · token + secondary trading</option>
            <option value="custodial-rwa">RWA · custodial mint / burn</option>
            <option value="wildcat-credit" disabled={demoWorkspace}>
              Credit · role provider + mock market + buyback
            </option>
          </select>
        </label>
        {mode !== "demo" && profile === "wildcat-credit" && (
          <p className="wb-muted">
            For the executable credit demo, upload the Wildcat MLA, lender-check policy and buyback addendum
            together.
          </p>
        )}
        <div className="wb-segmented" aria-label="Document input">
          <button type="button" aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>
            Demo
          </button>
          <button type="button" aria-pressed={mode === "files"} onClick={() => setMode("files")}>
            Upload files
          </button>
        </div>
        {mode === "demo" ? (
          <div className="wb-demo-bundle">
            <h3>BUIDL contract → executable policy</h3>
            <p>
              {status?.model.provider === "noolog"
                ? "Noolog legal models read the bundled contract and check each other's claims."
                : "Generate a sample AST from the bundled contract using a deterministic fixture. No API key is needed."}
            </p>
            <label className="wb-check">
              <input
                type="checkbox"
                checked={cashierDemo}
                onChange={(event) => setCashierDemo(event.target.checked)}
              />
              Include the separate NAV demo addendum and opt in to the cashier compiler
            </label>
            {cashierDemo && (
              <Notice>
                The addendum is separately authored—not BlackRock or Securitize economics. Upload will include
                cashier.enabled=true. No real assets, reserves or NAV feed are implied.
              </Notice>
            )}
            {!bundle && !demoError && <p role="status">Loading bundled documents…</p>}
            {demoError && (
              <Notice error>
                {demoError}
                <button type="button" onClick={() => setDemoRetry((value) => value + 1)}>
                  Retry document load
                </button>
              </Notice>
            )}
            {demoDocuments.map((document) => (
              <details key={document.name}>
                <summary>
                  {document.name} · {new TextEncoder().encode(document.text).length.toLocaleString()} bytes
                </summary>
                <a href={demoUrl(document.name)} download>
                  Download complete source ↗
                </a>
                <pre className="wb-json">{document.text}</pre>
              </details>
            ))}
            {cashierDemo && bundle?.config && (
              <details>
                <summary>rwa-cashier-config.json · compiler config, not a contract</summary>
                <a href={demoUrl("rwa-cashier-config.json")} download>
                  Download configuration ↗
                </a>
                <pre className="wb-json">{JSON.stringify(bundle.config, null, 2)}</pre>
              </details>
            )}
            <p className="wb-muted">
              After upload, review the contract’s source, AST, open questions and compiler checks.
            </p>
          </div>
        ) : (
          <label className="wb-file-input">
            <Icon name="file" size={28} />
            Text, Markdown or HTML
            <input
              type="file"
              multiple
              accept=".txt,.md,.htm,.html"
              onChange={(e) => {
                const selected = Array.from(e.target.files ?? []);
                setFiles(selected);
                if (selected.length && name === "BUIDL demo")
                  setName(selected[0].name.replace(/\.[^.]+$/, "").slice(0, 200));
              }}
            />
            <span>
              {files.map((file) => file.name).join(", ") || "Choose a contract and optional addenda"}
            </span>
          </label>
        )}
        <p className="wb-muted">
          No PDF support · 2 MB per file · 4 MB encoded request limit. Documents are sent to your gateway and,
          for file generation, to OpenAI. Demo generation runs locally.
        </p>
        {mode === "files" && !files.length && <p role="status">Choose at least one file to continue.</p>}
        {error && <Notice error>{error}</Notice>}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="wb-primary"
            disabled={!writable || busy || (mode === "demo" ? !bundle || !!demoError : !files.length)}
          >
            {busy ? "Uploading…" : "Upload & generate"}
            <Icon name="arrow" />
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function ConstraintForm({
  constraints,
  policy,
  writable,
  busy,
  onSave,
}: {
  constraints: Constraints;
  policy: PolicyData;
  writable: boolean;
  busy: boolean;
  onSave: (body: Constraints) => void;
}) {
  const current = constraints.identity;
  const [enabled, setEnabled] = useState(!!current);
  const [credential, setCredential] = useState<IdentityConstraint["credential"]>(
    current?.credential ?? "document"
  );
  const [actions, setActions] = useState<string[]>(
    current?.actions ?? ["mint", "transfer"].filter((action) => policy.actionOrder.includes(action))
  );
  const [clause, setClause] = useState(current?.clause ?? "");
  const [quote, setQuote] = useState(current?.quote ?? "");
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (enabled && (!actions.length || !quote.trim() || !policy.text.includes(quote))) {
      setError("Choose at least one action and a verbatim quote from the normalized source text.");
      return;
    }
    onSave({ identity: enabled ? { credential, actions, clause, quote } : null });
  }
  return (
    <form className="wb-form" onSubmit={submit}>
      <div className="wb-section-heading">
        <span className="wb-eyebrow">ISSUER POLICY</span>
        <h3>World ID constraint</h3>
        <p>
          Choose the minimum credential your contract requires. This is an issuer decision, not a substitute
          for AML, sanctions checks, or legal review.
        </p>
      </div>
      <fieldset disabled={!writable || busy}>
        <legend className="wb-sr-only">Identity constraint</legend>
        <label className="wb-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Require a
          World ID credential
        </label>
        {enabled && (
          <>
            <label>
              Credential
              <select
                value={credential}
                onChange={(e) => setCredential(e.target.value as IdentityConstraint["credential"])}
              >
                <option value="document">Government document · Passport / NFC</option>
                <option value="proof_of_human">Proof of human</option>
                <option value="selfie">Selfie · liveness</option>
              </select>
            </label>
            <div className="wb-credential-rationale">
              <strong>Why this credential?</strong>
              <p>{CREDENTIAL_COPY[credential].purpose}</p>
              <p>{CREDENTIAL_COPY[credential].limit}</p>
              <p>
                Choose the minimum assurance justified by the clause below. Changing credentials is an issuer
                policy decision, not a workaround for a failed proof.
              </p>
            </div>
            <div>
              <span className="wb-field-label">Required for actions</span>
              <div className="wb-checks">
                {policy.actionOrder.map((action) => (
                  <label className="wb-check" key={action}>
                    <input
                      type="checkbox"
                      checked={actions.includes(action)}
                      onChange={(e) =>
                        setActions(
                          e.target.checked ? [...actions, action] : actions.filter((item) => item !== action)
                        )
                      }
                    />
                    {action}
                  </label>
                ))}
              </div>
            </div>
            <label>
              Start from a source clause
              <select
                defaultValue=""
                onChange={(e) => {
                  const rule = policy.rules.find((entry) => entry.id === e.target.value);
                  if (rule) {
                    setClause(rule.source.clause);
                    setQuote(rule.source.quote);
                  }
                }}
              >
                <option value="">Choose a clause, or paste a quote below</option>
                {policy.rules.map((rule) => (
                  <option value={rule.id} key={rule.id}>
                    {rule.source.clause} · {rule.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Clause label
              <input required value={clause} onChange={(e) => setClause(e.target.value)} />
            </label>
            <label>
              Verbatim source quote
              <textarea required rows={4} value={quote} onChange={(e) => setQuote(e.target.value)} />
            </label>
          </>
        )}
      </fieldset>
      <Notice>
        Saving recompiles the policy, changes its hash and clears the current deployment record. Existing
        on-chain contracts are not removed; deploy the new policy separately.
      </Notice>
      {error && <Notice error>{error}</Notice>}
      <button className="wb-primary" disabled={!writable || busy} type="submit">
        Review constraint change <Icon name="arrow" />
      </button>
    </form>
  );
}
