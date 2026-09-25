import { describe, expect, it } from "vitest";
import type { Paragraph, PolicyData } from "@/lib/types";
// Plain ESM from the repository root; types are inferred from the JavaScript.
import { labelParagraphs, paragraphsOf, parseClauseRef } from "../../scripts/export-ui.js";
import { compiled } from "./fixtures";

const find = (policy: PolicyData, part: string, starts: string): Paragraph => {
  const index = policy.documents.findIndex((doc) => doc.name === part);
  const display = policy.documents[index].display;
  const hit = policy.coverage.paragraphs.find(
    (p) => p.part === index && display.slice(p.displayStart, p.displayEnd).startsWith(starts)
  );
  if (!hit) throw new Error(`no paragraph in ${part} starting "${starts}"`);
  return hit;
};

describe("paragraphsOf", () => {
  it("splits on blank lines and before every clause label, with exact offsets", () => {
    const display =
      "### 13) Sanctions\n\na) First.\n\ne) Disputes:\n1. Burden.\n2. Evidence\ncontinued\n\n2.1 Agreement.";
    const paragraphs = paragraphsOf(display);
    expect(paragraphs.map((p: { start: number; end: number }) => display.slice(p.start, p.end))).toEqual([
      "### 13) Sanctions",
      "a) First.",
      "e) Disputes:",
      "1. Burden.",
      "2. Evidence\ncontinued",
      "2.1 Agreement.",
    ]);
  });
});

describe("labelParagraphs", () => {
  it("builds hierarchical clause paths for markdown sections, letters and list items", () => {
    const display =
      "# Title\n\n### 13) Sanctions\n\ne) Disputes:\n1. Burden.\n\n## EXHIBIT A\n\n**Base APR**: 10%";
    const labelled = labelParagraphs(display, { markdown: true, prefix: "MLA" });
    expect(labelled.map((p: { label: string; kind: string }) => [p.label, p.kind])).toEqual([
      ["MLA Preamble", "heading"],
      ["MLA 13)", "heading"],
      ["MLA 13) e)", "clause"],
      ["MLA 13) e) 1.", "clause"],
      ["MLA Exhibit A", "heading"],
      ["MLA Exhibit A", "text"],
    ]);
    expect(labelled[3].path).toEqual(["13", "e", "1"]);
  });

  it("reads dotted numbering and caps headings from converted HTML", () => {
    const display =
      "RECITALS\n\nDEFINITIONS. For purposes of this Agreement:\n\n“Term” means the term.\n\n7\n\n2.ISSUANCE OF SHARES.\n\n2.1.1.Written instructions.";
    const labelled = labelParagraphs(display, { markdown: false, prefix: "" });
    expect(labelled.map((p: { label: string; kind: string }) => [p.label, p.kind])).toEqual([
      ["Preamble", "heading"],
      ["Definitions", "definition"],
      ["Definitions", "definition"],
      ["Definitions", "boilerplate"],
      ["2", "heading"],
      ["2.1.1", "clause"],
    ]);
    expect(labelled[5].path).toEqual(["2", "1", "1"]);
  });
});

describe("parseClauseRef", () => {
  it("expands shared prefixes, lists and ranges into clause paths", () => {
    expect(parseClauseRef("MLA 13) c), e)")).toEqual([
      { doc: "wildcat-mla", path: ["13", "c"] },
      { doc: "wildcat-mla", path: ["13", "e"] },
    ]);
    expect(parseClauseRef("MLA 4), 5)")).toEqual([
      { doc: "wildcat-mla", path: ["4"] },
      { doc: "wildcat-mla", path: ["5"] },
    ]);
    expect(parseClauseRef("Lender Check Policy 2.2, 2.3")).toEqual([
      { doc: "lender-check-policy", path: ["2", "2"] },
      { doc: "lender-check-policy", path: ["2", "3"] },
    ]);
    expect(parseClauseRef("Preamble; 2.1–2.2")).toEqual([
      { doc: null, path: ["Preamble"] },
      { doc: null, path: ["2", "1"] },
      { doc: null, path: ["2", "2"] },
    ]);
    expect(parseClauseRef("Exhibit A")).toEqual([{ doc: null, path: ["Exhibit A"] }]);
    expect(parseClauseRef("Agreement generally")).toEqual([]);
  });
});

describe("paragraph coverage — wildcat-credit", () => {
  it("marks a paragraph with a rule quote compiled and names its enforcing components", async () => {
    const policy = await compiled("wildcat-credit");
    const paragraph = find(policy, "lender-check-policy.md", "2.1 Agreement.");
    expect(paragraph.status).toBe("compiled");
    expect(paragraph.rules).toContain("deposit-countersigned");
    expect(paragraph.components).toContain("wildcat-admission");
    expect(paragraph.label).toBe("Lender Check Policy 2.1");
  });

  it("flags the §13(e) sanctions-dispute paragraph unresolved by clause label", async () => {
    const policy = await compiled("wildcat-credit");
    const paragraph = find(policy, "wildcat-mla.md", "e) In the event that a Lender disputes");
    const flag = policy.unresolved.findIndex((entry) => entry.clause === "MLA 13) c), e)");
    expect(paragraph.status).toBe("unresolved");
    expect(paragraph.label).toBe("MLA 13) e)");
    expect(paragraph.unresolved).toEqual([flag]);
    expect(policy.unresolved[flag].anchor?.offset).not.toBe(paragraph.displayStart);
    expect(find(policy, "wildcat-mla.md", "1. The burden of proof").status).toBe("unresolved");
  });

  it("leaves a definitions paragraph not executable", async () => {
    const policy = await compiled("wildcat-credit");
    const paragraph = find(policy, "wildcat-mla.md", "`Business Day` means");
    expect(paragraph).toMatchObject({
      status: "not-executable",
      kind: "definition",
      rules: [],
      terms: [],
      unresolved: [],
    });
  });

  it("maps every rule and term to a compiled paragraph and counts every paragraph once", async () => {
    const policy = await compiled("wildcat-credit");
    const { paragraphs, counts, total } = policy.coverage;
    const covered = new Set(paragraphs.flatMap((p) => [...p.rules, ...p.terms]));
    for (const rule of policy.rules) expect(covered.has(rule.id)).toBe(true);
    for (const term of policy.terms) expect(covered.has(term.name)).toBe(true);
    expect(counts.compiled + counts.unresolved + counts["not-executable"]).toBe(total);
    expect(policy.coverage.rules).toBe(policy.rules.length);
    for (const p of paragraphs) {
      expect(p.displayEnd).toBeGreaterThan(p.displayStart);
      expect(p.status === "compiled").toBe(p.rules.length + p.terms.length > 0);
    }
  });
});

describe("paragraph coverage — custodial-rwa", () => {
  it("flags the preamble and the 2.1–2.2 range, and compiles the quoted 2.3", async () => {
    const policy = await compiled("custodial-rwa");
    const part = "ea026411904ex10-9.htm";
    expect(find(policy, part, "Certain schedules and exhibits").status).toBe("unresolved");
    expect(find(policy, part, "2.1.1.Written instructions").status).toBe("unresolved");
    expect(find(policy, part, "2.2.If the Offering Memorandum").label).toBe("2.2");
    const issuance = find(policy, part, "2.3.After the initial issuance");
    expect(issuance.status).toBe("compiled");
    expect(issuance.components).toEqual(["custodial-token"]);
    expect(find(policy, part, "9.1.Generally").status).toBe("not-executable");
  });
});
