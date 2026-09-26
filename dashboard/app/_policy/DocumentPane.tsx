"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  coverageSentence,
  groupLines,
  nextRef,
  paragraphTitle,
  visibleUnder,
  type CoverageFilter,
} from "@/lib/coverage";
import { ruleRef, segmentLines, termRef, type Line, type Span } from "@/lib/segments";
import type { Effect, Paragraph, PolicyData } from "@/lib/types";

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
            onClick={(event) => {
              event.stopPropagation();
              setOpenMarker(openMarker === index ? null : index);
            }}
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
              onClick={(event) => {
                event.stopPropagation();
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

const FILTERS: { value: CoverageFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "compiled", label: "Enforced" },
  { value: "unresolved", label: "Open items" },
  { value: "not-executable", label: "Not enforceable" },
];

function CoverageBar({
  policy,
  filter,
  setFilter,
}: {
  policy: PolicyData;
  filter: CoverageFilter;
  setFilter: (filter: CoverageFilter) => void;
}) {
  const { counts } = policy.coverage;
  return (
    <div className="cov">
      <div className="cov-bar" aria-hidden>
        <span className="cov-compiled" style={{ flexGrow: counts.compiled }} />
        <span className="cov-unresolved" style={{ flexGrow: counts.unresolved }} />
        <span className="cov-not-executable" style={{ flexGrow: counts["not-executable"] }} />
      </div>
      <div className="cov-row">
        <span className="small">{coverageSentence(policy.coverage)}</span>
        <span className="cov-filters" role="radiogroup" aria-label="Show paragraphs">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={filter === option.value}
              className={`cov-filter cov-f-${option.value} ${filter === option.value ? "on" : ""}`}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
              {option.value !== "all" && <span className="muted"> {counts[option.value]}</span>}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

export function DocumentPane({ policy, selected, hot, scrollKey, onHover, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<CoverageFilter>("all");
  const [reason, setReason] = useState<number | null>(null);
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
        const lines = segmentLines(part.display, spans, markers);
        const paragraphs = policy.coverage.paragraphs
          .map((paragraph, i) => ({ index: i, paragraph }))
          .filter(({ paragraph }) => paragraph.part === index);
        return { part, markdown: part.name.endsWith(".md"), lines, blocks: groupLines(lines, paragraphs) };
      }),
    [policy]
  );
  const unanchored = policy.unresolved.map((entry, i) => ({ entry, i })).filter(({ entry }) => !entry.anchor);

  useEffect(() => {
    if (!selected || !scroller.current || scrollKey === 0) return;
    const target = scroller.current.querySelector<HTMLElement>(`[data-open~="${CSS.escape(selected)}"]`);
    if (!target) {
      // The quote sits in a paragraph the filter hides: show everything and try again.
      if (filter !== "all") setFilter("all");
      return;
    }
    const box = scroller.current;
    const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({
      top: Math.max(0, top - box.clientHeight / 3),
      behavior: scrollKey === 1 ? "auto" : "smooth",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, scrollKey, filter === "all"]);

  const onParagraph = (index: number, paragraph: Paragraph) => {
    if (paragraph.status === "compiled") {
      const ref = nextRef(paragraph, selected);
      if (ref) onSelect(ref, true);
    } else if (paragraph.status === "unresolved") setReason(reason === index ? null : index);
  };

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
        <h2>The contract</h2>
      </div>
      <CoverageBar policy={policy} filter={filter} setFilter={setFilter} />
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
        {parts.map(({ part, markdown, blocks }, index) => (
          <article className="doc-part" key={part.name}>
            <div className="doc-partHead">
              <strong title={`sha256 ${part.sha256} · chars ${part.start}–${part.end} of the bundle`}>
                {part.name}
              </strong>
            </div>
            <div className={`doc-text ${filter !== "all" ? "doc-filtered" : ""}`} lang="en">
              {blocks.map((block) => {
                const lineViews = block.lines.map((line) => (
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
                ));
                if (block.paragraph === null)
                  return filter === "all" ? (
                    <div key={`${index}:${block.lines[0].start}`}>{lineViews}</div>
                  ) : null;
                const paragraph = policy.coverage.paragraphs[block.paragraph];
                if (!visibleUnder(filter, paragraph)) return null;
                const clauses = paragraph.unresolved.map((i) => policy.unresolved[i].clause);
                return (
                  <div
                    key={`${index}:${block.lines[0].start}`}
                    className={`para para-${paragraph.status} para-k-${paragraph.kind}`}
                    data-tag={paragraph.label || undefined}
                    title={paragraphTitle(paragraph, clauses)}
                    onClick={() => onParagraph(block.paragraph!, paragraph)}
                  >
                    {lineViews}
                    {reason === block.paragraph && paragraph.status === "unresolved" && (
                      <div className="para-reason">
                        {paragraph.unresolved.map((i) => (
                          <div key={i}>
                            <strong>Not compiled · {policy.unresolved[i].clause}.</strong>{" "}
                            {policy.unresolved[i].description}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
