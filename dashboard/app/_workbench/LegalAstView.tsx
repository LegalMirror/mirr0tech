"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { downloadAst, legalGraph, type LegalAst } from "@/lib/legal-ast";
import { Icon } from "./ui";

export function LegalAstView({
  ast,
  selected,
  onSelect,
  human = false,
}: {
  ast: LegalAst;
  selected: string;
  onSelect: (id: string) => void;
  human?: boolean;
}) {
  const initial = ast.nodes.find((node) => node.kind === "clause") ?? ast.nodes[0];
  const active = ast.nodes.find((node) => node.id === selected);
  const selectedId =
    selected && (active || selected === "agreement" || ast.documents.some((doc) => doc.id === selected))
      ? selected
      : initial.id;
  const node = ast.nodes.find((entry) => entry.id === selectedId);
  const [focused, setFocused] = useState(true);
  const [query, setQuery] = useState("");
  const selectGraphNode = (id: string) => {
    setQuery("");
    onSelect(id);
  };
  const [zoom, setZoom] = useState(0.85);
  const list = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const graph = useMemo(() => legalGraph(ast, selectedId, focused), [ast, selectedId, focused]);
  const doc =
    ast.documents.find((entry) => entry.id === (node?.source.documentId ?? selectedId)) ?? ast.documents[0];
  const related = ast.relations.filter((link) => link.from === selectedId || link.to === selectedId);
  const visible = ast.nodes.filter((entry) =>
    `${entry.label} ${entry.summary} ${entry.source.quote}`.toLowerCase().includes(query.toLowerCase())
  );
  useEffect(() => {
    for (const ref of [list, canvas]) {
      const element = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-node]") ?? []).find(
        (el) => el.dataset.node === selectedId
      );
      if (element && ref.current) {
        const rect = element.getBoundingClientRect(),
          parent = ref.current.getBoundingClientRect();
        if (rect.top < parent.top || rect.bottom > parent.bottom)
          ref.current.scrollTop += rect.top - parent.top - 24;
        if (rect.left < parent.left || rect.right > parent.right)
          ref.current.scrollLeft += rect.left - parent.left - 24;
      }
    }
    const mark = source.current?.querySelector("mark");
    if (mark && source.current)
      source.current.scrollTop +=
        mark.getBoundingClientRect().top - source.current.getBoundingClientRect().top - 60;
  }, [selectedId, focused, human]);
  const fit = () => {
    if (canvas.current) setZoom(Math.max(0.25, Math.min(1, canvas.current.clientWidth / graph.width)));
  };
  return (
    <div className="wb-split wb-legal-split">
      <section className="wb-source-pane" aria-labelledby="legal-source-title">
        <header className="wb-pane-head">
          <div>
            <Icon name="file" />
            <h2 id="legal-source-title">Source clauses</h2>
          </div>
          <span>{ast.nodes.length} nodes</span>
        </header>
        <div className="wb-source-intro">
          <span className="wb-eyebrow">LEGAL DOCUMENT → CLAUSE GRAPH</span>
          <p>Select a clause to explore its structure and relationships.</p>
          <label className="wb-sr-only" htmlFor="clause-search">
            Search source clauses
          </label>
          <input
            id="clause-search"
            type="search"
            placeholder="Search clauses…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="wb-clause-list" ref={list}>
          {visible.map((entry) => (
            <button
              key={entry.id}
              data-node={entry.id}
              aria-pressed={entry.id === selectedId}
              className={`wb-clause wb-tone-${entry.kind === "exception" || entry.kind === "prohibition" ? "amber" : "cyan"} ${entry.id === selectedId ? "is-selected" : ""}`}
              onClick={() => onSelect(entry.id)}
            >
              <span className="wb-clause-top">
                <span>{entry.label}</span>
                <Icon name="arrow" size={15} />
              </span>
              <span className="wb-clause-quote">{entry.source.quote}</span>
              <span className="wb-clause-bottom">
                <code>{entry.kind}</code>
                <span>{ast.documents.find((part) => part.id === entry.source.documentId)?.name}</span>
              </span>
              {entry.id === selectedId && <span className="wb-clause-note">{entry.summary}</span>}
            </button>
          ))}
          {!visible.length && <p className="wb-source-foot">No clauses match this search.</p>}
        </div>
      </section>
      <section className="wb-graph-pane" aria-labelledby="legal-graph-title">
        <header className="wb-pane-head">
          <div>
            <Icon name={human ? "file" : "tree"} />
            <h2 id="legal-graph-title">{human ? "Human Language" : "Contract-AST"}</h2>
          </div>
          <span>AST v2 · {ast.relations.length} links</span>
        </header>
        <div className="wb-graph-tools">
          {!human && (
            <label>
              <input
                type="checkbox"
                checked={focused}
                onChange={(event) => setFocused(event.target.checked)}
              />{" "}
              Focus selection
            </label>
          )}
          <div>
            {!human && (
              <>
                <button
                  aria-label="Zoom out"
                  disabled={zoom <= 0.25}
                  onClick={() => setZoom(Math.max(0.25, zoom - 0.1))}
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
                <button onClick={fit}>Fit</button>
              </>
            )}
            <button onClick={() => downloadAst(ast, ast.title)}>Download AST JSON</button>
          </div>
        </div>
        {human ? (
          <div className="wb-legal-document" ref={source}>
            <h3>{doc.name}</h3>
            <p>
              {node && node.source.documentId === doc.id ? (
                <>
                  {doc.text.slice(0, node.source.start)}
                  <mark>{doc.text.slice(node.source.start, node.source.end)}</mark>
                  {doc.text.slice(node.source.end)}
                </>
              ) : (
                doc.text
              )}
            </p>
          </div>
        ) : (
          <div
            className="wb-graph-scroll"
            ref={canvas}
            tabIndex={0}
            aria-label="Clause graph. Scroll to pan; select a node to read its source."
          >
            <div style={{ width: graph.width * zoom, height: graph.height * zoom }}>
              <div
                className="wb-graph-canvas"
                style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}
              >
                <svg width={graph.width} height={graph.height} className="wb-edges" aria-hidden="true">
                  <defs>
                    <marker
                      id="legal-arrow"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                    </marker>
                  </defs>
                  {graph.edges.map((edge) => (
                    <path
                      key={edge.key}
                      d={edge.d}
                      markerEnd="url(#legal-arrow)"
                      className={edge.from === selectedId || edge.to === selectedId ? "is-connected" : ""}
                      strokeDasharray={edge.kind === "contains" ? undefined : "6 4"}
                    >
                      <title>{edge.kind.replaceAll("_", " ")}</title>
                    </path>
                  ))}
                </svg>
                {graph.nodes.map((entry) => (
                  <button
                    key={entry.id}
                    data-node={entry.id}
                    className={`wb-node wb-tone-${entry.kind === "exception" || entry.kind === "prohibition" ? "amber" : "cyan"} ${entry.id === selectedId ? "is-selected" : ""}`}
                    style={{ left: entry.x, top: entry.y, width: 210, height: 84 }}
                    aria-pressed={entry.id === selectedId}
                    onClick={() => selectGraphNode(entry.id)}
                    title={entry.label}
                  >
                    <span className="wb-node-type">
                      <span className="wb-dot" />
                      {entry.kind}
                    </span>
                    <strong>{entry.label}</strong>
                    <span>{entry.id}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <div className="wb-graph-legend">
          <span>── Document hierarchy</span>
          <span>┄ Clause relationships</span>
          <span>{graph.nodes.length} visible nodes</span>
        </div>
        <div className="wb-inspector wb-legal-inspector" aria-live="polite">
          <span className="wb-eyebrow">{node?.kind ?? "DOCUMENT"} / SOURCE EVIDENCE</span>
          <h3>{node?.label ?? graph.nodes.find((entry) => entry.id === selectedId)?.label}</h3>
          {node && (
            <>
              <p>{node.summary}</p>
              <blockquote>{node.source.quote}</blockquote>
              <p className="wb-muted">
                {doc.name} · characters {node.source.start}–{node.source.end}
              </p>
            </>
          )}
          {related.length > 0 && (
            <ul className="wb-legal-links">
              {related.map((link) => {
                const otherId = link.from === selectedId ? link.to : link.from;
                const other = ast.nodes.find((entry) => entry.id === otherId);
                return (
                  <li key={link.id}>
                    <button onClick={() => selectGraphNode(otherId)}>
                      {link.from === selectedId ? "→" : "←"} {link.kind.replaceAll("_", " ")} · {other?.label}
                    </button>
                    <blockquote>{link.source.quote}</blockquote>
                  </li>
                );
              })}
            </ul>
          )}
          {ast.issues
            .filter((issue) => issue.nodeId === null || issue.nodeId === selectedId)
            .map((issue, index) => (
              <p className="wb-legal-issue" key={index}>
                Open question: {issue.description}
              </p>
            ))}
        </div>
      </section>
    </div>
  );
}
