"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ruleRef, segmentLines, termRef, type Line, type Span } from "@/lib/segments";
import type { Effect, PolicyData } from "@/lib/types";

type Props = {
  policy: PolicyData;
  selected: string | null;
  hot: Set<string>;
  /** Scroll the selected quote into view (not when the click came from the document itself) */
  scrollKey: number;
  onHover: (refs: string[]) => void;
  onSelect: (ref: string, fromDocument: boolean) => void;
};

/** Markdown markers stay visible (the quote is verbatim) but step back. */
function inline(text: string, markdown: boolean, lineStart: boolean): ReactNode {
  if (!markdown) return text;
  const out: ReactNode[] = [];
  let rest = text;
  if (lineStart) {
    const heading = /^#+ /.exec(rest);
    if (heading) {
      out.push(
        <span key="h" className="md-mark">
          {heading[0]}
        </span>
      );
      rest = rest.slice(heading[0].length);
    }
  }
  rest.split(/(\*\*)/).forEach((chunk, index) =>
    out.push(
      chunk === "**" ? (
        <span key={index} className="md-mark">
          **
        </span>
      ) : (
        chunk
      )
    )
  );
  return out;
}

type LineProps = {
  line: Line;
  display: string;
  markdown: boolean;
  tone: Record<string, Effect | "term">;
  /** The refs on this line that are hot or selected, as a string so memo can compare it */
  state: string;
  unresolved: PolicyData["unresolved"];
  onHover: (refs: string[]) => void;
  onSelect: (ref: string, fromDocument: boolean) => void;
};

const DocLine = memo(function DocLine({
  line,
  display,
  markdown,
  tone,
  state,
  unresolved,
  onHover,
  onSelect,
}: LineProps) {
  const [openMarker, setOpenMarker] = useState<number | null>(null);
  const heading = markdown ? /^(#+) /.exec(display.slice(line.start, line.end)) : null;
  const hot = new Set(
    state
      .split(" ")
      .filter((s) => s.startsWith("h:"))
      .map((s) => s.slice(2))
  );
  const sel =
    state
      .split(" ")
      .find((s) => s.startsWith("s:"))
      ?.slice(2) ?? null;
  return (
    <>
      {line.markers.map((index) => (
        <div key={`m${index}`}>
          <button
            type="button"
            className="nc"
            onClick={() => setOpenMarker(openMarker === index ? null : index)}
            aria-expanded={openMarker === index}
          >
            ⚠ not compiled · {unresolved[index].clause}
          </button>
          {openMarker === index && <span className="nc-desc">{unresolved[index].description}</span>}
        </div>
      ))}
      <div className={`ln ${heading ? `ln-h ln-h${Math.min(heading[1].length, 3)}` : ""}`}>
        {line.pieces.map((piece) => {
          const text = display.slice(piece.start, piece.end);
          const content = inline(text, markdown, piece.start === line.start);
          if (!piece.refs.length) return <span key={piece.start}>{content}</span>;
          const primary = piece.refs.includes(sel ?? "") ? sel! : piece.refs[0];
          const classes = [
            "q",
            `q-${tone[primary]}`,
            piece.refs.length > 1 ? "q-multi" : "",
            piece.refs.some((ref) => hot.has(ref)) ? "q-hot" : "",
            sel && piece.refs.includes(sel) ? "q-sel" : "",
          ];
          return (
            <mark
              key={piece.start}
              className={classes.join(" ")}
              data-open={piece.opens.join(" ") || undefined}
              title={piece.refs.map((ref) => ref.replace(/^(rule|term):/, "")).join(" · ")}
              onMouseEnter={() => onHover(piece.refs)}
              onMouseLeave={() => onHover([])}
              onClick={() => {
                // A second click on a shared sentence moves to the next rule quoting it.
                const at = sel ? piece.refs.indexOf(sel) : -1;
                onSelect(piece.refs[(at + 1) % piece.refs.length], true);
              }}
            >
              {content}
            </mark>
          );
        })}
      </div>
    </>
  );
});

export function DocumentPane({ policy, selected, hot, scrollKey, onHover, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const tone = useMemo(() => {
    const map: Record<string, Effect | "term"> = {};
    policy.rules.forEach((rule) => (map[ruleRef(rule.id)] = rule.effect));
    policy.terms.forEach((term) => (map[termRef(term.name)] = "term"));
    return map;
  }, [policy]);

  const parts = useMemo(
    () =>
      policy.documents.map((part, index) => {
        const spans: Span[] = [
          ...policy.rules.flatMap((rule) =>
            rule.quotes
              .filter((q) => q.part === index)
              .map((q) => ({ start: q.displayStart, end: q.displayEnd, ref: ruleRef(rule.id) }))
          ),
          ...policy.terms.flatMap((term) =>
            term.quotes
              .filter((q) => q.part === index)
              .map((q) => ({ start: q.displayStart, end: q.displayEnd, ref: termRef(term.name) }))
          ),
        ];
        const markers = policy.unresolved.flatMap((entry, i) =>
          entry.anchor?.part === index ? [{ offset: entry.anchor.offset, index: i }] : []
        );
        return {
          part,
          markdown: part.name.endsWith(".md"),
          lines: segmentLines(part.display, spans, markers),
        };
      }),
    [policy]
  );
  const unanchored = policy.unresolved.map((entry, i) => ({ entry, i })).filter(({ entry }) => !entry.anchor);

  useEffect(() => {
    if (!selected || !scroller.current || scrollKey === 0) return;
    const target = scroller.current.querySelector<HTMLElement>(`[data-open~="${CSS.escape(selected)}"]`);
    if (!target) return;
    const box = scroller.current;
    const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: "smooth" });
  }, [selected, scrollKey]);

  const stateOf = (line: Line) => {
    const refs = new Set(line.pieces.flatMap((piece) => piece.refs));
    if (!refs.size) return "";
    const out: string[] = [];
    refs.forEach((ref) => {
      if (hot.has(ref)) out.push(`h:${ref}`);
      if (ref === selected) out.push(`s:${ref}`);
    });
    return out.join(" ");
  };

  return (
    <section className="card doc-card" aria-label="Source document">
      <div className="doc-head">
        <h2>Source document</h2>
        <div className="doc-legend">
          <span className="chip chip-permit">permit</span>
          <span className="chip chip-require">require</span>
          <span className="chip chip-forbid">forbid</span>
          {policy.terms.length > 0 && <span className="chip chip-term">term</span>}
          <span className="chip chip-review">not compiled</span>
        </div>
      </div>
      <div className="doc-scroll" ref={scroller}>
        {unanchored.length > 0 && (
          <div className="doc-unanchored">
            {unanchored.map(({ entry, i }) => (
              <details key={i}>
                <summary className="nc">⚠ not compiled · {entry.clause}</summary>
                <span className="nc-desc">{entry.description}</span>
              </details>
            ))}
          </div>
        )}
        {parts.map(({ part, markdown, lines }, index) => (
          <article className="doc-part" key={part.name}>
            <div className="doc-partHead">
              <strong>{part.name}</strong>
              <span className="small muted mono" title={part.sha256}>
                sha256 {part.sha256.slice(0, 12)}…
              </span>
              <span className="small muted">
                chars {part.start.toLocaleString()}–{part.end.toLocaleString()} of the bundle
              </span>
            </div>
            <div className="doc-text" lang="en">
              {lines.map((line) => (
                <DocLine
                  key={`${index}:${line.start}`}
                  line={line}
                  display={part.display}
                  markdown={markdown}
                  tone={tone}
                  state={stateOf(line)}
                  unresolved={policy.unresolved}
                  onHover={onHover}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
