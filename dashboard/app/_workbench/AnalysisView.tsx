"use client";

import { isLegalAst } from "@/lib/legal-ast";
import { useState } from "react";
import type { AgreementDetail } from "@/lib/agreements";
import { inFlight } from "@/lib/agreements";
import { Evidence } from "./PolicyPanes";
import { Icon, Notice } from "./ui";

export function AnalysisView({
  record,
  sample,
  onAst,
  onIdentity,
}: {
  record: AgreementDetail;
  sample: boolean;
  onAst: (node?: string) => void;
  onIdentity: () => void;
}) {
  const policy = record.export;
  const report = policy?.verification;
  const [filter, setFilter] = useState("all");
  const claims =
    report?.claims.filter(
      (claim) =>
        filter === "all" ||
        (filter === "contested"
          ? claim.disputed || claim.verdicts.some((verdict) => verdict.verdict === "contested")
          : claim.verdicts.some((verdict) => verdict.verdict === filter))
    ) ?? [];
  const stages = [
    { name: "Documents received", state: "uploaded" },
    { name: "Document structure extraction", state: "extracting" },
    { name: "AST / source validation", state: "verified" },
    { name: "Compile & equivalence", state: "compiled" },
  ] as const;
  const latestRun = record.history.map((item) => item.status).lastIndexOf("extracting");
  const seen = new Set(record.history.slice(Math.max(0, latestRun)).map((item) => item.status));
  if (record.history.some((item) => item.status === "uploaded")) seen.add("uploaded");
  return (
    <div className="wb-scroll-page wb-analysis-page">
      <div className="wb-analysis-status">
        <span className="wb-verifier-mode is-demo">
          {sample
            ? "Exported sample"
            : record.extraction?.provider === "openai"
              ? record.extraction.analysisMode === "light"
                ? "OpenAI light analysis · source quotes checked"
                : "OpenAI AST · source quotes checked"
              : record.extraction?.provider === "demo"
                ? "Demo AST · deterministic fixture"
                : report?.mock
                  ? "Historical simulated analysis"
                  : report?.mock === false
                    ? "Historical extraction report"
                    : "Awaiting analysis report"}
        </span>
        <span>{sample ? "No live job history" : record.status}</span>
      </div>
      <ol className="wb-analysis-stages">
        {stages.map((stage) => (
          <li key={stage.state} data-complete={!sample && seen.has(stage.state)}>
            <strong>{stage.name}</strong>
            <span>
              {sample
                ? "Export only"
                : seen.has(stage.state)
                  ? "Recorded"
                  : inFlight(record.status)
                    ? "Waiting"
                    : "Not recorded"}
            </span>
          </li>
        ))}
      </ol>
      {!sample && inFlight(record.status) && (
        <Notice>
          The gateway job is running; this view polls automatically. It may finish between polls. No
          fabricated token stream, agent messages or elapsed-time estimates are shown.
        </Notice>
      )}
      {record.error && <Notice error>{record.error}</Notice>}
      {record.extraction?.analysisMode === "light" && (
        <Notice>
          Light analysis highlights selected key terms and obligations. It does not cover every clause;
          review the full source for omitted details.
        </Notice>
      )}
      {record.extraction?.compilerMapping && (
        <Notice>
          The executable subset uses an explicit MVP mapping for these exact source documents.
          Compliance and settlement are simulated; other provisions remain unresolved.
        </Notice>
      )}
      {isLegalAst(record.ast) && (
        <section className="wb-surface">
          <h3>{record.ast.title}</h3>
          <p>
            {record.ast.nodes.length} source-linked nodes · {record.ast.relations.length} clause relationships
            · {record.ast.issues.length} open questions
          </p>
          <p>
            Source quotations and structural references passed validation. This document AST is ready to
            explore; deployment requires a separate executable policy.
          </p>
          <button className="wb-primary" onClick={() => onAst()}>
            Explore Contract-AST
          </button>
          {record.ast.issues.map((issue, index) => (
            <p key={index}>{issue.description}</p>
          ))}
        </section>
      )}
      {!policy && record.ast && !isLegalAst(record.ast) && (
        <section className="wb-surface">
          <h3>{record.ast.title} · generated AST</h3>
          <p>
            The AST was generated and its source quotes validated. Compilation needs attention before
            deployment.
          </p>
          {record.ast.rules.map((rule) => (
            <article className="wb-claim" key={rule.id}>
              <strong>
                {rule.source.clause} · {rule.action}
              </strong>
              <blockquote>{rule.source.quote}</blockquote>
              <p>{rule.rationale}</p>
            </article>
          ))}
          {record.ast.unresolved.map((item, index) => (
            <p key={index}>
              {item.clause}: {item.description}
            </p>
          ))}
          <details>
            <summary>Generated AST JSON</summary>
            <pre className="wb-json">{JSON.stringify(record.ast, null, 2)}</pre>
          </details>
        </section>
      )}
      {policy && (
        <>
          <section className="wb-analysis-metrics">
            <div>
              <strong>{policy.rules.length}</strong>
              <span>rules</span>
            </div>
            <div>
              <strong>{policy.terms.length}</strong>
              <span>terms</span>
            </div>
            <div>
              <strong>{policy.unresolved.length}</strong>
              <span>open interpretations</span>
            </div>
            <div>
              <strong>{policy.equivalenceChecks.toLocaleString()}</strong>
              <span>exhaustive checks</span>
            </div>
          </section>
          <div className="wb-actions">
            <button className="wb-primary" onClick={() => onAst()}>
              Explore Contract-AST <Icon name="tree" />
            </button>
            <button onClick={onIdentity}>
              Review the World ID trust decision <Icon name="arrow" />
            </button>
          </div>
          {report ? (
            <section className="wb-analysis-claims">
              <div className="wb-section-heading">
                <h3>Historical claim review</h3>
                <p>
                  {report.agents.join(" + ")} · {report.rounds} rounds · job <code>{report.jobId}</code>.{" "}
                  {report.mock
                    ? "Deterministic mock adapter output; these verdicts are not independent model judgment."
                    : "Model verdicts are review evidence, not legal certainty."}
                </p>
              </div>
              <label>
                Filter verdicts
                <select value={filter} onChange={(event) => setFilter(event.target.value)}>
                  <option value="all">All claims</option>
                  {["contested", "unverified", "wrong", "unknown", "verified"].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <p>
                {claims.length} of {report.claims.length} claims
              </p>
              {claims.map((claim) => {
                const source = claim.ref.startsWith("rule:")
                  ? policy.rules.find((rule) => `rule:${rule.id}` === claim.ref)?.source
                  : policy.terms.find((term) => `term:${term.name}` === claim.ref)?.source;
                return (
                  <article className="wb-analysis-claim" key={claim.key}>
                    <code>{claim.ref}</code>
                    <h4>{claim.claim}</h4>
                    {source && (
                      <blockquote>
                        <span>Verbatim source · {source.clause}</span>
                        {source.quote}
                      </blockquote>
                    )}
                    {claim.verdicts.map((verdict, index) => (
                      <p key={index}>
                        <strong>
                          {verdict.agent} · {verdict.verdict}
                        </strong>{" "}
                        — {verdict.reason ?? "No reason recorded"}
                      </p>
                    ))}
                    {source && (
                      <button onClick={() => onAst(claim.ref)}>
                        Trace this claim <Icon name="arrow" size={14} />
                      </button>
                    )}
                  </article>
                );
              })}
              {!claims.length && (
                <p className="wb-muted">
                  No claims match this filter. This does not establish that the contract is complete.
                </p>
              )}
              {!!report.contested.length && (
                <details>
                  <summary>Evaluator counter-positions ({report.contested.length})</summary>
                  {report.contested.map((item, index) => (
                    <article className="wb-claim" key={index}>
                      <strong>
                        {item.evaluator} · {item.confidence} confidence
                      </strong>
                      <p>{item.claim}</p>
                      <p>{item.position}</p>
                    </article>
                  ))}
                </details>
              )}
            </section>
          ) : (
            <Notice>
              {record.extraction?.provider === "openai"
                ? "OpenAI generated this AST. Source quotes and compiler equivalence were checked locally; no independent model review was performed."
                : "This demo uses a deterministic fixture. No live model review was performed."}
            </Notice>
          )}
          <section className="wb-surface">
            <h3>Not yet executable</h3>
            {policy.unresolved.map((item, index) => (
              <article className="wb-claim" key={index}>
                <strong>{item.clause}</strong>
                <p>{item.description}</p>
              </article>
            ))}
            <p className="wb-muted">
              Coverage: {policy.coverage.counts.compiled} of {policy.coverage.total} paragraphs compiled;{" "}
              {policy.coverage.counts.unresolved} unresolved paragraphs. Uncompiled text is not silently
              enforced.
            </p>
          </section>
          <details>
            <summary>Provenance, assumptions & verification details</summary>
            <Evidence policy={policy} sample={sample} />
            <ul>
              {policy.config.assumptions?.map((assumption, index) => (
                <li key={index}>{assumption}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      {!sample && !!record.history.length && (
        <details className="wb-history">
          <summary>Actual lifecycle timestamps</summary>
          <ol>
            {record.history.map((item, index) => (
              <li key={index}>
                {item.status} <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
