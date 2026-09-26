"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AstGraph } from "@/lib/agreements";
import type { PolicyData } from "@/lib/types";
import {
  dnfText,
  graphForAction,
  layoutGraph,
  nodeTone,
  NODE_HEIGHT,
  NODE_WIDTH,
  verificationLabel,
} from "@/lib/workbench";
import { DocumentPane } from "../_policy/DocumentPane";
import { Evaluator } from "../_policy/Evaluator";
import type { Facts } from "@/lib/evaluate";
import { Icon, Notice } from "./ui";

export function SourceCards({
  policy,
  selected,
  onSelect,
}: {
  policy: PolicyData;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("[data-node]") ?? []).find(
      (el) => el.dataset.node === selected
    );
    const list = ref.current;
    if (element && list) {
      const top = element.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (top < 0 || top + element.offsetHeight > list.clientHeight) list.scrollTop += top;
    }
  }, [selected]);
  const cards = [
    ...policy.rules.map((rule) => ({
      id: `rule:${rule.id}`,
      clause: rule.source.clause,
      quote: rule.source.quote,
      label: `${rule.action} · ${rule.effect}`,
      name: rule.id,
      note: rule.rationale,
    })),
    ...policy.terms.map((term) => ({
      id: `term:${term.name}`,
      clause: term.source.clause,
      quote: term.source.quote,
      label: `term · ${term.value} ${term.unit}`,
      name: term.name,
      note: term.rationale,
    })),
    ...policy.unresolved.map((item, index) => ({
      id: `unresolved:${index}`,
      clause: item.clause,
      quote: item.description,
      label: "unresolved · not enforced",
      name: "Open interpretation",
      note: "This item has not been compiled into an enforceable rule.",
    })),
  ];
  return (
    <section className="wb-source-pane" aria-labelledby="source-heading">
      <header className="wb-pane-head">
        <div>
          <Icon name="file" />
          <h2 id="source-heading">Source clauses</h2>
        </div>
        <span>
          {policy.rules.length} rules · {policy.terms.length} terms
        </span>
      </header>
      <div className="wb-source-intro">
        <span className="wb-eyebrow">HUMAN LANGUAGE → EXECUTABLE POLICY</span>
        <p>
          Every rule starts with a sentence.
          <br />
          <span className="wb-muted">Select a clause to trace its logic.</span>
        </p>
      </div>
      <div className="wb-clause-list" ref={ref}>
        {cards.map((card, index) => (
          <button
            key={card.id}
            data-node={card.id}
            aria-pressed={selected === card.id}
            className={`wb-clause wb-tone-${nodeTone(card.id, policy)} ${selected === card.id ? "is-selected" : ""}`}
            onClick={() => onSelect(card.id)}
          >
            <span className="wb-clause-top">
              <span className="wb-clause-number">{String(index + 1).padStart(2, "0")}</span>
              <span>{card.clause}</span>
              <Icon name="arrow" size={15} />
            </span>
            <span className="wb-clause-quote">{card.quote}</span>
            <span className="wb-clause-bottom">
              <code>{card.label}</code>
              <span className="wb-dot" />
            </span>
            {selected === card.id && card.note && <span className="wb-clause-note">{card.note}</span>}
          </button>
        ))}
        {!cards.length && <Notice>No extracted rules, terms or unresolved items were returned.</Notice>}
        <p className="wb-source-foot">
          Only the executable subset is shown here. Open Human Language for the complete document and
          coverage.
        </p>
      </div>
    </section>
  );
}

