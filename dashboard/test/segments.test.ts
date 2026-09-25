import { describe, expect, it } from "vitest";
import { segmentLines } from "@/lib/segments";

describe("segmentLines", () => {
  const text = "alpha beta gamma\ndelta epsilon\n\nzeta";

  it("returns one plain piece per line when nothing is quoted", () => {
    const lines = segmentLines(text, []);
    expect(lines.map((line) => text.slice(line.start, line.end))).toEqual([
      "alpha beta gamma",
      "delta epsilon",
      "",
      "zeta",
    ]);
    expect(lines.every((line) => line.pieces.length === 1 && line.pieces[0].refs.length === 0)).toBe(true);
  });

  it("splits overlapping quotes into pieces that carry every ref over them", () => {
    const lines = segmentLines(text, [
      { start: 6, end: 16, ref: "rule:a" },
      { start: 11, end: 16, ref: "rule:b" },
    ]);
    const pieces = lines[0].pieces.map((piece) => ({
      text: text.slice(piece.start, piece.end),
      refs: piece.refs,
      opens: piece.opens,
    }));
    expect(pieces).toEqual([
      { text: "alpha ", refs: [], opens: [] },
      { text: "beta ", refs: ["rule:a"], opens: ["rule:a"] },
      { text: "gamma", refs: ["rule:a", "rule:b"], opens: ["rule:b"] },
    ]);
  });

  it("carries a quote across a line break and opens it only where it starts", () => {
    const lines = segmentLines(text, [{ start: 11, end: 22, ref: "term:x" }]);
    expect(text.slice(lines[0].pieces[1].start, lines[0].pieces[1].end)).toBe("gamma");
    expect(lines[0].pieces[1].opens).toEqual(["term:x"]);
    expect(text.slice(lines[1].pieces[0].start, lines[1].pieces[0].end)).toBe("delta");
    expect(lines[1].pieces[0]).toMatchObject({ refs: ["term:x"], opens: [] });
  });

  it("places a marker on the line it points into, including an empty one", () => {
    const lines = segmentLines(
      text,
      [],
      [
        { offset: 17, index: 0 },
        { offset: 31, index: 1 },
      ]
    );
    expect(lines.map((line) => line.markers)).toEqual([[], [0], [1], []]);
  });

  it("ignores empty spans", () => {
    const lines = segmentLines("abc", [{ start: 1, end: 1, ref: "rule:z" }]);
    expect(lines[0].pieces).toHaveLength(1);
  });
});
