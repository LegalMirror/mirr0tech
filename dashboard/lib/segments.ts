// Splits a document's display text into lines and each line into pieces covered by the same set of
// quotes. Quotes overlap (two rules may quote one sentence), so a piece carries every ref over it.

export type Span = { start: number; end: number; ref: string };
export type Piece = { start: number; end: number; refs: string[]; opens: string[] };
export type Line = { start: number; end: number; pieces: Piece[]; markers: number[] };

export function segmentLines(display: string, spans: Span[], markers: { offset: number; index: number }[] = []): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const text of display.split("\n")) {
    const end = start + text.length;
    const over = spans.filter((span) => span.start < end && span.end > start && span.end > span.start);
    const cuts = new Set<number>([start, end]);
    for (const span of over) {
      cuts.add(Math.max(span.start, start));
      cuts.add(Math.min(span.end, end));
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    const pieces: Piece[] = [];
    for (let index = 0; index + 1 < sorted.length; index++) {
      const from = sorted[index];
      const to = sorted[index + 1];
      if (from === to) continue;
      const covering = over.filter((span) => span.start <= from && span.end >= to);
      pieces.push({
        start: from,
        end: to,
        refs: [...new Set(covering.map((span) => span.ref))],
        opens: [...new Set(covering.filter((span) => span.start === from).map((span) => span.ref))],
      });
    }
    if (!pieces.length) pieces.push({ start, end, refs: [], opens: [] });
    lines.push({
      start,
      end,
      pieces,
      markers: markers.filter((marker) => marker.offset >= start && marker.offset <= end).map((m) => m.index),
    });
    start = end + 1;
  }
  return lines;
}

export const ruleRef = (id: string) => `rule:${id}`;
export const termRef = (name: string) => `term:${name}`;
