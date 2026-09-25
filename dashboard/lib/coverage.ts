// Paragraph-level coverage: which lines belong to which paragraph, what clicking one selects, and how
// the coverage reads as a sentence.
import { ruleRef, termRef, type Line } from "./segments";
import type { Coverage, Paragraph, ParagraphStatus } from "./types";

export type Block = { paragraph: number | null; lines: Line[] };

/**
 * Groups a part's lines under the paragraph each belongs to. Paragraphs are whole lines, so a line
 * belongs to the paragraph whose range contains its start; blank lines between paragraphs stand alone.
 */
export function groupLines(lines: Line[], paragraphs: { index: number; paragraph: Paragraph }[]): Block[] {
  const sorted = [...paragraphs].sort((a, b) => a.paragraph.displayStart - b.paragraph.displayStart);
  const blocks: Block[] = [];
  let cursor = 0;
  for (const line of lines) {
    while (cursor < sorted.length && sorted[cursor].paragraph.displayEnd < line.start) cursor++;
    const owner = sorted[cursor];
    const inside =
      owner && line.start >= owner.paragraph.displayStart && line.start <= owner.paragraph.displayEnd;
    const index = inside && line.end > line.start ? owner.index : null;
    const last = blocks.at(-1);
    if (last && last.paragraph === index && index !== null) last.lines.push(line);
    else blocks.push({ paragraph: index, lines: [line] });
  }
  return blocks;
}

/** Every rule and term a paragraph compiles to, as selection refs. */
export const refsOf = (paragraph: Paragraph) => [
  ...paragraph.rules.map(ruleRef),
  ...paragraph.terms.map(termRef),
];

/** The ref a click on a compiled paragraph selects: the first, or the one after the current selection. */
export function nextRef(paragraph: Paragraph, selected: string | null): string | null {
  const refs = refsOf(paragraph);
  if (!refs.length) return null;
  const at = selected ? refs.indexOf(selected) : -1;
  return refs[(at + 1) % refs.length];
}

export function coverageSentence(coverage: Coverage): string {
  const { counts, total, rules, terms } = coverage;
  const into = [
    `${rules} rule${rules === 1 ? "" : "s"}`,
    terms ? `${terms} value${terms === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return `${counts.compiled} of ${total} paragraphs are enforced on-chain as ${into} · ${counts.unresolved} open items · ${counts["not-executable"]} not enforceable`;
}

export const NOT_EXECUTABLE =
  "No rule or term quotes this paragraph. The compiler emits nothing it cannot quote.";

export function paragraphTitle(paragraph: Paragraph, clauses: string[]): string {
  const label = paragraph.label ? `${paragraph.label} · ` : "";
  if (paragraph.status === "compiled") {
    const by = paragraph.components.length ? ` · enforced by ${paragraph.components.join(", ")}` : "";
    return `${label}compiled → ${[...paragraph.rules, ...paragraph.terms].join(", ")}${by}`;
  }
  if (paragraph.status === "unresolved")
    return `${label}not compiled (${clauses.join("; ")}) — click for the reason`;
  return `${label}${NOT_EXECUTABLE}`;
}

export type CoverageFilter = "all" | ParagraphStatus;

/** Headings stay visible under a filter so the reader keeps their place in the document. */
export const visibleUnder = (filter: CoverageFilter, paragraph: Paragraph) =>
  filter === "all" || paragraph.status === filter || paragraph.kind === "heading";
