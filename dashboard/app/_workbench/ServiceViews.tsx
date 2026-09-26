"use client";

import type { AgreementDetail, AgreementsClient, Constraints, StackStatus } from "@/lib/agreements";
import type { PolicyData } from "@/lib/types";
import { ConstraintForm } from "./Forms";
import { LocalEvaluator } from "./PolicyPanes";
import { Icon, Notice } from "./ui";

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function ApiView({
  record,
  policy,
  sample,
  baseUrl,
  refresh,
}: {
  record: AgreementDetail;
  policy: PolicyData | null;
  sample: boolean;
  baseUrl: string;
  refresh: () => void;
}) {
  const path = `/v1/agreements/${encodeURIComponent(record.id)}`;
  const routes = [
    ["GET", "/v1/status", "Gateway model, compilers and signer"],
    ["GET", "/v1/agreements", "Contract summaries"],
    ["POST", "/v1/agreements", "Upload documents; starts generation"],
    ["GET", path, "Contract + compiled export"],
    ["GET", `${path}/ast`, "Source-linked AST graph"],
    ["GET", `${path}/constraints`, "Current World ID policy"],
    ["PUT", `${path}/constraints`, "Recompile identity constraints"],
    ["POST", `${path}/regenerate`, "Regenerate from original documents"],
    ["POST", `${path}/deploy`, "Deploy the compiled policy"],
    ["GET", `${path}/liquidity`, "Backend balances and pool liquidity"],
    ["POST", `${path}/liquidity/seeds`, "Seed pool from backend"],
    ["GET", `${path}/liquidity/seeds/:requestId`, "Seed status and transaction hashes"],
    ["POST", `${path}/mint`, "Mint RWA through the backend and release to a recipient"],
    ["GET", `${path}/mints/:requestId`, "Mint/release status and transaction hashes"],
    ["POST", `${path}/swap/quote`, "Quote a swap through the deployed Uniswap pool"],
    ["POST", `${path}/swap/approval`, "Prepare an unsigned token approval"],
    ["POST", `${path}/swap/transaction`, "Simulate and prepare a wallet-signed swap"],
  ];
  return (
    <div className="wb-scroll-page">
      <div className="wb-section-heading">
        <h2>REST API.</h2>
        <p>Integrate with banking providers.</p>
      </div>
      {sample ? (
        <Notice>
          Sample export. These are documented route shapes, not live responses. Connect a gateway to use this
          contract lifecycle.
        </Notice>
      ) : (
        <Notice>
          Connected to <code>{baseUrl}</code>. Keys are intentionally omitted from this view and downloads.
        </Notice>
      )}
      <div className="wb-actions">
        <button onClick={refresh}>
          <Icon name="refresh" />
          Refresh from source
        </button>
        <button
          disabled={!policy}
          onClick={() => policy && downloadJson(policy, `${sample ? "sample" : record.id}-policy.json`)}
        >
          Download policy export
        </button>
      </div>
      <div className="wb-endpoints">
        {routes.map(([method, route, description]) => (
          <div key={`${method}${route}`}>
            <code className={method === "GET" ? "wb-method-read" : "wb-method-write"}>{method}</code>
            <code>{sample ? route.replace(encodeURIComponent(record.id), ":id") : route}</code>
            <span>{description}</span>
          </div>
        ))}
      </div>
      <details>
        <summary>{sample ? "Exported sample" : "Latest contract response"} · JSON</summary>
        <pre className="wb-json">{JSON.stringify(sample ? policy : record, null, 2)}</pre>
      </details>
    </div>
  );
}

