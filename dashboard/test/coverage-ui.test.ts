import { describe, expect, it } from "vitest";
import {
  coverageSentence,
  groupLines,
  nextRef,
  NOT_EXECUTABLE,
  paragraphTitle,
  refsOf,
  visibleUnder,
} from "@/lib/coverage";
import { segmentLines } from "@/lib/segments";
import type { Coverage, Paragraph } from "@/lib/types";

const paragraph = (over: Partial<Paragraph>): Paragraph => ({
  part: 0,
  displayStart: 0,
  displayEnd: 0,
  label: "",
  kind: "clause",
  status: "not-executable",
  rules: [],
  terms: [],
  unresolved: [],
  components: [],
  ...over,
});

describe("groupLines", () => {
  it("puts each line under its paragraph and leaves blank separators on their own", () => {
    const display = "a) One\ncontinued\n\nb) Two\n1. Item";
    const lines = segmentLines(display, []);
    const blocks = groupLines(lines, [
      { index: 7, paragraph: paragraph({ displayStart: 0, displayEnd: 16 }) },
      { index: 8, paragraph: paragraph({ displayStart: 18, displayEnd: 24 }) },
      { index: 9, paragraph: paragraph({ displayStart: 25, displayEnd: 32 }) },
    ]);
    expect(
      blocks.map((block) => [block.paragraph, block.lines.map((line) => display.slice(line.start, line.end))])
    ).toEqual([
      [7, ["a) One", "continued"]],
      [null, [""]],
      [8, ["b) Two"]],
      [9, ["1. Item"]],
    ]);
  });
});

describe("nextRef", () => {
  it("selects the first rule, then cycles through rules and terms", () => {
    const p = paragraph({ status: "compiled", rules: ["a", "b"], terms: ["price"] });
    expect(refsOf(p)).toEqual(["rule:a", "rule:b", "term:price"]);
    expect(nextRef(p, null)).toBe("rule:a");
    expect(nextRef(p, "rule:zzz")).toBe("rule:a");
    expect(nextRef(p, "rule:a")).toBe("rule:b");
    expect(nextRef(p, "term:price")).toBe("rule:a");
    expect(nextRef(paragraph({}), null)).toBeNull();
  });
});

describe("coverage copy", () => {
  it("summarises the counts in one line", () => {
    const coverage: Coverage = {
      paragraphs: [],
      total: 166,
      counts: { compiled: 23, unresolved: 44, "not-executable": 99 },
      rules: 14,
      terms: 8,
    };
    expect(coverageSentence(coverage)).toBe(
      "23 of 166 paragraphs compile to 14 rules and 8 terms · 44 flagged unresolved · 99 not executable"
    );
    expect(coverageSentence({ ...coverage, terms: 0, rules: 1 })).toContain("compile to 1 rule ·");
  });

  it("titles each status the way the reader needs it", () => {
    expect(
      paragraphTitle(
        paragraph({
          status: "compiled",
          label: "MLA 13) b)",
          rules: ["deposit-sanctions"],
          components: ["wildcat-admission"],
        }),
        []
      )
    ).toBe("MLA 13) b) · compiled → deposit-sanctions · enforced by wildcat-admission");
    expect(
      paragraphTitle(paragraph({ status: "unresolved", label: "MLA 13) e)" }), ["MLA 13) c), e)"])
    ).toContain("not compiled (MLA 13) c), e))");
    expect(paragraphTitle(paragraph({}), [])).toBe(NOT_EXECUTABLE);
  });

  it("keeps headings visible under a filter", () => {
    expect(visibleUnder("compiled", paragraph({ status: "compiled" }))).toBe(true);
    expect(visibleUnder("compiled", paragraph({ status: "unresolved" }))).toBe(false);
    expect(visibleUnder("unresolved", paragraph({ kind: "heading" }))).toBe(true);
    expect(visibleUnder("all", paragraph({}))).toBe(true);
  });
});