export function GraphPane({
  graph,
  policy,
  selected,
  onSelect,
  sample,
}: {
  graph: AstGraph;
  policy: PolicyData;
  selected: string;
  onSelect: (id: string) => void;
  sample: boolean;
}) {
  const [scope, setScope] = useState("selection");
  const [manualZoom, setZoom] = useState<number | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(660);
  const selectedRule = policy.rules.find((rule) => `rule:${rule.id}` === selected);
  const action = scope === "selection" ? (selectedRule?.action ?? "") : scope;
  const filtered = useMemo(() => graphForAction(graph, action), [graph, action]);
  const columns = canvasWidth < 560 ? 2 : 3;
  const layout = useMemo(() => layoutGraph(filtered, columns), [filtered, columns]);
  const viewport = useRef<HTMLDivElement>(null);
  const zoom = manualZoom ?? Math.max(0.5, Math.min(1, canvasWidth / layout.width));
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setCanvasWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const selectedNode = graph.nodes.find((node) => node.id === selected);
  const connected = new Set([
    selected,
    ...graph.edges
      .filter((edge) => edge.from === selected || edge.to === selected)
      .flatMap((edge) => [edge.from, edge.to]),
  ]);
  return (
    <section className="wb-graph-pane" aria-labelledby="graph-heading">
      <header className="wb-pane-head">
        <div>
          <Icon name="tree" />
          <h2 id="graph-heading">Contract-AST</h2>
        </div>
        <span>{sample ? "Export-derived graph" : "Gateway /ast"}</span>
      </header>
      <div className="wb-graph-tools">
        <label className="wb-sr-only" htmlFor="graph-scope">
          Graph scope
        </label>
        <select id="graph-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="selection">Selected action</option>
          <option value="">Entire agreement</option>
          {policy.actionOrder.map((item) => (
            <option value={item} key={item}>
              {item}
            </option>
          ))}
        </select>
        <div>
          <button
            aria-label="Zoom out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom(Math.max(0.5, zoom - 0.1))}
          >
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            aria-label="Zoom in"
            disabled={zoom >= 1.5}
            onClick={() => setZoom(Math.min(1.5, zoom + 0.1))}
          >
            +
          </button>
          <button onClick={() => setZoom(null)}>Fit</button>
        </div>
      </div>
      <div
        className="wb-graph-scroll"
        ref={viewport}
        tabIndex={0}
        aria-label="AST canvas. Scroll to pan; use graph buttons to inspect nodes."
      >
        <div style={{ width: layout.width * zoom, height: layout.height * zoom }}>
          <div
            className="wb-graph-canvas"
            style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
          >
            <svg width={layout.width} height={layout.height} aria-hidden="true" className="wb-edges">
              {layout.edges.map((edge) => (
                <path
                  key={edge.key}
                  d={edge.d}
                  className={edge.from === selected || edge.to === selected ? "is-connected" : ""}
                />
              ))}
            </svg>
            {layout.nodes.map((node) => (
              <button
                key={node.id}
                className={`wb-node wb-tone-${nodeTone(node.id, policy)} ${selected === node.id ? "is-selected" : ""} ${connected.has(node.id) ? "is-connected" : ""}`}
                style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                aria-pressed={selected === node.id}
                onClick={() => onSelect(node.id)}
                title={`${node.kind}: ${node.label}${node.clause ? ` · ${node.clause}` : ""}`}
              >
                <span className="wb-node-type">
                  <span className="wb-dot" />
                  {node.kind}
                  {node.effect && ` / ${node.effect}`}
                </span>
                <strong>{node.label}</strong>
                <span>
                  {node.clause ??
                    (node.kind === "agreement"
                      ? "source-linked policy"
                      : node.kind === "fact"
                        ? "attested boolean input"
                        : (node.value ?? ""))}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="wb-graph-legend">
        <span>
          <i className="wb-dot" />
          Source-linked node
        </span>
        <span>── Compiler relationships</span>
        <span>No inferred chain state</span>
      </div>
      <div className="wb-inspector" aria-live="polite">
        <span className="wb-eyebrow">INSPECTOR / {selectedNode?.kind ?? "NODE"}</span>
        <h3>{selectedNode?.label ?? "Select a node"}</h3>
        {selectedRule ? (
          <>
            <p>
              {selectedRule.effect.toUpperCase()} {selectedRule.action} when:
            </p>
            <code className="wb-logic">{dnfText(policy, selected)}</code>
            <p className="wb-muted">
              Clause #{selectedRule.clauseId} · {selectedRule.dnf.length} DNF term(s) · verdict evidence is in
              the extraction report, not implied by this graph.
            </p>
          </>
        ) : (
          <p>
            {selectedNode?.description ??
              selectedNode?.clause ??
              "Select a rule to inspect its compiled DNF and source clause."}
          </p>
        )}
      </div>
    </section>
  );
}

export function HumanView({
  policy,
  selected,
  onSelect,
}: {
  policy: PolicyData;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [hot, setHot] = useState<Set<string>>(new Set());
  return (
    <div className="wb-human-view">
      <div className="wb-section-heading">
        <span className="wb-eyebrow">THE ORIGINAL AGREEMENT</span>
        <h2>{policy.title}</h2>
        <p>
          {policy.coverage.counts.compiled} of {policy.coverage.total} paragraphs compiled ·{" "}
          {policy.coverage.counts.unresolved} unresolved · {policy.coverage.counts["not-executable"]} not
          executable
        </p>
      </div>
      <DocumentPane
        policy={policy}
        selected={selected}
        hot={hot}
        onHover={(refs) => setHot(new Set(refs))}
        scrollKey={0}
        onSelect={onSelect}
      />
    </div>
  );
}

export function Evidence({ policy, sample }: { policy: PolicyData; sample: boolean }) {
  const report = policy.verification;
  return (
    <div className="wb-evidence">
      <Notice>
        {verificationLabel(policy, sample)}. This is extraction evidence, not a legal opinion or a guarantee
        that the entire agreement is enforced.
      </Notice>
      <dl className="wb-dl">
        <dt>Source SHA-256</dt>
        <dd>
          <code>{policy.source.sha256}</code>
        </dd>
        <dt>Policy hash</dt>
        <dd>
          <code>{policy.policyHash}</code>
        </dd>
        <dt>Clause table hash</dt>
        <dd>
          <code>{policy.clauseTableHash}</code>
        </dd>
        <dt>Extraction</dt>
        <dd>
          {policy.extraction.provider} · {policy.extraction.model ?? "no model recorded"}
        </dd>
        <dt>Compiler checks</dt>
        <dd>{policy.equivalenceChecks.toLocaleString()} exhaustive equivalence checks (not Z3)</dd>
        <dt>Compile mode</dt>
        <dd>{policy.demo ? "Demo compilation · unresolved terms may remain" : "Standard compilation"}</dd>
        {report && (
          <>
            <dt>Report provenance</dt>
            <dd>
              {report.provider} ·{" "}
              {report.mock === true ? "mock" : report.mock === false ? "live" : "mode not recorded"} · job{" "}
              <code>{report.jobId}</code>
            </dd>
            <dt>Evaluators</dt>
            <dd>
              {report.agents.join(", ")} · {report.rounds} rounds
            </dd>
            <dt>Claims</dt>
            <dd>
              {report.confidence.verified} / {report.confidence.total} verified ·{" "}
              {report.confidence.counts.contested} contested · {report.confidence.counts.unverified}{" "}
              unverified · {report.confidence.counts.wrong} wrong · {report.confidence.counts.unknown} unknown
            </dd>
          </>
        )}
      </dl>
      <p className="wb-muted">
        The report describes extraction. Issuer-added identity constraints are separate decisions; saving one
        does not run a fresh deliberation. Review the per-claim evidence before relying on it.
      </p>
      {report && (
        <details>
          <summary>Per-claim extraction evidence ({report.claims.length})</summary>
          {report.claims.map((claim) => (
            <article className="wb-claim" key={claim.key}>
              <code>{claim.ref}</code>
              <p>{claim.claim}</p>
              {claim.verdicts.map((verdict, index) => (
                <p key={index}>
                  <strong>
                    {verdict.agent}: {verdict.verdict}
                  </strong>{" "}
                  — {verdict.reason ?? "No reason recorded"}
                </p>
              ))}
            </article>
          ))}
        </details>
      )}
    </div>
  );
}

export function LocalEvaluator({ policy }: { policy: PolicyData }) {
  const [facts, setFacts] = useState<Facts>({});
  const [action, setAction] = useState(policy.actionOrder[0]);
  return (
    <details className="wb-simulation">
      <summary>Try the compiled policy · local simulation</summary>
      <p className="wb-muted">
        Runs the existing browser evaluator only. It does not attest facts, verify identity, or transact.
      </p>
      <label>
        Action
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          {policy.actionOrder.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <Evaluator policy={policy} facts={facts} setFacts={setFacts} presets={[]} action={action} />
    </details>
  );
}