export function DeployView({
  record,
  policy,
  constraints,
  constraintError,
  sample,
  writable,
  busy,
  status,
  client,
  blocked,
  onDeploy,
  onConstrain,
}: {
  record: AgreementDetail;
  policy: PolicyData | null;
  constraints: Constraints | null;
  constraintError: string;
  sample: boolean;
  writable: boolean;
  busy: boolean;
  status: StackStatus | null;
  client: AgreementsClient;
  blocked: string | null;
  onDeploy: () => void;
  onConstrain: (constraints: Constraints) => void;
}) {
  const deployment = !sample && record.status === "deployed" ? record.deployment : null;
  const mismatch = !!deployment && deployment.policyHash !== record.policyHash;
  const explorer = deployment?.chainId === 11155111 ? "https://sepolia.etherscan.io" : null;
  const sources = Object.entries(policy?.contractSources ?? {});
  return (
    <div className="wb-scroll-page">
      <div className="wb-section-heading">
        <h2>{deployment ? "Deployment" : "Prepare for deployment"}</h2>
        <p>The policy hash binds the source, extracted rules and issuer configuration.</p>
      </div>
      <div className="wb-deploy-grid">
        <section className="wb-surface">
          <h3>Policy summary</h3>
          <dl className="wb-dl">
            <dt>Mode</dt>
            <dd>{sample ? "Sample · offline export" : `Gateway · ${record.status}`}</dd>
            <dt>Profile</dt>
            <dd>{record.profile}</dd>
            <dt>Policy hash</dt>
            <dd>
              <code>{record.policyHash ?? "Not compiled yet"}</code>
            </dd>
            <dt>Executable subset</dt>
            <dd>
              {policy
                ? `${policy.rules.length} rules · ${policy.terms.length} terms · ${policy.unresolved.length} unresolved`
                : "Waiting for compilation"}
            </dd>
            <dt>Target chain</dt>
            <dd>
              {sample
                ? "None (sample)"
                : status?.chain
                  ? `Chain ${status.chain.chainId}`
                  : "No signer reported"}
            </dd>
          </dl>
          {policy?.demo && (
            <Notice>
              Demo compilation permits unresolved terms. Review coverage, extraction evidence and assumptions
              before deployment.
            </Notice>
          )}
          <button className="wb-primary" disabled={!!blocked || busy} onClick={onDeploy}>
            <Icon name="rocket" />
            {record.status === "deploying" ? "Deploying…" : "Review deployment"}
          </button>
          {blocked && <p className="wb-muted">{blocked}</p>}
        </section>
        <section className="wb-surface">
          <h3>Deployment & economics</h3>
          {deployment ? (
            <>
              <Notice>
                {mismatch
                  ? "Warning: deployment and current policy hashes differ. Do not treat this as the current policy deployment."
                  : `Gateway reports deployment on chain ${deployment.chainId}. This UI has not independently queried the chain.`}
              </Notice>
              <dl className="wb-dl">
                {Object.entries({
                  "Deployed at": deployment.deployedAt,
                  Token: deployment.token,
                  Oracle: deployment.oracle,
                  Hook: deployment.hook,
                  "Role provider": deployment.roleProvider,
                  "Mock credit market": deployment.market,
                  "Buyback router": deployment.roleProvider ? deployment.router : undefined,
                  "Pool manager": deployment.poolManager,
                  "Pool ID": deployment.poolId,
                  "Deployed policy": deployment.policyHash,
                })
                  .filter(([, value]) => value !== undefined)
                  .map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>
                        <code>{value}</code>
                        {explorer && /^0x[0-9a-fA-F]{40}$/.test(String(value)) && (
                          <>
                            {" "}
                            <a href={`${explorer}/address/${value}`} target="_blank" rel="noreferrer">
                              Etherscan ↗
                            </a>
                          </>
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
              <section aria-label="Deployment transactions">
                <h4>Deployment transaction hashes</h4>
                {Object.entries(deployment.txs ?? {}).map(([label, hash]) => (
                  <p key={label}>
                    {label}: <code>{hash}</code>
                    {explorer && (
                      <>
                        {" "}
                        <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
                          Etherscan ↗
                        </a>
                      </>
                    )}
                  </p>
                ))}
                {!Object.keys(deployment.txs ?? {}).length && (
                  <p className="wb-muted">No transaction hashes reported by the gateway.</p>
                )}
              </section>
            </>
          ) : (
            <p className="wb-muted">
              No current deployment reported for this contract. An exported policy or successful compilation
              is not an on-chain deployment.
            </p>
          )}
          <Notice>
            Policy enforcement does not establish NAV, reserves, redemption liquidity, or settlement at NAV.
            Those require separate valuation and cashier arrangements. No live NAV or cashier integration is
            asserted here.
          </Notice>
        </section>
      </div>
      <section className="wb-surface">
        <h3>Contract code</h3>
        <p className="wb-muted">
          Generated Solidity for the current policy. These files use shared contract dependencies.
        </p>
        {mismatch && (
          <Notice>
            These sources describe the current policy, which differs from the recorded deployment.
          </Notice>
        )}
        {sources.length ? (
          sources.map(([filename, source]) => (
            <details key={filename}>
              <summary>{filename}</summary>
              <pre className="wb-json">
                <code>{source}</code>
              </pre>
            </details>
          ))
        ) : (
          <p className="wb-muted">
            Contract source is not available in this export. Compile the agreement or refresh from a gateway
            that provides contract sources.
          </p>
        )}
      </section>
      {policy && (
        <section className="wb-surface">
          {constraintError && <Notice error>{constraintError}</Notice>}
          {constraints ? (
            <ConstraintForm
              key={`${record.id}:${record.policyHash}:${JSON.stringify(constraints)}`}
              constraints={constraints}
              policy={policy}
              writable={writable && !sample}
              busy={busy}
              onSave={onConstrain}
            />
          ) : (
            <p>
              {sample
                ? "Connect a gateway to configure an issuer World ID constraint. Sample exports are read-only."
                : "Identity constraints are not available yet. They load after compilation."}
            </p>
          )}
        </section>
      )}

      {policy && <LocalEvaluator key={policy.policyHash} policy={policy} />}
      {!!record.history.length && (
        <details className="wb-history">
          <summary>Lifecycle history · {record.history.length} transitions</summary>
          <ol>
            {record.history.map((item, index) => (
              <li key={index}>
                <strong>{item.status}</strong>
                <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
                {item.policyHash && <code>{item.policyHash}</code>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
